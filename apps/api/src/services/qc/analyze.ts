import { chatJson } from "../openaiService.js";
import { fmt, type Segment } from "./transcribe.js";

export const DIMENSIONS = [
  { key: "greeting", label: "Greeting & introduction" },
  { key: "verification", label: "Verification & identity" },
  { key: "discovery", label: "Discovery & needs analysis" },
  { key: "active_listening", label: "Active listening" },
  { key: "product_knowledge", label: "Product knowledge & accuracy" },
  { key: "value_proposition", label: "Value proposition / pitch" },
  { key: "objection_handling", label: "Objection handling" },
  { key: "empathy", label: "Empathy & rapport" },
  { key: "tone", label: "Tone & professionalism" },
  { key: "call_control", label: "Call control & pace" },
  { key: "compliance", label: "Compliance & disclosures" },
  { key: "data_capture", label: "Data capture & confirmation" },
  { key: "resolution", label: "Resolution of the customer's needs" },
  { key: "next_steps", label: "Next steps & expectations" },
  { key: "closing", label: "Closing" },
] as const;
type DimKey = (typeof DIMENSIONS)[number]["key"];

// Category scores are averages of their dimensions, so the numbers on the
// report always add up and the same transcript always scores the same way.
const CATEGORIES: Record<string, { label: string; weight: number; dims: DimKey[] }> = {
  communication: { label: "Communication", weight: 0.25, dims: ["greeting", "active_listening", "tone", "call_control"] },
  resolution: { label: "Resolution", weight: 0.25, dims: ["resolution", "next_steps", "data_capture", "closing"] },
  customer_experience: { label: "CX Score", weight: 0.25, dims: ["empathy", "tone", "active_listening", "resolution"] },
  compliance: { label: "Compliance", weight: 0.15, dims: ["verification", "compliance", "product_knowledge"] },
  sales: { label: "Sales", weight: 0.1, dims: ["discovery", "value_proposition", "objection_handling"] },
};
// Overall = 60% call quality (categories above) + 40% sales compliance checks.
const RULES_WEIGHT = 0.4;
export const PASS_MARK = 70;

