import { Router } from "express";
import { z } from "zod";
import { stringify } from "csv-stringify/sync";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { requireTab } from "../services/accessService.js";
import { requirePermission } from "../middleware/permissions.js";
import { getStorageDriver } from "../services/storageService.js";
import { controlVapiCall } from "../voiceai/vapiClient.js";
import { hangUp } from "../voiceai/dialer.js";
import { publishEvent } from "../services/events.js";
import { normalizeUsE164 } from "../utils/phone.js";
import { DNC_CODES } from "../services/dispositionsService.js";

export const callsRouter = Router();
callsRouter.use(requireAuth);
callsRouter.use(requireModuleAccess("voice_agents"));
// One router, three tabs: live controls, the DNC list, and call records.
const liveTab = requireTab("voice_agents", "live");
const dncTab = requireTab("voice_agents", "dnc");
const historyTab = requireTab("voice_agents", "history", { readVia: ["leads"] });
callsRouter.use((req, res, next) => {
  if (req.path.startsWith("/dnc")) return dncTab(req, res, next);
  if (req.path === "/active" || /^\/[^/]+\/(whisper|barge|transfer|end)$/.test(req.path)) return liveTab(req, res, next);
  return historyTab(req, res, next);
});

const LIVE = ["queued", "ringing", "answered"];

// CDR filters (playbook §9). Phone search matches on digits only, so
// "(302) 342-3925", "302.342.3925" and "+13023423925" all find the same call.
function cdrWhere(q: Record<string, string | undefined>, organizationId: string) {
  const conditions = ["c.organization_id = $1", "c.candidate_id is null"];
  const params: unknown[] = [organizationId];
  const add = (sql: (n: number) => string, value: unknown) => {
    params.push(value);
    conditions.push(sql(params.length));
  };
  if (q.campaignId) add((n) => `c.campaign_id = $${n}`, q.campaignId);
  if (q.agentId) add((n) => `c.agent_id = $${n}`, q.agentId);
  if (q.status) add((n) => `c.status = $${n}`, q.status);
  if (q.direction) add((n) => `c.direction = $${n}`, q.direction);
  if (q.disposition) add((n) => `cd.key = any($${n})`, q.disposition.split(","));
  if (q.dateFrom) add((n) => `c.created_at >= $${n}`, q.dateFrom);
  if (q.dateTo) add((n) => `c.created_at < ($${n}::date + 1)`, q.dateTo);
  if (q.minTalk) add((n) => `coalesce(c.talk_seconds, 0) >= $${n}`, Number(q.minTalk));
  if (q.maxTalk) add((n) => `coalesce(c.talk_seconds, 0) <= $${n}`, Number(q.maxTalk));
  if (q.phone) {
    const digits = q.phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    if (digits) add((n) => `(regexp_replace(c.to_number, '\\D', '', 'g') like $${n} or regexp_replace(c.from_number, '\\D', '', 'g') like $${n})`, `%${digits}%`);
  }
  if (q.q) {
    add(
      (n) =>
        `exists (select 1 from call_transcripts t where t.call_id = c.id and to_tsvector('english', coalesce(t.full_text, '')) @@ websearch_to_tsquery('english', $${n}))`,
      q.q
    );
  }
  return { where: conditions.join(" and "), params };
}

const CDR_SELECT = `
  select c.id, c.status, c.direction, c.to_number, c.from_number, c.created_at, c.started_at, c.answered_at, c.ended_at,
         c.duration_seconds, c.talk_seconds, c.ended_reason, c.answered, c.voicemail_detected, c.transfer_status,
         c.disposition_source, c.evaluation_score, c.cost_usd, c.campaign_id, c.lead_id,
         coalesce(nullif(trim(concat(l.first_name, ' ', l.last_name)), ''), l.business_name) as lead_name,
         l.business_name, a.name as agent_name, cmp.name as campaign_name,
         cd.key as disposition_key, cd.label as disposition_label, cd.color as disposition_color
  from calls c
  left join leads l on l.id = c.lead_id
  left join ai_agents a on a.id = c.agent_id
  left join campaigns cmp on cmp.id = c.campaign_id
  left join call_dispositions cd on cd.id = c.disposition_id`;

