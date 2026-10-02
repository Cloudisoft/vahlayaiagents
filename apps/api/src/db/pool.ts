import pg from "pg";
import { env } from "../config/env.js";
import { pgConfig } from "./config.js";

export const pool = new pg.Pool({
  ...pgConfig(env.databaseUrl),
  max: env.databasePoolMax,
  idleTimeoutMillis: 30_000,
  keepAlive: true,
});

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
