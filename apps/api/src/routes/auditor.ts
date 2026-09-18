import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { getStorageDriver, recordFile } from "../services/storageService.js";
import { ensureDefaultAuditCriteria } from "../services/auditCriteriaService.js";
import { processCallAudit } from "../services/auditPipeline.js";
import { enqueueJob, isQueueEnabled } from "../services/queue.js";

export const auditorRouter = Router();
auditorRouter.use(requireAuth);

// --- Criteria ---

auditorRouter.get("/criteria", async (req: AuthedRequest, res) => {
  await ensureDefaultAuditCriteria(req.auth!.organizationId);
  const result = await pool.query("select * from audit_criteria where organization_id = $1 order by created_at", [
    req.auth!.organizationId,
  ]);
  res.json({ criteria: result.rows });
});

const criterionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  weight: z.number().min(0).optional(),
  passingScore: z.number().min(0).max(100).optional(),
  isRequired: z.boolean().optional(),
  aiEvaluationInstructions: z.string().optional(),
});

auditorRouter.post("/criteria", async (req: AuthedRequest, res) => {
  const parsed = criterionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const d = parsed.data;
  const result = await pool.query(
    `insert into audit_criteria (organization_id, name, description, weight, passing_score, is_required, ai_evaluation_instructions)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [req.auth!.organizationId, d.name, d.description ?? null, d.weight ?? 1, d.passingScore ?? 70, d.isRequired ?? true, d.aiEvaluationInstructions ?? null]
  );
  res.status(201).json({ criterion: result.rows[0] });
});

auditorRouter.delete("/criteria/:id", async (req: AuthedRequest, res) => {
  await pool.query("delete from audit_criteria where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  res.status(204).end();
});

// --- Audits ---

auditorRouter.get("/audits", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select ca.id, ca.overall_score, ca.processing_status, ca.created_at, f.file_name, c.to_number
     from call_audits ca
     left join files f on f.id = ca.source_file_id
     left join calls c on c.id = ca.call_id
     where ca.organization_id = $1 order by ca.created_at desc`,
    [req.auth!.organizationId]
  );
  res.json({ audits: result.rows });
});

auditorRouter.get("/audits/:id", async (req: AuthedRequest, res) => {
  const result = await pool.query("select * from call_audits where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  if (result.rows.length === 0) return res.status(404).json({ error: "Audit not found." });
  const audit = result.rows[0];

  let recordingUrl: string | null = null;
  const fileId = audit.source_file_id;
  if (fileId) {
    const file = await pool.query("select file_path from files where id = $1", [fileId]);
    if (file.rows[0]) recordingUrl = await getStorageDriver().getSignedUrl(file.rows[0].file_path);
  }

  res.json({ audit, recordingUrl });
});

const ALLOWED_AUDIO = new Set([".mp3", ".wav", ".m4a"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // spec §41: up to 200MB / ~1 hour
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_AUDIO.has(ext)) {
      cb(new Error(`Unsupported audio type: ${ext}. Use MP3, WAV, or M4A.`));
      return;
    }
    cb(null, true);
  },
});

auditorRouter.post("/audits/upload", upload.single("file"), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file provided." });

  const ext = path.extname(req.file.originalname);
  const key = `${req.auth!.organizationId}/audits/${crypto.randomUUID()}${ext}`;
  const stored = await getStorageDriver().put(key, Readable.from(req.file.buffer), req.file.mimetype);
  const fileId = await recordFile({
    organizationId: req.auth!.organizationId,
    ownerId: req.auth!.userId,
    key: stored.key,
    fileName: req.file.originalname,
    fileType: ext.replace(".", ""),
    mimeType: req.file.mimetype,
    size: stored.size,
  });

  const auditResult = await pool.query<{ id: string }>(
    `insert into call_audits (organization_id, source_file_id, created_by, processing_status)
     values ($1,$2,$3,'pending') returning id`,
    [req.auth!.organizationId, fileId, req.auth!.userId]
  );
  const auditId = auditResult.rows[0].id;

  if (isQueueEnabled()) {
    await enqueueJob({
      queueName: "call-audit",
      jobType: "process-audit",
      organizationId: req.auth!.organizationId,
      payload: { auditId },
    });
  } else {
    processCallAudit(auditId).catch((err) => console.error("Inline audit processing failed:", err));
  }

  res.status(202).json({ auditId, message: "Audit queued for processing." });
});

auditorRouter.post("/audits/from-call/:callId", async (req: AuthedRequest, res) => {
  const call = await pool.query("select id from calls where id = $1 and organization_id = $2", [
    req.params.callId,
    req.auth!.organizationId,
  ]);
  if (call.rows.length === 0) return res.status(404).json({ error: "Call not found." });

  const auditResult = await pool.query<{ id: string }>(
    `insert into call_audits (organization_id, call_id, created_by, processing_status) values ($1,$2,$3,'pending') returning id`,
    [req.auth!.organizationId, req.params.callId, req.auth!.userId]
  );
  const auditId = auditResult.rows[0].id;

  if (isQueueEnabled()) {
    await enqueueJob({ queueName: "call-audit", jobType: "process-audit", organizationId: req.auth!.organizationId, payload: { auditId } });
  } else {
    processCallAudit(auditId).catch((err) => console.error("Inline audit processing failed:", err));
  }

  res.status(202).json({ auditId, message: "Audit queued for processing." });
});
