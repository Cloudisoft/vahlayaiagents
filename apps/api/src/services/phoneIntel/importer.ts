import crypto from "node:crypto";
import { parse } from "csv-parse/sync";
import { pool } from "../../db/pool.js";
import { normalizeE164 } from "../../utils/phone.js";
import { lineTypeFromHistorical, normalizeCarrier, npaNxx } from "./normalize.js";
import { rebuildAll } from "./recompute.js";

const BATCH = 5000;

export class AlreadyImportedError extends Error {}

// Imports a historical lookup file (PHONE, IS_WIRELESS, CARRIER_NAME, TYPE,
// QUERIED_AT…) as evidence. Idempotent: the same file (by SHA-256) is never
// imported twice, and each (number, date, source) observation is stored once.
// Returns at once; the import finishes in the background.
export async function startHistoricalImport(params: { buffer: Buffer; fileName: string; userId: string | null }) {
  const sha256 = crypto.createHash("sha256").update(params.buffer).digest("hex");
  const existing = await pool.query("select id, status from intel_imports where sha256 = $1", [sha256]);
  if (existing.rows[0] && existing.rows[0].status !== "failed") throw new AlreadyImportedError("This file has already been imported.");
  if (existing.rows[0]) await pool.query("delete from intel_imports where id = $1", [existing.rows[0].id]);
  const ins = await pool.query<{ id: string }>(
    "insert into intel_imports (file_name, sha256, created_by) values ($1, $2, $3) returning id",
    [params.fileName, sha256, params.userId]
  );
  const importId = ins.rows[0].id;
  runImport(importId, params.buffer).catch(async (err) => {
    await pool.query("update intel_imports set status = 'failed', error = $2, finished_at = now() where id = $1", [importId, (err as Error).message.slice(0, 1000)]);
  });
  return importId;
}

function pick(row: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

async function runImport(importId: string, buffer: Buffer) {
  const rows = parse(buffer, {
    columns: (h: string[]) => h.map((x) => x.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")),
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  }) as Record<string, string>[];

  let invalid = 0;
  let minAt: Date | null = null;
  let maxAt: Date | null = null;
  const seen = new Set<string>();
  let duplicates = 0;
  const obs: Array<[string, string | null, string | null, string, string | null, string | null, string]> = [];
  for (const row of rows) {
    const e164 = normalizeE164(pick(row, "phone", "phone_number", "number", "phone_e164"));
    const at = new Date(pick(row, "queried_at", "observed_at", "checked_at", "date", "created_at").replace(" ", "T") + (/[zZ+]/.test(pick(row, "queried_at")) ? "" : "Z"));
    if (!e164 || Number.isNaN(at.getTime())) {
      invalid++;
      continue;
    }
    const key = `${e164}|${at.toISOString()}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    const pn = npaNxx(e164);
    const raw = pick(row, "carrier_name", "carrier");
    obs.push([
      e164,
      pn?.npa ?? null,
      pn?.nxx ?? null,
      lineTypeFromHistorical(pick(row, "type", "line_type"), pick(row, "is_wireless")),
      normalizeCarrier(raw),
      raw || null,
      at.toISOString(),
    ]);
    if (!minAt || at < minAt) minAt = at;
    if (!maxAt || at > maxAt) maxAt = at;
  }

  let inserted = 0;
  for (let i = 0; i < obs.length; i += BATCH) {
    const chunk = obs.slice(i, i + BATCH);
    const r = await pool.query(
      `insert into phone_observations (phone_e164, npa, nxx, line_type, carrier, carrier_raw, observed_at, source, import_id)
       select p, n, x, t, c, cr, a::timestamptz, 'historical', $8
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) as u(p, n, x, t, c, cr, a)
       on conflict (phone_e164, observed_at, source) do nothing`,
      [
        chunk.map((o) => o[0]),
        chunk.map((o) => o[1]),
        chunk.map((o) => o[2]),
        chunk.map((o) => o[3]),
        chunk.map((o) => o[4]),
        chunk.map((o) => o[5]),
        chunk.map((o) => o[6]),
        importId,
      ]
    );
    inserted += r.rowCount ?? 0;
    await pool.query("update intel_imports set rows_valid = $2 where id = $1", [importId, i + chunk.length]);
  }

  await pool.query(
    `update intel_imports set rows_total = $2, rows_valid = $3, rows_invalid = $4, duplicates = $5,
       phones = $6, observed_from = $7, observed_to = $8 where id = $1`,
    [importId, rows.length, obs.length, invalid, duplicates + (obs.length - inserted), new Set(obs.map((o) => o[0])).size, minAt, maxAt]
  );
  await rebuildAll();
  await pool.query("update intel_imports set status = 'completed', finished_at = now() where id = $1", [importId]);
}
