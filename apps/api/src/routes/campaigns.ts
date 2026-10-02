import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { requireRole } from "../middleware/rbac.js";
import { requirePermission } from "../middleware/permissions.js";
import multer from "multer";
import { normalizeLeadPhone } from "../leadgen/enrichment.js";
import { importLeads, readRows } from "../leadgen/leadImport.js";
import { normalizePlaceholders } from "../voiceai/placeholders.js";
import { parseWindow, zonedLocalToUtc } from "../voiceai/callingWindow.js";
import { publishCampaign, agentChangedSincePublish, PublishError } from "../voiceai/campaignVersions.js";
import { hangUp } from "../voiceai/dialer.js";
import { publishEvent, signalSlotFreed } from "../services/events.js";

export const campaignsRouter = Router();
campaignsRouter.use(requireAuth);
campaignsRouter.use(requireModuleAccess("voice_agents"));
campaignsRouter.use(requireRole("agent_manager"));

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const windowSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1),
  start: hhmm,
  end: hhmm,
  useLeadTimeZone: z.boolean(),
  lunchBreak: z.object({ start: hhmm, end: hhmm }).nullable(),
});

const campaignSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  aiAgentId: z.string().uuid().nullable().optional(),
  voiceId: z.string().uuid().nullable().optional(),
  transferNumber: z.string().nullable().optional(),
  concurrency: z.number().int().min(1).max(50).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  callingHours: windowSchema.optional(),
  timeZone: z.string().optional(),
  maxCallDurationSeconds: z.number().int().min(60).max(3600).optional(),
  introName: z.string().nullable().optional(),
  callbackNumber: z.string().nullable().optional(),
  script: z.string().nullable().optional(),
  knowledgeText: z.string().nullable().optional(),
  retryOnVoicemail: z.boolean().optional(),
  retryDelayMinutes: z.number().int().min(5).max(10080).optional(),
  leadCooldownHours: z.number().int().min(0).max(720).optional(),
  dialTimeoutSeconds: z.number().int().min(20).max(180).optional(),
  llmModel: z.string().optional(),
  transferTargets: z
    .object({
      sales: z.string().nullable().optional(),
      support: z.string().nullable().optional(),
      retention: z.string().nullable().optional(),
      manager: z.string().nullable().optional(),
    })
    .optional(),
  recordingDisclosure: z.boolean().optional(),
});

// API field -> column, with optional value transform.
const COLUMNS: Record<string, [string, ((v: any) => unknown)?]> = {
  name: ["name"],
  description: ["description"],
  aiAgentId: ["ai_agent_id"],
  voiceId: ["voice_id"],
  transferNumber: ["transfer_number"],
  concurrency: ["concurrency"],
  maxAttempts: ["max_attempts"],
  callingHours: ["calling_hours", (v) => JSON.stringify(v)],
  timeZone: ["time_zone"],
  maxCallDurationSeconds: ["max_call_duration_seconds"],
  introName: ["intro_name"],
  callbackNumber: ["callback_number"],
  script: ["script", (v) => (v == null ? v : normalizePlaceholders(v))],
  knowledgeText: ["knowledge_text"],
  retryOnVoicemail: ["retry_on_voicemail"],
  retryDelayMinutes: ["retry_delay_minutes"],
  leadCooldownHours: ["lead_cooldown_hours"],
  dialTimeoutSeconds: ["dial_timeout_seconds"],
  llmModel: ["llm_model"],
  transferTargets: [
    "transfer_targets",
    (v: Record<string, string | null | undefined>) =>
      JSON.stringify(Object.fromEntries(Object.entries(v).filter(([, n]) => n && String(n).trim()).map(([k, n]) => [k, String(n).trim()]))),
  ],
  recordingDisclosure: ["recording_disclosure"],
};

function toColumns(data: Record<string, unknown>) {
  const cols: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(data)) {
    const def = COLUMNS[key];
    if (!def || value === undefined) continue;
    cols.push(def[0]);
    values.push(def[1] ? def[1](value) : value);
  }
  return { cols, values };
}

async function loadCampaign(id: string, organizationId: string) {
  const r = await pool.query("select * from campaigns where id = $1 and organization_id = $2", [id, organizationId]);
  return r.rows[0] ?? null;
}

