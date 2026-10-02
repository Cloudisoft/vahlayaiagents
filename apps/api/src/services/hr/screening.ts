import { pool } from "../../db/pool.js";
import { getStorageDriver } from "../storageService.js";
import { extractText } from "../../utils/extractText.js";
import { chatJson, ProviderNotConfiguredError } from "../openaiService.js";
import { notify } from "../notifyService.js";
import { auditDecision, logActivity } from "./activity.js";
import { clampScore, cleanQuotes, quoteFound } from "./evidence.js";

export const SCREEN_MODEL = "gpt-4o";
const MAX_ATTEMPTS = 3;
const STALE_MINUTES = 10;

export interface Criterion {
  key: string;
  label: string;
  weight: number; // relative; normalised at scoring time
  guidance?: string;
}

export const DEFAULT_CRITERIA: Criterion[] = [
  { key: "skills", label: "Skills", weight: 40, guidance: "Required and preferred skills, tools and technologies." },
  { key: "experience", label: "Experience", weight: 30, guidance: "Years and relevance of experience against the minimum required." },
  { key: "education", label: "Education", weight: 15, guidance: "Degrees and certifications against the requirement." },
  { key: "responsibilities", label: "Relevant work", weight: 15, guidance: "Past responsibilities and achievements that match this role." },
];

export type Fit = "GOOD_FIT" | "REVIEW" | "NOT_A_FIT";

export function jobCriteria(job: { scoring_criteria?: any }): Criterion[] {
  const list = Array.isArray(job.scoring_criteria?.criteria) ? job.scoring_criteria.criteria : null;
  const valid = (list ?? [])
    .map((c: any) => ({ key: String(c.key ?? "").trim(), label: String(c.label ?? c.key ?? "").trim(), weight: Number(c.weight), guidance: c.guidance ? String(c.guidance) : undefined }))
    .filter((c: Criterion) => c.key && c.label && Number.isFinite(c.weight) && c.weight > 0);
  return valid.length ? valid : DEFAULT_CRITERIA;
}

// The job's mandatory requirements, one per line, in the job's own words.
export function jobRequirements(job: any): string[] {
  const out: string[] = [];
  for (const s of job.required_skills ?? []) if (String(s).trim()) out.push(String(s).trim());
  if (job.min_experience_years) out.push(`At least ${Number(job.min_experience_years)} years of relevant experience`);
  if (job.education) out.push(String(job.education).trim());
  for (const c of job.certifications ?? []) if (String(c).trim()) out.push(`Certification: ${String(c).trim()}`);
  for (const line of String(job.requirements ?? "").split(/\r?\n/)) {
    const l = line.replace(/^[\s*•\-–\d.)]+/, "").trim();
    if (l.length > 2) out.push(l);
  }
  return Array.from(new Set(out)).slice(0, 25);
}

export function fitFor(overall: number, job: { good_fit_threshold?: number; review_fit_threshold?: number }, mandatoryMissing: number): Fit {
  const good = job.good_fit_threshold ?? 75;
  const review = job.review_fit_threshold ?? 55;
  let fit: Fit = overall >= good ? "GOOD_FIT" : overall >= review ? "REVIEW" : "NOT_A_FIT";
  // A missing must-have never yields GOOD_FIT; a person decides.
  if (fit === "GOOD_FIT" && mandatoryMissing > 0) fit = "REVIEW";
  return fit;
}

interface AiScreen {
  candidate: { name: string | null; email: string | null; phone: string | null; location: string | null; current_company: string | null; years_experience: number | null };
  criteria: Array<{ key: string; score: number; rationale: string; evidence: string[] }>;
  requirements: Array<{ requirement: string; status: "met" | "partial" | "missing" | "unclear"; evidence: string | null; note: string }>;
  strengths: Array<{ point: string; evidence: string }>;
  concerns: Array<{ point: string; evidence: string | null }>;
  summary: string;
}

