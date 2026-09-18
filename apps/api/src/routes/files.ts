import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { getStorageDriver, getLocalDiskDriver, recordFile, verifyLocalFileToken } from "../services/storageService.js";
import { pool } from "../db/pool.js";

export const filesRouter = Router();

const ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".txt",
  ".csv",
  ".xls",
  ".xlsx",
  ".mp3",
  ".wav",
  ".m4a",
]);

// 200MB, per spec §4/§41 (audio recordings up to ~1 hour).
const MAX_FILE_SIZE = 200 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      cb(new Error(`Unsupported file type: ${ext}`));
      return;
    }
    cb(null, true);
  },
});

filesRouter.post("/upload", requireAuth, upload.single("file"), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: "No file provided." });
  try {
    const ext = path.extname(req.file.originalname);
    const key = `${req.auth!.organizationId}/${crypto.randomUUID()}${ext}`;
    const stream = Readable.from(req.file.buffer);
    const stored = await getStorageDriver().put(key, stream, req.file.mimetype);
    const fileId = await recordFile({
      organizationId: req.auth!.organizationId,
      ownerId: req.auth!.userId,
      key: stored.key,
      fileName: req.file.originalname,
      fileType: ext.replace(".", ""),
      mimeType: req.file.mimetype,
      size: stored.size,
    });
    res.status(201).json({ fileId });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesRouter.get("/:id/url", requireAuth, async (req: AuthedRequest, res) => {
  const result = await pool.query<{ file_path: string }>(
    "select file_path from files where id = $1 and organization_id = $2",
    [req.params.id, req.auth!.organizationId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "File not found." });
  try {
    const url = await getStorageDriver().getSignedUrl(result.rows[0].file_path);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Serves local-disk files via short-lived signed tokens (dev/self-hosted mode
// without S3). Not used when STORAGE_DRIVER=s3.
filesRouter.get("/local/:token", async (req, res) => {
  const key = verifyLocalFileToken(req.params.token);
  if (!key) return res.status(403).json({ error: "Invalid or expired file link." });
  try {
    const driver = getLocalDiskDriver();
    const stream = driver.readStream(key);
    stream.on("error", () => res.status(404).json({ error: "File not found." }));
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
