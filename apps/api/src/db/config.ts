import type pg from "pg";
import { env } from "../config/env.js";

let warned = false;

// Supabase (and most hosted Postgres) require TLS. With DATABASE_CA_CERT the
// server certificate is verified; without it the connection is still
// encrypted but unverified, and we say so once at startup.
export function pgConfig(connectionString: string): pg.ClientConfig {
  const url = new URL(connectionString);
  const wantsTls = /supabase\.(co|com)$/.test(url.hostname) || ["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") ?? "");
  url.searchParams.delete("sslmode");
  if (!wantsTls) return { connectionString };
  if (env.databaseCaCert) {
    return { connectionString: url.toString(), ssl: { ca: env.databaseCaCert.replace(/\\n/g, "\n"), rejectUnauthorized: true } };
  }
  if (!warned) {
    warned = true;
    console.warn("[db] TLS without certificate verification — set DATABASE_CA_CERT to verify the database server.");
  }
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: false } };
}
