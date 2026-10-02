import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { requireTab } from "../services/accessService.js";
import { requireRole } from "../middleware/rbac.js";
import { getTelephonyProvider } from "../telephony/index.js";
import { TwilioProvider } from "../telephony/TwilioProvider.js";
import { normalizeUsE164 } from "../utils/phone.js";
import {
  importTwilioNumberToVapi,
  listVapiPhoneNumbers,
  pointVapiNumberAtServer,
  updateVapiPhoneNumber,
} from "../voiceai/vapiClient.js";

export const phoneNumbersRouter = Router();
phoneNumbersRouter.use(requireAuth);
phoneNumbersRouter.use(requireModuleAccess("voice_agents"));
phoneNumbersRouter.use(requireTab("voice_agents", "numbers", { readVia: ["campaigns"] }));
phoneNumbersRouter.use(requireRole("agent_manager"));

phoneNumbersRouter.get("/", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select p.*, a.name as agent_name, c.name as campaign_name
     from phone_numbers p
     left join ai_agents a on a.id = p.assigned_agent_id
     left join campaigns c on c.id = p.assigned_campaign_id
     where p.organization_id = $1 order by p.created_at desc`,
    [req.auth!.organizationId]
  );
  res.json({ phoneNumbers: result.rows });
});

phoneNumbersRouter.post("/sync", async (req: AuthedRequest, res) => {
  const provider = (req.body.provider as string) || "plivo";
  try {
    const telephony = await getTelephonyProvider(req.auth!.organizationId, provider);
    const numbers = await telephony.getPhoneNumbers();
    let synced = 0;
    for (const n of numbers) {
      await pool.query(
        `insert into phone_numbers (organization_id, provider, phone_e164, status)
         values ($1,$2,$3,'active')
         on conflict (organization_id, phone_e164) do update set provider = excluded.provider`,
        [req.auth!.organizationId, provider, n.number]
      );
      synced++;
    }
    res.json({ message: `Synced ${synced} numbers from ${provider}.` });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

const assignSchema = z.object({
  assignedAgentId: z.string().uuid().nullable().optional(),
  assignedCampaignId: z.string().uuid().nullable().optional(),
  transferNumber: z.string().nullable().optional(),
});

phoneNumbersRouter.patch("/:id", async (req: AuthedRequest, res) => {
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const d = parsed.data;
  const result = await pool.query(
    `update phone_numbers set
       assigned_agent_id = coalesce($1, assigned_agent_id),
       assigned_campaign_id = coalesce($2, assigned_campaign_id),
       transfer_number = coalesce($3, transfer_number)
     where id = $4 and organization_id = $5 returning *`,
    [d.assignedAgentId ?? null, d.assignedCampaignId ?? null, d.transferNumber ?? null, req.params.id, req.auth!.organizationId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Phone number not found." });
  res.json({ phoneNumber: result.rows[0] });
});

function areaCodeOf(e164: string): string | null {
  return e164.startsWith("+1") && e164.length === 12 ? e164.slice(2, 5) : null;
}

async function twilioFor(organizationId: string): Promise<TwilioProvider> {
  return (await getTelephonyProvider(organizationId, "twilio")) as TwilioProvider;
}

async function connectToVapi(organizationId: string, row: { id: string; phone_e164: string }) {
  const twilio = await twilioFor(organizationId);
  const { accountSid, authToken } = twilio.credentials;
  const vapi = await importTwilioNumberToVapi({
    organizationId,
    number: row.phone_e164,
    twilioAccountSid: accountSid,
    twilioAuthToken: authToken,
    name: `Vahlay ${row.phone_e164}`,
  });
  await pool.query("update phone_numbers set vapi_phone_number_id = $1 where id = $2", [vapi.id, row.id]);
  return vapi.id;
}

// Search Twilio inventory (playbook §7: buy local numbers per area code).
phoneNumbersRouter.get("/available", async (req: AuthedRequest, res) => {
  try {
    const twilio = await twilioFor(req.auth!.organizationId);
    const numbers = await twilio.searchAvailableNumbers({
      areaCode: typeof req.query.areaCode === "string" ? req.query.areaCode : undefined,
      state: typeof req.query.state === "string" ? req.query.state : undefined,
      contains: typeof req.query.contains === "string" ? req.query.contains : undefined,
    });
    res.json({ numbers });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Buy on Twilio, then register with VAPI so campaigns can dial from it.
phoneNumbersRouter.post("/buy", async (req: AuthedRequest, res) => {
  const parsed = z.object({ phoneNumber: z.string().min(4) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const org = req.auth!.organizationId;
  let row;
  try {
    const twilio = await twilioFor(org);
    const bought = await twilio.buyNumber(parsed.data.phoneNumber);
    const ins = await pool.query(
      `insert into phone_numbers (organization_id, provider, provider_number_id, phone_e164, country, status, area_code)
       values ($1,'twilio',$2,$3,'US','active',$4)
       on conflict (organization_id, phone_e164) do update set provider_number_id = excluded.provider_number_id
       returning *`,
      [org, bought.sid, bought.number, areaCodeOf(bought.number)]
    );
    row = ins.rows[0];
  } catch (err) {
    return res.status(502).json({ error: `Twilio purchase failed: ${(err as Error).message}` });
  }
  try {
    await connectToVapi(org, row);
  } catch (err) {
    return res.status(207).json({
      phoneNumber: row,
      warning: `Number bought on Twilio but not yet connected to VAPI: ${(err as Error).message}`,
    });
  }
  const result = await pool.query("select * from phone_numbers where id = $1", [row.id]);
  res.status(201).json({ phoneNumber: result.rows[0] });
});

// Connect an already-owned Twilio number to VAPI.
phoneNumbersRouter.post("/:id/connect-vapi", async (req: AuthedRequest, res) => {
  const r = await pool.query("select * from phone_numbers where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: "Phone number not found." });
  if (row.provider !== "twilio") return res.status(400).json({ error: "Only Twilio numbers can be connected to VAPI here." });
  if (row.vapi_phone_number_id) return res.json({ vapiPhoneNumberId: row.vapi_phone_number_id });
  try {
    res.json({ vapiPhoneNumberId: await connectToVapi(req.auth!.organizationId, row) });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Pull every number already in the VAPI account and link it locally.
phoneNumbersRouter.post("/sync-vapi", async (req: AuthedRequest, res) => {
  const org = req.auth!.organizationId;
  try {
    const numbers = await listVapiPhoneNumbers(org);
    let linked = 0;
    const skipped: string[] = [];
    for (const n of numbers) {
      const e164 = n.number ? normalizeUsE164(n.number) : null;
      if (!e164) {
        skipped.push(n.name || n.id);
        continue;
      }
      await pool.query(
        `insert into phone_numbers (organization_id, provider, phone_e164, country, status, area_code, vapi_phone_number_id)
         values ($1,$2,$3,'US','active',$4,$5)
         on conflict (organization_id, phone_e164) do update set vapi_phone_number_id = excluded.vapi_phone_number_id`,
        [org, n.provider === "vapi" ? "vapi" : "twilio", e164, areaCodeOf(e164), n.id]
      );
      linked++;
    }
    res.json({
      message:
        `Linked ${linked} number(s) from VAPI. Their inbound settings in VAPI were not changed.` +
        (skipped.length ? ` Skipped ${skipped.length} without a US number.` : ""),
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Opt-in: send this number's inbound calls (people calling back) to the
// campaign agent here. Replaces whatever the number does in VAPI today.
phoneNumbersRouter.post("/:id/route-inbound", async (req: AuthedRequest, res) => {
  const r = await pool.query("select * from phone_numbers where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: "Phone number not found." });
  if (!row.vapi_phone_number_id) return res.status(400).json({ error: "This number isn't connected to VAPI." });
  try {
    await pointVapiNumberAtServer(req.auth!.organizationId, row.vapi_phone_number_id);
    await pool.query("update phone_numbers set inbound_route = $2, inbound_enabled = true where id = $1", [row.id, JSON.stringify({ mode: "campaign_agent", since: new Date().toISOString() })]);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Inbound routing: turn AI answering on for a number and pick the campaign
// whose published agent, SOP, knowledge base and transfer lines answer it.
// On points the VAPI number's webhook here (VAPI then asks us for the
// assistant on every call); off detaches it again.
phoneNumbersRouter.put("/:id/inbound", async (req: AuthedRequest, res) => {
  const parsed = z.object({ enabled: z.boolean(), campaignId: z.string().uuid().nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const org = req.auth!.organizationId;
  const r = await pool.query("select * from phone_numbers where id = $1 and organization_id = $2", [req.params.id, org]);
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: "Phone number not found." });
  if (!row.vapi_phone_number_id) return res.status(400).json({ error: "Connect this number to VAPI first." });
  const campaignId = parsed.data.campaignId ?? row.assigned_campaign_id;
  if (parsed.data.enabled) {
    if (!campaignId) return res.status(400).json({ error: "Choose the campaign that answers this number." });
    const c = await pool.query("select published_version_id from campaigns where id = $1 and organization_id = $2", [campaignId, org]);
    if (!c.rows[0]) return res.status(400).json({ error: "Campaign not found." });
    if (!c.rows[0].published_version_id) return res.status(400).json({ error: "Save that campaign first so it has a live version to answer with." });
  }
  try {
    if (parsed.data.enabled) await pointVapiNumberAtServer(org, row.vapi_phone_number_id);
    else await updateVapiPhoneNumber(org, row.vapi_phone_number_id, { server: null });
  } catch (err) {
    return res.status(502).json({ error: (err as Error).message });
  }
  const updated = await pool.query(
    `update phone_numbers set inbound_enabled = $2, assigned_campaign_id = $3, inbound_route = $4 where id = $1 returning *`,
    [
      row.id,
      parsed.data.enabled,
      campaignId ?? null,
      JSON.stringify(parsed.data.enabled ? { mode: "campaign_agent", since: new Date().toISOString() } : {}),
    ]
  );
  res.json({ phoneNumber: updated.rows[0] });
});

// Removes the number from this app only — Twilio and VAPI are not touched.
phoneNumbersRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const live = await pool.query(
    "select 1 from calls where phone_number_id = $1 and status in ('queued','ringing','answered') limit 1",
    [req.params.id]
  );
  if (live.rows.length) return res.status(409).json({ error: "This number has a call in progress." });
  await pool.query("delete from phone_numbers where id = $1 and organization_id = $2", [req.params.id, req.auth!.organizationId]);
  res.status(204).end();
});
