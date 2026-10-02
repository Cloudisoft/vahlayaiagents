import { Router } from "express";
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
  if (q.dnc === "true") conditions.push("l.is_dnc");
  const page = Math.max(1, Number(q.page) || 1);
  const where = conditions.join(" and ");
  const [rows, count] = await Promise.all([
    pool.query(
      `select l.id, l.business_name, l.first_name, l.last_name, l.main_phone_e164, l.state, l.current_provider,
              l.customer_type, l.call_status, l.attempts, l.last_called_at, l.is_dnc, l.business_email,
              cd.label as status_label, cd.color as status_color
       from leads l left join call_dispositions cd on cd.organization_id = l.organization_id and cd.key = l.call_status
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
