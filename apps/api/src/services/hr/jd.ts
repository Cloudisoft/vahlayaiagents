import { chatJson } from "../openaiService.js";
import { env } from "../../config/env.js";

export interface JdDraft {
  title: string;
  department: string | null;
  summary: string;
  description: string; // full JD, plain text with headings
  responsibilities: string[];
  requirements: string[]; // must-haves
  preferredSkills: string[];
  requiredSkills: string[];
  minExperienceYears: number | null;
  education: string | null;
  benefits: string[];
  notes: string[]; // things HR must confirm (never invented facts)
}

const RULES = `Rules:
- Use only facts HR gave you. Never invent salary, benefits, company facts, locations, or perks. If something is missing, leave it out and list it under "notes" as a question for HR.
- Inclusive, plain language. No gendered terms, no age-coded phrases ("young", "digital native"), no unnecessary degree requirements.
- Keep must-haves to the real minimum; put the rest in preferred skills.
JSON only.`;

const SHAPE = `{"title":string,"department":string|null,"summary":"2-3 sentence hook","description":"full JD text with sections: About the role, What you'll do, What you'll bring, Nice to have, Benefits (only if given)","responsibilities":[string],"requirements":[string],"requiredSkills":[string],"preferredSkills":[string],"minExperienceYears":number|null,"education":string|null,"benefits":[string],"notes":[string]}`;

export async function generateJd(organizationId: string, brief: { title: string; department?: string; location?: string; employmentType?: string; salary?: string; notes?: string; company?: string }) {
  return chatJson<JdDraft>({
    organizationId,
    model: "gpt-4o",
    temperature: 0.4,
    maxTokens: 3000,
    system: `You write job descriptions for a hiring team. ${RULES}`,
    user: `Company: ${brief.company ?? "-"}
Title: ${brief.title}
Department: ${brief.department ?? "-"}
Location: ${brief.location ?? "-"}
Employment type: ${brief.employmentType ?? "-"}
Salary: ${brief.salary ?? "not given"}
HR notes (the source of truth):
${brief.notes ?? "-"}

Return JSON: ${SHAPE}`,
  });
}

export interface JdReview {
  score: number;
  issues: Array<{ severity: "high" | "medium" | "low"; issue: string; quote: string | null; fix: string }>;
  improved: JdDraft;
}

export async function optimizeJd(organizationId: string, job: { title: string; description: string; requirements?: string | null }) {
  return chatJson<JdReview>({
    organizationId,
    model: "gpt-4o",
    temperature: 0.2,
    maxTokens: 3500,
    system: `You review and improve job descriptions for clarity, inclusiveness, accuracy and candidate appeal. ${RULES}`,
    user: `Title: ${job.title}
Current JD:
"""
${job.description.slice(0, 10000)}
"""
${job.requirements ? `Requirements:\n${job.requirements}` : ""}

Return JSON: {"score":0-100 quality score,"issues":[{"severity":"high"|"medium"|"low","issue":string,"quote":exact text from the JD|null,"fix":string}],"improved":${SHAPE}}`,
  });
}

export async function generateQuestions(organizationId: string, job: { title: string; description: string | null; responsibilities?: string | null; requirements?: string | null }, count = 6) {
  const r = await chatJson<{ questions: Array<{ question: string; purpose: string }> }>({
    organizationId,
    model: "gpt-4o",
    temperature: 0.3,
    system: `You write structured first-round phone interview questions. Each is open-ended, job-related, answerable by phone in 1-2 minutes, and legal to ask (nothing about age, family, health, religion, nationality or other protected traits). JSON only.`,
    user: `Role: ${job.title}
${String(job.description ?? "").slice(0, 5000)}
${job.responsibilities ?? ""}
${job.requirements ?? ""}

Write ${count} questions in a natural order (warm-up first). Return {"questions":[{"question":string,"purpose":"what it assesses"}]}`,
  });
  return (r.questions ?? []).filter((q) => q?.question).slice(0, 12);
}

