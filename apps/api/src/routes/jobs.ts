import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { analyzeJobDescription } from "../services/jobAnalysisService.js";

export const jobsRouter = Router();

function slugify(title: string): string {
  return `${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")}-${crypto.randomBytes(3).toString("hex")}`;
}

const jobSchema = z.object({
  title: z.string().min(2),
  description: z.string().optional(),
  responsibilities: z.string().optional(),
  requiredSkills: z.array(z.string()).optional(),
  preferredSkills: z.array(z.string()).optional(),
  minExperienceYears: z.number().optional(),
  education: z.string().optional(),
  certifications: z.array(z.string()).optional(),
  salaryMin: z.number().optional(),
  salaryMax: z.number().optional(),
  location: z.string().optional(),
  employmentType: z.string().optional(),
  screeningQuestions: z.array(z.object({ question: z.string(), required: z.boolean().default(true) })).optional(),
  scoreRejectThreshold: z.number().min(0).max(100).optional(),
  scoreReviewThreshold: z.number().min(0).max(100).optional(),
});

jobsRouter.use(requireAuth);
jobsRouter.use(requireRole("hr", "recruiter"));

jobsRouter.get("/", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select id, title, status, location, employment_type, public_slug, created_at,
            (select count(*) from applications a where a.job_id = jobs.id) as application_count
     from jobs where organization_id = $1 order by created_at desc`,
    [req.auth!.organizationId]
  );
  res.json({ jobs: result.rows });
});

jobsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const result = await pool.query("select * from jobs where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  if (result.rows.length === 0) return res.status(404).json({ error: "Job not found." });
  const questions = await pool.query(
    "select * from interview_questions where job_id = $1 order by order_index",
    [req.params.id]
  );
  res.json({ job: result.rows[0], interviewQuestions: questions.rows });
});

jobsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = jobSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const d = parsed.data;
  const result = await pool.query(
    `insert into jobs (organization_id, created_by, title, description, responsibilities, required_skills,
       preferred_skills, min_experience_years, education, certifications, salary_min, salary_max, location,
       employment_type, screening_questions, score_reject_threshold, score_review_threshold)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     returning *`,
    [
      req.auth!.organizationId,
      req.auth!.userId,
      d.title,
      d.description ?? null,
      d.responsibilities ?? null,
      d.requiredSkills ?? [],
      d.preferredSkills ?? [],
      d.minExperienceYears ?? null,
      d.education ?? null,
      d.certifications ?? [],
      d.salaryMin ?? null,
      d.salaryMax ?? null,
      d.location ?? null,
      d.employmentType ?? null,
      JSON.stringify(d.screeningQuestions ?? []),
      d.scoreRejectThreshold ?? 49,
      d.scoreReviewThreshold ?? 64,
    ]
  );
  res.status(201).json({ job: result.rows[0] });
});

jobsRouter.patch("/:id", async (req: AuthedRequest, res) => {
  const parsed = jobSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const existing = await pool.query("select id from jobs where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  if (existing.rows.length === 0) return res.status(404).json({ error: "Job not found." });

  const d = parsed.data;
  const result = await pool.query(
    `update jobs set
       title = coalesce($1, title),
       description = coalesce($2, description),
       responsibilities = coalesce($3, responsibilities),
       required_skills = coalesce($4, required_skills),
       preferred_skills = coalesce($5, preferred_skills),
       min_experience_years = coalesce($6, min_experience_years),
       education = coalesce($7, education),
       certifications = coalesce($8, certifications),
       salary_min = coalesce($9, salary_min),
       salary_max = coalesce($10, salary_max),
       location = coalesce($11, location),
       employment_type = coalesce($12, employment_type),
       screening_questions = coalesce($13, screening_questions),
       score_reject_threshold = coalesce($14, score_reject_threshold),
       score_review_threshold = coalesce($15, score_review_threshold),
       updated_at = now()
     where id = $16
     returning *`,
    [
      d.title ?? null,
      d.description ?? null,
      d.responsibilities ?? null,
      d.requiredSkills ?? null,
      d.preferredSkills ?? null,
      d.minExperienceYears ?? null,
      d.education ?? null,
      d.certifications ?? null,
      d.salaryMin ?? null,
      d.salaryMax ?? null,
      d.location ?? null,
      d.employmentType ?? null,
      d.screeningQuestions ? JSON.stringify(d.screeningQuestions) : null,
      d.scoreRejectThreshold ?? null,
      d.scoreReviewThreshold ?? null,
      req.params.id,
    ]
  );
  res.json({ job: result.rows[0] });
});

async function setStatus(req: AuthedRequest, res: any, status: string) {
  const result = await pool.query(
    "update jobs set status = $1, updated_at = now() where id = $2 and organization_id = $3 returning *",
    [status, req.params.id, req.auth!.organizationId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Job not found." });
  res.json({ job: result.rows[0] });
}

jobsRouter.post("/:id/publish", async (req: AuthedRequest, res) => {
  const jobResult = await pool.query("select title, public_slug from jobs where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  if (jobResult.rows.length === 0) return res.status(404).json({ error: "Job not found." });
  const slug = jobResult.rows[0].public_slug ?? slugify(jobResult.rows[0].title);
  const result = await pool.query(
    "update jobs set status = 'published', public_slug = $1, updated_at = now() where id = $2 returning *",
    [slug, req.params.id]
  );
  res.json({ job: result.rows[0] });
});

jobsRouter.post("/:id/unpublish", async (req: AuthedRequest, res) => setStatus(req, res, "unpublished"));
jobsRouter.post("/:id/archive", async (req: AuthedRequest, res) => setStatus(req, res, "archived"));

jobsRouter.post("/:id/duplicate", async (req: AuthedRequest, res) => {
  const result = await pool.query("select * from jobs where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  if (result.rows.length === 0) return res.status(404).json({ error: "Job not found." });
  const j = result.rows[0];
  const dup = await pool.query(
    `insert into jobs (organization_id, created_by, title, description, responsibilities, required_skills,
       preferred_skills, min_experience_years, education, certifications, salary_min, salary_max, location,
       employment_type, screening_questions, ai_criteria, score_reject_threshold, score_review_threshold, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'draft')
     returning *`,
    [
      req.auth!.organizationId,
      req.auth!.userId,
      `${j.title} (Copy)`,
      j.description,
      j.responsibilities,
      j.required_skills,
      j.preferred_skills,
      j.min_experience_years,
      j.education,
      j.certifications,
      j.salary_min,
      j.salary_max,
      j.location,
      j.employment_type,
      j.screening_questions,
      j.ai_criteria,
      j.score_reject_threshold,
      j.score_review_threshold,
    ]
  );
  res.status(201).json({ job: dup.rows[0] });
});

jobsRouter.post("/:id/analyze", async (req: AuthedRequest, res) => {
  const result = await pool.query("select title, description from jobs where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  if (result.rows.length === 0) return res.status(404).json({ error: "Job not found." });
  const job = result.rows[0];
  if (!job.description) return res.status(400).json({ error: "Add a job description before running AI analysis." });

  try {
    const criteria = await analyzeJobDescription({
      organizationId: req.auth!.organizationId,
      title: job.title,
      description: job.description,
    });
    const updated = await pool.query(
      "update jobs set ai_criteria = $1, updated_at = now() where id = $2 returning *",
      [JSON.stringify(criteria), req.params.id]
    );
    res.json({ job: updated.rows[0] });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Interview questions for a job
const questionSchema = z.object({
  question: z.string().min(2),
  expectedAnswerCriteria: z.string().optional(),
  followUpInstructions: z.string().optional(),
  isRequired: z.boolean().optional(),
});

jobsRouter.post("/:id/interview-questions", async (req: AuthedRequest, res) => {
  const parsed = questionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const job = await pool.query("select id from jobs where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  if (job.rows.length === 0) return res.status(404).json({ error: "Job not found." });

  const orderResult = await pool.query(
    "select coalesce(max(order_index), -1) + 1 as next from interview_questions where job_id = $1",
    [req.params.id]
  );
  const result = await pool.query(
    `insert into interview_questions (job_id, question, expected_answer_criteria, follow_up_instructions, is_required, order_index)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [
      req.params.id,
      parsed.data.question,
      parsed.data.expectedAnswerCriteria ?? null,
      parsed.data.followUpInstructions ?? null,
      parsed.data.isRequired ?? true,
      orderResult.rows[0].next,
    ]
  );
  res.status(201).json({ question: result.rows[0] });
});

jobsRouter.delete("/:id/interview-questions/:questionId", async (req: AuthedRequest, res) => {
  await pool.query(
    `delete from interview_questions where id = $1 and job_id in (select id from jobs where id = $2 and organization_id = $3)`,
    [req.params.questionId, req.params.id, req.auth!.organizationId]
  );
  res.status(204).end();
});

jobsRouter.put("/:id/interview-questions/reorder", async (req: AuthedRequest, res) => {
  const parsed = z.object({ order: z.array(z.string()) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  for (let i = 0; i < parsed.data.order.length; i++) {
    await pool.query("update interview_questions set order_index = $1 where id = $2 and job_id = $3", [
      i,
      parsed.data.order[i],
      req.params.id,
    ]);
  }
  res.status(204).end();
});
