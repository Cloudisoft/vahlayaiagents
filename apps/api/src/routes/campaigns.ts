import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { requireRole } from "../middleware/rbac.js";
import { normalizeLeadPhone } from "../leadgen/enrichment.js";

export const campaignsRouter = Router();
campaignsRouter.use(requireAuth);
campaignsRouter.use(requireModuleAccess("voice_agents"));
campaignsRouter.use(requireRole("agent_manager"));

const campaignSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  aiAgentId: z.string().uuid().nullable().optional(),
  voiceId: z.string().uuid().nullable().optional(),
  phoneNumberId: z.string().uuid().nullable().optional(),
  leadListId: z.string().uuid().nullable().optional(),
  transferNumber: z.string().nullable().optional(),
  concurrency: z.number().min(1).max(50).optional(),
  maxAttempts: z.number().min(1).max(10).optional(),
  callingHours: z.record(z.any()).optional(),
  timeZone: z.string().optional(),
  maxCallDurationSeconds: z.number().optional(),
});

campaignsRouter.get("/", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select c.*,
       (select count(*) from campaign_leads where campaign_id = c.id) as total_leads,
       (select count(*) from campaign_leads where campaign_id = c.id and status = 'called') as leads_called,
       (select count(*) from campaign_leads where campaign_id = c.id and status = 'queued') as leads_remaining,
       (select count(*) from calls where campaign_id = c.id and status = 'answered') as connected_calls,
       (select count(*) from calls where campaign_id = c.id and status = 'failed') as failed_calls,
       (select count(*) from calls ca join call_dispositions cd on cd.id = ca.disposition_id
          where ca.campaign_id = c.id and cd.key = 'interested') as interested_leads,
       (select count(*) from calls ca join call_dispositions cd on cd.id = ca.disposition_id
          where ca.campaign_id = c.id and cd.key = 'appointment_booked') as appointments,
       (select count(*) from call_transfers ct join calls ca on ca.id = ct.call_id where ca.campaign_id = c.id) as transfers,
       (select avg(duration_seconds) from calls where campaign_id = c.id and duration_seconds is not null) as avg_duration
     from campaigns c where c.organization_id = $1 order by c.created_at desc`,
    [req.auth!.organizationId]
  );
  res.json({ campaigns: result.rows });
});

campaignsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const result = await pool.query("select * from campaigns where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  if (result.rows.length === 0) return res.status(404).json({ error: "Campaign not found." });
  const leads = await pool.query(
    `select cl.*, l.business_name, l.main_phone_e164 from campaign_leads cl
     join leads l on l.id = cl.lead_id where cl.campaign_id = $1 order by cl.created_at desc limit 100`,
    [req.params.id]
  );
  res.json({ campaign: result.rows[0], leads: leads.rows });
});

campaignsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = campaignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const d = parsed.data;
  const result = await pool.query(
    `insert into campaigns (organization_id, name, description, ai_agent_id, voice_id, phone_number_id, lead_list_id,
       transfer_number, concurrency, max_attempts, calling_hours, time_zone, max_call_duration_seconds, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [
      req.auth!.organizationId,
      d.name,
      d.description ?? null,
      d.aiAgentId ?? null,
      d.voiceId ?? null,
      d.phoneNumberId ?? null,
      d.leadListId ?? null,
      d.transferNumber ?? null,
      d.concurrency ?? 1,
      d.maxAttempts ?? 3,
      JSON.stringify(d.callingHours ?? {}),
      d.timeZone ?? "America/New_York",
      d.maxCallDurationSeconds ?? 600,
      req.auth!.userId,
    ]
  );
  const campaign = result.rows[0];

  if (d.leadListId) {
    await pool.query(
      `insert into campaign_leads (campaign_id, lead_id)
       select $1, id from leads where lead_list_id = $2 and organization_id = $3
       on conflict (campaign_id, lead_id) do nothing`,
      [campaign.id, d.leadListId, req.auth!.organizationId]
    );
  }

  res.status(201).json({ campaign });
});

