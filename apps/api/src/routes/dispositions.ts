import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { ensureDefaultDispositions } from "../services/dispositionsService.js";
import { requirePermission } from "../middleware/permissions.js";

const COLORS = ["red", "amber", "green", "blue", "slate", "purple", "teal"] as const;

export const dispositionsRouter = Router();
dispositionsRouter.use(requireAuth);
dispositionsRouter.use(requireModuleAccess("voice_agents"));

dispositionsRouter.get("/", async (req: AuthedRequest, res) => {
  await ensureDefaultDispositions(req.auth!.organizationId);
  const result = await pool.query("select * from call_dispositions where organization_id = $1 order by is_custom, label", [
    req.auth!.organizationId,
  ]);
  res.json({ dispositions: result.rows });
});

dispositionsRouter.post("/", requirePermission("calls.disposition"), async (req: AuthedRequest, res) => {
  const parsed = z
    .object({ label: z.string().min(1).max(60), color: z.enum(COLORS).optional(), retryable: z.boolean().optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const key = parsed.data.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/(^_|_$)/g, "");
  const result = await pool.query(
    `insert into call_dispositions (organization_id, key, label, is_custom, color, retryable) values ($1,$2,$3,true,$4,$5)
     on conflict (organization_id, key) do nothing returning *`,
    [req.auth!.organizationId, key, parsed.data.label, parsed.data.color ?? "slate", parsed.data.retryable ?? false]
  );
  if (!result.rows[0]) return res.status(409).json({ error: "A disposition with that name already exists." });
  res.status(201).json({ disposition: result.rows[0] });
});

dispositionsRouter.patch("/:id", requirePermission("calls.disposition"), async (req: AuthedRequest, res) => {
  const parsed = z
    .object({ label: z.string().min(1).max(60).optional(), color: z.enum(COLORS).optional(), retryable: z.boolean().optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const d = parsed.data;
  // Built-in labels and retry rules drive the engine; only custom ones are fully editable.
  const result = await pool.query(
    `update call_dispositions set
       label = case when is_custom then coalesce($1, label) else label end,
       color = coalesce($2, color),
       retryable = case when is_custom then coalesce($3, retryable) else retryable end
     where id = $4 and organization_id = $5 returning *`,
    [d.label ?? null, d.color ?? null, d.retryable ?? null, req.params.id, req.auth!.organizationId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Disposition not found." });
  res.json({ disposition: result.rows[0] });
});

dispositionsRouter.delete("/:id", requirePermission("calls.disposition"), async (req: AuthedRequest, res) => {
  await pool.query("delete from call_dispositions where id = $1 and organization_id = $2 and is_custom = true", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  res.status(204).end();
});
