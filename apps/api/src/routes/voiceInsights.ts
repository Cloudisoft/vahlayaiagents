import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { importLeads, readRows } from "../leadgen/leadImport.js";
import { normalizeE164 } from "../utils/phone.js";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { requireTab } from "../services/accessService.js";
import { requirePermission } from "../middleware/permissions.js";
import { signalSlotFreed } from "../services/events.js";
import { CALLBACK_CODES, DNC_CODES, POSITIVE_CODES } from "../services/dispositionsService.js";

export const voiceInsightsRouter = Router();
voiceInsightsRouter.use(requireAuth);
voiceInsightsRouter.use(requireModuleAccess("voice_agents"));
const summaryTab = requireTab("voice_agents", "analytics", { readVia: ["dashboard"] });
const callbacksTab = requireTab("voice_agents", "callbacks", { readVia: ["dashboard"] });
const leadsTab = requireTab("voice_agents", "leads");
voiceInsightsRouter.use((req, res, next) => {
  if (req.path.startsWith("/summary")) return summaryTab(req, res, next);
  if (req.path.startsWith("/callbacks")) return callbacksTab(req, res, next);
  return leadsTab(req, res, next);
});

const CALLBACK_KEYS = CALLBACK_CODES;

// One query set backs both the Voice dashboard (days=1) and Analytics.
voiceInsightsRouter.get("/summary", requirePermission("cdr.view"), async (req: AuthedRequest, res) => {
  const org = req.auth!.organizationId;
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const campaignId = typeof req.query.campaignId === "string" && req.query.campaignId ? req.query.campaignId : null;
  const tz = typeof req.query.tz === "string" && /^[A-Za-z_\/+-]+$/.test(req.query.tz) ? req.query.tz : "America/New_York";
  const scope = `c.organization_id = $1 and c.candidate_id is null and c.created_at >= now() - ($2 || ' days')::interval
    and ($3::uuid is null or c.campaign_id = $3)`;
  const p = [org, String(days), campaignId];

  const [totals, daily, dispositions, campaigns, hours, live, callbacks] = await Promise.all([
    pool.query(
      `select count(*)::int as calls,
              count(*) filter (where c.answered)::int as connected,
              count(*) filter (where c.customer_spoke and c.talk_seconds >= 10)::int as conversations,
              count(*) filter (where c.voicemail_detected)::int as voicemails,
              count(*) filter (where cd.key = 'XFER')::int as transfers,
              count(*) filter (where cd.key = any($4))::int as positive,
              count(*) filter (where cd.key = any($5))::int as dnc,
              coalesce(sum(c.talk_seconds), 0)::int as talk_seconds,
              round(avg(c.talk_seconds) filter (where c.talk_seconds > 0))::int as avg_talk_seconds,
              round(coalesce(sum(c.cost_usd), 0)::numeric, 2)::float as cost_usd
       from calls c left join call_dispositions cd on cd.id = c.disposition_id where ${scope}`,
      [...p, POSITIVE_CODES, DNC_CODES]
    ),
    pool.query(
      `select to_char(date_trunc('day', c.created_at at time zone $4), 'YYYY-MM-DD') as day,
              count(*)::int as calls, count(*) filter (where c.answered)::int as connected,
              count(*) filter (where cd.key = any($5))::int as positive
       from calls c left join call_dispositions cd on cd.id = c.disposition_id
       where ${scope} group by 1 order by 1`,
      [...p, tz, POSITIVE_CODES]
    ),
    pool.query(
      `select cd.key, cd.label, cd.color, count(*)::int as count
       from calls c join call_dispositions cd on cd.id = c.disposition_id
       where ${scope} group by cd.key, cd.label, cd.color order by count desc`,
      p
    ),
    pool.query(
      `select cmp.id, cmp.name, cmp.status, count(c.id)::int as calls,
              count(c.id) filter (where c.answered)::int as connected,
              count(c.id) filter (where cd.key = any($4))::int as positive,
              round(avg(c.talk_seconds) filter (where c.talk_seconds > 0))::int as avg_talk_seconds
       from calls c join campaigns cmp on cmp.id = c.campaign_id
       left join call_dispositions cd on cd.id = c.disposition_id
       where ${scope} group by cmp.id order by calls desc limit 20`,
      [...p, POSITIVE_CODES]
    ),
    pool.query(
      `select extract(hour from c.created_at at time zone $4)::int as hour, count(*)::int as calls,
              count(*) filter (where c.answered)::int as connected
       from calls c where ${scope} group by 1 order by 1`,
      [...p, tz]
    ),
    pool.query(
      `select count(*)::int as live from calls where organization_id = $1 and status in ('queued','ringing','answered') and candidate_id is null`,
      [org]
    ),
    pool.query(
      `select count(*)::int as due from campaign_leads cl join campaigns cmp on cmp.id = cl.campaign_id
       where cmp.organization_id = $1 and cl.status = 'retry_scheduled' and cl.last_disposition = any($2)
         and cl.next_attempt_at < now() + interval '1 day'`,
      [org, CALLBACK_KEYS]
    ),
  ]);

  res.json({
    days,
    totals: totals.rows[0],
    daily: daily.rows,
    dispositions: dispositions.rows,
    campaigns: campaigns.rows,
    hours: hours.rows,
    liveCalls: live.rows[0].live,
    callbacksNext24h: callbacks.rows[0].due,
  });
});

