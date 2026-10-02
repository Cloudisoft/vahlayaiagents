import { pool } from "../../db/pool.js";
import { normalizeE164 } from "../../utils/phone.js";
import { lookupCarrier, ProviderNotConfiguredError } from "../twilioLookupService.js";
import { commit, release, reserve, budgetState, countLocal } from "./budget.js";
import { carrierEntity, lineTypeFromTwilio, normalizeCarrier, npaNxx, type LineType } from "./normalize.js";
import { HALF_LIFE_DAYS, recomputeCarriers, recomputePrefixes, rebuildPhones } from "./recompute.js";

export type Source =
  | "twilio_validated" // Twilio checked it just now
  | "twilio_cache" // Twilio checked it recently
  | "phone_record" // this exact number was seen before
  | "prefix_intelligence"
  | "carrier_intelligence"
  | "neighbor_prefix"
  | "historical_inference" // area-code level
  | "unknown";

export interface Resolution {
  phone: string;
  npa: string | null;
  nxx: string | null;
  carrier: string | null; // network family, e.g. "AT&T Wireless"
  carrierEntity: string | null; // licensed company, e.g. "New Cingular Wireless PCS"
  lineType: LineType;
  confidence: number; // 0..1, a measured probability where calibration exists
  source: Source;
  verified: boolean;
  twilioUsed: boolean;
  prefixTrust: string | null;
  portabilityDetected?: boolean;
  reasons: string[];
  // Precision mode: below the accuracy target the type isn't asserted;
  // the best guess is kept here instead.
  withheld?: boolean;
  likelyLineType?: LineType;
}

export const DEFAULT_ACCURACY_TARGET = 0.93;
export async function accuracyTarget(organizationId: string): Promise<number> {
  const r = await pool.query("select accuracy_target from coverage_budgets where organization_id = $1", [organizationId]);
  const t = Number(r.rows[0]?.accuracy_target);
  return Number.isFinite(t) && t > 0.5 && t < 1 ? t : DEFAULT_ACCURACY_TARGET;
}

// Only answers measured to be right at least `target` of the time are
// classified; the rest say "unknown" with their best guess alongside.
export function applyTarget(r: Resolution, target: number): Resolution {
  if (r.verified || r.lineType === "unknown" || r.confidence >= target) return r;
  return {
    ...r,
    withheld: true,
    likelyLineType: r.lineType,
    lineType: "unknown",
    reasons: [...r.reasons, `Not classified: ${Math.round(r.confidence * 100)}% is below the ${Math.round(target * 100)}% accuracy target`],
  };
}

// Floor for preferring a tier's answer over a more confident lower tier.
// Twilio is decided by the accuracy target (see verificationReason).
export const VERIFY_BELOW = 0.85;
const TWILIO_FRESH_DAYS = 180;
// A known number's line type changed on re-check only ~0.4% of the time in
// the historical files (47 of 11,026), i.e. about 1% a year. Confidence
// decays from there with age.
const PHONE_RECORD_BASE = 0.99;
const PHONE_RECORD_ANNUAL_DRIFT = 0.04;

const ageDays = (d: Date | string | null) => (d ? (Date.now() - new Date(d).getTime()) / 86400000 : Infinity);

interface PrefixRow {
  npa: string;
  nxx: string;
  dominant_type: LineType | null;
  confidence: number;
  trust: string;
  top_carrier: string | null;
  known_obs: number;
  last_seen: string | null;
  twilio_validations: number;
  twilio_contradictions: number;
}

interface Context {
  phones: Map<string, any>;
  prefixes: Map<string, PrefixRow>;
  blocks: Map<string, { dom: LineType; share: number; n: number }>;
  npas: Map<string, { dom: LineType; share: number; n: number }>;
  carriers: Map<string, { dominant_type: LineType; confidence: number }>;
  prefixEntities: Map<string, string>; // npa+nxx -> most common licensed company of its top carrier
  calib: Map<string, number>; // "signal:bucket" -> accuracy
}

