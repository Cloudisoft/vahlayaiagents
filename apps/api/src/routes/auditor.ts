import { Router, type Response } from "express";
import multer from "multer";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { getStorageDriver, recordFile } from "../services/storageService.js";
import { ensureDefaultAuditCriteria } from "../services/auditCriteriaService.js";
import { ensureDefaultRules, retryAudit, FAILED_STATES } from "../services/qc/pipeline.js";

export const auditorRouter = Router();

// --- Signed audio links (an <audio> tag can't send an Authorization header) ---

function sign(payload: string) {
  if (!env.credentialsEncryptionKey && !env.jwtSecret) throw new Error("CREDENTIALS_ENCRYPTION_KEY must be set to sign audio links.");
  return crypto.createHmac("sha256", env.credentialsEncryptionKey ?? env.jwtSecret ?? "").update(payload).digest("base64url");
}
function audioToken(auditId: string, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${auditId}.${exp}.${sign(`${auditId}.${exp}`)}`;
}
function verifyAudioToken(token: string): string | null {
  const [id, exp, sig] = token.split(".");
  if (!id || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  const expected = sign(`${id}.${exp}`);
  return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig)) ? id : null;
}

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
  ".weba": "audio/webm",
  ".wma": "audio/x-ms-wma",
  ".amr": "audio/amr",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
  ".3gp": "audio/3gpp",
  ".mov": "video/quicktime",
};

// Streams the ORIGINAL upload (complete, unmodified) with byte-range support
// so the player can seek; the storage path is never exposed.
async function streamOriginal(auditId: string, rangeHeader: string | undefined, download: boolean, res: Response) {
  const r = await pool.query(
    `select coalesce(ca.original_file_name, f.file_name) as name, f.file_path, f.file_size, coalesce(ca.original_mime, f.mime_type) as mime
     from call_audits ca join files f on f.id = ca.source_file_id where ca.id = $1`,
    [auditId]
  );
  const f = r.rows[0];
  if (!f) return res.status(404).json({ error: "Recording not found." });
  const size = Number(f.file_size);
  const ext = path.extname(f.name ?? "").toLowerCase();
  const type = MIME[ext] ?? f.mime ?? "application/octet-stream";
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(f.name ?? `recording${ext}`)}`);
  const m = rangeHeader ? /bytes=(\d*)-(\d*)/.exec(rangeHeader) : null;
  if (m && size > 0) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.setHeader("Content-Range", `bytes */${size}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    (await getStorageDriver().open(f.file_path, { start, end })).pipe(res);
    return;
  }
  res.setHeader("Content-Length", String(size));
  (await getStorageDriver().open(f.file_path)).pipe(res);
}

auditorRouter.get("/audio/:token", async (req, res) => {
  const id = verifyAudioToken(String(req.params.token));
  if (!id) return res.status(403).json({ error: "This audio link has expired. Reopen the report." });
  await streamOriginal(id, req.header("range"), req.query.download === "1", res);
});

auditorRouter.use(requireAuth);
auditorRouter.use(requireModuleAccess("call_auditor"));

// --- Criteria (legacy) and custom rules ---

auditorRouter.get("/criteria", async (req: AuthedRequest, res) => {
  await ensureDefaultAuditCriteria(req.auth!.organizationId);
  const result = await pool.query("select * from audit_criteria where organization_id = $1 order by created_at", [req.auth!.organizationId]);
  res.json({ criteria: result.rows });
});

auditorRouter.get("/rules", async (req: AuthedRequest, res) => {
  await ensureDefaultRules(req.auth!.organizationId);
  const r = await pool.query("select id, rule, mandatory, active, created_at from audit_rules where organization_id = $1 order by created_at", [req.auth!.organizationId]);
  res.json({ rules: r.rows });
});

auditorRouter.post("/rules", async (req: AuthedRequest, res) => {
  const parsed = z.object({ rule: z.string().trim().min(5).max(500), mandatory: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Write the rule as a full sentence." });
  const r = await pool.query("insert into audit_rules (organization_id, rule, mandatory) values ($1,$2,$3) returning *", [
    req.auth!.organizationId,
    parsed.data.rule,
    parsed.data.mandatory ?? true,
  ]);
  res.status(201).json({ rule: r.rows[0] });
});

auditorRouter.patch("/rules/:id", async (req: AuthedRequest, res) => {
  const parsed = z.object({ active: z.boolean().optional(), mandatory: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid change." });
  await pool.query(
    "update audit_rules set active = coalesce($3, active), mandatory = coalesce($4, mandatory) where id = $1 and organization_id = $2",
    [req.params.id, req.auth!.organizationId, parsed.data.active ?? null, parsed.data.mandatory ?? null]
  );
  res.json({ ok: true });
});

auditorRouter.delete("/rules/:id", async (req: AuthedRequest, res) => {
  await pool.query("delete from audit_rules where id = $1 and organization_id = $2", [req.params.id, req.auth!.organizationId]);
  res.status(204).end();
});

// --- Audits ---

const LIST_COLS = `ca.id, ca.status, ca.status_message, ca.overall_score, ca.pass, ca.needs_review, ca.created_at, ca.completed_at,
  ca.original_duration_sec, ca.agent_name, ca.business_name, ca.batch_id, ca.attempts,
  coalesce(ca.original_file_name, f.file_name) as file_name, ca.processing_status,
  ca.report->>'callType' as call_type, ca.report->'sentiment'->>'customer' as customer_sentiment`;

auditorRouter.get("/audits", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select ${LIST_COLS} from call_audits ca left join files f on f.id = ca.source_file_id
     where ca.organization_id = $1 order by ca.created_at desc limit 200`,
    [req.auth!.organizationId]
  );
  res.json({ audits: result.rows });
});