voiceInsightsRouter.get("/callbacks", async (req: AuthedRequest, res) => {
  const scope = req.query.scope === "done" ? "done" : "upcoming";
  const result = await pool.query(
    `select cl.id, cl.status, cl.next_attempt_at, cl.last_disposition, cl.attempts, cl.campaign_id,
            cmp.name as campaign_name, cmp.status as campaign_status, l.id as lead_id, l.business_name,
            coalesce(nullif(trim(concat(l.first_name, ' ', l.last_name)), ''), l.business_name) as lead_name,
            l.main_phone_e164, l.state, l.time_zone,
            (select c.id from calls c where c.id = cl.last_call_id) as last_call_id,
            (select t.summary from call_transcripts t where t.call_id = cl.last_call_id) as last_summary
     from campaign_leads cl
     join campaigns cmp on cmp.id = cl.campaign_id
     join leads l on l.id = cl.lead_id
     where cmp.organization_id = $1 and cl.last_disposition = any($2)
       and ${scope === "upcoming" ? "cl.status = 'retry_scheduled'" : "cl.status <> 'retry_scheduled'"}
     order by cl.next_attempt_at ${scope === "upcoming" ? "asc" : "desc"} nulls last limit 500`,
    [req.auth!.organizationId, CALLBACK_KEYS]
  );
  res.json({ callbacks: result.rows });
});

async function ownedCampaignLead(id: string, org: string) {
  const r = await pool.query(
    `select cl.*, cmp.status as campaign_status from campaign_leads cl join campaigns cmp on cmp.id = cl.campaign_id
     where cl.id = $1 and cmp.organization_id = $2`,
    [id, org]
  );
  return r.rows[0] ?? null;
}

voiceInsightsRouter.post("/callbacks/:id/call-now", requirePermission("campaign.start"), async (req: AuthedRequest, res) => {
  const cl = await ownedCampaignLead(req.params.id, req.auth!.organizationId);
  if (!cl) return res.status(404).json({ error: "Callback not found." });
  if (cl.status !== "retry_scheduled") return res.status(409).json({ error: "This callback is no longer scheduled." });
  await pool.query("update campaign_leads set next_attempt_at = now() where id = $1", [cl.id]);
  if (cl.campaign_status === "active") await signalSlotFreed(cl.campaign_id);
  res.json({
    ok: true,
    message:
      cl.campaign_status === "active"
        ? "Queued — it dials on the next free line, inside the lead's calling hours."
        : "Moved to the front of the queue. Start or resume the campaign to dial it.",
  });
});

voiceInsightsRouter.post("/callbacks/:id/cancel", requirePermission("campaign.start"), async (req: AuthedRequest, res) => {
  const cl = await ownedCampaignLead(req.params.id, req.auth!.organizationId);
  if (!cl) return res.status(404).json({ error: "Callback not found." });
  await pool.query("update campaign_leads set status = 'done', next_attempt_at = null where id = $1 and status = 'retry_scheduled'", [cl.id]);
  res.json({ ok: true });
});

