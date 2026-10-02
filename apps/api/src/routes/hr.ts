import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { getStorageDriver, recordFile } from "../services/storageService.js";
import { STAGES, STAGE_LABEL, auditDecision, logActivity, setStage, type Stage } from "../services/hr/activity.js";
import { DEFAULT_CRITERIA, jobCriteria, jobRequirements, retryScreening } from "../services/hr/screening.js";
import { TEMPLATES, approveMessages, advanceStatus, createMessage, type Channel, type MessageKind } from "../services/hr/messaging.js";
import { DEFAULT_EVAL_CRITERIA, availableSlots, evaluateInterview, interviewSettings, inviteToInterview } from "../services/hr/interview.js";
import { generateJd, generateQuestions, optimizeJd, postingPackage } from "../services/hr/jd.js";
import { normalizeE164 } from "../utils/phone.js";

export const hrRouter = Router();
hrRouter.use(requireAuth);
hrRouter.use(requireModuleAccess("hr"));

const org = (req: AuthedRequest) => req.auth!.organizationId;
const uid = (req: AuthedRequest) => req.auth!.userId;
const uuid = z.string().uuid();

function bad(res: any, err: z.ZodError) {
  return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid request." });
}

async function ownApp(req: AuthedRequest, id: string) {
  const r = await pool.query("select id, stage, job_id, candidate_id, ai_fit, hr_fit from applications where id = $1 and organization_id = $2", [id, org(req)]);
  return r.rows[0] ?? null;
}

// ---------- overview & settings ----------

hrRouter.get("/overview", async (req: AuthedRequest, res) => {
  const [stages, jobs, failures, upcoming, activity, drafts] = await Promise.all([
    pool.query("select stage, count(*)::int as n from applications where organization_id = $1 group by stage", [org(req)]),
    pool.query(
      `select j.id, j.title, j.status, j.department, j.location, j.created_at, j.published_at,
              count(a.id)::int as total,
              count(a.id) filter (where a.created_at > now() - interval '7 days')::int as new_7d,
              count(a.id) filter (where coalesce(a.hr_fit, a.ai_fit) = 'GOOD_FIT' and a.stage not in ('REJECTED','HIRED'))::int as good_fit,
              count(a.id) filter (where a.stage in ('INTERVIEW_INVITED','SCHEDULED','AI_INTERVIEW'))::int as interviewing,
              count(a.id) filter (where a.stage = 'HIRED')::int as hired
       from jobs j left join applications a on a.job_id = j.id
       where j.organization_id = $1 group by j.id order by (j.status = 'published') desc, j.created_at desc`,
      [org(req)]
    ),
    pool.query("select processing_status, count(*)::int as n from applications where organization_id = $1 and processing_status <> 'DONE' group by processing_status", [org(req)]),
    pool.query(
      `select s.id, s.scheduled_at, s.time_zone, s.application_id, c.first_name, c.last_name, j.title
       from interview_sessions s join applications a on a.id = s.application_id join candidates c on c.id = a.candidate_id join jobs j on j.id = a.job_id
       where s.organization_id = $1 and s.scheduling_status = 'scheduled' and s.call_status = 'pending' and s.scheduled_at > now() - interval '1 hour'
       order by s.scheduled_at limit 8`,
      [org(req)]
    ),
    pool.query(
      `select ca.id, ca.kind, ca.title, ca.created_at, ca.application_id, c.first_name, c.last_name, j.title as job_title
       from candidate_activity ca join applications a on a.id = ca.application_id join candidates c on c.id = a.candidate_id join jobs j on j.id = a.job_id
       where ca.organization_id = $1 order by ca.created_at desc limit 15`,
      [org(req)]
    ),
    pool.query("select count(*)::int as n from candidate_messages where organization_id = $1 and status = 'draft'", [org(req)]),
  ]);
  res.json({
    stages: Object.fromEntries(STAGES.map((s) => [s, stages.rows.find((r) => r.stage === s)?.n ?? 0])),
    stageLabels: STAGE_LABEL,
    jobs: jobs.rows,
    processing: Object.fromEntries(failures.rows.map((r) => [r.processing_status, r.n])),
    upcoming: upcoming.rows,
    activity: activity.rows,
    draftMessages: drafts.rows[0].n,
  });
});

hrRouter.get("/settings", async (req: AuthedRequest, res) => {
  const [o, numbers, voices] = await Promise.all([
    pool.query("select name, slug, settings from organizations where id = $1", [org(req)]),
    pool.query("select id, phone_e164, friendly_name, vapi_phone_number_id is not null as vapi_ready from phone_numbers where organization_id = $1 and status <> 'released' order by phone_e164", [org(req)]),
    pool.query("select id, name, gender, provider from voices where (organization_id = $1 or organization_id is null) and coalesce(hidden,false) = false and coalesce(language,'en') like 'en%' order by name limit 500", [org(req)]),
  ]);
  const hr = o.rows[0]?.settings?.hr ?? {};
  res.json({ settings: { companyName: hr.companyName ?? "", smsFrom: hr.smsFrom ?? null, voiceNumberId: hr.voiceNumberId ?? null }, orgName: o.rows[0]?.name, numbers: numbers.rows, voices: voices.rows });
});