export interface ScreenResult {
  overall: number;
  fit: Fit;
  criteria: Array<{ key: string; label: string; weight: number; score: number; rationale: string; evidence: string[]; unverified: string[]; capped: boolean }>;
  requirements: Array<{ requirement: string; status: string; evidence: string | null; note: string }>;
  strengths: Array<{ point: string; evidence: string }>;
  concerns: Array<{ point: string; evidence: string | null }>;
  summary: string;
  candidate: AiScreen["candidate"];
  stats: { quotes: number; verified: number; dropped: number };
}

// Scores a resume against the job. Every score must cite resume text; a
// claim whose quote isn't in the resume is dropped, and a criterion with no
// verified support is capped so it can't carry the overall score.
export async function screenResume(organizationId: string, job: any, resumeText: string): Promise<ScreenResult> {
  const criteria = jobCriteria(job);
  const requirements = jobRequirements(job);
  const ai = await chatJson<AiScreen>({
    organizationId,
    model: SCREEN_MODEL,
    temperature: 0,
    seed: 11,
    maxTokens: 4000,
    system: `You screen resumes for a recruiter. Rules:
- Use ONLY the resume text. Never invent or assume skills, employers, dates, degrees or contact details.
- Every score and claim cites one or more short quotes copied EXACTLY from the resume.
- If the resume does not show something, say so and score it low; do not give benefit of the doubt.
- Refer to the candidate by name or as "the candidate"; never assume pronouns.
- Ignore name, age, gender, ethnicity, religion, nationality, disability, marital status, photos and any other protected characteristic.
- Scores are 0-100 integers. JSON only.`,
    user: `JOB
Title: ${job.title}
Department: ${job.department ?? "-"}
Location: ${job.location ?? "-"} · ${job.employment_type ?? "-"}
Description:
${String(job.description ?? "").slice(0, 6000)}
Responsibilities:
${String(job.responsibilities ?? "").slice(0, 3000)}
Preferred skills: ${(job.preferred_skills ?? []).join(", ") || "-"}

MANDATORY REQUIREMENTS (assess each):
${requirements.map((r, i) => `${i + 1}. ${r}`).join("\n") || "(none listed)"}

SCORING CRITERIA (score each):
${criteria.map((c) => `- ${c.key}: ${c.label}${c.guidance ? ` — ${c.guidance}` : ""}`).join("\n")}

RESUME TEXT
"""
${resumeText.slice(0, 24000)}
"""

Return JSON:
{
  "candidate": {"name": string|null, "email": string|null, "phone": string|null, "location": string|null, "current_company": string|null, "years_experience": number|null},
  "criteria": [{"key": string, "score": number, "rationale": string, "evidence": [exact quotes]}],
  "requirements": [{"requirement": string (as listed), "status": "met"|"partial"|"missing"|"unclear", "evidence": exact quote|null, "note": string}],
  "strengths": [{"point": string, "evidence": exact quote}],
  "concerns": [{"point": string, "evidence": exact quote|null}],
  "summary": "2-4 sentence factual summary for the recruiter"
}`,
  });

  let quotes = 0;
  let verified = 0;
  const outCriteria = criteria.map((c) => {
    const got = (ai.criteria ?? []).find((x) => x?.key === c.key);
    const ev = cleanQuotes(resumeText, got?.evidence);
    quotes += ev.verified.length + ev.rejected.length;
    verified += ev.verified.length;
    let score = clampScore(got?.score);
    const capped = ev.verified.length === 0 && score > 30;
    if (capped) score = 30;
    return {
      key: c.key,
      label: c.label,
      weight: c.weight,
      score,
      rationale: String(got?.rationale ?? (got ? "" : "Not assessed by the AI.")).slice(0, 1200),
      evidence: ev.verified,
      unverified: ev.rejected,
      capped,
    };
  });

  const outReq = requirements.map((r) => {
    const got = (ai.requirements ?? []).find((x) => String(x?.requirement ?? "").trim().toLowerCase() === r.toLowerCase())
      ?? (ai.requirements ?? [])[requirements.indexOf(r)];
    let status = ["met", "partial", "missing", "unclear"].includes(got?.status as string) ? (got!.status as string) : "unclear";
    let evidence = got?.evidence ? String(got.evidence) : null;
    if (evidence) {
      quotes++;
      if (quoteFound(resumeText, evidence)) verified++;
      else evidence = null;
    }
    // "Met" must be shown in the resume.
    if ((status === "met" || status === "partial") && !evidence) status = "unclear";
    return { requirement: r, status, evidence, note: String(got?.note ?? "").slice(0, 400) };
  });

  const strengths = (ai.strengths ?? [])
    .filter((s) => s?.point)
    .map((s) => ({ point: String(s.point).slice(0, 300), evidence: String(s.evidence ?? "") }))
    .filter((s) => {
      quotes++;
      const ok = quoteFound(resumeText, s.evidence);
      if (ok) verified++;
      return ok;
    })
    .slice(0, 8);
  const concerns = (ai.concerns ?? [])
    .filter((c) => c?.point)
    .map((c) => {
      const ev = c.evidence && quoteFound(resumeText, String(c.evidence)) ? String(c.evidence) : null;
      return { point: String(c.point).slice(0, 300), evidence: ev };
    })
    .slice(0, 8);

  const totalW = outCriteria.reduce((s, c) => s + c.weight, 0) || 1;
  const overall = Math.round(outCriteria.reduce((s, c) => s + c.score * c.weight, 0) / totalW);
  const missing = outReq.filter((r) => r.status === "missing").length;

  return {
    overall,
    fit: fitFor(overall, job, missing),
    criteria: outCriteria,
    requirements: outReq,
    strengths,
    concerns,
    summary: String(ai.summary ?? "").slice(0, 2000),
    candidate: verifyContact(resumeText, ai.candidate ?? ({} as AiScreen["candidate"])),
    stats: { quotes, verified, dropped: quotes - verified },
  };
}

