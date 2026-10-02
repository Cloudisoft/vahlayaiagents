import { pool } from "../../db/pool.js";
import { chatJson } from "../../services/openaiService.js";
import { OPPORTUNITIES, industryByKey, opportunityByKey } from "./taxonomy.js";
import type { SourceLocation } from "./sources/types.js";

export const QUALIFY_MODEL = "gpt-4o-mini";

export interface Criteria {
  industry: string | null;
  keywords: string;
  services: string; // what the target businesses sell / do
  locations: SourceLocation[];
  website: "any" | "has" | "missing";
  requirePhone: boolean;
  requireEmail: boolean;
  size: "any" | "single" | "multi";
  opportunities: string[]; // what the user sells (opportunity keys)
  idealCustomer: string;
  qualifyThreshold: number;
}

const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();

export function locationMatch(lead: { city?: string | null; state?: string | null; zip?: string | null; country?: string | null }, locs: SourceLocation[]): { score: number; reason: string } {
  if (!locs.length) return { score: 100, reason: "No location filter" };
  let best = { score: 0, reason: "Outside the target locations" };
  for (const l of locs) {
    if ((l.country ?? "US").toUpperCase() !== (lead.country ?? "US").toUpperCase()) continue;
    let s = 0;
    let r = "";
    if (l.zip) [s, r] = lead.zip === l.zip ? [100, `In ZIP ${l.zip}`] : [0, ""];
    else if (l.city) [s, r] = lc(lead.city) === lc(l.city) && (!l.state || lc(lead.state) === lc(l.state) || !lead.state) ? [100, `In ${l.city}`] : lc(lead.state) && lc(lead.state) === lc(l.state) ? [60, `Same state (${lead.state}), different city`] : [0, ""];
    else if (l.state) [s, r] = lc(lead.state) === lc(l.state) ? [100, `In ${l.state}`] : [0, ""];
    else [s, r] = [100, "In the target country"];
    if (s > best.score) best = { score: s, reason: r };
  }
  if (best.score === 0 && !lead.city && !lead.state && !lead.zip) return { score: 50, reason: "Location not stated by the source (found by searching the area)" };
  return best;
}

interface AiQual {
  industry_match: { score: number; reason: string };
  fit: { score: number; reason: string };
  opportunities: Array<{ key: string; strength: number; reason: string; evidence: string[] }>;
  summary: string;
  concerns: string[];
}

// The facts the AI may use — only data we collected, each with a key the
// AI must cite.
export function leadFacts(lead: any, multiLocation: boolean) {
  const v = lead.validation ?? {};
  const facts: Record<string, unknown> = {
    name: lead.business_name,
    category: lead.category ?? null,
    description: lead.description ?? null,
    location: [lead.city, lead.state, lead.country].filter(Boolean).join(", ") || null,
    website: lead.website ? lead.website_domain : null,
    website_status: lead.website_status ?? null,
    website_findings: lead.enrichment?.website?.reasons ?? null,
    website_title: lead.enrichment?.website?.signals?.title ?? null,
    website_platform: lead.enrichment?.website?.signals?.generator ?? null,
    has_contact_form: lead.enrichment?.website?.signals?.hasForm ?? null,
    phone: lead.main_phone_e164 ? (v.phone?.valid ? "valid" : "unverified") : "none",
    email: lead.business_email ? (v.email?.valid ? `valid${v.email.role ? " (generic inbox)" : ""}` : "unverified") : "none",
    social_profiles: (lead.social_urls ?? []).length,
    locations: multiLocation ? "multiple locations share this website" : "single location found",
    business_status: lead.enrichment?.businessStatus ?? null,
  };
  for (const k of Object.keys(facts)) if (facts[k] == null || facts[k] === "") delete facts[k];
  return facts;
}

export function mustHaveFailures(lead: any, c: Criteria, multiLocation: boolean): string[] {
  const out: string[] = [];
  const hasSite = lead.website && lead.website_status !== "unreachable";
  if (c.website === "has" && !hasSite) out.push("No working website (required)");
  if (c.website === "missing" && hasSite) out.push("Already has a working website (looking for businesses without one)");
  if (c.requirePhone && !lead.validation?.phone?.valid) out.push("No valid phone number (required)");
  if (c.requireEmail && !lead.validation?.email?.valid) out.push("No valid email address (required)");
  if (c.size === "multi" && !multiLocation) out.push("Single location (looking for multi-location businesses)");
  if (c.size === "single" && multiLocation) out.push("Multi-location business (looking for single locations)");
  return out;
}

export function scoreLead(p: { fit: number; industry: number; location: number; completeness: number; topOpportunity: number }) {
  return Math.round(0.3 * p.fit + 0.2 * p.industry + 0.15 * p.location + 0.15 * p.completeness + 0.2 * p.topOpportunity);
}

const arr = <T,>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : x == null || x === "" ? [] : [x as T]);
const clamp = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