auditorRouter.get("/stats", async (req: AuthedRequest, res) => {
  const r = await pool.query(
    `select count(*)::int as total,
       count(*) filter (where status = 'READY')::int as completed,
       round(avg(overall_score) filter (where status = 'READY'))::int as avg_score,
       count(*) filter (where status = 'READY' and pass)::int as passed,
       count(*) filter (where status = 'READY' and needs_review)::int as needs_review,
       count(*) filter (where status = any($2::text[]))::int as failed,
       count(*) filter (where status not in ('READY') and not (status = any($2::text[])))::int as in_progress
     from call_audits where organization_id = $1`,
    [req.auth!.organizationId, FAILED_STATES]
  );
  const s = r.rows[0];
  res.json({ stats: { ...s, pass_rate: s.completed ? s.passed / s.completed : null } });
});

auditorRouter.get("/audits/:id", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select ca.id, ca.status, ca.status_message, ca.failed_stage, ca.overall_score, ca.pass, ca.needs_review, ca.created_at, ca.completed_at,
       ca.original_duration_sec, ca.converted_duration_sec, ca.audible_end_sec, ca.transcript_end_sec, ca.transcript_coverage,
       ca.transcript, ca.report, ca.agent_name, ca.business_name, ca.attempts, ca.audio_info, ca.stage_log, ca.call_id,
       coalesce(ca.original_file_name, f.file_name) as file_name, coalesce(ca.original_size_bytes, f.file_size) as file_size,
       ca.pdf_file_id is not null as has_pdf, ca.source_file_id is not null as has_audio, ca.processing_status
     from call_audits ca left join files f on f.id = ca.source_file_id
     where ca.id = $1 and ca.organization_id = $2`,
    [req.params.id, req.auth!.organizationId]
  );
  const audit = result.rows[0];
  if (!audit) return res.status(404).json({ error: "Audit not found." });
  // Technical errors stay server-side; only admins see the stage log detail.
  if (!["company_admin", "super_admin"].includes(req.auth!.role)) delete audit.stage_log;
  res.json({
    audit,
    audioUrl: audit.has_audio ? `/api/auditor/audio/${audioToken(audit.id)}` : null,
  });
});

auditorRouter.get("/audits/:id/pdf", async (req: AuthedRequest, res) => {
  const r = await pool.query(
    `select f.file_path, f.file_size, coalesce(ca.original_file_name, 'call') as name, ca.status
     from call_audits ca join files f on f.id = ca.pdf_file_id where ca.id = $1 and ca.organization_id = $2`,
    [req.params.id, req.auth!.organizationId]
  );
  const f = r.rows[0];
  if (!f || f.status !== "READY") return res.status(404).json({ error: "The PDF isn't available for this audit." });
  const base = String(f.name).replace(/\.[a-z0-9]+$/i, "").replace(/[^\w.-]+/g, "_").slice(0, 80) || "call";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", String(f.file_size));
  res.setHeader("Content-Disposition", `attachment; filename="QC-${base}.pdf"`);
  (await getStorageDriver().open(f.file_path)).pipe(res);
});

auditorRouter.get("/audits/:id/audio", async (req: AuthedRequest, res) => {
  const own = await pool.query("select 1 from call_audits where id = $1 and organization_id = $2", [req.params.id, req.auth!.organizationId]);
  if (!own.rows[0]) return res.status(404).json({ error: "Audit not found." });
  await streamOriginal(String(req.params.id), req.header("range"), req.query.download !== "0", res);
});

auditorRouter.post("/audits/:id/retry", async (req: AuthedRequest, res) => {
  const cur = await pool.query("select status from call_audits where id = $1 and organization_id = $2", [req.params.id, req.auth!.organizationId]);
  if (!cur.rows[0]) return res.status(404).json({ error: "Audit not found." });
  if (!FAILED_STATES.includes(cur.rows[0].status)) return res.status(409).json({ error: "Only failed audits can be retried." });
  const next = await retryAudit(String(req.params.id), req.auth!.organizationId);
  res.json({ status: next, message: "Queued for retry." });
});

auditorRouter.post("/audits/retry-failed", async (req: AuthedRequest, res) => {
  const r = await pool.query("select id from call_audits where organization_id = $1 and status = any($2::text[])", [req.auth!.organizationId, FAILED_STATES]);
  for (const row of r.rows) await retryAudit(row.id, req.auth!.organizationId);
  res.json({ message: `Re-queued ${r.rows.length} failed audit(s).` });
});

auditorRouter.delete("/audits/:id", async (req: AuthedRequest, res) => {
  await pool.query(
    "delete from call_audits where id = $1 and organization_id = $2 and (status = 'READY' or status = any($3::text[]) or status = 'UPLOADED')",
    [req.params.id, req.auth!.organizationId, FAILED_STATES]
  );
  res.status(204).end();
});

// Uploads go to disk first (not memory) so several large files can arrive at once.
const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: 500 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!MIME[ext]) return cb(new Error(`Unsupported audio type: ${ext || "unknown"}. Use MP3, WAV, M4A, FLAC, OGG, OPUS, WebM, MP4 or AAC.`));
    cb(null, true);
  },
});

auditorRouter.post(
  "/audits/upload",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "files", maxCount: 50 },
  ]),
  async (req: AuthedRequest, res) => {
    const files = [...(((req.files as any)?.file ?? []) as Express.Multer.File[]), ...(((req.files as any)?.files ?? []) as Express.Multer.File[])];
    if (files.length === 0) return res.status(400).json({ error: "Choose at least one recording." });
    const org = req.auth!.organizationId;
    const agentName = typeof req.body?.agentName === "string" && req.body.agentName.trim() ? req.body.agentName.trim().slice(0, 120) : null;
    const businessName = typeof req.body?.businessName === "string" && req.body.businessName.trim() ? req.body.businessName.trim().slice(0, 160) : null;
    const batchId = files.length > 1 ? crypto.randomUUID() : null;
    const created: Array<{ id: string; fileName: string }> = [];
    try {
      for (const file of files) {
        if (file.size === 0) {
          created.push({ id: "", fileName: `${file.originalname} (empty — skipped)` });
          continue;
        }
        const ext = path.extname(file.originalname).toLowerCase();
        const key = `${org}/audits/${crypto.randomUUID()}${ext}`;
        const stored = await getStorageDriver().put(key, createReadStream(file.path), MIME[ext]);
        if (stored.size !== file.size) throw new Error(`Stored ${stored.size} of ${file.size} bytes for ${file.originalname}.`);
        const fileId = await recordFile({ organizationId: org, ownerId: req.auth!.userId, key: stored.key, fileName: file.originalname, fileType: ext.slice(1), mimeType: MIME[ext], size: stored.size });
        const a = await pool.query<{ id: string }>(
          `insert into call_audits (organization_id, source_file_id, created_by, status, processing_status, status_message, agent_name, business_name,
             original_file_name, original_mime, original_size_bytes, batch_id)
           values ($1,$2,$3,'UPLOADED','pending','Queued',$4,$5,$6,$7,$8,$9) returning id`,
          [org, fileId, req.auth!.userId, agentName, businessName, file.originalname, MIME[ext], file.size, batchId]
        );
        created.push({ id: a.rows[0].id, fileName: file.originalname });
      }
    } finally {
      await Promise.all(files.map((f) => unlink(f.path).catch(() => undefined)));
    }
    res.status(202).json({
      audits: created.filter((c) => c.id),
      batchId,
      message: created.length === 1 ? "Recording uploaded — the audit is running." : `${created.filter((c) => c.id).length} recordings uploaded and queued.`,
    });
  }
);

auditorRouter.post("/audits/from-call/:callId", async (req: AuthedRequest, res) => {
  const call = await pool.query(
    `select c.id, f.id as file_id, f.file_name, f.mime_type, f.file_size from calls c
     join call_recordings cr on cr.call_id = c.id join files f on f.id = cr.file_id
     where c.id = $1 and c.organization_id = $2`,
    [req.params.callId, req.auth!.organizationId]
  );
  if (!call.rows[0]) return res.status(404).json({ error: "This call has no stored recording yet." });
  const c = call.rows[0];
  const a = await pool.query<{ id: string }>(
    `insert into call_audits (organization_id, call_id, source_file_id, created_by, status, processing_status, status_message, original_file_name, original_mime, original_size_bytes)
     values ($1,$2,$3,$4,'UPLOADED','pending','Queued',$5,$6,$7) returning id`,
    [req.auth!.organizationId, c.id, c.file_id, req.auth!.userId, c.file_name, c.mime_type, c.file_size]
  );
  res.status(202).json({ auditId: a.rows[0].id, message: "Audit queued." });
});
