import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test";
const { quoteFound, cleanQuotes } = await import("../src/services/hr/evidence.js");
const { screenResume, fitFor, jobRequirements, verifyContact } = await import("../src/services/hr/screening.js");
const { zonedToUtc, interviewSettings } = await import("../src/services/hr/interview.js");
const { render, TEMPLATES } = await import("../src/services/hr/messaging.js");
const { postingPackage } = await import("../src/services/hr/jd.js");

const ORG = "00000000-0000-0000-0000-000000000000";

const RESUME = `Jordan Smith
jordan.smith@example.com · (415) 555-0134 · Austin, TX
EXPERIENCE
Senior Customer Success Manager, Acme Cloud (2019 – 2024)
- Managed a book of 60 enterprise accounts worth $4.2M ARR with 97% gross retention.
- Built onboarding playbooks in Salesforce and Gainsight.
Customer Support Lead, Northwind (2015 – 2019)
- Led a team of 8 agents handling Zendesk tickets.
EDUCATION
B.A. Communications, University of Texas at Austin`;

const JOB = {
  title: "Customer Success Manager",
  description: "Own a portfolio of B2B SaaS accounts.",
  required_skills: ["Salesforce", "Account management"],
  min_experience_years: 3,
  education: null,
  certifications: [],
  requirements: "- Fluent in Spanish",
  preferred_skills: ["Gainsight"],
  good_fit_threshold: 75,
  review_fit_threshold: 55,
  scoring_criteria: {},
};

function mockChat(content: unknown) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] }), { status: 200 });
    }
    return real(url);
  }) as typeof fetch;
  return () => (globalThis.fetch = real);
}

test("quotes must exist in the source (case/punctuation-insensitive)", () => {
  assert.ok(quoteFound(RESUME, "managed a book of 60 enterprise accounts"));
  assert.ok(quoteFound(RESUME, "Built onboarding playbooks in Salesforce & Gainsight"));
  assert.ok(!quoteFound(RESUME, "Certified Scrum Master"));
  assert.ok(!quoteFound(RESUME, "ok"));
  const c = cleanQuotes(RESUME, ["Led a team of 8 agents", "10 years at Google"]);
  assert.deepEqual(c.verified, ["Led a team of 8 agents"]);
  assert.deepEqual(c.rejected, ["10 years at Google"]);
});

test("invented evidence is dropped and unsupported scores are capped", async () => {
  const restore = mockChat({
    candidate: { name: "Jordan Smith", email: "jordan.smith@example.com", phone: "(415) 555-0134", location: "Austin, TX", current_company: "Google", years_experience: 9 },
    criteria: [
      { key: "skills", score: 90, rationale: "Strong CRM", evidence: ["Built onboarding playbooks in Salesforce and Gainsight"] },
      { key: "experience", score: 85, rationale: "9 years", evidence: ["Senior Customer Success Manager, Acme Cloud (2019 – 2024)"] },
      { key: "education", score: 95, rationale: "MBA from Harvard", evidence: ["MBA, Harvard Business School"] },
      { key: "responsibilities", score: 80, rationale: "Retention", evidence: ["97% gross retention"] },
    ],
    requirements: [
      { requirement: "Salesforce", status: "met", evidence: "Salesforce and Gainsight", note: "" },
      { requirement: "Account management", status: "met", evidence: "I personally managed 500 accounts", note: "" },
      { requirement: "At least 3 years of relevant experience", status: "met", evidence: "Customer Support Lead, Northwind (2015 – 2019)", note: "" },
      { requirement: "Fluent in Spanish", status: "missing", evidence: null, note: "Not mentioned" },
    ],
    strengths: [
      { point: "High retention", evidence: "97% gross retention" },
      { point: "Ran a 50-person org", evidence: "Managed 50 people across EMEA" },
    ],
    concerns: [{ point: "No Spanish mentioned", evidence: null }],
    summary: "Experienced CSM.",
  });
  try {
    const r = await screenResume(ORG, JOB, RESUME);
    const edu = r.criteria.find((c) => c.key === "education")!;
    assert.equal(edu.score, 30, "unsupported education score is capped");
    assert.ok(edu.capped);
    assert.deepEqual(edu.evidence, []);
    assert.equal(edu.unverified.length, 1);
    const acct = r.requirements.find((x) => x.requirement === "Account management")!;
    assert.equal(acct.status, "unclear", "a 'met' requirement with a fake quote becomes unclear");
    assert.equal(r.strengths.length, 1, "strength with invented quote is dropped");
    // 90*40 + 85*30 + 30*15 + 80*15 = 7800 / 100
    assert.equal(r.overall, 78);
    assert.equal(r.fit, "REVIEW", "a missing must-have keeps it out of GOOD FIT");
    assert.equal(r.candidate.current_company, null, "employer not in the resume is not stored");
    assert.equal(r.candidate.email, "jordan.smith@example.com");
    assert.ok(r.stats.dropped >= 3);
  } finally {
    restore();
  }
});

test("fit thresholds and requirement list", () => {
  assert.equal(fitFor(80, JOB, 0), "GOOD_FIT");
  assert.equal(fitFor(80, JOB, 1), "REVIEW");
  assert.equal(fitFor(60, JOB, 0), "REVIEW");
  assert.equal(fitFor(54, JOB, 0), "NOT_A_FIT");
  assert.deepEqual(jobRequirements(JOB), ["Salesforce", "Account management", "At least 3 years of relevant experience", "Fluent in Spanish"]);
});

test("contact details come from the resume, never the AI", () => {
  const c = verifyContact(RESUME, { name: "Jane Doe", email: "jane@fake.com", phone: "+1 999 999 9999" });
  assert.equal(c.name, null);
  assert.equal(c.email, "jordan.smith@example.com");
  assert.equal(c.phone, "(415) 555-0134");
});

test("time zones and settings", () => {
  // 9:00 in New York on a summer day is 13:00 UTC; in winter 14:00 UTC.
  assert.equal(zonedToUtc(2026, 7, 15, 9, 0, "America/New_York").toISOString(), "2026-07-15T13:00:00.000Z");
  assert.equal(zonedToUtc(2026, 1, 15, 9, 0, "America/New_York").toISOString(), "2026-01-15T14:00:00.000Z");
  assert.equal(zonedToUtc(2026, 1, 15, 9, 30, "Asia/Kolkata").toISOString(), "2026-01-15T04:00:00.000Z");
  const s = interviewSettings({ interview_settings: { durationMinutes: 500, slotMinutes: 7 } });
  assert.equal(s.durationMinutes, 45);
  assert.equal(s.slotMinutes, 30);
});

test("templates render and posting package is honest", () => {
  const body = render(TEMPLATES.rejection.email, { first_name: "Jordan", job_title: "CSM", company: "Vahlay" });
  assert.match(body, /Hi Jordan/);
  assert.doesNotMatch(body, /\{\{/);
  const pkg = postingPackage({ ...JOB, public_slug: "csm-abc", location: "Remote", employment_type: "full_time", salary_min: 70000, salary_max: 90000, created_at: new Date("2026-01-01") }, { name: "Vahlay", slug: "vahlay" });
  assert.equal((pkg.jsonLd as any)["@type"], "JobPosting");
  assert.equal((pkg.jsonLd as any).jobLocationType, "TELECOMMUTE");
  assert.equal((pkg.jsonLd as any).employmentType, "FULL_TIME");
  assert.ok(pkg.applyUrl?.endsWith("/apply/csm-abc"));
  assert.equal(pkg.checklist.find((c) => c.item.startsWith("Interview questions"))?.ok, false);
});