hrRouter.put("/settings", async (req: AuthedRequest, res) => {
  const p = z.object({ companyName: z.string().max(120).optional(), smsFrom: z.string().nullable().optional(), voiceNumberId: uuid.nullable().optional() }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const d = p.data;
  if (d.smsFrom) {
    const ok = await pool.query("select 1 from phone_numbers where organization_id = $1 and phone_e164 = $2", [org(req), d.smsFrom]);
    if (!ok.rows[0]) return res.status(400).json({ error: "The SMS number must be one of this account's numbers." });
  }
  if (d.voiceNumberId) {
    const ok = await pool.query("select vapi_phone_number_id from phone_numbers where organization_id = $1 and id = $2", [org(req), d.voiceNumberId]);
    if (!ok.rows[0]) return res.status(400).json({ error: "Unknown number." });
    if (!ok.rows[0].vapi_phone_number_id) return res.status(400).json({ error: "That number isn't connected to VAPI yet (Voice AI → Phone numbers → Sync)." });
  }
  await pool.query(
    `update organizations set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{hr}', coalesce(settings->'hr','{}'::jsonb) || $2::jsonb), updated_at = now() where id = $1`,
    [org(req), JSON.stringify(Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)))]
  );
  res.json({ ok: true });
});

// ---------- jobs ----------

const criterionSchema = z.object({ key: z.string().min(1).max(40), label: z.string().min(1).max(60), weight: z.number().min(1).max(100), guidance: z.string().max(300).optional() });
const jobSchema = z.object({
  title: z.string().min(2).max(140),
  department: z.string().max(80).nullable().optional(),
  description: z.string().max(30000).nullable().optional(),
  responsibilities: z.string().max(10000).nullable().optional(),
  requirements: z.string().max(10000).nullable().optional(),
  requiredSkills: z.array(z.string().max(80)).max(40).optional(),
  preferredSkills: z.array(z.string().max(80)).max(40).optional(),
  minExperienceYears: z.number().min(0).max(50).nullable().optional(),
  education: z.string().max(200).nullable().optional(),
  certifications: z.array(z.string().max(120)).max(20).optional(),
  salaryMin: z.number().min(0).nullable().optional(),
  salaryMax: z.number().min(0).nullable().optional(),
  salaryCurrency: z.string().length(3).optional(),
  location: z.string().max(120).nullable().optional(),
  employmentType: z.string().max(40).nullable().optional(),
  goodFitThreshold: z.number().int().min(1).max(100).optional(),
  reviewFitThreshold: z.number().int().min(0).max(99).optional(),
  scoringCriteria: z.array(criterionSchema).min(1).max(10).optional(),
  interviewSettings: z
    .object({
      questions: z.array(z.object({ question: z.string().min(5).max(500), purpose: z.string().max(200).optional() })).max(15).optional(),
      durationMinutes: z.number().int().min(5).max(45).optional(),
      interviewerName: z.string().max(30).optional(),
      voiceId: uuid.nullable().optional(),
      evaluationCriteria: z.array(criterionSchema).min(1).max(8).optional(),
      nextRoundThreshold: z.number().int().min(1).max(100).optional(),
      holdThreshold: z.number().int().min(0).max(99).optional(),
      slotMinutes: z.number().int().optional(),
      days: z.array(z.number().int().min(0).max(6)).optional(),
      startHour: z.number().int().min(0).max(23).optional(),
      endHour: z.number().int().min(1).max(24).optional(),
      maxPerSlot: z.number().int().min(1).max(20).optional(),
      timeZone: z.string().max(60).optional(),
    })
    .optional(),
});

const COLS: Record<string, string> = {
  title: "title", department: "department", description: "description", responsibilities: "responsibilities", requirements: "requirements",
  requiredSkills: "required_skills", preferredSkills: "preferred_skills", minExperienceYears: "min_experience_years", education: "education",
  certifications: "certifications", salaryMin: "salary_min", salaryMax: "salary_max", salaryCurrency: "salary_currency", location: "location",
  employmentType: "employment_type", goodFitThreshold: "good_fit_threshold", reviewFitThreshold: "review_fit_threshold",
};

function jobValues(d: z.infer<typeof jobSchema> | Partial<z.infer<typeof jobSchema>>) {
  const out: Array<[string, unknown]> = [];
  for (const [k, col] of Object.entries(COLS)) if ((d as any)[k] !== undefined) out.push([col, (d as any)[k]]);
  if (d.scoringCriteria) out.push(["scoring_criteria", JSON.stringify({ criteria: d.scoringCriteria })]);
  return out;
}

function checkThresholds(good?: number, review?: number) {
  if (good !== undefined && review !== undefined && review >= good) return "The REVIEW threshold must be below the GOOD FIT threshold.";
  return null;
}

hrRouter.get("/jobs", async (req: AuthedRequest, res) => {
  const r = await pool.query(
    `select j.id, j.title, j.status, j.department, j.location, j.employment_type, j.public_slug, j.created_at, j.published_at,
            count(a.id)::int as application_count
     from jobs j left join applications a on a.job_id = j.id where j.organization_id = $1 group by j.id order by j.created_at desc`,
    [org(req)]
  );
  res.json({ jobs: r.rows });
});

