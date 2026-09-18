import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { getCoverageStats, lookupPhone } from "../services/coverageService.js";
import { enqueueJob, isQueueEnabled } from "../services/queue.js";
import { getStorageDriver, recordFile } from "../services/storageService.js";
import { Readable } from "node:stream";
import crypto from "node:crypto";

export const coverageRouter = Router();
coverageRouter.use(requireAuth);

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
  const parsed = z.object({ budgetUsd: z.number().min(0) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  await pool.query(
    `insert into coverage_budgets (organization_id, budget_usd) values ($1, $2)
     on conflict (organization_id) do update set budget_usd = excluded.budget_usd, updated_at = now()`,
    [req.auth!.organizationId, parsed.data.budgetUsd]
  );
  res.json({ stats: await getCoverageStats(req.auth!.organizationId) });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Bulk CSV lookup. Expects a "phone" column (case-insensitive). Runs as a
// background job when Redis is available; otherwise processes inline
// up to a safety cap so a request can't hang forever on a huge file.
coverageRouter.post("/lookup/bulk", upload.single("file"), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: "No CSV file provided." });

  let records: Record<string, string>[];
  try {
    records = parse(req.file.buffer, { columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()), skip_empty_lines: true });
  } catch (err) {
    return res.status(400).json({ error: `Invalid CSV: ${(err as Error).message}` });
  }
  const phones = records.map((r) => r.phone ?? r.phone_number ?? r.number).filter(Boolean);
  if (phones.length === 0) return res.status(400).json({ error: "CSV must have a 'phone' column." });

  const key = `${req.auth!.organizationId}/coverage-bulk/${crypto.randomUUID()}.csv`;
  const stored = await getStorageDriver().put(key, Readable.from(req.file.buffer), "text/csv");
  const fileId = await recordFile({
    organizationId: req.auth!.organizationId,
    ownerId: req.auth!.userId,
    key: stored.key,
    fileName: req.file.originalname,
    fileType: "csv",
    mimeType: "text/csv",
    size: stored.size,
  });

  if (isQueueEnabled()) {
    const jobId = await enqueueJob({
      queueName: "coverage-bulk-lookup",
      jobType: "bulk-lookup",
      organizationId: req.auth!.organizationId,
      payload: { fileId, phones, requestedBy: req.auth!.userId },
    });
    return res.status(202).json({ message: `Queued ${phones.length} numbers for lookup.`, backgroundJobId: jobId });
  }

  const CAP = 200;
  const capped = phones.slice(0, CAP);
  const results = [];
  for (const phone of capped) {
    results.push(await lookupPhone({ organizationId: req.auth!.organizationId, requestedBy: req.auth!.userId, rawPhone: phone }));
  }
  res.json({
    message:
      phones.length > CAP
        ? `Processed first ${CAP} of ${phones.length} numbers inline (configure REDIS_URL for full background processing).`
        : `Processed ${capped.length} numbers.`,
    results,
  });
});
