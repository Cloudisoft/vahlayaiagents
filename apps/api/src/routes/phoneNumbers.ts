import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { requireRole } from "../middleware/rbac.js";
import { getTelephonyProvider } from "../telephony/index.js";

export const phoneNumbersRouter = Router();
phoneNumbersRouter.use(requireAuth);
phoneNumbersRouter.use(requireModuleAccess("voice_agents"));
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