hrRouter.post("/jobs", async (req: AuthedRequest, res) => {
  const p = jobSchema.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const t = checkThresholds(p.data.goodFitThreshold, p.data.reviewFitThreshold);
  if (t) return res.status(400).json({ error: t });
  const vals = jobValues(p.data);
  const cols = ["organization_id", "created_by", ...vals.map((v) => v[0]), "interview_settings"];
  const params = [org(req), uid(req), ...vals.map((v) => v[1]), JSON.stringify(p.data.interviewSettings ?? {})];
  const r = await pool.query(`insert into jobs (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, params);
  res.status(201).json({ id: r.rows[0].id });
});

hrRouter.get("/jobs/:id", async (req: AuthedRequest, res) => {
  if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: "Job not found." });
  const r = await pool.query("select * from jobs where id = $1 and organization_id = $2", [req.params.id, org(req)]);
  const job = r.rows[0];
  if (!job) return res.status(404).json({ error: "Job not found." });
  const [stages, o] = await Promise.all([
    pool.query("select stage, count(*)::int as n from applications where job_id = $1 group by stage", [job.id]),
    pool.query("select name, slug from organizations where id = $1", [org(req)]),
  ]);
  res.json({
    job,
    criteria: jobCriteria(job),
    defaultCriteria: DEFAULT_CRITERIA,
    requirementsList: jobRequirements(job),
    interview: { ...interviewSettings(job), defaultEvaluationCriteria: DEFAULT_EVAL_CRITERIA },
    stages: Object.fromEntries(stages.rows.map((x) => [x.stage, x.n])),
    posting: postingPackage(job, o.rows[0]),
  });
});

hrRouter.patch("/jobs/:id", async (req: AuthedRequest, res) => {
  const p = jobSchema.partial().safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const cur = await pool.query("select good_fit_threshold, review_fit_threshold, interview_settings from jobs where id = $1 and organization_id = $2", [req.params.id, org(req)]);
  if (!cur.rows[0]) return res.status(404).json({ error: "Job not found." });
  const t = checkThresholds(p.data.goodFitThreshold ?? cur.rows[0].good_fit_threshold, p.data.reviewFitThreshold ?? cur.rows[0].review_fit_threshold);
  if (t) return res.status(400).json({ error: t });
  const vals = jobValues(p.data);
  if (p.data.interviewSettings) vals.push(["interview_settings", JSON.stringify({ ...(cur.rows[0].interview_settings ?? {}), ...p.data.interviewSettings })]);
  if (!vals.length) return res.json({ ok: true });
  await pool.query(
    `update jobs set ${vals.map((v, i) => `${v[0]} = $${i + 3}`).join(", ")}, updated_at = now() where id = $1 and organization_id = $2`,
    [req.params.id, org(req), ...vals.map((v) => v[1])]
  );
  res.json({ ok: true });
});

hrRouter.post("/jobs/:id/status", async (req: AuthedRequest, res) => {
  const p = z.object({ status: z.enum(["draft", "published", "closed"]) }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const job = (await pool.query("select title, public_slug, description from jobs where id = $1 and organization_id = $2", [req.params.id, org(req)])).rows[0];
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (p.data.status === "published" && String(job.description ?? "").trim().length < 50) return res.status(400).json({ error: "Add a job description before publishing." });
  const slug = job.public_slug ?? `${job.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60)}-${crypto.randomBytes(3).toString("hex")}`;
  await pool.query(
    "update jobs set status = $3, public_slug = $4, published_at = case when $3 = 'published' then coalesce(published_at, now()) else published_at end, updated_at = now() where id = $1 and organization_id = $2",
    [req.params.id, org(req), p.data.status, slug]
  );
  res.json({ ok: true, slug });
});

hrRouter.delete("/jobs/:id", async (req: AuthedRequest, res) => {
  const n = await pool.query("select count(*)::int as n from applications where job_id = $1", [req.params.id]);
  if (n.rows[0].n > 0) return res.status(409).json({ error: "This job has candidates. Close it instead so their records are kept." });
  await pool.query("delete from jobs where id = $1 and organization_id = $2", [req.params.id, org(req)]);
  res.json({ ok: true });
});

// ---------- AI: JD and questions ----------

hrRouter.post("/jd/generate", async (req: AuthedRequest, res) => {
  const p = z.object({ title: z.string().min(2), department: z.string().optional(), location: z.string().optional(), employmentType: z.string().optional(), salary: z.string().optional(), notes: z.string().max(8000).optional() }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const o = await pool.query("select name, settings from organizations where id = $1", [org(req)]);
  const draft = await generateJd(org(req), { ...p.data, company: o.rows[0]?.settings?.hr?.companyName || o.rows[0]?.name });
  res.json({ draft });
});

hrRouter.post("/jobs/:id/optimize", async (req: AuthedRequest, res) => {
  const job = (await pool.query("select title, description, requirements from jobs where id = $1 and organization_id = $2", [req.params.id, org(req)])).rows[0];
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (String(job.description ?? "").trim().length < 50) return res.status(400).json({ error: "Write or generate a description first." });
  res.json({ review: await optimizeJd(org(req), job) });
});

hrRouter.post("/jobs/:id/questions", async (req: AuthedRequest, res) => {
  const job = (await pool.query("select title, description, responsibilities, requirements from jobs where id = $1 and organization_id = $2", [req.params.id, org(req)])).rows[0];
  if (!job) return res.status(404).json({ error: "Job not found." });
  const count = Math.min(10, Math.max(3, Number(req.body?.count) || 6));
  res.json({ questions: await generateQuestions(org(req), job, count) });
});

// ---------- candidates ----------

hrRouter.get("/jobs/:id/applications", async (req: AuthedRequest, res) => {
  const conds = ["a.organization_id = $1", "a.job_id = $2"];
  const params: unknown[] = [org(req), req.params.id];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    conds.push(sql.replace("?", `$${params.length}`));
  };
  if (req.query.stage) add("a.stage = ?", String(req.query.stage));
  if (req.query.fit) add("coalesce(a.hr_fit, a.ai_fit) = ?", String(req.query.fit));
  if (req.query.processing) add("a.processing_status = ?", String(req.query.processing));
  if (req.query.q) add("(c.first_name || ' ' || c.last_name || ' ' || coalesce(c.email,'') || ' ' || coalesce(r.file_name,'')) ilike ?", `%${String(req.query.q)}%`);
  const r = await pool.query(
    `select a.id, a.stage, a.stage_changed_at, a.created_at, a.processing_status, a.processing_error, a.processing_detail, a.ai_fit, a.hr_fit, a.source,
            c.first_name, c.last_name, c.email, c.phone, c.location, c.current_company, c.years_experience,
            r.file_name, cs.overall_score, cs.skill_match, cs.experience_match, cs.education_match, cs.summary,
            (select count(*)::int from candidate_messages m where m.application_id = a.id) as messages,
            s.scheduled_at, s.call_status, s.ai_recommendation, s.hr_recommendation, s.overall_score as interview_score
     from applications a join candidates c on c.id = a.candidate_id left join resumes r on r.id = a.resume_id
     left join lateral (select * from candidate_scores where application_id = a.id order by created_at desc limit 1) cs on true
     left join lateral (select * from interview_sessions where application_id = a.id order by created_at desc limit 1) s on true
     where ${conds.join(" and ")}
     order by cs.overall_score desc nulls last, a.created_at desc limit 1000`,
    params
  );
  res.json({ applications: r.rows });
});

const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 100 },
  fileFilter: (_req, file, cb) => cb(null, true), // type checked per file so one bad file doesn't sink the batch
});

const RESUME_EXT = new Set([".pdf", ".doc", ".docx", ".txt", ".rtf"]);

// Bulk resume upload: each file becomes its own candidate + application,
// queued for screening. A bad file is reported and skipped; the rest go on.
hrRouter.post("/jobs/:id/resumes", resumeUpload.array("files", 100), async (req: AuthedRequest, res) => {
  const job = (await pool.query("select id from jobs where id = $1 and organization_id = $2", [req.params.id, org(req)])).rows[0];
  if (!job) return res.status(404).json({ error: "Job not found." });
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) return res.status(400).json({ error: "Choose at least one resume (PDF, DOC or DOCX)." });
  const batchId = crypto.randomUUID();
  const results: Array<{ file: string; ok: boolean; applicationId?: string; error?: string }> = [];
  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase();
    try {
      if (!RESUME_EXT.has(ext)) throw new Error(`Unsupported file type ${ext || "(none)"}. Use PDF, DOC or DOCX.`);
      if (f.size < 200) throw new Error("The file is empty.");
      const sha = crypto.createHash("sha256").update(f.buffer).digest("hex");
      const dup = await pool.query(
        `select a.id from applications a join resumes r on r.id = a.resume_id join files fl on fl.id = r.file_id
         where a.job_id = $1 and fl.metadata->>'sha256' = $2 limit 1`,
        [job.id, sha]
      );
      if (dup.rows[0]) throw new Error("This exact resume is already in this job.");
      const key = `${org(req)}/resumes/${crypto.randomUUID()}${ext}`;
      const stored = await getStorageDriver().put(key, Readable.from(f.buffer), f.mimetype);
      const fileId = await recordFile({ organizationId: org(req), ownerId: uid(req), key: stored.key, fileName: f.originalname, fileType: ext.slice(1), mimeType: f.mimetype, size: stored.size, metadata: { sha256: sha } });
      const client = await pool.connect();
      try {
        await client.query("begin");
        const cand = await client.query("insert into candidates (organization_id, metadata) values ($1, $2) returning id", [org(req), JSON.stringify({ source_file: f.originalname })]);
        const resume = await client.query("insert into resumes (organization_id, candidate_id, file_id, file_name) values ($1,$2,$3,$4) returning id", [org(req), cand.rows[0].id, fileId, f.originalname]);
        const app = await client.query(
          "insert into applications (organization_id, job_id, candidate_id, resume_id, status, source, batch_id) values ($1,$2,$3,$4,'submitted','upload',$5) returning id",
          [org(req), job.id, cand.rows[0].id, resume.rows[0].id, batchId]
        );
        await client.query(
          "insert into candidate_activity (organization_id, application_id, actor_user_id, kind, title, detail) values ($1,$2,$3,'applied','Resume uploaded by HR',$4)",
          [org(req), app.rows[0].id, uid(req), JSON.stringify({ file: f.originalname, batchId })]
        );
        await client.query("commit");
        results.push({ file: f.originalname, ok: true, applicationId: app.rows[0].id });
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      results.push({ file: f.originalname, ok: false, error: (err as Error).message.slice(0, 300) });
    }
  }
  res.status(201).json({ batchId, accepted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
});

hrRouter.get("/applications/:id", async (req: AuthedRequest, res) => {
  if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: "Candidate not found." });
  const a = await pool.query(
    `select a.*, c.first_name, c.last_name, c.email, c.phone, c.location, c.current_company, c.years_experience, c.expected_salary, c.notice_period, c.work_authorization,
            j.title as job_title, j.good_fit_threshold, j.review_fit_threshold
     from applications a join candidates c on c.id = a.candidate_id join jobs j on j.id = a.job_id where a.id = $1 and a.organization_id = $2`,
    [req.params.id, org(req)]
  );
  if (!a.rows[0]) return res.status(404).json({ error: "Candidate not found." });
  const [scores, resume, interviews, messages, activity, audits] = await Promise.all([
    pool.query("select * from candidate_scores where application_id = $1 order by created_at desc", [req.params.id]),
    pool.query("select r.id, r.text_content, r.parsing_status, r.parse_error, coalesce(r.file_name, f.file_name) as file_name, f.file_type, f.file_size from resumes r left join files f on f.id = r.file_id where r.id = $1", [a.rows[0].resume_id]),
    pool.query(
      `select id, scheduling_status, scheduled_at, time_zone, call_status, call_attempts, started_at, ended_at, duration_seconds, ended_reason, transcript_segments,
              evaluation, completeness, ai_recommendation, hr_recommendation, hr_recommendation_reason, overall_score, error, created_at, schedule_token,
              (recording_file_id is not null or recording_url is not null) as has_recording
       from interview_sessions where application_id = $1 order by created_at desc`,
      [req.params.id]
    ),
    pool.query("select id, channel, kind, to_address, subject, body, status, error, attempts, approved_at, sent_at, delivered_at, opened_at, replied_at, created_at from candidate_messages where application_id = $1 order by created_at desc", [req.params.id]),
    pool.query(
      "select ca.id, ca.kind, ca.title, ca.detail, ca.created_at, u.username as actor from candidate_activity ca left join users u on u.id = ca.actor_user_id where ca.application_id = $1 order by ca.created_at desc limit 300",
      [req.params.id]
    ),
    pool.query("select l.action, l.metadata, l.created_at, u.username as actor from audit_logs l left join users u on u.id = l.actor_user_id where l.entity_type = 'application' and l.entity_id = $1 order by l.created_at desc limit 100", [req.params.id]),
  ]);
  res.json({ application: a.rows[0], scores: scores.rows, resume: resume.rows[0] ?? null, interviews: interviews.rows, messages: messages.rows, activity: activity.rows, audit: audits.rows, stageLabels: STAGE_LABEL });
});

hrRouter.get("/applications/:id/resume", async (req: AuthedRequest, res) => {
  const r = await pool.query(
    `select f.file_path, f.file_name, f.mime_type from applications a join resumes rs on rs.id = a.resume_id join files f on f.id = rs.file_id where a.id = $1 and a.organization_id = $2`,
    [req.params.id, org(req)]
  );
  const f = r.rows[0];
  if (!f) return res.status(404).json({ error: "Resume not found." });
  const stream = await getStorageDriver().open(f.file_path).catch(() => null);
  if (!stream) return res.status(404).json({ error: "The resume file is missing from storage." });
  res.setHeader("Content-Type", f.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${String(f.file_name).replace(/[^\w.\- ]/g, "_")}"`);
  res.setHeader("Cache-Control", "private, no-store");
  (stream as Readable).pipe(res);
});