const STATS_SQL = `
  (select count(*) from campaign_leads where campaign_id = c.id)::int as total_leads,
  (select count(*) from campaign_leads where campaign_id = c.id and status in ('queued','retry_scheduled'))::int as leads_remaining,
  (select count(*) from campaign_leads where campaign_id = c.id and status = 'dialing')::int as leads_dialing,
  (select count(*) from calls where campaign_id = c.id)::int as total_calls,
  (select count(*) from calls where campaign_id = c.id and status in ('queued','ringing','answered'))::int as live_calls,
  (select count(*) from calls where campaign_id = c.id and answered)::int as connected_calls,
  (select count(*) from calls ca join call_dispositions cd on cd.id = ca.disposition_id
     where ca.campaign_id = c.id and cd.key in ('FL','PROPO','XFER','SALE'))::int as interested_leads,
  (select count(*) from calls ca join call_dispositions cd on cd.id = ca.disposition_id
     where ca.campaign_id = c.id and cd.key = 'CALLBK')::int as appointments,
  (select count(*) from calls ca join call_dispositions cd on cd.id = ca.disposition_id
     where ca.campaign_id = c.id and cd.key = 'XFER')::int as transfers,
  (select count(*) from calls where campaign_id = c.id and voicemail_detected)::int as voicemails,
  (select round(avg(talk_seconds)) from calls where campaign_id = c.id and talk_seconds > 0)::int as avg_talk_seconds,
  (select version from campaign_versions where id = c.published_version_id) as published_version`;

campaignsRouter.get("/", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select c.*, a.name as agent_name, ${STATS_SQL}
     from campaigns c left join ai_agents a on a.id = c.ai_agent_id
     where c.organization_id = $1 order by c.created_at desc`,
    [req.auth!.organizationId]
  );
  res.json({ campaigns: result.rows });
});

campaignsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select c.*, ${STATS_SQL} from campaigns c where c.id = $1 and c.organization_id = $2`,
    [req.params.id, req.auth!.organizationId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Campaign not found." });
  const campaign = result.rows[0];
  campaign.calling_hours = parseWindow(campaign.calling_hours);
  const [numbers, agentChanged] = await Promise.all([
    pool.query(
      `select p.id, p.phone_e164, p.provider, p.status, p.area_code, p.vapi_phone_number_id, cpn.last_used_at
       from campaign_phone_numbers cpn join phone_numbers p on p.id = cpn.phone_number_id
       where cpn.campaign_id = $1 order by p.phone_e164`,
      [req.params.id]
    ),
    agentChangedSincePublish(req.params.id),
  ]);
  res.json({ campaign, numbers: numbers.rows, agentChangedSincePublish: agentChanged });
});

