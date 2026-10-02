import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { stringify } from "csv-stringify/sync";
import { getCoverageStats, lookupPhone, recordLookup, toLookupResult } from "../services/coverageService.js";
import { resolveBulk } from "../services/phoneIntel/engine.js";
import { carrierLabel } from "../services/phoneIntel/normalize.js";
import { createBulkJob, createCompletedBulkJob, MAX_BULK } from "../services/phoneIntel/bulkJobs.js";
import { AlreadyImportedError, startHistoricalImport } from "../services/phoneIntel/importer.js";
import { budgetState, HARD_DAILY_CAP_USD } from "../services/phoneIntel/budget.js";
import { requireRole } from "../middleware/rbac.js";

export const coverageRouter = Router();
coverageRouter.use(requireAuth);
coverageRouter.use(requireModuleAccess("coverage"));

coverageRouter.post("/lookup", async (req: AuthedRequest, res) => {
  const parsed = z.object({ phone: z.string().min(4) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const result = await lookupPhone({
    organizationId: req.auth!.organizationId,
    requestedBy: req.auth!.userId,
    rawPhone: parsed.data.phone,
  });
  res.json({ result });
});

coverageRouter.get("/lookups", async (req: AuthedRequest, res) => {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(200, Number(req.query.pageSize ?? 50));
  const result = await pool.query(
    `select * from coverage_lookups where organization_id = $1 order by created_at desc limit $2 offset $3`,
    [req.auth!.organizationId, pageSize, (page - 1) * pageSize]
  );
  res.json({ lookups: result.rows, page, pageSize });
});

coverageRouter.get("/stats", async (req: AuthedRequest, res) => {
  res.json({ stats: await getCoverageStats(req.auth!.organizationId) });
});

coverageRouter.put("/budget", async (req: AuthedRequest, res) => {
  const parsed = z.object({ budgetUsd: z.number().min(0).max(HARD_DAILY_CAP_USD) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  await pool.query(
    `insert into coverage_budgets (organization_id, budget_usd) values ($1, $2)
     on conflict (organization_id) do update set budget_usd = excluded.budget_usd, updated_at = now()`,
    [req.auth!.organizationId, parsed.data.budgetUsd]
  );
  res.json({ stats: await getCoverageStats(req.auth!.organizationId) });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });

function phonesFromCsv(buffer: Buffer): string[] {
  const records = parse(buffer, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  }) as Record<string, string>[];
  return records.map((r) => r.phone ?? r.phone_number ?? r.number ?? r.mobile ?? "").filter(Boolean);
}

// Pasted numbers: one per line, or separated by commas, semicolons or tabs.
// Spaces stay, so "(501) 501-8711" is one number. A "phone" header is ignored.
export function phonesFromText(text: string): string[] {
  return text
    .split(/[\r\n,;\t]+/)
    .map((p) => p.trim())
    .filter((p) => p && /\d/.test(p));
}

// Bulk lookup (up to 20,000 numbers). Small files are answered inline; larger
// ones become a job the worker processes, polled via /lookup/bulk/:id.
coverageRouter.post("/lookup/bulk", upload.single("file"), async (req: AuthedRequest, res) => {
  const pasted = typeof req.body?.numbers === "string" ? req.body.numbers : null;
  if (!req.file && !pasted?.trim()) return res.status(400).json({ error: "Upload a CSV or paste some phone numbers." });
  let phones: string[];
  if (req.file) {
    try {
      phones = phonesFromCsv(req.file.buffer);
    } catch (err) {
      return res.status(400).json({ error: `Invalid CSV: ${(err as Error).message}` });
    }
    if (phones.length === 0) return res.status(400).json({ error: "CSV must have a 'phone' column." });
  } else {
    phones = phonesFromText(pasted!);
    if (phones.length === 0) return res.status(400).json({ error: "No phone numbers found. Paste one number per line." });
  }
  const fileName = req.file?.originalname ?? `Pasted numbers (${phones.length.toLocaleString()})`;
  const org = req.auth!.organizationId;
  if (phones.length <= 300) {
    const { rows, summary } = await resolveBulk(org, phones);
    const results = rows.map((r) => toLookupResult(r.input, r.e164, r.resolution, { budgetExceeded: summary.budgetExceeded, error: r.error }));
    const seen = new Set<string>();
    for (const r of results) if (r.phoneE164 && !seen.has(r.phoneE164)) { seen.add(r.phoneE164); await recordLookup(org, req.auth!.userId, r.phoneOriginal, r.phoneE164, r); }
    const jobId = await createCompletedBulkJob(org, req.auth!.userId, fileName, rows, summary);
    return res.json({ message: `Processed ${phones.length} numbers — ${Math.round(summary.engineShare * 100)}% answered by the Vahlay engine. Download the results below.`, results, summary, jobId });
  }
  const jobId = await createBulkJob(org, req.auth!.userId, fileName, phones);
  res.status(202).json({
    message: `Queued ${Math.min(phones.length, MAX_BULK).toLocaleString()} numbers.${phones.length > MAX_BULK ? ` Only the first ${MAX_BULK.toLocaleString()} are processed per batch.` : ""}`,
    jobId,
  });
});

coverageRouter.get("/lookup/bulk", async (req: AuthedRequest, res) => {
  const r = await pool.query(
    `select id, file_name, status, total, processed, summary, error, created_at, finished_at
     from coverage_bulk_jobs where organization_id = $1 order by created_at desc limit 20`,
    [req.auth!.organizationId]
  );
  res.json({ jobs: r.rows });
});

coverageRouter.get("/lookup/bulk/:id", async (req: AuthedRequest, res) => {
  const r = await pool.query(
    "select id, file_name, status, total, processed, summary, error, created_at, finished_at from coverage_bulk_jobs where id = $1 and organization_id = $2",
    [req.params.id, req.auth!.organizationId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "Job not found." });
  res.json({ job: r.rows[0] });
});

coverageRouter.get("/lookup/bulk/:id/results.csv", async (req: AuthedRequest, res) => {
  const j = await pool.query("select file_name from coverage_bulk_jobs where id = $1 and organization_id = $2", [req.params.id, req.auth!.organizationId]);
  if (!j.rows[0]) return res.status(404).json({ error: "Job not found." });
  const r = await pool.query(
    `select phone_original, phone_e164, line_type, carrier, carrier_entity, round((confidence * 100)::numeric) as confidence_pct, likely_line_type, source, verified, error
     from coverage_bulk_results where job_id = $1 order by idx`,
    [req.params.id]
  );
  const rows = r.rows.map((x) => ({
    phone_original: x.phone_original,
    phone_e164: x.phone_e164,
    line_type: x.line_type,
    carrier: carrierLabel(x.carrier_entity, x.carrier),
    carrier_company: x.carrier_entity,
    carrier_network: x.carrier,
    confidence_pct: x.confidence_pct,
    likely_line_type: x.likely_line_type,
    answered_by: x.verified ? "verified" : x.source ? "vahlay_engine" : "",
    source: x.source,
    error: x.error,
  }));
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="lookup-results-${String(req.params.id).slice(0, 8)}.csv"`);
  res.send(stringify(rows, { header: true, columns: ["phone_original", "phone_e164", "line_type", "carrier", "carrier_company", "carrier_network", "confidence_pct", "likely_line_type", "answered_by", "source", "error"] }));
});

// --- Intelligence: historical import, health and measured accuracy ---

coverageRouter.post("/intelligence/import", requireRole("company_admin"), importUpload.single("file"), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a historical lookup CSV." });
  try {
    const importId = await startHistoricalImport({ buffer: req.file.buffer, fileName: req.file.originalname, userId: req.auth!.userId });
    res.status(202).json({ importId, message: "Import started. Intelligence is rebuilt when it finishes." });
  } catch (err) {
    if (err instanceof AlreadyImportedError) return res.status(409).json({ error: err.message });
    throw err;
  }
});

coverageRouter.get("/intelligence", async (req: AuthedRequest, res) => {
  const org = req.auth!.organizationId;
  const [imports, totals, trust, holdout, live, ported, budget, usage30] = await Promise.all([
    pool.query("select id, file_name, status, rows_total, rows_valid, rows_invalid, duplicates, phones, observed_from, observed_to, error, created_at, finished_at from intel_imports order by created_at desc limit 20"),
    pool.query(
      `select (select count(*) from phone_observations)::int as observations, (select count(*) from phone_intelligence)::int as numbers,
              (select count(*) from prefix_intelligence)::int as prefixes, (select count(*) from carrier_statistics)::int as carriers,
              (select count(*) from phone_intelligence where verified)::int as twilio_verified_numbers`
    ),
    pool.query("select trust, count(*)::int as n, round(avg(confidence)::numeric, 3)::float as avg_confidence from prefix_intelligence group by trust"),
    pool.query("select evaluated, correct, coverage, by_type, by_bucket, created_at from intel_quality_runs where kind = 'holdout' order by id desc limit 1"),
    pool.query(
      `select kind, predicted_type, count(*)::int as n, count(*) filter (where correct)::int as ok
       from intel_quality_samples where organization_id = $1 and created_at > now() - interval '30 days' group by kind, predicted_type`,
      [org]
    ),
    pool.query("select kind, count(*)::int as n from portability_events where detected_at > now() - interval '30 days' group by kind"),
    budgetState(org),
    pool.query(
      `select coalesce(sum(spent_usd), 0)::float as spent, coalesce(sum(twilio_lookups + local_lookups), 0)::int as lookups,
              coalesce(sum(twilio_lookups), 0)::int as twilio
       from lookup_budget_days where organization_id = $1 and day > current_date - 30`,
      [org]
    ),
  ]);
  const unknownRate = await pool.query(
    "select count(*) filter (where line_type = 'unknown' or line_type is null)::float / nullif(count(*), 0) as r from coverage_lookups where organization_id = $1 and created_at > now() - interval '30 days'",
    [org]
  );
  const agg = (kind: string) => {
    const rows = live.rows.filter((r) => r.kind === kind);
    const n = rows.reduce((a, r) => a + r.n, 0);
    const ok = rows.reduce((a, r) => a + r.ok, 0);
    return {
      samples: n,
      accuracy: n ? ok / n : null,
      byType: Object.fromEntries(rows.map((r) => [r.predicted_type, { samples: r.n, accuracy: r.n ? r.ok / r.n : null }])),
    };
  };
  const u = usage30.rows[0];
  res.json({
    imports: imports.rows,
    totals: totals.rows[0],
    prefixTrust: trust.rows,
    holdout: holdout.rows[0] ?? null,
    audit: agg("audit"),
    corrections: agg("correction"),
    portability30d: Object.fromEntries(ported.rows.map((r) => [r.kind, r.n])),
    unknownRate30d: unknownRate.rows[0].r,
    // Volumes only — lookup spend is never shown.
    today: { lookups: budget.twilioLookups + budget.localLookups, engineLookups: budget.localLookups, verifications: budget.twilioLookups },
    last30d: { lookups: u.lookups, engineLookups: u.lookups - u.twilio, verifications: u.twilio, engineShare: u.lookups ? (u.lookups - u.twilio) / u.lookups : null },
  });
});

coverageRouter.put("/intelligence/target", requireRole("company_admin"), async (req: AuthedRequest, res) => {
  const parsed = z.object({ target: z.number().min(0.8).max(0.99) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose a target between 80% and 99%." });
  await pool.query(
    `insert into coverage_budgets (organization_id, accuracy_target) values ($1, $2)
     on conflict (organization_id) do update set accuracy_target = excluded.accuracy_target, updated_at = now()`,
    [req.auth!.organizationId, parsed.data.target]
  );
  res.json({ target: parsed.data.target });
});

coverageRouter.put("/intelligence/price", requireRole("company_admin"), async (req: AuthedRequest, res) => {
  const parsed = z.object({ priceUsd: z.number().min(0.0001).max(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter Twilio's per-lookup price in USD, e.g. 0.008." });
  await pool.query(
    `insert into coverage_budgets (organization_id, price_per_lookup_usd) values ($1, $2)
     on conflict (organization_id) do update set price_per_lookup_usd = excluded.price_per_lookup_usd, updated_at = now()`,
    [req.auth!.organizationId, parsed.data.priceUsd]
  );
  res.json({ ok: true });
});
