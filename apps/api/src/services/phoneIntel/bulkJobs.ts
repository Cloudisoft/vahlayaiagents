import { pool } from "../../db/pool.js";
import { resolveBulk } from "./engine.js";
import { toLookupResult, recordLookup } from "../coverageService.js";
import { notify } from "../notifyService.js";

export const MAX_BULK = 20000;

export async function createBulkJob(organizationId: string, userId: string, fileName: string, phones: string[]) {
  const r = await pool.query<{ id: string }>(
    "insert into coverage_bulk_jobs (organization_id, requested_by, file_name, phones, total) values ($1,$2,$3,$4,$5) returning id",
    [organizationId, userId, fileName, phones.slice(0, MAX_BULK), Math.min(phones.length, MAX_BULK)]
  );
  return r.rows[0].id;
}

type ResolvedRows = Awaited<ReturnType<typeof resolveBulk>>["rows"];

export async function saveBulkResults(jobId: string, rows: ResolvedRows) {
  const BATCH = 2000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const part = rows.slice(i, i + BATCH);
    await pool.query(
      `insert into coverage_bulk_results (job_id, idx, phone_original, phone_e164, line_type, carrier, confidence, source, verified, twilio_used, error, likely_line_type, carrier_entity)
       select $1, i, po, pe, lt, ca, cf, so, ve, tu, er, ll, ce
       from unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::float8[], $8::text[], $9::bool[], $10::bool[], $11::text[], $12::text[], $13::text[])
         as u(i, po, pe, lt, ca, cf, so, ve, tu, er, ll, ce)
       on conflict do nothing`,
      [
        jobId,
        part.map((_, k) => i + k),
        part.map((r) => r.input),
        part.map((r) => r.e164),
        part.map((r) => r.resolution?.lineType ?? null),
        part.map((r) => r.resolution?.carrier ?? null),
        part.map((r) => r.resolution?.confidence ?? null),
        part.map((r) => r.resolution?.source ?? null),
        part.map((r) => r.resolution?.verified ?? false),
        part.map((r) => r.resolution?.twilioUsed ?? false),
        part.map((r) => r.error),
        part.map((r) => r.resolution?.likelyLineType ?? null),
        part.map((r) => r.resolution?.carrierEntity ?? null),
      ]
    );
    await pool.query("update coverage_bulk_jobs set processed = $2, locked_at = now() where id = $1", [jobId, Math.min(rows.length, i + BATCH)]);
  }
}

// Small batches are answered inline; they're still saved as a finished job so
// the results show in the list and can be downloaded like any other.
export async function createCompletedBulkJob(
  organizationId: string,
  userId: string,
  fileName: string,
  rows: ResolvedRows,
  summary: unknown
) {
  const r = await pool.query<{ id: string }>(
    `insert into coverage_bulk_jobs (organization_id, requested_by, file_name, phones, total, processed, status, summary, finished_at)
     values ($1,$2,$3,'{}',$4,$4,'completed',$5,now()) returning id`,
    [organizationId, userId, fileName, rows.length, JSON.stringify(summary)]
  );
  await saveBulkResults(r.rows[0].id, rows);
  return r.rows[0].id;
}

// Claims one queued job (or one abandoned for 15+ minutes) so two workers
// never process the same file.
export async function processNextBulkJob(): Promise<boolean> {
  const claim = await pool.query(
    `update coverage_bulk_jobs set status = 'processing', locked_at = now()
     where id = (select id from coverage_bulk_jobs
                 where status = 'queued' or (status = 'processing' and locked_at < now() - interval '15 minutes')
                 order by created_at limit 1 for update skip locked)
     returning id, organization_id, requested_by, phones, file_name`
  );
  const job = claim.rows[0];
  if (!job) return false;
  try {
    const { rows, summary } = await resolveBulk(job.organization_id, job.phones, async (n) => {
      await pool.query("update coverage_bulk_jobs set locked_at = now(), summary = summary || $2 where id = $1", [job.id, JSON.stringify({ twilioSoFar: n })]);
    });
    await saveBulkResults(job.id, rows);
    // Keep the lookup history the Coverage page lists (unique numbers only).
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.e164 || seen.has(r.e164)) continue;
      seen.add(r.e164);
      if (seen.size > 2000) break; // history keeps a sample; full results live with the job
      await recordLookup(job.organization_id, job.requested_by ?? undefined, r.input, r.e164, toLookupResult(r.input, r.e164, r.resolution, { budgetExceeded: false }));
    }
    await pool.query(
      "update coverage_bulk_jobs set status = 'completed', processed = total, summary = $2, finished_at = now(), phones = '{}' where id = $1",
      [job.id, JSON.stringify(summary)]
    );
    await notify(job.organization_id, {
      type: "coverage_bulk_done",
      title: "Bulk lookup finished",
      body: `${summary.unique.toLocaleString()} numbers · ${Math.round(summary.engineShare * 100)}% answered by the Vahlay engine`,
      link: "/coverage",
    }).catch(() => undefined);
  } catch (err) {
    await pool.query("update coverage_bulk_jobs set status = 'failed', error = $2, finished_at = now() where id = $1", [job.id, (err as Error).message.slice(0, 1000)]);
  }
  return true;
}