voiceInsightsRouter.get("/leads", async (req: AuthedRequest, res) => {
  const q = req.query as Record<string, string | undefined>;
  const conditions = ["l.organization_id = $1"];
  const params: unknown[] = [req.auth!.organizationId];
  const add = (sql: (n: number) => string, v: unknown) => {
    params.push(v);
    conditions.push(sql(params.length));
  };
  if (q.search) {
    const digits = q.search.replace(/\D/g, "");
    add(
      (n) =>
        `(l.business_name ilike $${n} or l.first_name ilike $${n} or l.last_name ilike $${n} or l.business_email ilike $${n}` +
        (digits.length >= 3 ? ` or l.main_phone_e164 like '%${digits}%'` : "") +
        ")",
      `%${q.search}%`
    );
  }
  if (q.callStatus) add((n) => `l.call_status = $${n}`, q.callStatus);
  if (q.customerType) add((n) => `l.customer_type = $${n}`, q.customerType);
  if (q.campaignId) add((n) => `exists (select 1 from campaign_leads cl where cl.lead_id = l.id and cl.campaign_id = $${n})`, q.campaignId);
  if (q.listId === "none") conditions.push("l.lead_list_id is null");
  else if (q.listId) add((n) => `l.lead_list_id = $${n}`, q.listId);
  if (q.called === "never") conditions.push("coalesce(l.attempts, 0) = 0");
  else if (q.called === "yes") conditions.push("coalesce(l.attempts, 0) > 0");
  if (q.dnc === "false") conditions.push("not l.is_dnc");
  if (q.dnc === "true") conditions.push("l.is_dnc");
  const page = Math.max(1, Number(q.page) || 1);
  const where = conditions.join(" and ");
  const [rows, count] = await Promise.all([
    pool.query(
      `select l.id, l.business_name, l.first_name, l.last_name, l.main_phone_e164, l.state, l.current_provider,
              l.customer_type, l.call_status, l.attempts, l.last_called_at, l.is_dnc, l.business_email, l.alt_phone,
              l.lead_list_id, ll.name as list_name, l.created_at,
              cd.label as status_label, cd.color as status_color
       from leads l left join call_dispositions cd on cd.organization_id = l.organization_id and cd.key = l.call_status
       left join lead_lists ll on ll.id = l.lead_list_id
       where ${where} order by l.last_called_at desc nulls last, l.created_at desc
       limit 50 offset $${params.length + 1}`,
      [...params, (page - 1) * 50]
    ),
    pool.query(`select count(*)::int as total from leads l where ${where}`, params),
  ]);
  res.json({ leads: rows.rows, total: count.rows[0].total, page, pageSize: 50 });
});

voiceInsightsRouter.get("/leads/:id", async (req: AuthedRequest, res) => {
  const lead = await pool.query("select * from leads where id = $1 and organization_id = $2", [req.params.id, req.auth!.organizationId]);
  if (!lead.rows[0]) return res.status(404).json({ error: "Lead not found." });
  const [calls, campaigns] = await Promise.all([
    pool.query(
      `select c.id, c.created_at, c.status, c.direction, c.talk_seconds, c.ended_reason, cmp.name as campaign_name,
              cd.key as disposition_key, cd.label as disposition_label, cd.color as disposition_color, t.summary
       from calls c left join campaigns cmp on cmp.id = c.campaign_id
       left join call_dispositions cd on cd.id = c.disposition_id
       left join call_transcripts t on t.call_id = c.id
       where c.lead_id = $1 order by c.created_at desc limit 100`,
      [req.params.id]
    ),
    pool.query(
      `select cl.id, cl.status, cl.attempts, cl.next_attempt_at, cl.last_disposition, cmp.id as campaign_id, cmp.name
       from campaign_leads cl join campaigns cmp on cmp.id = cl.campaign_id where cl.lead_id = $1`,
      [req.params.id]
    ),
  ]);
  res.json({ lead: lead.rows[0], calls: calls.rows, campaigns: campaigns.rows });
});

