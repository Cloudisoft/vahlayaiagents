import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get("/", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select * from notifications where organization_id = $1 order by created_at desc limit 50`,
    [req.auth!.organizationId]
  );
  const unread = await pool.query(
    `select count(*) from notifications where organization_id = $1 and read_at is null`,
    [req.auth!.organizationId]
  );
  res.json({ notifications: result.rows, unreadCount: Number(unread.rows[0].count) });
});

notificationsRouter.post("/:id/read", async (req: AuthedRequest, res) => {
  await pool.query("update notifications set read_at = now() where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  res.status(204).end();
});

notificationsRouter.post("/read-all", async (req: AuthedRequest, res) => {
  await pool.query("update notifications set read_at = now() where organization_id = $1 and read_at is null", [
    req.auth!.organizationId,
  ]);
  res.status(204).end();
});
