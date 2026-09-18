import { pool } from "../db/pool.js";

const DEFAULT_DISPOSITIONS = [
  "interested",
  "not_interested",
  "callback",
  "appointment_booked",
  "transferred",
  "no_answer",
  "voicemail",
  "wrong_number",
  "do_not_call",
  "qualified",
  "disqualified",
];

export async function ensureDefaultDispositions(organizationId: string): Promise<void> {
  for (const key of DEFAULT_DISPOSITIONS) {
    await pool.query(
      `insert into call_dispositions (organization_id, key, label, is_custom)
       values ($1, $2, $3, false)
       on conflict (organization_id, key) do nothing`,
      [organizationId, key, key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())]
    );
  }
}