// --- Lead lists ---

voiceInsightsRouter.get("/lead-lists", async (req: AuthedRequest, res) => {
  const r = await pool.query(
    `select ll.id, ll.name, ll.description, ll.created_at, count(l.id)::int as lead_count,
            count(l.id) filter (where coalesce(l.attempts, 0) = 0 and not l.is_dnc)::int as never_called
     from lead_lists ll left join leads l on l.lead_list_id = ll.id
     where ll.organization_id = $1 group by ll.id order by ll.created_at desc`,
    [req.auth!.organizationId]
  );
  res.json({ lists: r.rows });
});

voiceInsightsRouter.post("/lead-lists", async (req: AuthedRequest, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(500).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Give the list a name." });
  const r = await pool.query(
    "insert into lead_lists (organization_id, name, description, created_by) values ($1,$2,$3,$4) returning *",
    [req.auth!.organizationId, parsed.data.name, parsed.data.description ?? null, req.auth!.userId]
  );
  res.status(201).json({ list: r.rows[0] });
});

voiceInsightsRouter.patch("/lead-lists/:id", async (req: AuthedRequest, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(500).nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Give the list a name." });
  const r = await pool.query(
    "update lead_lists set name = $3, description = coalesce($4, description) where id = $1 and organization_id = $2 returning *",
    [req.params.id, req.auth!.organizationId, parsed.data.name, parsed.data.description ?? null]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "List not found." });
  res.json({ list: r.rows[0] });
});

// Deleting a list keeps its leads (they become unlisted) unless asked to
// delete them too.
voiceInsightsRouter.delete("/lead-lists/:id", async (req: AuthedRequest, res) => {
  const org = req.auth!.organizationId;
  if (req.query.withLeads === "1") {
    await pool.query(
      `delete from leads where lead_list_id = $1 and organization_id = $2
         and not exists (select 1 from campaign_leads cl where cl.lead_id = leads.id and cl.status = 'dialing')`,
      [req.params.id, org]
    );
  }
  await pool.query("delete from lead_lists where id = $1 and organization_id = $2", [req.params.id, org]);
  res.status(204).end();
});

// --- Adding leads ---