hrRouter.patch("/applications/:id/candidate", async (req: AuthedRequest, res) => {
  const p = z.object({ firstName: z.string().max(80).optional(), lastName: z.string().max(80).optional(), email: z.string().email().nullable().optional().or(z.literal("")), phone: z.string().max(30).nullable().optional(), location: z.string().max(120).nullable().optional() }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const app = await ownApp(req, req.params.id);
  if (!app) return res.status(404).json({ error: "Candidate not found." });
  const d = p.data;
  if (d.phone && !normalizeE164(d.phone)) return res.status(400).json({ error: "That phone number doesn't look valid." });
  await pool.query(
    `update candidates set first_name = coalesce($2, first_name), last_name = coalesce($3, last_name), email = case when $4::text = '' then null else coalesce($4, email) end,
       phone = coalesce($5, phone), phone_normalized = coalesce($6, phone_normalized), location = coalesce($7, location) where id = $1`,
    [app.candidate_id, d.firstName ?? null, d.lastName ?? null, d.email === undefined ? null : d.email, d.phone ?? null, d.phone ? normalizeE164(d.phone) : null, d.location ?? null]
  );
  await logActivity({ organizationId: org(req), applicationId: app.id, actorUserId: uid(req), kind: "edit", title: "Candidate details edited by HR", detail: { fields: Object.keys(d) } });
  res.json({ ok: true });
});

hrRouter.post("/applications/:id/stage", async (req: AuthedRequest, res) => {
  const p = z.object({ stage: z.enum(STAGES), reason: z.string().max(500).optional() }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const app = await ownApp(req, req.params.id);
  if (!app) return res.status(404).json({ error: "Candidate not found." });
  await setStage({ organizationId: org(req), applicationId: app.id, stage: p.data.stage, actorUserId: uid(req), reason: p.data.reason ?? null });
  await auditDecision({ organizationId: org(req), actorUserId: uid(req), action: "hr.stage_change", entityId: app.id, before: { stage: app.stage }, after: { stage: p.data.stage, reason: p.data.reason ?? null } });
  res.json({ ok: true });
});

hrRouter.post("/applications/:id/fit", async (req: AuthedRequest, res) => {
  const p = z.object({ fit: z.enum(["GOOD_FIT", "REVIEW", "NOT_A_FIT"]).nullable(), reason: z.string().max(500).optional() }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  if (p.data.fit && !p.data.reason?.trim()) return res.status(400).json({ error: "Please give a reason for the override." });
  const app = await ownApp(req, req.params.id);
  if (!app) return res.status(404).json({ error: "Candidate not found." });
  await pool.query("update applications set hr_fit = $2, hr_fit_reason = $3, updated_at = now() where id = $1", [app.id, p.data.fit, p.data.fit ? p.data.reason : null]);
  await logActivity({ organizationId: org(req), applicationId: app.id, actorUserId: uid(req), kind: "override", title: p.data.fit ? `HR set fit to ${p.data.fit.replace(/_/g, " ")} (AI said ${String(app.ai_fit ?? "—").replace(/_/g, " ")})` : "HR cleared the fit override", detail: { reason: p.data.reason ?? null } });
  await auditDecision({ organizationId: org(req), actorUserId: uid(req), action: "hr.fit_override", entityId: app.id, before: { aiFit: app.ai_fit, hrFit: app.hr_fit }, after: { hrFit: p.data.fit, reason: p.data.reason ?? null } });
  res.json({ ok: true });
});

hrRouter.post("/applications/:id/retry", async (req: AuthedRequest, res) => {
  const n = await retryScreening(org(req), [req.params.id]);
  if (!n) return res.status(409).json({ error: "This candidate is already being processed." });
  await logActivity({ organizationId: org(req), applicationId: req.params.id, actorUserId: uid(req), kind: "retry", title: "Screening re-run requested" });
  res.json({ ok: true });
});

hrRouter.post("/applications/bulk", async (req: AuthedRequest, res) => {
  const p = z.object({ ids: z.array(uuid).min(1).max(1000), action: z.enum(["stage", "retry", "delete"]), stage: z.enum(STAGES).optional(), reason: z.string().max(500).optional() }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const own = await pool.query<{ id: string; stage: Stage }>("select id, stage from applications where organization_id = $1 and id = any($2::uuid[])", [org(req), p.data.ids]);
  if (p.data.action === "retry") return res.json({ updated: await retryScreening(org(req), own.rows.map((r) => r.id)) });
  if (p.data.action === "delete") {
    // Deleting removes the candidate's data (PII) for these applications.
    for (const a of own.rows) await auditDecision({ organizationId: org(req), actorUserId: uid(req), action: "hr.delete_application", entityId: a.id, before: { stage: a.stage } });
    await pool.query("delete from candidates where id in (select candidate_id from applications where id = any($1::uuid[])) and not exists (select 1 from applications x where x.candidate_id = candidates.id and not (x.id = any($1::uuid[])))", [own.rows.map((r) => r.id)]);
    await pool.query("delete from applications where id = any($1::uuid[])", [own.rows.map((r) => r.id)]);
    return res.json({ updated: own.rows.length });
  }
  if (!p.data.stage) return res.status(400).json({ error: "Choose a stage." });
  let n = 0;
  const errors: string[] = [];
  for (const a of own.rows) {
    try {
      await setStage({ organizationId: org(req), applicationId: a.id, stage: p.data.stage, actorUserId: uid(req), reason: p.data.reason ?? "Bulk update" });
      await auditDecision({ organizationId: org(req), actorUserId: uid(req), action: "hr.stage_change", entityId: a.id, before: { stage: a.stage }, after: { stage: p.data.stage, bulk: true } });
      n++;
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  res.json({ updated: n, errors });
});

// ---------- messages ----------

hrRouter.get("/templates", (_req, res) => res.json({ templates: TEMPLATES }));

const msgSchema = z.object({
  channel: z.enum(["email", "sms"]),
  kind: z.enum(["invite", "confirmation", "reminder", "next_round", "info_request", "rejection", "custom"]),
  subject: z.string().max(200).optional(),
  body: z.string().max(5000).optional(),
  send: z.boolean().default(false), // true = HR approves now
});

hrRouter.post("/applications/:id/messages", async (req: AuthedRequest, res) => {
  const p = msgSchema.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  if (!(await ownApp(req, req.params.id))) return res.status(404).json({ error: "Candidate not found." });
  if (p.data.kind === "invite") return res.status(400).json({ error: "Use “Invite to interview” so the scheduling link is created." });
  const id = await createMessage({ organizationId: org(req), applicationId: req.params.id, channel: p.data.channel as Channel, kind: p.data.kind as MessageKind, subject: p.data.subject, body: p.data.body, createdBy: uid(req), approvedBy: p.data.send ? uid(req) : null });
  res.status(201).json({ id });
});

// The same message to many candidates (e.g. rejections). Each is rendered
// for its candidate; failures are reported per candidate.
hrRouter.post("/applications/bulk-message", async (req: AuthedRequest, res) => {
  const p = msgSchema.extend({ ids: z.array(uuid).min(1).max(500) }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  if (p.data.kind === "invite") return res.status(400).json({ error: "Use bulk “Invite to interview”." });
  const own = await pool.query<{ id: string }>("select id from applications where organization_id = $1 and id = any($2::uuid[])", [org(req), p.data.ids]);
  const results = [];
  for (const a of own.rows) {
    try {
      await createMessage({ organizationId: org(req), applicationId: a.id, channel: p.data.channel as Channel, kind: p.data.kind as MessageKind, subject: p.data.subject, body: p.data.body, createdBy: uid(req), approvedBy: p.data.send ? uid(req) : null });
      results.push({ id: a.id, ok: true });
    } catch (err) {
      results.push({ id: a.id, ok: false, error: (err as Error).message });
    }
  }
  res.json({ created: results.filter((r) => r.ok).length, results });
});

hrRouter.post("/messages/approve", async (req: AuthedRequest, res) => {
  const p = z.object({ ids: z.array(uuid).min(1).max(500) }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  res.json({ approved: await approveMessages(org(req), p.data.ids, uid(req)) });
});

hrRouter.get("/messages/drafts", async (req: AuthedRequest, res) => {
  const r = await pool.query(
    `select m.id, m.channel, m.kind, m.to_address, m.subject, m.body, m.status, m.error, m.created_at, m.application_id, c.first_name, c.last_name, j.title as job_title
     from candidate_messages m join applications a on a.id = m.application_id join candidates c on c.id = a.candidate_id join jobs j on j.id = a.job_id
     where m.organization_id = $1 and m.status in ('draft','failed') order by m.created_at desc limit 300`,
    [org(req)]
  );
  res.json({ messages: r.rows });
});

hrRouter.patch("/messages/:id", async (req: AuthedRequest, res) => {
  const p = z.object({ subject: z.string().max(200).optional(), body: z.string().min(1).max(5000) }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const r = await pool.query("update candidate_messages set subject = coalesce($3, subject), body = $4 where id = $1 and organization_id = $2 and status = 'draft' returning id", [req.params.id, org(req), p.data.subject ?? null, p.data.body]);
  if (!r.rows[0]) return res.status(409).json({ error: "Only drafts can be edited." });
  res.json({ ok: true });
});

hrRouter.post("/messages/:id/replied", async (req: AuthedRequest, res) => {
  const own = await pool.query("select id from candidate_messages where id = $1 and organization_id = $2", [req.params.id, org(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: "Message not found." });
  await advanceStatus({ id: req.params.id }, "replied");
  res.json({ ok: true });
});

hrRouter.delete("/messages/:id", async (req: AuthedRequest, res) => {
  const r = await pool.query("delete from candidate_messages where id = $1 and organization_id = $2 and status in ('draft','failed') returning application_id", [req.params.id, org(req)]);
  if (!r.rows[0]) return res.status(409).json({ error: "Only drafts or failed messages can be discarded." });
  await logActivity({ organizationId: org(req), applicationId: r.rows[0].application_id, actorUserId: uid(req), kind: "message", title: "Discarded a draft message" });
  res.json({ ok: true });
});

// ---------- interviews ----------

const inviteSchema = z.object({ channels: z.array(z.enum(["email", "sms"])).min(1), subject: z.string().max(200).optional(), emailBody: z.string().max(5000).optional(), smsBody: z.string().max(1000).optional() });

hrRouter.post("/applications/:id/invite", async (req: AuthedRequest, res) => {
  const p = inviteSchema.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  if (!(await ownApp(req, req.params.id))) return res.status(404).json({ error: "Candidate not found." });
  res.json(await inviteToInterview({ organizationId: org(req), applicationId: req.params.id, userId: uid(req), ...p.data }));
});

hrRouter.post("/applications/bulk-invite", async (req: AuthedRequest, res) => {
  const p = inviteSchema.extend({ ids: z.array(uuid).min(1).max(300) }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const own = await pool.query<{ id: string }>("select id from applications where organization_id = $1 and id = any($2::uuid[])", [org(req), p.data.ids]);
  const results = [];
  for (const a of own.rows) {
    try {
      await inviteToInterview({ organizationId: org(req), applicationId: a.id, userId: uid(req), channels: p.data.channels, subject: p.data.subject, emailBody: p.data.emailBody, smsBody: p.data.smsBody });
      results.push({ id: a.id, ok: true });
    } catch (err) {
      results.push({ id: a.id, ok: false, error: (err as Error).message });
    }
  }
  res.json({ invited: results.filter((r) => r.ok).length, results });
});

async function ownInterview(req: AuthedRequest) {
  const r = await pool.query("select * from interview_sessions where id = $1 and organization_id = $2", [req.params.id, org(req)]);
  return r.rows[0] ?? null;
}

hrRouter.get("/interviews/:id/slots", async (req: AuthedRequest, res) => {
  const s = await ownInterview(req);
  if (!s) return res.status(404).json({ error: "Interview not found." });
  const job = (await pool.query("select j.* from jobs j join applications a on a.job_id = j.id where a.id = $1", [s.application_id])).rows[0];
  res.json({ slots: await availableSlots(org(req), job, 14, s.id), timeZone: interviewSettings(job).timeZone });
});

// HR books a time for the candidate (e.g. agreed by phone).
hrRouter.post("/interviews/:id/schedule", async (req: AuthedRequest, res) => {
  const p = z.object({ at: z.string(), timeZone: z.string().max(60) }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const s = await ownInterview(req);
  if (!s) return res.status(404).json({ error: "Interview not found." });
  if (!["pending", "no_answer", "failed"].includes(s.call_status)) return res.status(409).json({ error: "This interview already took place." });
  const at = new Date(p.data.at);
  if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 5 * 60_000) return res.status(400).json({ error: "Choose a time at least 5 minutes from now." });
  await pool.query("update interview_sessions set scheduled_at = $2, time_zone = $3, scheduling_status = 'scheduled', call_status = 'pending', call_attempts = 0, error = null, reminder_24h_at = null, reminder_1h_at = null where id = $1", [s.id, at, p.data.timeZone]);
  await setStage({ organizationId: org(req), applicationId: s.application_id, stage: "SCHEDULED", actorUserId: uid(req), reason: `Scheduled by HR for ${at.toISOString()}` });
  res.json({ ok: true });
});

hrRouter.post("/interviews/:id/cancel", async (req: AuthedRequest, res) => {
  const s = await ownInterview(req);
  if (!s) return res.status(404).json({ error: "Interview not found." });
  if (["calling", "in_progress"].includes(s.call_status)) return res.status(409).json({ error: "The call is in progress." });
  await pool.query("update interview_sessions set scheduling_status = 'cancelled' where id = $1", [s.id]);
  await logActivity({ organizationId: org(req), applicationId: s.application_id, actorUserId: uid(req), kind: "interview", title: "Interview cancelled by HR" });
  res.json({ ok: true });
});

hrRouter.post("/interviews/:id/evaluate", async (req: AuthedRequest, res) => {
  const s = await ownInterview(req);
  if (!s) return res.status(404).json({ error: "Interview not found." });
  if (!s.transcript_segments?.length) return res.status(409).json({ error: "There is no transcript to evaluate." });
  await pool.query("update interview_sessions set error = null where id = $1", [s.id]);
  await evaluateInterview(s.id);
  await logActivity({ organizationId: org(req), applicationId: s.application_id, actorUserId: uid(req), kind: "retry", title: "Interview re-evaluated" });
  res.json({ ok: true });
});

hrRouter.post("/interviews/:id/recommendation", async (req: AuthedRequest, res) => {
  const p = z.object({ recommendation: z.enum(["NEXT_ROUND", "HOLD", "HR_REVIEW", "DO_NOT_ADVANCE"]).nullable(), reason: z.string().max(500).optional() }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  if (p.data.recommendation && !p.data.reason?.trim()) return res.status(400).json({ error: "Please give a reason for the override." });
  const s = await ownInterview(req);
  if (!s) return res.status(404).json({ error: "Interview not found." });
  await pool.query("update interview_sessions set hr_recommendation = $2, hr_recommendation_reason = $3 where id = $1", [s.id, p.data.recommendation, p.data.recommendation ? p.data.reason : null]);
  await logActivity({ organizationId: org(req), applicationId: s.application_id, actorUserId: uid(req), kind: "override", title: p.data.recommendation ? `HR set recommendation to ${p.data.recommendation.replace(/_/g, " ")} (AI said ${String(s.ai_recommendation ?? "—").replace(/_/g, " ")})` : "HR cleared the recommendation override", detail: { reason: p.data.reason ?? null } });
  await auditDecision({ organizationId: org(req), actorUserId: uid(req), action: "hr.interview_override", entityId: s.application_id, before: { ai: s.ai_recommendation, hr: s.hr_recommendation }, after: { hr: p.data.recommendation, reason: p.data.reason ?? null } });
  res.json({ ok: true });
});

hrRouter.get("/interviews/:id/recording", async (req: AuthedRequest, res) => {
  const s = await ownInterview(req);
  if (!s) return res.status(404).json({ error: "Interview not found." });
  if (s.recording_file_id) {
    const f = (await pool.query("select file_path, mime_type, file_name from files where id = $1", [s.recording_file_id])).rows[0];
    const stream = f ? await getStorageDriver().open(f.file_path).catch(() => null) : null;
    if (stream) {
      res.setHeader("Content-Type", f.mime_type || "audio/wav");
      res.setHeader("Cache-Control", "private, no-store");
      return (stream as Readable).pipe(res);
    }
  }
  if (!s.recording_url) return res.status(404).json({ error: "No recording for this interview." });
  const up = await fetch(s.recording_url);
  if (!up.ok || !up.body) return res.status(502).json({ error: "The recording couldn't be fetched from VAPI." });
  res.setHeader("Content-Type", up.headers.get("content-type") ?? "audio/wav");
  res.setHeader("Cache-Control", "private, no-store");
  Readable.fromWeb(up.body as any).pipe(res);
});