// One batch load serves 1 or 20,000 numbers alike.
export async function loadContext(e164s: string[]): Promise<Context> {
  const pns = e164s.map(npaNxx).filter(Boolean) as Array<{ npa: string; nxx: string }>;
  const npaList = [...new Set(pns.map((p) => p.npa))];
  const blockKeys = [...new Set(pns.map((p) => p.npa + p.nxx.slice(0, 2)))];
  const [phones, prefixes, blocks, npas, calib] = await Promise.all([
    pool.query("select * from phone_intelligence where phone_e164 = any($1::text[])", [e164s]),
    pool.query(
      `select npa, nxx, dominant_type, confidence, trust, top_carrier, known_obs, last_seen, twilio_validations, twilio_contradictions
       from prefix_intelligence where (npa, nxx) in (select * from unnest($1::text[], $2::text[]))`,
      [pns.map((p) => p.npa), pns.map((p) => p.nxx)]
    ),
    // Neighbouring prefixes: same area code, same first two NXX digits.
    pool.query(
      `select npa || substr(nxx, 1, 2) as k, sum(w_mobile) m, sum(w_landline) l, sum(w_voip) v, sum(known_obs)::int n
       from prefix_intelligence where npa || substr(nxx, 1, 2) = any($1::text[]) group by 1`,
      [blockKeys]
    ),
    pool.query(
      `select npa as k, sum(w_mobile) m, sum(w_landline) l, sum(w_voip) v, sum(known_obs)::int n
       from prefix_intelligence where npa = any($1::text[]) group by 1`,
      [npaList]
    ),
    pool.query("select signal, bucket, n, correct from intel_calibration where n >= 30"),
  ]);
  const entities = await pool.query(
    `select npa || nxx as k, carrier, carrier_raw, count(*)::int as n from phone_intelligence
     where (npa, nxx) in (select * from unnest($1::text[], $2::text[])) and carrier_raw is not null
     group by 1, 2, 3`,
    [pns.map((p) => p.npa), pns.map((p) => p.nxx)]
  );
  const topCarrier = new Map(prefixes.rows.map((r) => [r.npa + r.nxx, r.top_carrier]));
  const prefixEntities = new Map<string, { name: string; n: number }>();
  for (const r of entities.rows) {
    if (r.carrier !== topCarrier.get(r.k)) continue;
    const name = carrierEntity(r.carrier_raw);
    const cur = prefixEntities.get(r.k);
    if (name && (!cur || r.n > cur.n)) prefixEntities.set(r.k, { name, n: r.n });
  }
  const agg = (rows: any[]) =>
    new Map(
      rows.map((r) => {
        const m = Number(r.m), l = Number(r.l), v = Number(r.v);
        const tot = m + l + v;
        const dom: LineType = m >= l && m >= v ? "mobile" : l >= v ? "landline" : "voip";
        return [r.k, { dom, share: tot ? Math.max(m, l, v) / tot : 0, n: r.n }];
      })
    );
  const carrierNames = [...new Set([...phones.rows.map((p) => p.carrier), ...prefixes.rows.map((p) => p.top_carrier)].filter(Boolean))];
  const carriers = await pool.query("select carrier, dominant_type, confidence from carrier_statistics where carrier = any($1::text[])", [carrierNames]);
  return {
    phones: new Map(phones.rows.map((r) => [r.phone_e164, r])),
    prefixes: new Map(prefixes.rows.map((r) => [r.npa + r.nxx, { ...r, confidence: Number(r.confidence) }])),
    blocks: agg(blocks.rows),
    npas: agg(npas.rows),
    carriers: new Map(carriers.rows.map((r) => [r.carrier, { dominant_type: r.dominant_type, confidence: Number(r.confidence) }])),
    calib: new Map(calib.rows.map((r) => [`${r.signal}:${r.bucket}`, r.correct / r.n])),
    prefixEntities: new Map([...prefixEntities].map(([k, v]) => [k, v.name])),
  };
}