export interface Evidence {
  segment: number | null;
  timestamp: string | null;
  quote: string;
  verified: boolean;
}
export type Rating = "green" | "yellow" | "red";
export interface Finding {
  title: string;
  detail: string;
  rating: Rating;
  evidence: Evidence[];
}
export interface QcReport {
  callType: string;
  callTypeTags: string[];
  agentName: string | null;
  customerName: string | null;
  businessName: string | null;
  scores: { overall: number; compliance: number; communication: number; sales: number; resolution: number; customerExperience: number; rules: number | null };
  categoryWeights: Record<string, number>;
  rulesWeight: number;
  pass: boolean;
  needsReview: boolean;
  dimensions: Array<{ key: string; label: string; score: number | null; rating: Rating | "na"; finding: string; evidence: Evidence[] }>;
  rules: Array<{ rule: string; mandatory: boolean; result: "PASS" | "FAIL" | "PARTIAL" | "NOT_APPLICABLE"; explanation: string; evidence: Evidence[] }>;
  complianceChecks: Array<{ check: string; result: "PASS" | "FAIL" | "PARTIAL" | "NOT_APPLICABLE"; severity: "critical" | "major" | "minor"; evidence: Evidence[] }>;
  callTypeRules: Array<{ rule: string; result: "PASS" | "FAIL" | "PARTIAL" | "NOT_APPLICABLE"; evidence: Evidence[] }>;
  risks: Array<{ level: "high" | "medium" | "low"; description: string; evidence: Evidence[] }>;
  sentiment: { customer: string; agent: string; trajectory: string };
  executiveSummary: string;
  wentWell: Finding[];
  toImprove: Finding[];
  coaching: Array<{ recommendation: string; why: string; example: string | null }>;
  keyMoments: Array<{ timestamp: string | null; description: string; evidence: Evidence[] }>;
  findings: { green: Finding[]; yellow: Finding[]; red: Finding[] };
  evidenceStats: { cited: number; verified: number };
  model: string;
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

// The model must quote the transcript; quotes are checked against the
// stored segments so no finding rests on words nobody said.
function makeVerifier(segments: Segment[]) {
  const normed = segments.map((s) => norm(s.text));
  let cited = 0;
  let verified = 0;
  const check = (raw: any): Evidence | null => {
    const quote = String(raw?.quote ?? "").trim();
    if (!quote) return null;
    cited++;
    const q = norm(quote);
    const hint = Number.isInteger(raw?.segment) ? Number(raw.segment) : null;
    const order = hint !== null ? [hint, hint - 1, hint + 1, hint - 2, hint + 2, ...normed.keys()] : [...normed.keys()];
    for (const i of order) {
      if (i < 0 || i >= normed.length) continue;
      const hay = normed[i];
      const window = normed.slice(i, i + 3).join(" ");
      if (hay.includes(q) || window.includes(q) || (q.length > 20 && tokenOverlap(q, window) >= 0.8)) {
        verified++;
        return { segment: i, timestamp: fmt(segments[i].start), quote, verified: true };
      }
    }
    return { segment: null, timestamp: null, quote, verified: false };
  };
  return {
    list: (arr: any): Evidence[] => (Array.isArray(arr) ? arr.map(check).filter((e): e is Evidence => !!e) : []),
    stats: () => ({ cited, verified }),
  };
}

function tokenOverlap(q: string, hay: string) {
  const qt = q.split(" ");
  const set = new Set(hay.split(" "));
  return qt.filter((t) => set.has(t)).length / qt.length;
}

const RESULTS = ["PASS", "FAIL", "PARTIAL", "NOT_APPLICABLE"] as const;
const asResult = (v: any) => (RESULTS.includes(v) ? v : "NOT_APPLICABLE") as (typeof RESULTS)[number];
const clamp = (n: any) => (Number.isFinite(Number(n)) ? Math.max(0, Math.min(100, Math.round(Number(n)))) : null);
const ratingOf = (score: number | null): Rating | "na" => (score === null ? "na" : score >= 80 ? "green" : score >= 60 ? "yellow" : "red");

export async function analyzeTranscript(params: {
  organizationId: string;
  segments: Segment[];
  durationSec: number;
  rules: Array<{ rule: string; mandatory: boolean }>;
  agentName: string | null;
  businessName: string | null;
}): Promise<QcReport> {
  const { segments } = params;
  const lines = segments.map((s, i) => `[${i}] ${fmt(s.start)} ${s.role}: ${s.text}`).join("\n");
  const MODEL = "gpt-4o";
  const raw = await chatJson<any>({
    organizationId: params.organizationId,
    model: MODEL,
    temperature: 0,
    seed: 7,
    maxTokens: 12000,
    system: `You are a senior call-centre QC auditor for sales and service calls (telecom/ISP context such as Spectrum Business is common).
Audit the COMPLETE transcript below. Every finding must cite evidence: the segment number in [brackets] and an exact short quote copied verbatim from that segment.
If something required never happened, say so and cite no quote ("Not found in transcript"). Never invent quotes, names, prices or events.
Score each dimension 0-100 (null only if it truly did not apply). Be strict and consistent: 90+ excellent, 75-89 good, 60-74 needs work, <60 poor.
Custom rules: decide PASS (clearly and correctly done, quote it), PARTIAL (attempted but incomplete/unclear), FAIL (not said, or done wrong). Mandatory rules are never NOT_APPLICABLE: if the statement isn't in the transcript, it is FAIL. Optional rules may be NOT_APPLICABLE only if the call never reached the point where they apply.
Respond with JSON only.`,
    user: `Recording length: ${fmt(params.durationSec)}. Agent name given at upload: ${params.agentName ?? "not given"}. Business: ${params.businessName ?? "not given"}.

Custom rules to check:
${params.rules.map((r, i) => `${i + 1}. ${r.rule}${r.mandatory ? " (mandatory)" : ""}`).join("\n") || "(none)"}

Dimensions (use these keys): ${DIMENSIONS.map((d) => `${d.key} = ${d.label}`).join("; ")}

Transcript (segment number, start time, speaker role, text):
${lines}

JSON shape:
{
 "callType": "short label, e.g. Internet upgrade",
 "callTypeTags": ["Internet Upgrade","Two Account Setup",...],
 "agentName": "as stated in the call, or null",
 "customerName": "as stated, or null",
 "businessName": "as stated, or null",
 "dimensions": {"<key>": {"score": number|null, "finding": "one or two sentences", "evidence": [{"segment": n, "quote": "verbatim"}]}},
 "rules": [{"rule": "exact rule text", "result": "PASS|FAIL|PARTIAL|NOT_APPLICABLE", "explanation": "why", "evidence": [{"segment": n, "quote": "verbatim"}]}],
 "complianceChecks": [{"check": "e.g. Recorded-line/disclosure, authorised decision maker confirmed, pricing stated accurately, contract terms disclosed, consent before changes", "result": "PASS|FAIL|PARTIAL|NOT_APPLICABLE", "severity": "critical|major|minor", "evidence": [...]}],
 "callTypeRules": [{"rule": "rule specific to this call type (e.g. for an upgrade: new price and term confirmed)", "result": "...", "evidence": [...]}],
 "risks": [{"level": "high|medium|low", "description": "...", "evidence": [...]}],
 "sentiment": {"customer": "Positive|Neutral|Negative|Mixed", "agent": "e.g. Helpful, Rushed, Confident", "trajectory": "how the customer's mood changed"},
 "executiveSummary": "a paragraph citing [mm:ss] times",
 "wentWell": [{"title": "...", "detail": "...", "evidence": [...]}],
 "toImprove": [{"title": "...", "detail": "...", "severity": "yellow|red", "evidence": [...]}],
 "coaching": [{"recommendation": "...", "why": "...", "example": "a better line the agent could have said, or null"}],
 "keyMoments": [{"segment": n, "description": "...", "evidence": [{"segment": n, "quote": "..."}]}]
}`,
  });

  const v = makeVerifier(segments);
  const dims = DIMENSIONS.map((d) => {
    const r = raw.dimensions?.[d.key] ?? {};
    const score = clamp(r.score);
    return { key: d.key, label: d.label, score, rating: ratingOf(score), finding: String(r.finding ?? ""), evidence: v.list(r.evidence) };
  });
  const dimScore = new Map(dims.map((d) => [d.key, d.score]));
  const avg = (keys: DimKey[]) => {
    const vals = keys.map((k) => dimScore.get(k)).filter((x): x is number => x !== null && x !== undefined);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };
  const cat = Object.fromEntries(Object.entries(CATEGORIES).map(([k, c]) => [k, avg(c.dims)]));
  const wSum = Object.entries(CATEGORIES).reduce((a, [k, c]) => a + (cat[k] !== null ? c.weight : 0), 0);
  const quality = wSum ? Object.entries(CATEGORIES).reduce((a, [k, c]) => a + (cat[k] ?? 0) * c.weight, 0) / wSum : 0;

  // Every configured rule gets a verdict, even if the model skipped one.
  const rules = params.rules.map((r) => {
    const got = (raw.rules ?? []).find((x: any) => norm(String(x.rule ?? "")) === norm(r.rule)) ?? (raw.rules ?? [])[params.rules.indexOf(r)];
    const evidence = v.list(got?.evidence);
    let result = asResult(got?.result);
    // A PASS needs proof in the transcript.
    if (result === "PASS" && !evidence.some((e) => e.verified)) result = "PARTIAL";
    // Mandatory rules always apply: not said means not done.
    if (r.mandatory && result === "NOT_APPLICABLE") result = "FAIL";
    return {
      rule: r.rule,
      mandatory: r.mandatory,
      result,
      explanation:
        result === "FAIL" && !evidence.some((e) => e.verified)
          ? "Not found in transcript"
          : String(got?.explanation ?? (got ? "" : "Not evaluated by the model; treated as not found.")),
      evidence,
    };
  });
  const applicable = rules.filter((r) => r.result !== "NOT_APPLICABLE");
  const rulesScore = applicable.length
    ? Math.round((applicable.reduce((a, r) => a + (r.result === "PASS" ? 1 : r.result === "PARTIAL" ? 0.5 : 0), 0) / applicable.length) * 100)
    : null;
  const overall = Math.round(rulesScore === null ? quality : quality * (1 - RULES_WEIGHT) + rulesScore * RULES_WEIGHT);

  const complianceChecks = (raw.complianceChecks ?? []).map((c: any) => ({
    check: String(c.check ?? ""),
    result: asResult(c.result),
    severity: (["critical", "major", "minor"].includes(c.severity) ? c.severity : "major") as "critical" | "major" | "minor",
    evidence: v.list(c.evidence),
  }));
  const risks = (raw.risks ?? []).map((r: any) => ({
    level: (["high", "medium", "low"].includes(r.level) ? r.level : "medium") as "high" | "medium" | "low",
    description: String(r.description ?? ""),
    evidence: v.list(r.evidence),
  }));
  const mandatoryFail = rules.some((r) => r.mandatory && r.result === "FAIL");
  const criticalFail = complianceChecks.some((c: any) => c.severity === "critical" && c.result === "FAIL");
  const pass = overall >= PASS_MARK && !mandatoryFail && !criticalFail;
  const needsReview = !pass || rules.some((r) => r.result === "PARTIAL") || risks.some((r: any) => r.level === "high");

  const wentWell: Finding[] = (raw.wentWell ?? []).map((f: any) => ({ title: String(f.title ?? ""), detail: String(f.detail ?? ""), rating: "green" as Rating, evidence: v.list(f.evidence) }));
  const toImprove: Finding[] = (raw.toImprove ?? []).map((f: any) => ({
    title: String(f.title ?? ""),
    detail: String(f.detail ?? ""),
    rating: (f.severity === "red" ? "red" : "yellow") as Rating,
    evidence: v.list(f.evidence),
  }));
  // Rule and compliance failures are always red findings.
  const failedRules: Finding[] = rules
    .filter((r) => r.result === "FAIL")
    .map((r) => ({ title: r.rule, detail: r.explanation || "Not found in transcript", rating: "red" as Rating, evidence: r.evidence }));
  const partialRules: Finding[] = rules
    .filter((r) => r.result === "PARTIAL")
    .map((r) => ({ title: r.rule, detail: r.explanation, rating: "yellow" as Rating, evidence: r.evidence }));

  const report: QcReport = {
    callType: String(raw.callType ?? "Call"),
    callTypeTags: Array.isArray(raw.callTypeTags) ? raw.callTypeTags.map(String).slice(0, 5) : [],
    agentName: params.agentName || raw.agentName || null,
    customerName: raw.customerName || null,
    businessName: params.businessName || raw.businessName || null,
    scores: {
      overall,
      compliance: cat.compliance ?? 0,
      communication: cat.communication ?? 0,
      sales: cat.sales ?? 0,
      resolution: cat.resolution ?? 0,
      customerExperience: cat.customer_experience ?? 0,
      rules: rulesScore,
    },
    categoryWeights: Object.fromEntries(Object.entries(CATEGORIES).map(([k, c]) => [k, c.weight])),
    rulesWeight: RULES_WEIGHT,
    pass,
    needsReview,
    dimensions: dims,
    rules,
    complianceChecks,
    callTypeRules: (raw.callTypeRules ?? []).map((c: any) => ({ rule: String(c.rule ?? ""), result: asResult(c.result), evidence: v.list(c.evidence) })),
    risks,
    sentiment: {
      customer: String(raw.sentiment?.customer ?? "Neutral"),
      agent: String(raw.sentiment?.agent ?? "Neutral"),
      trajectory: String(raw.sentiment?.trajectory ?? ""),
    },
    executiveSummary: String(raw.executiveSummary ?? ""),
    wentWell,
    toImprove,
    coaching: (raw.coaching ?? []).map((c: any) => ({ recommendation: String(c.recommendation ?? ""), why: String(c.why ?? ""), example: c.example ? String(c.example) : null })),
    keyMoments: (raw.keyMoments ?? []).map((k: any) => {
      const evidence = v.list(k.evidence);
      const seg = Number.isInteger(k.segment) && segments[k.segment] ? segments[k.segment] : null;
      return { timestamp: evidence.find((e) => e.verified)?.timestamp ?? (seg ? fmt(seg.start) : null), description: String(k.description ?? ""), evidence };
    }),
    findings: {
      green: wentWell,
      yellow: [...partialRules, ...toImprove.filter((f) => f.rating === "yellow")],
      red: [...failedRules, ...toImprove.filter((f) => f.rating === "red")],
    },
    evidenceStats: { cited: 0, verified: 0 },
    model: MODEL,
  };
  report.evidenceStats = v.stats();
  return report;
}
