import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { getStorageDriver, recordFile } from "../services/storageService.js";
import { enqueueJob, isQueueEnabled } from "../services/queue.js";
import { processApplication } from "../services/applicationPipeline.js";

export const publicJobsRouter = Router();

publicJobsRouter.get("/:slug", async (req, res) => {
  const result = await pool.query(
    `select id, title, description, responsibilities, required_skills, preferred_skills, location,
            employment_type, salary_min, salary_max, screening_questions, organization_id
     from jobs where public_slug = $1 and status = 'published'`,
    [req.params.slug]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "This job posting is not available." });
  const { organization_id, ...job } = result.rows[0];
  const org = await pool.query("select name from organizations where id = $1", [organization_id]);
  res.json({ job: { ...job, organizationName: org.rows[0]?.name } });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".pdf", ".doc", ".docx", ".txt"].includes(ext)) {
      cb(new Error(`Unsupported resume file type: ${ext}`));
      return;
    }
    cb(null, true);
  },
});

const applySchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(6),
  location: z.string().optional(),
  currentCompany: z.string().optional(),
  yearsExperience: z.coerce.number().optional(),
  currentSalary: z.coerce.number().optional(),
  expectedSalary: z.coerce.number().optional(),
  noticePeriod: z.string().optional(),
  workAuthorization: z.string().optional(),
  coverLetter: z.string().optional(),
  answers: z.string().optional(), // JSON-encoded string from multipart form
});

publicJobsRouter.post("/:slug/apply", upload.single("resume"), async (req, res) => {
  const jobResult = await pool.query(
    "select id, organization_id from jobs where public_slug = $1 and status = 'published'",
    [req.params.slug]
  );
  if (jobResult.rows.length === 0) return res.status(404).json({ error: "This job posting is not available." });
  const job = jobResult.rows[0];

  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (!req.file) return res.status(400).json({ error: "Resume is required." });

  const d = parsed.data;

  try {
    const candidateResult = await pool.query<{ id: string }>(
      `insert into candidates (organization_id, first_name, last_name, email, phone, location, current_company,
         years_experience, current_salary, expected_salary, notice_period, work_authorization)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [
        job.organization_id,
        d.firstName,
        d.lastName,
        d.email.toLowerCase(),
        d.phone,
        d.location ?? null,
        d.currentCompany ?? null,
        d.yearsExperience ?? null,
        d.currentSalary ?? null,
        d.expectedSalary ?? null,
        d.noticePeriod ?? null,
        d.workAuthorization ?? null,
      ]
    );
    const candidateId = candidateResult.rows[0].id;

    const ext = path.extname(req.file.originalname);
    const key = `${job.organization_id}/resumes/${crypto.randomUUID()}${ext}`;
    const stored = await getStorageDriver().put(key, Readable.from(req.file.buffer), req.file.mimetype);
    const fileId = await recordFile({
      organizationId: job.organization_id,
      key: stored.key,
      fileName: req.file.originalname,
      fileType: ext.replace(".", ""),
      mimeType: req.file.mimetype,
      size: stored.size,
    });

    const resumeResult = await pool.query<{ id: string }>(
      "insert into resumes (organization_id, candidate_id, file_id) values ($1,$2,$3) returning id",
      [job.organization_id, candidateId, fileId]
    );

    let answers: Record<string, unknown> = {};
    if (d.answers) {
      try {
        answers = JSON.parse(d.answers);
      } catch {
        // ignore malformed answers rather than failing the whole application
      }
    }

    const applicationResult = await pool.query<{ id: string }>(
      `insert into applications (organization_id, job_id, candidate_id, resume_id, cover_letter, answers, status)
       values ($1,$2,$3,$4,$5,$6,'submitted') returning id`,
      [job.organization_id, job.id, candidateId, resumeResult.rows[0].id, d.coverLetter ?? null, JSON.stringify(answers)]
    );
    const applicationId = applicationResult.rows[0].id;

    if (isQueueEnabled()) {
      await enqueueJob({
        queueName: "resume-processing",
        jobType: "process-application",
        organizationId: job.organization_id,
        payload: { applicationId },
      });
    } else {
      // No Redis configured — process inline so the pipeline still runs for
      // real rather than leaving the application stuck at "submitted".
      processApplication(applicationId).catch((err) => console.error("Inline application processing failed:", err));
    }

    res.status(201).json({ applicationId, message: "Application submitted." });
  } catch (err: any) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "You have already applied to this job with this email." });
    }
    res.status(500).json({ error: (err as Error).message });
  }
});
