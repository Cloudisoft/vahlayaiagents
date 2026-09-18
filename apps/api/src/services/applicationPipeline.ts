import { pool } from "../db/pool.js";
import { getStorageDriver } from "./storageService.js";
import { extractText } from "../utils/extractText.js";
import { parseResume, scoreCandidateAgainstJob } from "./resumeService.js";
import { sendRejectionEmail } from "./rejectionService.js";
import { createInterviewSession } from "./interviewEngine.js";

// APPLICATION -> RESUME UPLOAD -> RESUME PROCESSING -> AI ANALYSIS -> SCORE -> DECISION
// Runs as a background job (see workers/resumeWorker.ts). Every step writes
// real state to the DB so the UI reflects actual progress, not a spinner
// that resolves to nothing.
export async function processApplication(applicationId: string): Promise<void> {
  const appResult = await pool.query(
    `select a.id, a.organization_id, a.job_id, a.resume_id, a.candidate_id, a.answers,
            c.expected_salary,
            j.title, j.required_skills, j.preferred_skills, j.min_experience_years, j.education,
            j.ai_criteria, j.salary_min, j.salary_max, j.score_reject_threshold, j.score_review_threshold
     from applications a
     join candidates c on c.id = a.candidate_id
     join jobs j on j.id = a.job_id
     where a.id = $1`,
    [applicationId]
  );
  if (appResult.rows.length === 0) throw new Error("Application not found.");
  const app = appResult.rows[0];

  await pool.query("update applications set status = 'processing', updated_at = now() where id = $1", [
    applicationId,
  ]);

  if (!app.resume_id) {
    // No resume attached — leave for manual HR review rather than guessing.
    await pool.query("update applications set status = 'hr_review', updated_at = now() where id = $1", [
      applicationId,
    ]);
    return;
  }

  const resumeResult = await pool.query(
    `select r.id, f.file_path, f.file_type from resumes r join files f on f.id = r.file_id where r.id = $1`,
    [app.resume_id]
  );
  if (resumeResult.rows.length === 0) throw new Error("Resume file not found.");
  const resume = resumeResult.rows[0];

  await pool.query("update resumes set parsing_status = 'processing' where id = $1", [resume.id]);

  try {
    // Local storage keys are read from disk directly by the driver's key;
    // for S3 we'd fetch bytes via a signed GET. Both cases funnel through
    // the same extraction step once we have a buffer.
    const buffer = await readFileBuffer(resume.file_path);
    const text = await extractText(buffer, resume.file_type);
    const parsed = await parseResume({ organizationId: app.organization_id, resumeText: text });

    await pool.query("update resumes set parsed_data = $1, parsing_status = 'completed' where id = $2", [
      JSON.stringify(parsed),
      resume.id,
    ]);

    const score = await scoreCandidateAgainstJob({
      organizationId: app.organization_id,
      job: {
        title: app.title,
        requiredSkills: app.required_skills ?? [],
        preferredSkills: app.preferred_skills ?? [],
        minExperienceYears: app.min_experience_years,
        education: app.education,
        aiCriteria: app.ai_criteria ?? {},
        salaryMin: app.salary_min,
        salaryMax: app.salary_max,
      },
      candidate: parsed,
      expectedSalary: app.expected_salary,
    });

    const decision =
      score.overallScore < app.score_reject_threshold
        ? "reject"
        : score.overallScore < app.score_review_threshold
          ? "hr_review"
          : "qualified";

    await pool.query(
      `insert into candidate_scores (application_id, overall_score, skill_match, experience_match, education_match,
         industry_match, responsibility_match, salary_compatibility, missing_requirements, strengths, concerns,
         explanation, decision, model)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'gpt-4o-mini')`,
      [
        applicationId,
        score.overallScore,
        score.skillMatch,
        score.experienceMatch,
        score.educationMatch,
        score.industryMatch,
        score.responsibilityMatch,
        score.salaryCompatibility,
        score.missingRequirements,
        score.strengths,
        score.concerns,
        score.explanation,
        decision,
      ]
    );

    if (decision === "reject") {
      await pool.query("update applications set status = 'rejected', updated_at = now() where id = $1", [
        applicationId,
      ]);
      await sendRejectionEmail(applicationId).catch((err) =>
        pool.query(
          `insert into system_logs (organization_id, level, source, message, metadata) values ($1,'error','rejection_email',$2,$3)`,
          [app.organization_id, (err as Error).message, JSON.stringify({ applicationId })]
        )
      );
    } else if (decision === "qualified") {
      await pool.query("update applications set status = 'qualified', updated_at = now() where id = $1", [
        applicationId,
      ]);
      await createInterviewSession(applicationId).catch((err) =>
        pool.query(
          `insert into system_logs (organization_id, level, source, message, metadata) values ($1,'error','interview_create',$2,$3)`,
          [app.organization_id, (err as Error).message, JSON.stringify({ applicationId })]
        )
      );
    } else {
      await pool.query("update applications set status = 'hr_review', updated_at = now() where id = $1", [
        applicationId,
      ]);
    }
  } catch (err) {
    await pool.query("update resumes set parsing_status = 'failed' where id = $1", [resume.id]);
    await pool.query("update applications set status = 'hr_review', updated_at = now() where id = $1", [
      applicationId,
    ]);
    await pool.query(
      `insert into system_logs (organization_id, level, source, message, metadata) values ($1,'error','resume_pipeline',$2,$3)`,
      [app.organization_id, (err as Error).message, JSON.stringify({ applicationId })]
    );
    throw err;
  }
}

async function readFileBuffer(key: string): Promise<Buffer> {
  const driver = getStorageDriver() as any;
  if (typeof driver.readStream === "function") {
    const stream = driver.readStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }
  // S3-compatible: fetch via a fresh signed URL rather than assuming a
  // local read method exists.
  const url = await getStorageDriver().getSignedUrl(key);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to read stored file (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}
