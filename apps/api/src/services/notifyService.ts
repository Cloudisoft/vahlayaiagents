import { pool } from "../db/pool.js";
import { publishEvent } from "./events.js";

// One place to raise an in-app notification: stored for the bell's list
// and pushed live so open tabs update without polling.
export async function notify(
  organizationId: string,
  n: { type: string; title: string; body?: string | null; link?: string | null; userId?: string | null }
): Promise<void> {
  const r = await pool.query<{ id: string; created_at: string }>(
    `insert into notifications (organization_id, user_id, type, title, body, metadata) values ($1,$2,$3,$4,$5,$6)
     returning id, created_at`,
    [organizationId, n.userId ?? null, n.type, n.title, n.body ?? null, JSON.stringify(n.link ? { link: n.link } : {})]
  );
  await publishEvent(organizationId, {
    type: "notification",
    notification: { id: r.rows[0].id, type: n.type, title: n.title, body: n.body ?? null, link: n.link ?? null, created_at: r.rows[0].created_at },
  }).catch(() => undefined);
}