// Contact details are taken from the resume text itself, never the AI's guess.
export function verifyContact(text: string, c: Partial<AiScreen["candidate"]>): AiScreen["candidate"] {
  const emailInText = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
  const email = c.email && text.toLowerCase().includes(String(c.email).toLowerCase()) ? String(c.email) : emailInText;
  const digits = (s: string) => s.replace(/\D/g, "");
  const textDigits = digits(text);
  let phone = c.phone && digits(String(c.phone)).length >= 7 && textDigits.includes(digits(String(c.phone)).slice(-10)) ? String(c.phone) : null;
  if (!phone) phone = text.match(/(\+?\(?\d[\d\s().-]{8,}\d)/)?.[1]?.trim() ?? null;
  const name = c.name && quoteFound(text, String(c.name)) ? String(c.name).trim() : null;
  const company = c.current_company && quoteFound(text, String(c.current_company)) ? String(c.current_company) : null;
  const location = c.location && quoteFound(text, String(c.location)) ? String(c.location) : null;
  const years = Number.isFinite(Number(c.years_experience)) && c.years_experience != null ? Number(c.years_experience) : null;
  return { name, email: email?.toLowerCase() ?? null, phone, location, current_company: company, years_experience: years };
}

export async function readStored(key: string): Promise<Buffer> {
  const stream = await getStorageDriver().open(key);
  const chunks: Buffer[] = [];
  for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

// Claims one application whose resume needs processing. Abandoned work
// (a crashed worker) is picked up again after STALE_MINUTES.
export async function claimNextApplication(): Promise<string | null> {
  const r = await pool.query<{ id: string }>(
    `update applications set processing_status = 'PARSING', locked_at = now(), attempts = attempts + 1, updated_at = now()
     where id = (select id from applications
                 where (processing_status = 'QUEUED' and (locked_at is null or locked_at <= now()))
                    or (processing_status in ('PARSING','SCORING') and locked_at < now() - make_interval(mins => ${STALE_MINUTES}))
                 order by created_at limit 1 for update skip locked)
     returning id`
  );
  return r.rows[0]?.id ?? null;
}

async function setProcessing(id: string, status: string, detail: string | null, error: string | null = null) {
  await pool.query(
    "update applications set processing_status = $2, processing_detail = $3, processing_error = $4, locked_at = case when $2 in ('DONE','PARSE_FAILED','AI_FAILED') then null else now() end, updated_at = now() where id = $1",
    [id, status, detail, error]
  );
}

// Parses and scores one application. Never contacts the candidate and never
// rejects: the result is advice that HR acts on.
export async function processApplicationScreening(applicationId: string): Promise<void> {
  const r = await pool.query(
    `select a.id, a.organization_id, a.stage, a.attempts, a.candidate_id, a.job_id, a.resume_id,
            j.*, j.id as job_id_real,
            r.text_content, r.id as resume_row_id, f.file_path, f.file_type, f.file_name,
            c.first_name, c.last_name, c.email as c_email, c.phone as c_phone
     from applications a join jobs j on j.id = a.job_id join candidates c on c.id = a.candidate_id
     left join resumes r on r.id = a.resume_id left join files f on f.id = r.file_id
     where a.id = $1`,
    [applicationId]
  );
  const app = r.rows[0];
  if (!app) return;
  const org = app.organization_id as string;

  if (!app.resume_row_id || !app.file_path) {
    await setProcessing(applicationId, "PARSE_FAILED", null, "No resume file is attached to this application.");
    return;
  }

  // 1. Text extraction (skipped on retries once we have it).
  let text: string = app.text_content ?? "";
  if (!text.trim()) {
    await setProcessing(applicationId, "PARSING", "Reading resume");
    try {
      const buf = await readStored(app.file_path);
      text = (await extractText(buf, app.file_type)).replace(/\u0000/g, "").trim();
      if (text.length < 80) throw new Error(text ? "Very little text could be read from this resume (it may be a scanned image)." : "No text could be read from this resume (it may be a scanned image or empty).");
      await pool.query("update resumes set text_content = $2, parsing_status = 'completed', parse_error = null where id = $1", [app.resume_row_id, text]);
    } catch (err) {
      const raw = (err as Error).message;
      const known = /little text|No text could be read/.test(raw);
      const msg = (known ? raw : `The file couldn't be read (it may be corrupt, password-protected or not really a ${String(app.file_type).toUpperCase()}). Details: ${raw}`).slice(0, 500);
      await pool.query("update resumes set parsing_status = 'failed', parse_error = $2 where id = $1", [app.resume_row_id, msg]);
      await setProcessing(applicationId, "PARSE_FAILED", null, msg);
      await logActivity({ organizationId: org, applicationId, kind: "error", title: "Resume could not be read", detail: { error: msg, file: app.file_name } });
      return;
    }
  }
  if (app.stage === "APPLIED") {
    await pool.query("update applications set stage = 'SCREENING', stage_changed_at = now() where id = $1", [applicationId]);
  }

  // 2. AI scoring.
  await setProcessing(applicationId, "SCORING", "Scoring against the job");
  let result: ScreenResult;
  try {
    result = await screenResume(org, app, text);
  } catch (err) {
    const msg = (err as Error).message.slice(0, 500);
    const permanent = err instanceof ProviderNotConfiguredError;
    if (!permanent && app.attempts < MAX_ATTEMPTS) {
      // Back off and try again automatically.
      await pool.query(
        "update applications set processing_status = 'QUEUED', processing_detail = $2, processing_error = $3, locked_at = now() + make_interval(secs => $4), updated_at = now() where id = $1",
        [applicationId, `Retrying (attempt ${app.attempts + 1} of ${MAX_ATTEMPTS})`, msg, 30 * app.attempts]
      );
      return;
    }
    await setProcessing(applicationId, "AI_FAILED", null, msg);
    await logActivity({ organizationId: org, applicationId, kind: "error", title: "AI scoring failed", detail: { error: msg, attempts: app.attempts } });
    return;
  }

  // 3. Fill only blank candidate fields, and only with details found in the resume.
  const c = result.candidate;
  const [first, ...rest] = (c.name ?? "").split(/\s+/);
  await pool.query(
    `update candidates set
       first_name = case when coalesce(first_name,'') = '' and $2::text is not null then $2 else first_name end,
       last_name = case when coalesce(last_name,'') = '' and $3::text is not null then $3 else last_name end,
       email = coalesce(nullif(email,''), $4),
       phone = coalesce(nullif(phone,''), $5),
       location = coalesce(location, $6),
       current_company = coalesce(current_company, $7),
       years_experience = coalesce(years_experience, $8)
     where id = $1`,
    [app.candidate_id, c.name ? first : null, c.name ? rest.join(" ") : null, c.email, c.phone, c.location, c.current_company, c.years_experience]
  );

  const byKey = (k: string) => result.criteria.find((x) => x.key === k)?.score ?? null;
  const gaps = result.requirements.filter((x) => x.status !== "met");
  await pool.query(
    `insert into candidate_scores (application_id, overall_score, skill_match, experience_match, education_match, responsibility_match,
       missing_requirements, strengths, concerns, explanation, decision, model, fit, summary, requirement_gaps, evidence, criteria_scores, evidence_stats)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      applicationId,
      result.overall,
      byKey("skills"),
      byKey("experience"),
      byKey("education"),
      byKey("responsibilities"),
      result.requirements.filter((x) => x.status === "missing").map((x) => x.requirement),
      result.strengths.map((s) => s.point),
      result.concerns.map((s) => s.point),
      result.summary,
      result.fit,
      SCREEN_MODEL,
      result.fit,
      result.summary,
      JSON.stringify(gaps),
      JSON.stringify({ requirements: result.requirements, strengths: result.strengths, concerns: result.concerns }),
      JSON.stringify(result.criteria),
      JSON.stringify(result.stats),
    ]
  );
  await pool.query("update applications set ai_fit = $2 where id = $1", [applicationId, result.fit]);
  await setProcessing(applicationId, "DONE", null);
  await logActivity({
    organizationId: org,
    applicationId,
    kind: "ai_screening",
    title: `AI screening: ${result.overall}/100 · ${result.fit.replace(/_/g, " ")}`,
    detail: { overall: result.overall, fit: result.fit, evidence: result.stats },
  });
  await auditDecision({ organizationId: org, actorUserId: null, action: "hr.ai_screening", entityId: applicationId, after: { overall: result.overall, fit: result.fit, model: SCREEN_MODEL } });
  if (result.fit === "GOOD_FIT") {
    const who = [app.first_name, app.last_name].filter(Boolean).join(" ") || c.name || app.file_name;
    await notify(org, { type: "hr_good_fit", title: "Strong candidate", body: `${who} scored ${result.overall} for ${app.title}.`, link: `/hr/applications/${applicationId}` }).catch(() => undefined);
  }
}

export async function retryScreening(organizationId: string, applicationIds: string[]) {
  const r = await pool.query(
    `update applications set processing_status = 'QUEUED', processing_error = null, processing_detail = null, attempts = 0, locked_at = null, updated_at = now()
     where organization_id = $1 and id = any($2::uuid[]) and processing_status in ('PARSE_FAILED','AI_FAILED','DONE')
     returning id`,
    [organizationId, applicationIds]
  );
  // A re-read of the file is wanted when parsing failed.
  await pool.query(
    "update resumes set text_content = null where id in (select resume_id from applications where id = any($1::uuid[])) and parsing_status = 'failed'",
    [r.rows.map((x) => x.id)]
  );
  return r.rowCount ?? 0;
}
