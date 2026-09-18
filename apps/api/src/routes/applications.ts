import { Router } from "express";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { pool } from "../db/pool.js";
import { sendRejectionEmail } from "../services/rejectionService.js";
import { createInterviewSession } from "../services/interviewEngine.js";

export const applicationsRouter = Router();
applicationsRouter.use(requireAuth);
applicationsRouter.use(requireRole("hr", "recruiter"));

applicationsRouter.get("/", async (req: AuthedRequest, res) => {
  const jobId = req.query.jobId as string | undefined;
  const status = req.query.status as string | undefined;
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(100, Number(req.query.pageSize ?? 25));

  const conditions = ["a.organization_id = $1"];
  const params: unknown[] = [req.auth!.organizationId];
  if (jobId) {
    params.push(jobId);
    conditions.push(`a.job_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`a.status = $${params.length}`);
  }

  params.push(pageSize, (page - 1) * pageSize);
  const result = await pool.query(
    `select a.id, a.status, a.created_at, j.title as job_title,
            c.first_name, c.last_name, c.email, c.phone,
            cs.overall_score, cs.decision
     from applications a
     join jobs j on j.id = a.job_id
     join candidates c on c.id = a.candidate_id
     left join lateral (
       select overall_score, decision from candidate_scores where application_id = a.id order by created_at desc limit 1
     ) cs on true
     where ${conditions.join(" and ")}
     order by a.created_at desc
     limit $${params.length - 1} offset $${params.length}`,
    params
  );
  res.json({ applications: result.rows, page, pageSize });
});

applicationsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const appResult = await pool.query(
    `select a.*, j.title as job_title, c.first_name, c.last_name, c.email, c.phone
     from applications a
     join jobs j on j.id = a.job_id
     join candidates c on c.id = a.candidate_id
     where a.id = $1 and a.organization_id = $2`,
    [req.params.id, req.auth!.organizationId]
  );
  if (appResult.rows.length === 0) return res.status(404).json({ error: "Application not found." });

  const [scores, resumes, interviews, rejection] = await Promise.all([
    pool.query("select * from candidate_scores where application_id = $1 order by created_at desc", [req.params.id]),
    pool.query(
      `select r.id, r.parsed_data, r.parsing_status, f.file_name, f.id as file_id
       from resumes r join files f on f.id = r.file_id where r.id = (select resume_id from applications where id = $1)`,
      [req.params.id]
    ),
    pool.query(
      `select s.*, (select json_agg(ia order by ia.order_index) from interview_answers ia where ia.interview_session_id = s.id) as answers
       from interview_sessions s where application_id = $1 order by created_at desc`,
      [req.params.id]
    ),
    pool.query("select * from rejection_emails where application_id = $1", [req.params.id]),
  ]);

  res.json({
    application: appResult.rows[0],
    scores: scores.rows,
    resume: resumes.rows[0] ?? null,
    interviews: interviews.rows,
    rejectionEmail: rejection.rows[0] ?? null,
  });
});

applicationsRouter.post("/:id/reject", requireRole("hr"), async (req: AuthedRequest, res) => {
  const result = await pool.query(
    "update applications set status = 'rejected', updated_at = now() where id = $1 and organization_id = $2 returning id",
    [req.params.id, req.auth!.organizationId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Application not found." });
  try {
    await sendRejectionEmail(req.params.id);
    res.json({ message: "Application rejected and email sent." });
  } catch (err) {
    res.status(207).json({ message: "Application rejected, but the email failed to send.", error: (err as Error).message });
  }
});

applicationsRouter.post("/:id/qualify", requireRole("hr"), async (req: AuthedRequest, res) => {
  const result = await pool.query(
    "update applications set status = 'qualified', updated_at = now() where id = $1 and organization_id = $2 returning id",
    [req.params.id, req.auth!.organizationId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Application not found." });
  try {
    const sessionId = await createInterviewSession(req.params.id);
    res.json({ message: "Candidate qualified. Interview call initiated.", interviewSessionId: sessionId });
  } catch (err) {
    res.status(207).json({ message: "Candidate qualified, but the interview call could not be started.", error: (err as Error).message });
  }
});
