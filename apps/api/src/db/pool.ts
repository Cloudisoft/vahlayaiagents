import pg from "pg";
import { env } from "../config/env.js";
import { pgConfig } from "./config.js";

export const pool = new pg.Pool({
  ...pgConfig(env.databaseUrl),
  max: env.databasePoolMax,
  // Keep connections warm: a fresh TLS connection to the Supabase pooler
  // costs ~100 ms, which users feel on the first click after a quiet spell.
  idleTimeoutMillis: 10 * 60_000,
  keepAlive: true,
});

// An idle client dropped by the pooler must not crash the process.
pool.on("error", (err) => console.error("[db] idle client error:", err.message));

// Open a few connections at boot so the first page load doesn't pay for them.
export async function warmPool(count = 3) {
  const clients = await Promise.all(Array.from({ length: count }, () => pool.connect().catch(() => null)));
  for (const c of clients) c?.release();
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as any[]);
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
