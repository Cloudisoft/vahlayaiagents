import { pool } from "../db/pool.js";

const OPT_OUT_PATTERNS = [
  /\bstop\b/i,
  /\bdo not call\b/i,
  /\bdon'?t call\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bunsubscribe\b/i,
];

export async function isOnDncList(organizationId: string, phoneE164: string): Promise<boolean> {
  const result = await pool.query("select 1 from dnc_entries where organization_id = $1 and phone_e164 = $2", [
    organizationId,
    phoneE164,
  ]);
  return result.rows.length > 0;
}

export async function addToDnc(organizationId: string, phoneE164: string, reason: string): Promise<void> {
  await pool.query(
    `insert into dnc_entries (organization_id, phone_e164, reason) values ($1,$2,$3)
     on conflict (organization_id, phone_e164) do nothing`,
    [organizationId, phoneE164, reason]
  );
}

// Detects an opt-out request in a candidate's spoken response and, if
// found, immediately suppresses that number (spec §50: immediate DNC
// suppression). This is a keyword check, not an AI judgment call — a false
// negative here should never happen from over-cleverness.
export function detectsOptOut(text: string): boolean {
  return OPT_OUT_PATTERNS.some((p) => p.test(text));
}