campaignsRouter.patch("/:id", async (req: AuthedRequest, res) => {
  const parsed = campaignSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const existing = await pool.query("select id from campaigns where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  if (existing.rows.length === 0) return res.status(404).json({ error: "Campaign not found." });
  const d = parsed.data;
  const result = await pool.query(
    `update campaigns set
       name = coalesce($1, name), description = coalesce($2, description), ai_agent_id = coalesce($3, ai_agent_id),
       voice_id = coalesce($4, voice_id), phone_number_id = coalesce($5, phone_number_id),
       lead_list_id = coalesce($6, lead_list_id), transfer_number = coalesce($7, transfer_number),
       concurrency = coalesce($8, concurrency), max_attempts = coalesce($9, max_attempts),
       calling_hours = coalesce($10, calling_hours), time_zone = coalesce($11, time_zone),
       max_call_duration_seconds = coalesce($12, max_call_duration_seconds), updated_at = now()
     where id = $13 returning *`,
    [
      d.name ?? null,
      d.description ?? null,
      d.aiAgentId ?? null,
      d.voiceId ?? null,
      d.phoneNumberId ?? null,
      d.leadListId ?? null,
      d.transferNumber ?? null,
      d.concurrency ?? null,
      d.maxAttempts ?? null,
      d.callingHours ? JSON.stringify(d.callingHours) : null,
      d.timeZone ?? null,
      d.maxCallDurationSeconds ?? null,
      req.params.id,
    ]
  );
  res.json({ campaign: result.rows[0] });
});

campaignsRouter.post("/:id/status", async (req: AuthedRequest, res) => {
  const parsed = z.object({ status: z.enum(["draft", "active", "paused", "completed"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const result = await pool.query(
    "update campaigns set status = $1, updated_at = now() where id = $2 and organization_id = $3 returning *",
    [parsed.data.status, req.params.id, req.auth!.organizationId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Campaign not found." });
  res.json({ campaign: result.rows[0] });
});

// Add leads from a LeadGen list (or explicit lead IDs) into a campaign's queue.
campaignsRouter.post("/:id/leads", async (req: AuthedRequest, res) => {
  const parsed = z
    .object({ leadListId: z.string().uuid().optional(), leadIds: z.array(z.string().uuid()).optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const campaign = await pool.query("select id from campaigns where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  if (campaign.rows.length === 0) return res.status(404).json({ error: "Campaign not found." });

  let added = 0;
  if (parsed.data.leadListId) {
    const result = await pool.query(
      `insert into campaign_leads (campaign_id, lead_id)
       select $1, id from leads where lead_list_id = $2 and organization_id = $3
       on conflict (campaign_id, lead_id) do nothing returning id`,
      [req.params.id, parsed.data.leadListId, req.auth!.organizationId]
    );
    added = result.rowCount ?? 0;
  } else if (parsed.data.leadIds) {
    const result = await pool.query(
      `insert into campaign_leads (campaign_id, lead_id)
       select $1, id from leads where id = any($2) and organization_id = $3
       on conflict (campaign_id, lead_id) do nothing returning id`,
      [req.params.id, parsed.data.leadIds, req.auth!.organizationId]
    );
    added = result.rowCount ?? 0;
  }
  res.json({ added });
});

const singleLeadSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(4),
  email: z.string().optional(),
  company: z.string().optional(),
  notes: z.string().optional(),
});

// Single-lead add directly to a campaign (spec §35).
campaignsRouter.post("/:id/leads/single", async (req: AuthedRequest, res) => {
  const parsed = singleLeadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const d = parsed.data;
  const phoneE164 = normalizeLeadPhone(d.phone);
  if (!phoneE164) return res.status(400).json({ error: "Not a valid US phone number." });

  const campaign = await pool.query("select id from campaigns where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  if (campaign.rows.length === 0) return res.status(404).json({ error: "Campaign not found." });

  const lead = await pool.query(
    `insert into leads (organization_id, business_name, main_phone, main_phone_e164, business_email, source)
     values ($1,$2,$3,$4,$5,'manual') returning id`,
    [req.auth!.organizationId, d.company ?? d.name, d.phone, phoneE164, d.email ?? null]
  );
  await pool.query("insert into campaign_leads (campaign_id, lead_id) values ($1,$2) on conflict do nothing", [
    req.params.id,
    lead.rows[0].id,
  ]);
  res.status(201).json({ leadId: lead.rows[0].id });
});