// AI QUALIFICATION against one job's criteria.
export async function qualifyLead(leadId: string, jobId: string | null) {
  const lead = (await pool.query("select * from leads where id = $1", [leadId])).rows[0];
  if (!lead) return;
  const job = jobId ? (await pool.query("select criteria, organization_id from discovery_jobs where id = $1", [jobId])).rows[0] : null;
  const c: Criteria = {
    industry: null, keywords: "", services: "", locations: [], website: "any", requirePhone: false, requireEmail: false, size: "any", opportunities: [], idealCustomer: "", qualifyThreshold: 70,
    ...(job?.criteria ?? {}),
  };
  const multi = lead.website_domain
    ? Number((await pool.query("select count(distinct lower(coalesce(city,''))) as n from leads where organization_id = $1 and website_domain = $2", [lead.organization_id, lead.website_domain])).rows[0].n) > 1
    : false;
  const facts = leadFacts(lead, multi);
  const allowed = c.opportunities.length ? c.opportunities.filter((k) => opportunityByKey(k)) : OPPORTUNITIES.map((o) => o.key);
  const ind = industryByKey(c.industry);

  const ai = await chatJson<AiQual>({
    organizationId: lead.organization_id,
    model: QUALIFY_MODEL,
    temperature: 0,
    seed: 5,
    maxTokens: 1200,
    system: `You qualify B2B sales leads. Use ONLY the FACTS given. Never assume revenue, employee counts, owners, software they use or anything not in the facts. Every opportunity must cite the fact keys that support it in "evidence". The ideal-customer text describes what the user wants — it is NOT a fact about this business; never restate it as one (e.g. don't call a business "residential" or "owner-run" unless a fact says so). If facts are thin, say so and score lower. JSON only.`,
    user: `TARGET
Industry: ${ind?.label ?? "any"}${c.keywords ? ` · keywords: ${c.keywords}` : ""}${c.services ? ` · services/products: ${c.services}` : ""}
Ideal customer: ${c.idealCustomer || "not specified"}

OPPORTUNITIES (choose only from these keys):
${allowed.map((k) => `- ${k}: ${opportunityByKey(k)!.label} — ${opportunityByKey(k)!.hint}`).join("\n")}

FACTS
${JSON.stringify(facts, null, 1)}

Return JSON:
{"industry_match":{"score":0-100,"reason":string},
 "fit":{"score":0-100 how well it matches the ideal customer,"reason":string},
 "opportunities":[{"key":string,"strength":0-100,"reason":string,"evidence":[fact keys]}] (best first, at most 3, only if supported),
 "summary":"2-3 sentence qualification summary for a salesperson",
 "concerns":[string]}`,
  });

  const factKeys = new Set(Object.keys(facts));
  // "website_findings[0]", "Website Status" or "phone: valid" all cite a real fact key.
  const factKey = (e: unknown): string | null => {
    const k = String(e ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_").match(/^[a-z_]+/)?.[0]?.replace(/_+$/, "") ?? "";
    return factKeys.has(k) ? k : null;
  };
  const proposed = arr<AiQual["opportunities"][number]>(ai.opportunities);
  const discarded = proposed
    .filter((o) => !o || !allowed.includes(o.key) || !arr<string>(o.evidence).map(factKey).some((e) => e !== null))
    .map((o) => ({ key: o?.key ?? null, reason: !o || !allowed.includes(o.key) ? "not one of the target opportunities" : "no supporting fact cited", cited: arr<string>(o?.evidence).map(String) }));
  const opportunities = proposed
    .filter((o) => o && allowed.includes(o.key))
    .map((o) => ({ key: o.key, label: opportunityByKey(o.key)!.label, strength: clamp(o.strength), reason: String(o.reason ?? "").slice(0, 300), evidence: Array.from(new Set(arr<string>(o.evidence).map(factKey).filter((e): e is string => e !== null))) }))
    .filter((o) => o.evidence.length > 0)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 3);
  // Deterministic website opportunity: it rests on our own check, not the AI.
  if (allowed.includes("website_development") && ["none", "unreachable", "weak"].includes(lead.website_status) && !opportunities.some((o) => o.key === "website_development")) {
    opportunities.push({ key: "website_development", label: "Website development", strength: lead.website_status === "none" ? 90 : lead.website_status === "unreachable" ? 80 : 65, reason: (lead.enrichment?.website?.reasons ?? []).join("; ") || "No website", evidence: ["website_status"] });
    opportunities.sort((a, b) => b.strength - a.strength);
  }

  const loc = locationMatch(lead, c.locations);
  const industry = { score: clamp(ai.industry_match?.score), reason: String(ai.industry_match?.reason ?? "").slice(0, 300) };
  const fit = { score: clamp(ai.fit?.score), reason: String(ai.fit?.reason ?? "").slice(0, 400) };
  const completenessScore = lead.completeness ?? 0;
  const top = opportunities[0]?.strength ?? 0;
  const leadScore = scoreLead({ fit: fit.score, industry: industry.score, location: loc.score, completeness: completenessScore, topOpportunity: top });
  const failures = mustHaveFailures(lead, c, multi);
  const threshold = c.qualifyThreshold || 70;
  const status = failures.length ? "disqualified" : leadScore >= threshold ? "qualified" : leadScore >= threshold - 20 ? "needs_review" : "disqualified";
  const qualification = {
    model: QUALIFY_MODEL,
    at: new Date().toISOString(),
    jobId,
    leadScore,
    fit,
    industry,
    location: loc,
    completeness: completenessScore,
    opportunities,
    summary: String(ai.summary ?? "").slice(0, 800),
    concerns: arr<unknown>(ai.concerns).map(String).slice(0, 5),
    mustHaveFailures: failures,
    discardedOpportunities: discarded,
    multiLocation: multi,
    formula: "30% fit + 20% industry match + 15% location match + 15% data completeness + 20% top opportunity",
    threshold,
    factsUsed: Object.keys(facts),
  };
  await pool.query(
    `update leads set qualification = $2, lead_score = $3, fit_score = $4, qualification_status = $5, primary_opportunity = $6, opportunities = $7,
       qualified_at = now(), qualified_for_job = $8, pipeline_status = 'qualified', pipeline_error = null, pipeline_attempts = 0, pipeline_locked_at = null, updated_at = now()
     where id = $1`,
    [leadId, JSON.stringify(qualification), leadScore, fit.score, status, opportunities[0]?.key ?? null, opportunities.map((o) => o.key), jobId]
  );
}
