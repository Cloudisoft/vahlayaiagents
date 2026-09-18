import { pool } from "../db/pool.js";
import { decryptSecret } from "../utils/crypto.js";

// Resolves a provider's credentials for an org: an org-level override saved
// via Settings takes priority; otherwise falls back to server env vars.
// Returns null if neither is configured — callers must handle that as a
// real "not configured" state, never fall back to fake data.
export async function getOrgCredential(
  organizationId: string,
  provider: string
): Promise<Record<string, string> | null> {
  const result = await pool.query<{ encrypted_value: string }>(
    "select encrypted_value from api_credentials where organization_id = $1 and provider = $2 and is_active = true",
    [organizationId, provider]
  );
  if (result.rows.length === 0) return null;
  try {
    return JSON.parse(decryptSecret(result.rows[0].encrypted_value));
  } catch {
    return null;
  }
}