callsRouter.get("/", requirePermission("cdr.view"), async (req: AuthedRequest, res) => {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(200, Number(req.query.pageSize ?? 50));
  const { where, params } = cdrWhere(req.query as Record<string, string | undefined>, req.auth!.organizationId);
  const [rows, count] = await Promise.all([
    pool.query(`${CDR_SELECT} where ${where} order by c.created_at desc limit $${params.length + 1} offset $${params.length + 2}`, [
      ...params,
      pageSize,
      (page - 1) * pageSize,
    ]),
    pool.query(`select count(*) from calls c left join call_dispositions cd on cd.id = c.disposition_id where ${where}`, params),
  ]);
  res.json({ calls: rows.rows, page, pageSize, total: Number(count.rows[0].count) });
});

const CDR_COLUMNS = [
  "call_id", "created_at", "direction", "campaign", "agent", "lead", "business", "to", "from", "status",
  "disposition", "disposition_source", "answered", "voicemail", "transfer", "duration_seconds", "talk_seconds",
  "ended_reason", "score", "cost_usd", "summary",
];

callsRouter.get("/export", requirePermission("cdr.export"), async (req: AuthedRequest, res) => {
  const { where, params } = cdrWhere(req.query as Record<string, string | undefined>, req.auth!.organizationId);
  const rows = await pool.query(
    `${CDR_SELECT} left join call_transcripts t on t.call_id = c.id
     where ${where} order by c.created_at desc limit 50000`.replace("cd.color as disposition_color", "cd.color as disposition_color, t.summary"),
    params
  );
  const csv = stringify(
    rows.rows.map((r) => ({
      call_id: r.id,
      created_at: r.created_at?.toISOString?.() ?? r.created_at,
      direction: r.direction,
      campaign: r.campaign_name,
      agent: r.agent_name,
      lead: r.lead_name,
      business: r.business_name,
      to: r.to_number,
      from: r.from_number,
      status: r.status,
      disposition: r.disposition_label,
      disposition_source: r.disposition_source,
      answered: r.answered,
      voicemail: r.voicemail_detected,
      transfer: r.transfer_status,
      duration_seconds: r.duration_seconds,
      talk_seconds: r.talk_seconds,
      ended_reason: r.ended_reason,
      score: r.evaluation_score,
      cost_usd: r.cost_usd,
      summary: r.summary,
    })),
    { header: true, columns: CDR_COLUMNS }
  );
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="cdr-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

callsRouter.get("/active", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select c.id, c.status, c.direction, c.to_number, c.from_number, c.created_at, c.started_at, c.answered_at,
            c.campaign_id, cmp.name as campaign_name, a.name as agent_name,
            coalesce(nullif(trim(concat(l.first_name, ' ', l.last_name)), ''), l.business_name) as lead_name,
            l.business_name, (c.monitor_listen_url is not null) as can_listen, (c.monitor_control_url is not null) as can_control,
            (select turns from call_transcripts t where t.call_id = c.id) as turns
     from calls c
     left join leads l on l.id = c.lead_id
     left join ai_agents a on a.id = c.agent_id
     left join campaigns cmp on cmp.id = c.campaign_id
     where c.organization_id = $1 and c.status = any($2) and c.candidate_id is null
     order by c.created_at desc`,
    [req.auth!.organizationId, LIVE]
  );
  res.json({ calls: result.rows });
});

callsRouter.get("/:id", requirePermission("cdr.view"), async (req: AuthedRequest, res) => {
  const call = await pool.query(
    `select c.*, l.business_name, l.first_name, l.last_name, l.current_provider, l.customer_type, l.state,
            a.name as agent_name, cmp.name as campaign_name, cv.version as campaign_version,
            cd.key as disposition_key, cd.label as disposition_label, cd.color as disposition_color
     from calls c
     left join leads l on l.id = c.lead_id
     left join ai_agents a on a.id = c.agent_id
     left join campaigns cmp on cmp.id = c.campaign_id
     left join campaign_versions cv on cv.id = c.campaign_version_id
     left join call_dispositions cd on cd.id = c.disposition_id
     where c.id = $1 and c.organization_id = $2`,
    [req.params.id, req.auth!.organizationId]
  );
  if (call.rows.length === 0) return res.status(404).json({ error: "Call not found." });
  const row = call.rows[0];
  // Capability URLs stay server-side.
  delete row.monitor_listen_url;
  delete row.monitor_control_url;

  const [transcript, recording, transfers, history] = await Promise.all([
    pool.query("select full_text, turns, summary from call_transcripts where call_id = $1", [req.params.id]),
    pool.query("select * from call_recordings where call_id = $1", [req.params.id]),
    pool.query("select * from call_transfers where call_id = $1 order by created_at", [req.params.id]),
    row.lead_id
      ? pool.query(
          `select c.id, c.created_at, c.status, c.talk_seconds, cd.label as disposition_label, cd.color as disposition_color
           from calls c left join call_dispositions cd on cd.id = c.disposition_id
           where c.lead_id = $1 and c.id <> $2 order by c.created_at desc limit 20`,
          [row.lead_id, req.params.id]
        )
      : Promise.resolve({ rows: [] }),
  ]);

  let recordingUrl: string | null = null;
  if (recording.rows[0]?.file_id) {
    const file = await pool.query("select file_path from files where id = $1", [recording.rows[0].file_id]);
    if (file.rows[0]) recordingUrl = await getStorageDriver().getSignedUrl(file.rows[0].file_path);
  }

  res.json({
    call: row,
    transcript: transcript.rows[0] ?? null,
    recording: recording.rows[0] ?? null,
    recordingUrl,
    transfers: transfers.rows,
    leadHistory: history.rows,
  });
});

async function liveCall(req: AuthedRequest) {
  const r = await pool.query("select * from calls where id = $1 and organization_id = $2 and status = any($3)", [
    req.params.id,
    req.auth!.organizationId,
    LIVE,
  ]);
  return r.rows[0] ?? null;
}

async function logEvent(callId: string, event: Record<string, unknown>) {
  await pool.query("update calls set events = coalesce(events, '[]'::jsonb) || $2::jsonb where id = $1", [
    callId,
    JSON.stringify([{ ...event, at: new Date().toISOString() }]),
  ]);
}

// Whisper: a private instruction to the AI the caller never hears.
callsRouter.post("/:id/whisper", requirePermission("calls.whisper"), async (req: AuthedRequest, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) return res.status(400).json({ error: "Enter a message for the agent." });
  const call = await liveCall(req);
  if (!call?.monitor_control_url) return res.status(409).json({ error: "Call is not live or has no control channel." });
  try {
    await controlVapiCall(call.monitor_control_url, {
      type: "add-message",
      message: { role: "system", content: `Supervisor instruction (do not read aloud): ${message}` },
      triggerResponseEnabled: false,
    });
    await logEvent(call.id, { type: "whisper", by: req.auth!.userId, message });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Barge: the agent speaks the supervisor's words to the caller now.
callsRouter.post("/:id/barge", requirePermission("calls.barge"), async (req: AuthedRequest, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) return res.status(400).json({ error: "Enter what the agent should say." });
  const call = await liveCall(req);
  if (!call?.monitor_control_url) return res.status(409).json({ error: "Call is not live or has no control channel." });
  try {
    await controlVapiCall(call.monitor_control_url, { type: "say", content: message, endCallAfterSpoken: false });
    await logEvent(call.id, { type: "barge", by: req.auth!.userId, message });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

callsRouter.post("/:id/transfer", requirePermission("calls.transfer"), async (req: AuthedRequest, res) => {
  const call = await liveCall(req);
  if (!call?.monitor_control_url) return res.status(409).json({ error: "Call is not live or has no control channel." });
  const target = normalizeUsE164(String(req.body?.transferTo ?? ""));
  if (!target) return res.status(400).json({ error: "Enter a valid US number to transfer to." });
  try {
    await controlVapiCall(call.monitor_control_url, {
      type: "transfer",
      destination: { type: "number", number: target },
      content: "Please hold while I connect you.",
    });
    await pool.query("insert into call_transfers (call_id, transfer_to, status) values ($1,$2,'initiated')", [call.id, target]);
    await pool.query("update calls set transfer_status = 'initiated' where id = $1", [call.id]);
    await logEvent(call.id, { type: "manual_transfer", by: req.auth!.userId, to: target });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

callsRouter.post("/:id/end", requirePermission("calls.end"), async (req: AuthedRequest, res) => {
  const call = await liveCall(req);
  if (!call) return res.status(409).json({ error: "Call is not live." });
  await hangUp(call);
  await logEvent(call.id, { type: "ended_by_supervisor", by: req.auth!.userId });
  res.json({ ok: true });
});

// Manual disposition always wins over the engine (disposition_source='manual').
callsRouter.patch("/:id/disposition", requirePermission("calls.disposition"), async (req: AuthedRequest, res) => {
  const parsed = z.object({ dispositionKey: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const org = req.auth!.organizationId;
  const disp = await pool.query("select id, key, retryable from call_dispositions where organization_id = $1 and key = $2", [
    org,
    parsed.data.dispositionKey,
  ]);
  if (disp.rows.length === 0) return res.status(400).json({ error: "Unknown disposition." });
  const result = await pool.query(
    `update calls set disposition_id = $1, disposition_source = 'manual' where id = $2 and organization_id = $3
     returning id, lead_id, campaign_id, to_number`,
    [disp.rows[0].id, req.params.id, org]
  );
  const call = result.rows[0];
  if (!call) return res.status(404).json({ error: "Call not found." });

  const key = disp.rows[0].key;
  if (call.campaign_id && call.lead_id) {
    await pool.query(
      `update campaign_leads set last_disposition = $3,
         status = case when status = 'dialing' then status when $4 then status else 'done' end
       where campaign_id = $1 and lead_id = $2`,
      [call.campaign_id, call.lead_id, key, disp.rows[0].retryable]
    );
  }
  if (call.lead_id) await pool.query("update leads set call_status = $2 where id = $1", [call.lead_id, key]);
  if (DNC_CODES.includes(key)) {
    if (call.to_number) {
      await pool.query(
        "insert into dnc_entries (organization_id, phone_e164, reason) values ($1,$2,'Manual disposition') on conflict do nothing",
        [org, call.to_number]
      );
    }
    if (call.lead_id) await pool.query("update leads set is_dnc = true where id = $1", [call.lead_id]);
  }
  await logEvent(call.id, { type: "manual_disposition", by: req.auth!.userId, key });
  await publishEvent(org, { type: "call_updated", callId: call.id });
  res.json({ ok: true });
});

// --- Do-not-call list ---

callsRouter.get("/dnc/list", async (req: AuthedRequest, res) => {
  const result = await pool.query("select * from dnc_entries where organization_id = $1 order by created_at desc limit 1000", [
    req.auth!.organizationId,
  ]);
  res.json({ entries: result.rows });
});

callsRouter.post("/dnc/list", requirePermission("calls.disposition"), async (req: AuthedRequest, res) => {
  const phone = normalizeUsE164(String(req.body?.phone ?? ""));
  if (!phone) return res.status(400).json({ error: "Enter a valid US phone number." });
  const org = req.auth!.organizationId;
  await pool.query(
    "insert into dnc_entries (organization_id, phone_e164, reason) values ($1,$2,$3) on conflict do nothing",
    [org, phone, typeof req.body?.reason === "string" ? req.body.reason : "Added manually"]
  );
  await pool.query("update leads set is_dnc = true, call_status = 'DNC' where organization_id = $1 and main_phone_e164 = $2", [org, phone]);
  res.status(201).json({ ok: true });
});

callsRouter.delete("/dnc/list/:id", requirePermission("calls.disposition"), async (req: AuthedRequest, res) => {
  await pool.query("delete from dnc_entries where id = $1 and organization_id = $2", [req.params.id, req.auth!.organizationId]);
  res.status(204).end();
});