// Everything needed to publish the job. Job boards (LinkedIn, Indeed) don't
// accept direct posting from a third party without a partner agreement, so
// we give: our hosted careers page, Google for Jobs structured data (which
// Google indexes from that page), an XML feed Indeed/aggregators can crawl,
// and copy-ready text for manual posting.
export function postingPackage(job: any, org: { name: string; slug?: string }) {
  const applyUrl = job.public_slug ? `${env.appUrl.replace(/\/$/, "")}/apply/${job.public_slug}` : null;
  const lines = (s: string | null | undefined) => String(s ?? "").split(/\r?\n/).map((l) => l.replace(/^[\s*•\-–\d.)]+/, "").trim()).filter(Boolean);
  const empLabel = job.employment_type ? String(job.employment_type).replace(/[_-]/g, "-").replace(/^\w/, (c: string) => c.toUpperCase()) : null;
  const salary =
    job.salary_min || job.salary_max
      ? `${job.salary_currency ?? "USD"} ${[job.salary_min, job.salary_max].filter(Boolean).map((n: number) => Number(n).toLocaleString()).join(" – ")}`
      : null;
  const empMap: Record<string, string> = { full_time: "FULL_TIME", "full-time": "FULL_TIME", part_time: "PART_TIME", "part-time": "PART_TIME", contract: "CONTRACTOR", contractor: "CONTRACTOR", temporary: "TEMPORARY", intern: "INTERN", internship: "INTERN" };
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title: job.title,
    description: String(job.description ?? "").replace(/\n/g, "<br>"),
    datePosted: (job.published_at ?? job.created_at ?? new Date()).toISOString?.() ?? String(job.published_at ?? job.created_at),
    hiringOrganization: { "@type": "Organization", name: org.name },
    ...(job.employment_type ? { employmentType: empMap[String(job.employment_type).toLowerCase()] ?? String(job.employment_type).toUpperCase() } : {}),
    ...(job.location
      ? /remote/i.test(job.location)
        ? { jobLocationType: "TELECOMMUTE" }
        : { jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: job.location } } }
      : {}),
    ...(job.salary_min || job.salary_max
      ? { baseSalary: { "@type": "MonetaryAmount", currency: job.salary_currency ?? "USD", value: { "@type": "QuantitativeValue", ...(job.salary_min ? { minValue: Number(job.salary_min) } : {}), ...(job.salary_max ? { maxValue: Number(job.salary_max) } : {}), unitText: "YEAR" } } }
      : {}),
    ...(applyUrl ? { url: applyUrl } : {}),
  };
  const plain = [
    job.title,
    [job.location, empLabel, salary].filter(Boolean).join(" · "),
    "",
    String(job.description ?? "").trim(),
    lines(job.requirements).length ? `\nRequirements:\n${lines(job.requirements).map((l) => `• ${l}`).join("\n")}` : "",
    applyUrl ? `\nApply: ${applyUrl}` : "",
  ]
    .filter((x) => x !== null)
    .join("\n")
    .trim();
  const linkedin = plain.length > 2900 ? plain.slice(0, 2850) + `…\n\nFull details and apply: ${applyUrl ?? ""}` : plain;
  const shortPost = `We're hiring: ${job.title}${job.location ? ` (${job.location})` : ""}.${applyUrl ? ` Apply: ${applyUrl}` : ""}`;
  return {
    applyUrl,
    jsonLd,
    copy: { full: plain, linkedin, indeed: plain, short: shortPost.slice(0, 280) },
    feedUrl: org.slug ? `${env.apiUrl.replace(/\/$/, "")}/api/public/hr/feed/${org.slug}.xml` : null,
    checklist: [
      { item: "Title is specific (no internal codes)", ok: job.title.length >= 4 && !/\b(req|#\d)/i.test(job.title) },
      { item: "Location or Remote is set", ok: Boolean(job.location) },
      { item: "Employment type is set", ok: Boolean(job.employment_type) },
      { item: "Salary range is set (required by law in several US states)", ok: Boolean(job.salary_min || job.salary_max) },
      { item: "Description is at least 150 words", ok: String(job.description ?? "").split(/\s+/).length >= 150 },
      { item: "Must-have requirements are listed", ok: lines(job.requirements).length > 0 || (job.required_skills ?? []).length > 0 },
      { item: "Interview questions are ready", ok: (job.interview_settings?.questions ?? []).length > 0 },
    ],
  };
}

export function xmlEscape(s: unknown) {
  return String(s ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}
