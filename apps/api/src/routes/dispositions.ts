import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { ensureDefaultDispositions } from "../services/dispositionsService.js";

export const dispositionsRouter = Router();
dispositionsRouter.use(requireAuth);

dispositionsRouter.get("/", async (req: AuthedRequest, res) => {
  await ensureDefaultDispositions(req.auth!.organizationId);
  const result = await pool.query("select * from call_dispositions where organization_id = $1 order by is_custom, label", [
    req.auth!.organizationId,
  ]);
  res.json({ dispositions: result.rows });
});

dispositionsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = z.object({ label: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const key = parsed.data.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/(^_|_$)/g, "");
  const result = await pool.query(
    `insert into call_dispositions (organization_id, key, label, is_custom) values ($1,$2,$3,true)
     on conflict (organization_id, key) do update set label = excluded.label returning *`,
    [req.auth!.organizationId, key, parsed.data.label]
  );
  res.status(201).json({ disposition: result.rows[0] });
});

dispositionsRouter.delete("/:id", async (req: AuthedRequest, res) => {
  await pool.query("delete from call_dispositions where id = $1 and organization_id = $2 and is_custom = true", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  res.status(204).end();
});