// Paste numbers: one lead per line as "phone", "name, phone" or
// "first, last, phone[, business[, email]]". Every number is normalised to
// E.164 and each line reports what happened to it.
voiceInsightsRouter.post("/leads/paste", async (req: AuthedRequest, res) => {
  const parsed = z
    .object({ text: z.string().min(1).max(500_000), listId: z.string().uuid().nullable().optional(), campaignId: z.string().uuid().nullable().optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Paste at least one number." });
  const org = req.auth!.organizationId;
  const lines = parsed.data.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 10000);
  const results: Array<{ input: string; result: string | null; status: "added" | "invalid" | "duplicate" | "dnc"; reason?: string }> = [];
  const records: Record<string, string>[] = [];
  const seen = new Set<string>();
  const dnc = await pool.query<{ phone_e164: string }>("select phone_e164 from dnc_entries where organization_id = $1", [org]);
  const dncSet = new Set(dnc.rows.map((r) => r.phone_e164));
  for (const line of lines) {
    const parts = line.split(/\t|,|;|\|/).map((p) => p.trim()).filter(Boolean);
    const phoneIdx = parts.findIndex((p) => (p.match(/\d/g) ?? []).length >= 7 && !/@/.test(p));
    let phoneRaw = phoneIdx >= 0 ? parts[phoneIdx] : "";
    let nameParts = parts.filter((_, i) => i !== phoneIdx);
    // "Jane Doe 302-555-0100" on one line, no separators.
    if (phoneIdx < 0 || (parts.length === 1 && /[a-z]/i.test(parts[0]))) {
      const m = line.match(/(\+?[\d][\d\s().-]{6,}\d)/);
      if (m) {
        phoneRaw = m[1];
        nameParts = [line.replace(m[1], "").trim()].filter(Boolean);
      }
    }
    const e164 = phoneRaw ? normalizeE164(phoneRaw) : null;
    if (!e164) {
      results.push({ input: line, result: null, status: "invalid", reason: "Not a valid phone number" });
      continue;
    }
    if (seen.has(e164)) {
      results.push({ input: line, result: e164, status: "duplicate", reason: "Repeated in this paste" });
      continue;
    }
    seen.add(e164);
    const email = nameParts.find((p) => /@/.test(p));
    const names = nameParts.filter((p) => p !== email);
    let first = names[0] ?? "";
    let last = names.length >= 2 ? names[1] : "";
    if (names.length === 1 && /\s/.test(first)) [first, last] = [first.split(/\s+/)[0], first.split(/\s+/).slice(1).join(" ")];
    const business = names.length >= 3 ? names[2] : "";
    records.push({ first_name: first, last_name: last, phone: e164, business_name: business, email: email ?? "" });
    results.push({ input: line, result: e164, status: dncSet.has(e164) ? "dnc" : "added", reason: dncSet.has(e164) ? "On the Do Not Call list — added but won't be dialed" : undefined });
  }
  const summary = records.length
    ? await importLeads(org, records, { leadListId: parsed.data.listId ?? null, campaignId: parsed.data.campaignId ?? null, source: "paste" })
    : { imported: 0, duplicates: 0, dncMarked: 0, errors: [], totalErrors: 0 };
  res.json({ results, summary });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
voiceInsightsRouter.post("/leads/import", upload.single("file"), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a CSV or Excel file." });
  let rows;
  try {
    rows = await readRows(req.file.buffer, req.file.originalname);
  } catch (err) {
    return res.status(400).json({ error: `Couldn't read that file: ${(err as Error).message}` });
  }
  const listId = typeof req.body?.listId === "string" && req.body.listId ? req.body.listId : null;
  const campaignId = typeof req.body?.campaignId === "string" && req.body.campaignId ? req.body.campaignId : null;
  const summary = await importLeads(req.auth!.organizationId, rows, { leadListId: listId, campaignId, source: "file_import" });
  res.json({ summary });
});

voiceInsightsRouter.post("/leads", async (req: AuthedRequest, res) => {
  const parsed = z
    .object({
      firstName: z.string().trim().max(80).optional(),
      lastName: z.string().trim().max(80).optional(),
      businessName: z.string().trim().max(200).optional(),
      phone: z.string().min(4),
      email: z.string().email().optional().or(z.literal("")),
      listId: z.string().uuid().nullable().optional(),
      campaignId: z.string().uuid().nullable().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const d = parsed.data;
  if (!normalizeE164(d.phone)) return res.status(400).json({ error: "That phone number isn't valid." });
  const summary = await importLeads(
    req.auth!.organizationId,
    [{ first_name: d.firstName ?? "", last_name: d.lastName ?? "", business_name: d.businessName ?? "", phone: d.phone, email: d.email ?? "" }],
    { leadListId: d.listId ?? null, campaignId: d.campaignId ?? null, source: "manual" }
  );
  if (summary.duplicates) return res.status(409).json({ error: "That number is already in this list or campaign." });
  res.status(201).json({ summary });
});

// --- Bulk actions on selected leads ---

voiceInsightsRouter.post("/leads/bulk", async (req: AuthedRequest, res) => {
  const parsed = z
    .object({
      ids: z.array(z.string().uuid()).min(1).max(5000),
      action: z.enum(["delete", "move_to_list", "remove_from_list", "add_to_campaign", "remove_from_campaign", "dnc", "undnc", "retry"]),
      listId: z.string().uuid().optional(),
      campaignId: z.string().uuid().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const org = req.auth!.organizationId;
  const { ids, action, listId, campaignId } = parsed.data;
  const owned = await pool.query<{ id: string }>("select id from leads where id = any($1::uuid[]) and organization_id = $2", [ids, org]);
  const mine = owned.rows.map((r) => r.id);
  const needs = async (table: "lead_lists" | "campaigns", id: string | undefined) =>
    id && (await pool.query(`select 1 from ${table} where id = $1 and organization_id = $2`, [id, org])).rows.length > 0;
  let n = 0;
  switch (action) {
    case "delete": {
      const r = await pool.query(
        `delete from leads where id = any($1::uuid[])
           and not exists (select 1 from campaign_leads cl where cl.lead_id = leads.id and cl.status = 'dialing')`,
        [mine]
      );
      n = r.rowCount ?? 0;
      return res.json({ message: `Deleted ${n} lead(s).${n < mine.length ? ` ${mine.length - n} are on a live call and were kept.` : ""}` });
    }
    case "move_to_list": {
      if (!(await needs("lead_lists", listId))) return res.status(400).json({ error: "Choose a list." });
      n = (await pool.query("update leads set lead_list_id = $2, updated_at = now() where id = any($1::uuid[])", [mine, listId])).rowCount ?? 0;
      return res.json({ message: `Moved ${n} lead(s) to the list.` });
    }
    case "remove_from_list":
      n = (await pool.query("update leads set lead_list_id = null, updated_at = now() where id = any($1::uuid[])", [mine])).rowCount ?? 0;
      return res.json({ message: `Removed ${n} lead(s) from their list.` });
    case "add_to_campaign": {
      if (!(await needs("campaigns", campaignId))) return res.status(400).json({ error: "Choose a campaign." });
      n =
        (
          await pool.query(
            `insert into campaign_leads (campaign_id, lead_id)
             select $2, l.id from leads l where l.id = any($1::uuid[]) and not l.is_dnc and l.main_phone_e164 is not null
             on conflict do nothing`,
            [mine, campaignId]
          )
        ).rowCount ?? 0;
      await signalSlotFreed(campaignId!);
      return res.json({ message: `Added ${n} lead(s) to the campaign. DNC leads and leads without a phone were skipped.` });
    }
    case "remove_from_campaign": {
      if (!(await needs("campaigns", campaignId))) return res.status(400).json({ error: "Choose a campaign." });
      n =
        (await pool.query("delete from campaign_leads where campaign_id = $2 and lead_id = any($1::uuid[]) and status <> 'dialing'", [mine, campaignId]))
          .rowCount ?? 0;
      return res.json({ message: `Removed ${n} lead(s) from the campaign.` });
    }
    case "dnc": {
      await pool.query(
        `insert into dnc_entries (organization_id, phone_e164, reason)
         select $2, main_phone_e164, 'Marked from Leads' from leads where id = any($1::uuid[]) and main_phone_e164 is not null
         on conflict do nothing`,
        [mine, org]
      );
      n = (await pool.query("update leads set is_dnc = true, call_status = 'DNC' where id = any($1::uuid[])", [mine])).rowCount ?? 0;
      await pool.query("update campaign_leads set status = 'dnc' where lead_id = any($1::uuid[]) and status <> 'dialing'", [mine]);
      return res.json({ message: `Marked ${n} lead(s) Do Not Call.` });
    }
    case "undnc": {
      await pool.query(
        "delete from dnc_entries where organization_id = $2 and phone_e164 in (select main_phone_e164 from leads where id = any($1::uuid[]))",
        [mine, org]
      );
      n = (await pool.query("update leads set is_dnc = false, call_status = case when call_status = 'DNC' then 'NEW' else call_status end where id = any($1::uuid[])", [mine])).rowCount ?? 0;
      return res.json({ message: `Removed ${n} lead(s) from Do Not Call. Add them to a campaign to dial them again.` });
    }
    case "retry": {
      n =
        (
          await pool.query(
            `update campaign_leads cl set status = 'queued', next_attempt_at = null
             from leads l where l.id = cl.lead_id and cl.lead_id = any($1::uuid[]) and not l.is_dnc
               and cl.status in ('done','retry_scheduled','failed')`,
            [mine]
          )
        ).rowCount ?? 0;
      const camps = await pool.query("select distinct campaign_id from campaign_leads where lead_id = any($1::uuid[])", [mine]);
      for (const c of camps.rows) await signalSlotFreed(c.campaign_id);
      return res.json({ message: `Re-queued ${n} lead(s) in their campaigns.` });
    }
  }
});