campaignsRouter.get("/:id/leads", async (req: AuthedRequest, res) => {
  const campaign = await loadCampaign(req.params.id, req.auth!.organizationId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const result = await pool.query(
    `select cl.id, cl.status, cl.attempts, cl.last_disposition, cl.next_attempt_at, cl.created_at,
            l.id as lead_id, l.business_name, l.first_name, l.last_name, l.main_phone_e164, l.state, l.is_dnc
     from campaign_leads cl join leads l on l.id = cl.lead_id
     where cl.campaign_id = $1 and ($2::text is null or cl.status = $2)
     order by cl.created_at desc limit $3 offset $4`,
    [req.params.id, status, limit, offset]
  );
  res.json({ leads: result.rows });
});

campaignsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = campaignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { cols, values } = toColumns(parsed.data);
  cols.push("organization_id", "created_by", "has_unpublished_changes");
  values.push(req.auth!.organizationId, req.auth!.userId, true);
  if (!parsed.data.callingHours) {
    cols.push("calling_hours");
    values.push(JSON.stringify(parseWindow(null)));
  }
  const result = await pool.query(
    `insert into campaigns (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
    values
  );
  res.status(201).json({ campaign: result.rows[0] });
});

// Edits are drafts: they don't reach live calls until Save & publish.
campaignsRouter.patch("/:id", async (req: AuthedRequest, res) => {
  const parsed = campaignSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { cols, values } = toColumns(parsed.data);
  if (cols.length === 0) return res.status(400).json({ error: "Nothing to update." });
  const sets = cols.map((c, i) => `${c} = $${i + 1}`);
  const result = await pool.query(
    `update campaigns set ${sets.join(", ")}, has_unpublished_changes = true, updated_at = now()
     where id = $${cols.length + 1} and organization_id = $${cols.length + 2} returning *`,
    [...values, req.params.id, req.auth!.organizationId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Campaign not found." });
  res.json({ campaign: result.rows[0] });
});

campaignsRouter.post("/:id/publish", requirePermission("campaign.publish"), async (req: AuthedRequest, res) => {
  const campaign = await loadCampaign(req.params.id, req.auth!.organizationId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  const agentChanged = await agentChangedSincePublish(campaign.id);
  if (agentChanged && !req.body?.confirmAgentChange) {
    return res.status(409).json({
      error: "The linked agent changed since the last publish. Publishing will push those agent changes to live calls.",
      code: "agent_changed",
    });
  }
  try {
    const result = await publishCampaign(campaign.id, req.auth!.organizationId, req.auth!.userId);
    await publishEvent(req.auth!.organizationId, { type: "campaign_published", campaignId: campaign.id, version: result.version });
    res.json(result);
  } catch (err) {
    if (err instanceof PublishError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

campaignsRouter.get("/:id/versions", async (req: AuthedRequest, res) => {
  const campaign = await loadCampaign(req.params.id, req.auth!.organizationId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  const result = await pool.query(
    `select cv.id, cv.version, cv.created_at, cv.snapshot, trim(concat(u.first_name, ' ', u.last_name)) as published_by_name,
            (select count(*) from calls where campaign_version_id = cv.id)::int as calls
     from campaign_versions cv left join users u on u.id = cv.published_by
     where cv.campaign_id = $1 order by cv.version desc`,
    [campaign.id]
  );
  res.json({ versions: result.rows, publishedVersionId: campaign.published_version_id });
});

// Number pool (playbook §4): the dialer rotates across these, preferring a
// number whose area code matches the lead.
campaignsRouter.post("/:id/numbers", async (req: AuthedRequest, res) => {
  const parsed = z.object({ phoneNumberIds: z.array(z.string().uuid()).min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const campaign = await loadCampaign(req.params.id, req.auth!.organizationId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  const result = await pool.query(
    `insert into campaign_phone_numbers (campaign_id, phone_number_id)
     select $1, id from phone_numbers where id = any($2) and organization_id = $3
     on conflict do nothing returning phone_number_id`,
    [campaign.id, parsed.data.phoneNumberIds, req.auth!.organizationId]
  );
  res.json({ added: result.rowCount ?? 0 });
});

campaignsRouter.delete("/:id/numbers/:phoneNumberId", async (req: AuthedRequest, res) => {
  const campaign = await loadCampaign(req.params.id, req.auth!.organizationId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  await pool.query("delete from campaign_phone_numbers where campaign_id = $1 and phone_number_id = $2", [
    campaign.id,
    req.params.phoneNumberId,
  ]);
  res.json({ removed: true });
});

const controlSchema = z.object({
  action: z.enum(["start", "pause", "resume", "stop", "restart", "schedule"]),
  scheduledStartAt: z.string().optional(),
  endLiveCalls: z.boolean().optional(),
});

campaignsRouter.post("/:id/control", requirePermission("campaign.start"), async (req: AuthedRequest, res) => {
  const parsed = controlSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const campaign = await loadCampaign(req.params.id, req.auth!.organizationId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  const { action } = parsed.data;

  if (["start", "resume", "restart", "schedule"].includes(action) && !campaign.published_version_id) {
    return res.status(400).json({ error: "Save & publish the campaign before starting it." });
  }

  let status: string = campaign.status;
  let scheduledAt: Date | null = null;
  switch (action) {
    case "start":
    case "resume":
      status = "active";
      break;
    case "pause":
      status = "paused";
      break;
    case "stop":
      status = "stopped";
      break;
    case "restart":
      // Requeue everything except leads that must never be called again.
      await pool.query(
        `update campaign_leads cl set status = 'queued', attempts = 0, next_attempt_at = null
         from leads l where l.id = cl.lead_id and cl.campaign_id = $1
           and cl.status <> 'dialing' and cl.status <> 'dnc' and not l.is_dnc`,
        [campaign.id]
      );
      status = "active";
      break;
    case "schedule": {
      const raw = parsed.data.scheduledStartAt;
      scheduledAt = raw ? (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? new Date(raw) : zonedLocalToUtc(raw, campaign.time_zone)) : null;
      if (!scheduledAt || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now()) {
        return res.status(400).json({ error: "Pick a future start time." });
      }
      status = "scheduled";
      break;
    }
  }

  const result = await pool.query(
    `update campaigns set status = $1, scheduled_start_at = $2, paused_reason = null,
       breaker_error_count = case when $1 = 'active' then 0 else breaker_error_count end,
       updated_at = now()
     where id = $3 returning *`,
    [status, scheduledAt, campaign.id]
  );

  if ((action === "stop" || action === "pause") && parsed.data.endLiveCalls) {
    const live = await pool.query(
      "select * from calls where campaign_id = $1 and status in ('queued','ringing','answered')",
      [campaign.id]
    );
    for (const call of live.rows) await hangUp(call);
  }
  if (status === "active") await signalSlotFreed(campaign.id);
  await publishEvent(req.auth!.organizationId, { type: "campaign_status", campaignId: campaign.id, status });
  res.json({ campaign: result.rows[0] });
});

campaignsRouter.delete("/:id", requirePermission("campaign.start"), async (req: AuthedRequest, res) => {
  const campaign = await loadCampaign(req.params.id, req.auth!.organizationId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  const live = await pool.query(
    "select count(*) from calls where campaign_id = $1 and status in ('queued','ringing','answered')",
    [campaign.id]
  );
  if (Number(live.rows[0].count) > 0) return res.status(409).json({ error: "Stop the campaign and wait for live calls to end first." });
  // calls.campaign_id is ON DELETE SET NULL, so call history survives for CDR.
  await pool.query("delete from campaigns where id = $1", [campaign.id]);
  res.json({ deleted: true });
});

// Add leads from a lead list (or explicit lead IDs) into the campaign queue.
campaignsRouter.post("/:id/leads", async (req: AuthedRequest, res) => {
  const parsed = z
    .object({ leadListId: z.string().uuid().optional(), leadIds: z.array(z.string().uuid()).optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const campaign = await loadCampaign(req.params.id, req.auth!.organizationId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });

  const filter = parsed.data.leadListId ? "lead_list_id = $2" : "id = any($2)";
  const arg = parsed.data.leadListId ?? parsed.data.leadIds ?? [];
  const result = await pool.query(
    `insert into campaign_leads (campaign_id, lead_id)
     select $1, id from leads where ${filter} and organization_id = $3 and main_phone_e164 is not null
     on conflict (campaign_id, lead_id) do nothing returning id`,
    [campaign.id, arg, req.auth!.organizationId]
  );
  if (campaign.status === "active") await signalSlotFreed(campaign.id);
  res.json({ added: result.rowCount ?? 0 });
});

campaignsRouter.post("/:id/leads/remove", async (req: AuthedRequest, res) => {
  const parsed = z.object({ campaignLeadIds: z.array(z.string().uuid()).min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const campaign = await loadCampaign(req.params.id, req.auth!.organizationId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  const result = await pool.query(
    "delete from campaign_leads where campaign_id = $1 and id = any($2) and status <> 'dialing' returning id",
    [campaign.id, parsed.data.campaignLeadIds]
  );
  res.json({ removed: result.rowCount ?? 0 });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

campaignsRouter.post("/:id/leads/import", upload.single("file"), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: "No CSV or XLSX file provided." });
  const campaign = await loadCampaign(req.params.id, req.auth!.organizationId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  let records: Record<string, unknown>[];
  try {
    records = await readRows(req.file.buffer, req.file.originalname);
  } catch (err) {
    return res.status(400).json({ error: `Could not read file: ${(err as Error).message}` });
  }
  const result = await importLeads(req.auth!.organizationId, records, { leadListId: null, campaignId: campaign.id });
  if (campaign.status === "active") await signalSlotFreed(campaign.id);
  res.json(result);
});

const singleLeadSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  company: z.string().optional(),
  phone: z.string().min(4),
  email: z.string().optional(),
  state: z.string().optional(),
});

campaignsRouter.post("/:id/leads/single", async (req: AuthedRequest, res) => {
  const parsed = singleLeadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const d = parsed.data;
  const phoneE164 = normalizeLeadPhone(d.phone);
  if (!phoneE164) return res.status(400).json({ error: "Not a valid US phone number." });
  const campaign = await loadCampaign(req.params.id, req.auth!.organizationId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });

  const name = [d.firstName, d.lastName].filter(Boolean).join(" ");
  const lead = await pool.query(
    `insert into leads (organization_id, business_name, first_name, last_name, main_phone, main_phone_e164, business_email, state, source)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'manual') returning id`,
    [req.auth!.organizationId, d.company || name || phoneE164, d.firstName ?? null, d.lastName ?? null, d.phone, phoneE164, d.email ?? null, d.state ?? null]
  );
  await pool.query("insert into campaign_leads (campaign_id, lead_id) values ($1,$2) on conflict do nothing", [
    campaign.id,
    lead.rows[0].id,
  ]);
  if (campaign.status === "active") await signalSlotFreed(campaign.id);
  res.status(201).json({ leadId: lead.rows[0].id });
});
