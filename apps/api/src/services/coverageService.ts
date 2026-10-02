import { pool } from "../db/pool.js";
import { parseNpaNxx } from "../utils/phone.js";
import { resolveOne, type Resolution, type Source } from "./phoneIntel/engine.js";
import { carrierLabel } from "./phoneIntel/normalize.js";


export interface CoverageLookupResult {
  phoneOriginal: string;
  phoneE164: string;
  npa: string | null;
  nxx: string | null;
  predictedCarrier: string | null;
  lineType: string | null;
  confidence: number | null;
  verificationStatus: "unverified" | "predicted" | "verified" | "cached";
  usedCache: boolean;
  verified: boolean;
  budgetExceeded: boolean;
  error?: string;
  // Added by the intelligence engine.
  phone: string;
  carrier: string | null;
  carrierEntity: string | null; // licensed company, e.g. "New Cingular Wireless PCS"
  carrierNetwork: string | null; // family, e.g. "AT&T Wireless"
  confidencePct: number | null;
  source: Source | null;
  twilioUsed: boolean;
  prefixTrust: string | null;
  portabilityDetected?: boolean;
  reasons?: string[];
  withheld?: boolean;
  likelyLineType?: string | null;
}

export function toLookupResult(original: string, e164: string | null, r: Resolution | null, extra: { budgetExceeded: boolean; error?: string | null }): CoverageLookupResult {
  return {
    phoneOriginal: original,
    phoneE164: e164 ?? "",
    phone: e164 ?? "",
    npa: r?.npa ?? null,
    nxx: r?.nxx ?? null,
    predictedCarrier: r ? carrierLabel(r.carrierEntity, r.carrier) : null,
    carrier: r ? carrierLabel(r.carrierEntity, r.carrier) : null,
    carrierEntity: r?.carrierEntity ?? null,
    carrierNetwork: r?.carrier ?? null,
    lineType: r?.lineType ?? null,
    confidence: r ? Math.round(r.confidence * 1000) / 1000 : null,
    confidencePct: r ? Math.round(r.confidence * 100) : null,
    source: r?.source ?? null,
    verificationStatus: !r ? "unverified" : r.source === "twilio_validated" ? "verified" : r.source === "twilio_cache" ? "cached" : "predicted",
    usedCache: r?.source === "twilio_cache",
    verified: r?.verified ?? false,
    twilioUsed: r?.twilioUsed ?? false,
    prefixTrust: r?.prefixTrust ?? null,
    portabilityDetected: r?.portabilityDetected,
    reasons: r?.reasons,
    withheld: r?.withheld,
    likelyLineType: r?.likelyLineType ?? null,
    budgetExceeded: extra.budgetExceeded,
    ...(extra.error ? { error: extra.error } : {}),
  };
}

// NUMBER -> NORMALIZE -> HISTORY / NPA-NXX INTELLIGENCE -> CONFIDENCE ->
// SELECTIVE TWILIO VALIDATION (within the daily budget) -> WRITE-BACK.
export async function lookupPhone(params: {
  organizationId: string;
  requestedBy?: string;
  rawPhone: string;
  forceVerify?: boolean;
}): Promise<CoverageLookupResult> {
  const out = await resolveOne(params.organizationId, params.rawPhone, { forceVerify: params.forceVerify });
  const result = toLookupResult(params.rawPhone, out.e164, out.resolution, { budgetExceeded: out.budgetExceeded, error: out.error });
  if (out.e164) await recordLookup(params.organizationId, params.requestedBy, params.rawPhone, out.e164, result);
  return result;
}

export async function recordLookup(organizationId: string, requestedBy: string | undefined, original: string, e164: string, r: CoverageLookupResult) {
  const npaNxx = parseNpaNxx(e164);
  await pool.query(
    `insert into coverage_lookups (organization_id, requested_by, phone_original, phone_e164, npa, nxx, predicted_carrier, confidence,
       used_cache, line_type, source, twilio_used)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [organizationId, requestedBy ?? null, original, e164, npaNxx?.npa ?? null, npaNxx?.nxx ?? null, r.carrier, r.confidence, r.usedCache, r.lineType, r.source, r.twilioUsed]
  );
}

// Accuracy here is measured from Twilio audits and corrections against
// what the engine predicted — never assumed from Twilio usage.
export async function getCoverageStats(organizationId: string) {
  const [q, lookups] = await Promise.all([
    pool.query(
      // Random audits only: corrections are chosen because they were uncertain,
      // so they'd understate accuracy.
      `select count(*)::int as n, count(*) filter (where correct)::int as ok
       from intel_quality_samples where organization_id = $1 and kind = 'audit' and created_at > now() - interval '30 days'`,
      [organizationId]
    ),
    pool.query(
      `select count(*)::int as n,
              count(*) filter (where created_at > now() - interval '30 days')::int as n30,
              count(*) filter (where created_at > now() - interval '30 days' and not coalesce(twilio_used, false))::int as engine30
       from coverage_lookups where organization_id = $1`,
      [organizationId]
    ),
  ]);
  const n = q.rows[0].n;
  const l = lookups.rows[0];
  return {
    totalPredictions: l.n,
    verifiedPredictions: n,
    correctPredictions: q.rows[0].ok,
    incorrectPredictions: n - q.rows[0].ok,
    observedAccuracy: n > 0 ? q.rows[0].ok / n : null,
    // Share of the last 30 days' lookups the engine answered without Twilio.
    engineShare30d: l.n30 ? l.engine30 / l.n30 : null,
  };
}