// Measured accuracy of an area-level majority, from that level's own
// holdout calibration; without one, a cautious discount of the raw share.
function areaConfidence(ctx: Context, signal: "neighbor" | "area", share: number, n: number) {
  if (n < 10) return 0;
  const measured = ctx.calib.get(`${signal}:${Math.min(9, Math.floor(share * 10))}`);
  return Math.max(0, Math.min(0.95, measured ?? share * 0.7));
}

// The lookup hierarchy. Each tier yields a candidate; the first one that is
// confident enough wins, otherwise the most confident candidate does.
export function resolveLocal(e164: string, ctx: Context): Resolution {
  const pn = npaNxx(e164);
  const base = { phone: e164, npa: pn?.npa ?? null, nxx: pn?.nxx ?? null, verified: false, twilioUsed: false };
  const rec = ctx.phones.get(e164);
  const prefix = pn ? ctx.prefixes.get(pn.npa + pn.nxx) ?? null : null;
  const candidates: Resolution[] = [];
  const recEntity = carrierEntity(rec?.carrier_raw);
  const prefixEntity = pn ? ctx.prefixEntities.get(pn.npa + pn.nxx) ?? null : null;

  // 1. Recent Twilio validation of this number.
  if (rec?.twilio_validated_at && ageDays(rec.twilio_validated_at) <= TWILIO_FRESH_DAYS && rec.line_type !== "unknown") {
    return { ...base, carrier: rec.carrier, carrierEntity: recEntity, lineType: rec.line_type, confidence: 0.99, source: "twilio_cache", verified: true, prefixTrust: prefix?.trust ?? null, reasons: [`Twilio-validated ${Math.round(ageDays(rec.twilio_validated_at))} day(s) ago`] };
  }

  // 2. A record of this exact number (historical evidence, may be ported since).
  if (rec && rec.line_type !== "unknown") {
    let c = PHONE_RECORD_BASE * Math.pow(1 - PHONE_RECORD_ANNUAL_DRIFT, ageDays(rec.observed_at) / 365);
    const reasons = [`Seen as ${rec.line_type} on ${new Date(rec.observed_at).toISOString().slice(0, 10)}`];
    if (rec.conflicts > 0) {
      c = Math.min(c, 0.7);
      reasons.push("Its history has conflicting line types");
    }
    if (prefix?.trust === "drifting") {
      c *= 0.9;
      reasons.push("Its prefix shows recent porting");
    }
    candidates.push({ ...base, carrier: rec.carrier, carrierEntity: recEntity, lineType: rec.line_type, confidence: c, source: "phone_record", prefixTrust: prefix?.trust ?? null, reasons });
  }

  // 3. NPA-NXX intelligence.
  if (prefix?.dominant_type) {
    candidates.push({
      ...base,
      carrier: prefix.top_carrier,
      carrierEntity: prefixEntity,
      lineType: prefix.dominant_type,
      confidence: prefix.confidence,
      source: "prefix_intelligence",
      prefixTrust: prefix.trust,
      reasons: [`${prefix.npa}-${prefix.nxx}: ${prefix.trust}, ${prefix.known_obs} known number(s)`],
    });
  }

  // 4. Carrier intelligence: a known carrier whose numbers are almost all one type.
  const carrierName = rec?.carrier ?? null;
  const cs = carrierName ? ctx.carriers.get(carrierName) : null;
  if (cs?.dominant_type && cs.confidence >= 0.9) {
    candidates.push({
      ...base,
      carrier: carrierName,
      carrierEntity: recEntity,
      lineType: cs.dominant_type,
      confidence: Math.min(0.95, cs.confidence * (rec ? Math.pow(1 - PHONE_RECORD_ANNUAL_DRIFT, ageDays(rec.observed_at) / 365) : 1)),
      source: "carrier_intelligence",
      prefixTrust: prefix?.trust ?? null,
      reasons: [`${carrierName} numbers are ${Math.round(cs.confidence * 100)}%+ ${cs.dominant_type}`],
    });
  }

  // 5. Neighbouring prefixes, 6. area-code history.
  if (pn) {
    const blk = ctx.blocks.get(pn.npa + pn.nxx.slice(0, 2));
    if (blk) candidates.push({ ...base, carrier: null, carrierEntity: null, lineType: blk.dom, confidence: areaConfidence(ctx, "neighbor", blk.share, blk.n), source: "neighbor_prefix", prefixTrust: prefix?.trust ?? null, reasons: [`Neighbouring ${pn.npa}-${pn.nxx.slice(0, 2)}x prefixes`] });
    const area = ctx.npas.get(pn.npa);
    if (area) candidates.push({ ...base, carrier: null, carrierEntity: null, lineType: area.dom, confidence: areaConfidence(ctx, "area", area.share, area.n), source: "historical_inference", prefixTrust: prefix?.trust ?? null, reasons: [`Area code ${pn.npa} history`] });
  }

  const ordered = candidates.filter((c) => c.confidence > 0);
  const firstStrong = ordered.find((c) => c.confidence >= VERIFY_BELOW);
  const best = firstStrong ?? ordered.sort((a, b) => b.confidence - a.confidence)[0];
  if (best) {
    if (best.carrier) return best;
    const fromRec = !!rec?.carrier;
    return { ...best, carrier: rec?.carrier ?? prefix?.top_carrier ?? null, carrierEntity: fromRec ? recEntity : prefixEntity };
  }
  return { ...base, carrier: rec?.carrier ?? null, carrierEntity: recEntity, lineType: "unknown", confidence: 0, source: "unknown", prefixTrust: prefix?.trust ?? null, reasons: ["No evidence for this number or its prefix yet"] };
}

// Engine first: Twilio is only asked when the engine can't give an answer
// that meets the accuracy target. History conflicts, prefix drift and record
// age already lower the confidence, so they matter only through it. Returns
// why the engine fell short, or null when its answer stands.
export function verificationReason(r: Resolution, ctx: Context, target = VERIFY_BELOW): string | null {
  if (r.verified) return null;
  if (r.source === "unknown") return "no_engine_answer";
  if (r.confidence >= target) return null;
  const rec = ctx.phones.get(r.phone);
  const prefix = r.npa ? ctx.prefixes.get(r.npa + r.nxx!) : null;
  if (rec?.conflicts > 0) return "conflicting_history";
  if (prefix?.trust === "drifting") return "prefix_drifting";
  if (!prefix) return "new_prefix";
  if (r.source === "phone_record" && ageDays(rec?.observed_at) > 365) return "stale_record";
  return "below_target";
}

// Twilio call + write-back into numbers, prefixes and carriers, with
// portability detection. Budget must already be reserved by the caller.
async function validateWithTwilio(organizationId: string, e164: string, predicted: Resolution | null, kind: "correction" | "audit"): Promise<Resolution> {
  const result = await lookupCarrier(organizationId, e164);
  const lineType = lineTypeFromTwilio(result.lineType);
  const carrier = normalizeCarrier(result.carrierName);
  const pn = npaNxx(e164);
  const prev = await pool.query("select line_type, carrier, observed_at from phone_intelligence where phone_e164 = $1", [e164]);
  const before = prev.rows[0];

  await pool.query(
    `insert into coverage_verifications (organization_id, phone_e164, provider, provider_carrier, provider_line_type, raw_response, cost_usd, status)
     values ($1,$2,'twilio',$3,$4,$5,(select price_per_lookup_usd from coverage_budgets where organization_id = $1),'completed')`,
    [organizationId, e164, result.carrierName, result.lineType, JSON.stringify(result.raw)]
  );
  await pool.query(
    `insert into phone_observations (phone_e164, npa, nxx, line_type, carrier, carrier_raw, observed_at, source)
     values ($1,$2,$3,$4,$5,$6, now(), 'twilio') on conflict do nothing`,
    [e164, pn?.npa ?? null, pn?.nxx ?? null, lineType, carrier, result.carrierName]
  );
  await rebuildPhones([e164]);

  // Portability / drift.
  let ported = false;
  if (before && before.line_type !== "unknown" && lineType !== "unknown" && before.line_type !== lineType) {
    ported = true;
    await pool.query(
      `insert into portability_events (phone_e164, npa, nxx, previous_type, current_type, previous_carrier, current_carrier, previous_observed_at, kind)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'line_type_change')`,
      [e164, pn?.npa ?? null, pn?.nxx ?? null, before.line_type, lineType, before.carrier, carrier, before.observed_at]
    );
  } else if (before?.carrier && carrier && before.carrier !== carrier) {
    await pool.query(
      `insert into portability_events (phone_e164, npa, nxx, previous_type, current_type, previous_carrier, current_carrier, previous_observed_at, kind)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'carrier_change')`,
      [e164, pn?.npa ?? null, pn?.nxx ?? null, before.line_type, lineType, before.carrier, carrier, before.observed_at]
    );
  }
  if (pn) {
    // Did the prefix's own call agree with Twilio? That drives trust/drift.
    const pr = await pool.query("select dominant_type from prefix_intelligence where npa = $1 and nxx = $2", [pn.npa, pn.nxx]);
    const dom = pr.rows[0]?.dominant_type;
    if (dom && lineType !== "unknown") {
      await pool.query(
        `update prefix_intelligence set twilio_validations = twilio_validations + 1,
           twilio_agreements = twilio_agreements + $3, twilio_contradictions = twilio_contradictions + $4, last_twilio_at = now()
         where npa = $1 and nxx = $2`,
        [pn.npa, pn.nxx, dom === lineType ? 1 : 0, dom === lineType ? 0 : 1]
      );
    }
    await recomputePrefixes([pn]);
  }
  await recomputeCarriers([before?.carrier, carrier].filter(Boolean) as string[]);

  if (predicted && lineType !== "unknown") {
    await pool.query(
      `insert into intel_quality_samples (organization_id, phone_e164, kind, predicted_type, predicted_carrier, predicted_source,
         predicted_confidence, actual_type, actual_carrier, correct)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [organizationId, e164, kind, predicted.lineType, predicted.carrier, predicted.source, predicted.confidence, lineType, carrier, predicted.lineType === lineType]
    );
  }

  const prefix = pn ? (await pool.query("select trust from prefix_intelligence where npa = $1 and nxx = $2", [pn.npa, pn.nxx])).rows[0] : null;
  return {
    phone: e164,
    npa: pn?.npa ?? null,
    nxx: pn?.nxx ?? null,
    carrier: carrier ?? result.carrierName,
    carrierEntity: carrierEntity(result.carrierName),
    lineType,
    confidence: 1,
    source: "twilio_validated",
    verified: true,
    twilioUsed: true,
    prefixTrust: prefix?.trust ?? null,
    portabilityDetected: ported,
    reasons: ported ? [`Ported: was ${before.line_type}, now ${lineType}`] : ["Validated by Twilio just now"],
  };
}

// Reserve, call, commit/release. Null when the budget is spent or Twilio
// isn't usable; the caller keeps the local answer.
async function tryTwilio(organizationId: string, e164: string, predicted: Resolution | null, kind: "correction" | "audit") {
  const res = await reserve(organizationId);
  if (!res) return { resolution: null, budgetExceeded: true, error: null as string | null };
  try {
    const resolution = await validateWithTwilio(organizationId, e164, predicted, kind);
    await commit(organizationId, res);
    return { resolution, budgetExceeded: false, error: null };
  } catch (err) {
    await release(organizationId, res);
    return {
      resolution: null,
      budgetExceeded: false,
      error: err instanceof ProviderNotConfiguredError ? err.message : `Twilio validation failed: ${(err as Error).message}`,
    };
  }
}

// Share of each day's budget kept back for random audits of confident
// answers — the unbiased accuracy measurement.
const AUDIT_SHARE = 0.05;
const AUDIT_RATE = 0.01;

async function auditRoom(organizationId: string): Promise<boolean> {
  const b = await budgetState(organizationId);
  const r = await pool.query(
    "select count(*)::int as n from intel_quality_samples where organization_id = $1 and kind = 'audit' and created_at > now() - interval '24 hours'",
    [organizationId]
  );
  return b.remainingLookups > 0 && r.rows[0].n * b.priceUsd < b.limitUsd * AUDIT_SHARE;
}

// Single lookup: same engine; Twilio only when the answer is uncertain.
export async function resolveOne(organizationId: string, raw: string, opts: { forceVerify?: boolean } = {}) {
  const e164 = normalizeE164(raw);
  if (!e164) return { e164: null, resolution: null, budgetExceeded: false, error: "Not a valid phone number." };
  const ctx = await loadContext([e164]);
  const target = await accuracyTarget(organizationId);
  const guess = resolveLocal(e164, ctx);
  const local = applyTarget(guess, target);
  const reason = opts.forceVerify ? "forced" : verificationReason(guess, ctx, target);
  if (reason) {
    const t = await tryTwilio(organizationId, e164, guess, "correction");
    if (t.resolution) return { e164, resolution: t.resolution, budgetExceeded: false, error: null };
    await countLocal(organizationId, 1);
    return { e164, resolution: local, budgetExceeded: t.budgetExceeded, error: t.error };
  }
  // Confident local answer: occasionally audited so accuracy is measured,
  // not assumed. Audits may use at most AUDIT_SHARE of the day's budget.
  if (Math.random() < AUDIT_RATE && (await auditRoom(organizationId))) {
    const t = await tryTwilio(organizationId, e164, guess, "audit");
    if (t.resolution) return { e164, resolution: t.resolution, budgetExceeded: false, error: null };
  }
  await countLocal(organizationId, 1);
  return { e164, resolution: local, budgetExceeded: false, error: null };
}

export interface BulkSummary {
  total: number;
  valid: number;
  unique: number;
  twilioValidations: number;
  prefixesValidated: number;
  localResolved: number;
  budgetExceeded: boolean;
  twilioError: string | null;
  withheld: number;
  accuracyTarget: number;
  bySource: Record<string, number>;
  byLineType: Record<string, number>;
  engineShare: number; // share of unique numbers answered by the engine alone
}

// Bulk: resolve everything locally, then spend the limited budget where one
// validation teaches the most — one number per uncertain prefix, ranked by
// how many numbers in this batch it affects and how unsure we are. Each
// validation updates its prefix, and the batch is re-resolved afterwards.
export async function resolveBulk(
  organizationId: string,
  raws: string[],
  onProgress?: (done: number) => Promise<void>
): Promise<{ rows: Array<{ input: string; e164: string | null; resolution: Resolution | null; error: string | null }>; summary: BulkSummary }> {
  const normalized = raws.map((r) => ({ input: r, e164: normalizeE164(String(r ?? "")) }));
  const unique = [...new Set(normalized.map((n) => n.e164).filter(Boolean) as string[])];
  const CHUNK = 5000;
  const resolved = new Map<string, Resolution>();
  const reasons = new Map<string, string>();
  const target = await accuracyTarget(organizationId);
  for (let i = 0; i < unique.length; i += CHUNK) {
    const part = unique.slice(i, i + CHUNK);
    const ctx = await loadContext(part);
    for (const p of part) {
      const r = resolveLocal(p, ctx);
      resolved.set(p, r);
      const why = verificationReason(r, ctx, target);
      if (why) reasons.set(p, why);
    }
  }

  // Plan validations.
  const budget = await budgetState(organizationId);
  // Leave 20% of what's left today for single lookups made by people.
  let allowance = Math.floor(budget.remainingLookups * 0.8);
  const groups = new Map<string, { phones: string[]; uncertainty: number; reason: string; untrusted: boolean }>();
  for (const [phone, r] of resolved) {
    const reason = reasons.get(phone);
    if (!reason) continue;
    const key = r.npa ? r.npa + r.nxx : phone;
    const g = groups.get(key) ?? { phones: [], uncertainty: 0, reason, untrusted: r.prefixTrust !== "trusted" };
    g.phones.push(phone);
    g.uncertainty += 1 - r.confidence;
    groups.set(key, g);
  }
  // Information gain ≈ numbers helped now + future value of an untrusted prefix.
  const ranked = [...groups.entries()]
    .map(([key, g]) => ({ key, ...g, score: g.uncertainty + (g.untrusted ? 2 : 0) }))
    .sort((a, b) => b.score - a.score);

  let twilio = 0;
  let budgetExceeded = false;
  let failures = 0;
  let twilioError: string | null = null;
  const validatedPrefixes: Array<{ npa: string; nxx: string }> = [];
  for (const g of ranked) {
    if (allowance <= 0) {
      budgetExceeded = true;
      break;
    }
    // Validate the least-certain number of the prefix.
    const target = g.phones.sort((a, b) => resolved.get(a)!.confidence - resolved.get(b)!.confidence)[0];
    const t = await tryTwilio(organizationId, target, resolved.get(target)!, "correction");
    if (t.budgetExceeded) {
      budgetExceeded = true;
      break;
    }
    if (t.error) {
      twilioError = t.error;
      // Twilio down or misconfigured: stop trying, answer from local intelligence.
      if (/not configured/i.test(t.error) || ++failures >= 3) break;
      continue;
    }
    failures = 0;
    if (t.resolution) {
      resolved.set(target, t.resolution);
      twilio++;
      allowance--;
      if (t.resolution.npa) validatedPrefixes.push({ npa: t.resolution.npa, nxx: t.resolution.nxx! });
      if (onProgress && twilio % 25 === 0) await onProgress(twilio);
    }
  }

  // Re-resolve numbers in prefixes that just learned something.
  if (validatedPrefixes.length) {
    const touched = new Set(validatedPrefixes.map((p) => p.npa + p.nxx));
    const again = [...resolved.entries()].filter(([, r]) => !r.twilioUsed && r.npa && touched.has(r.npa + r.nxx)).map(([p]) => p);
    for (let i = 0; i < again.length; i += CHUNK) {
      const part = again.slice(i, i + CHUNK);
      const ctx = await loadContext(part);
      for (const p of part) resolved.set(p, resolveLocal(p, ctx));
    }
  }

  for (const [p, r] of resolved) resolved.set(p, applyTarget(r, target));
  await countLocal(organizationId, unique.length - twilio);
  const bySource: Record<string, number> = {};
  const byLineType: Record<string, number> = {};
  let withheld = 0;
  for (const r of resolved.values()) {
    if (r.withheld) withheld++;
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    byLineType[r.lineType] = (byLineType[r.lineType] ?? 0) + 1;
  }
  return {
    rows: normalized.map((n) => ({
      input: n.input,
      e164: n.e164,
      resolution: n.e164 ? resolved.get(n.e164) ?? null : null,
      error: n.e164 ? null : "Not a valid phone number.",
    })),
    summary: {
      total: raws.length,
      valid: normalized.filter((n) => n.e164).length,
      unique: unique.length,
      twilioValidations: twilio,
      prefixesValidated: new Set(validatedPrefixes.map((p) => p.npa + p.nxx)).size,
      localResolved: unique.length - twilio,
      budgetExceeded,
      twilioError,
      withheld,
      accuracyTarget: target,
      bySource,
      byLineType,
      engineShare: unique.length ? (unique.length - twilio) / unique.length : 1,
    },
  };
}

export { HALF_LIFE_DAYS };
