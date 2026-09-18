import { pool } from "../db/pool.js";
import { normalizeUsE164, parseNpaNxx } from "../utils/phone.js";
import { lookupCarrier, TWILIO_LOOKUP_COST_USD, ProviderNotConfiguredError } from "./twilioLookupService.js";

const CONFIDENCE_VERIFICATION_THRESHOLD = 0.85;
const DEFAULT_BUDGET_USD = 7.0;

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
}

// NUMBER -> NORMALIZE -> INTERNAL NPA/NXX MATCH -> PREDICT CARRIER ->
// CONFIDENCE CHECK -> TWILIO VERIFICATION IF NECESSARY -> STORE VERIFIED
// RESULT -> CACHE -> UPDATE KNOWLEDGE BASE (spec §20)
export async function lookupPhone(params: {
  organizationId: string;
  requestedBy?: string;
  rawPhone: string;
  forceVerify?: boolean;
}): Promise<CoverageLookupResult> {
  const e164 = normalizeUsE164(params.rawPhone);
  if (!e164) {
    return {
      phoneOriginal: params.rawPhone,
      phoneE164: "",
      npa: null,
      nxx: null,
      predictedCarrier: null,
      lineType: null,
      confidence: null,
      verificationStatus: "unverified",
      usedCache: false,
      verified: false,
      budgetExceeded: false,
      error: "Not a valid US phone number.",
    };
  }

  // 1. Already verified for this exact number? Use the cached result —
  // never spend budget re-verifying the same number (spec §20/§21).
  const cachedVerification = await pool.query(
    `select cv.provider_carrier, cv.provider_line_type
     from coverage_verifications cv
     where cv.organization_id = $1 and cv.phone_e164 = $2 and cv.status = 'completed'
     order by cv.created_at desc limit 1`,
    [params.organizationId, e164]
  );

  if (cachedVerification.rows.length > 0 && !params.forceVerify) {
    const cv = cachedVerification.rows[0];
    await recordLookup(params.organizationId, params.requestedBy, params.rawPhone, e164, cv.provider_carrier, 1, true, null);
    const npaNxx = parseNpaNxx(e164);
    return {
      phoneOriginal: params.rawPhone,
      phoneE164: e164,
      npa: npaNxx?.npa ?? null,
      nxx: npaNxx?.nxx ?? null,
      predictedCarrier: cv.provider_carrier,
      lineType: cv.provider_line_type,
      confidence: 1,
      verificationStatus: "cached",
      usedCache: true,
      verified: true,
      budgetExceeded: false,
    };
  }

  // 2. Internal NPA/NXX intelligence.
  const npaNxx = parseNpaNxx(e164);
  let predictedCarrier: string | null = null;
  let lineType: string | null = null;
  let confidence = 0;

  if (npaNxx) {
    const record = await pool.query(
      "select carrier, line_type, confidence, verification_status from carrier_records where npa = $1 and nxx = $2",
      [npaNxx.npa, npaNxx.nxx]
    );
    if (record.rows.length > 0) {
      predictedCarrier = record.rows[0].carrier;
      lineType = record.rows[0].line_type;
      confidence = Number(record.rows[0].confidence);
    }
  }

  const needsVerification = params.forceVerify || confidence < CONFIDENCE_VERIFICATION_THRESHOLD;

  if (!needsVerification) {
    await recordLookup(params.organizationId, params.requestedBy, params.rawPhone, e164, predictedCarrier, confidence, false, null);
    return {
      phoneOriginal: params.rawPhone,
      phoneE164: e164,
      npa: npaNxx?.npa ?? null,
      nxx: npaNxx?.nxx ?? null,
      predictedCarrier,
      lineType,
      confidence,
      verificationStatus: "predicted",
      usedCache: false,
      verified: false,
      budgetExceeded: false,
    };
  }

  // 3. Budget check before spending on verification.
  const budget = await getOrCreateBudget(params.organizationId);
  if (Number(budget.spent_usd) + TWILIO_LOOKUP_COST_USD > Number(budget.budget_usd)) {
    await recordLookup(params.organizationId, params.requestedBy, params.rawPhone, e164, predictedCarrier, confidence, false, null);
    return {
      phoneOriginal: params.rawPhone,
      phoneE164: e164,
      npa: npaNxx?.npa ?? null,
      nxx: npaNxx?.nxx ?? null,
      predictedCarrier,
      lineType,
      confidence,
      verificationStatus: "predicted",
      usedCache: false,
      verified: false,
      budgetExceeded: true,
    };
  }

  // 4. Twilio verification.
  try {
    const result = await lookupCarrier(params.organizationId, e164);

    const verificationResult = await pool.query<{ id: string }>(
      `insert into coverage_verifications (organization_id, phone_e164, provider, provider_carrier, provider_line_type, raw_response, cost_usd, status)
       values ($1,$2,'twilio',$3,$4,$5,$6,'completed') returning id`,
      [params.organizationId, e164, result.carrierName, result.lineType, JSON.stringify(result.raw), TWILIO_LOOKUP_COST_USD]
    );

    await pool.query(
      "update coverage_budgets set spent_usd = spent_usd + $1, updated_at = now() where organization_id = $2",
      [TWILIO_LOOKUP_COST_USD, params.organizationId]
    );

    // Update the internal knowledge base — every verification improves
    // future predictions for this NPA-NXX (spec §20).
    if (npaNxx) {
      await pool.query(
        `insert into carrier_records (npa, nxx, carrier, line_type, source, confidence, verification_status, last_verified_at)
         values ($1,$2,$3,$4,'twilio',1,'verified', now())
         on conflict (npa, nxx) do update set
           carrier = excluded.carrier, line_type = excluded.line_type, source = 'twilio',
           confidence = 1, verification_status = 'verified', last_verified_at = now()`,
        [npaNxx.npa, npaNxx.nxx, result.carrierName, result.lineType]
      );
    }

    await updateAccuracyStats(params.organizationId, predictedCarrier, result.carrierName, confidence > 0);
    await recordLookup(
      params.organizationId,
      params.requestedBy,
      params.rawPhone,
      e164,
      result.carrierName,
      1,
      false,
      verificationResult.rows[0].id
    );

    return {
      phoneOriginal: params.rawPhone,
      phoneE164: e164,
      npa: npaNxx?.npa ?? null,
      nxx: npaNxx?.nxx ?? null,
      predictedCarrier: result.carrierName,
      lineType: result.lineType,
      confidence: 1,
      verificationStatus: "verified",
      usedCache: false,
      verified: true,
      budgetExceeded: false,
    };
  } catch (err) {
    await recordLookup(params.organizationId, params.requestedBy, params.rawPhone, e164, predictedCarrier, confidence, false, null);
    return {
      phoneOriginal: params.rawPhone,
      phoneE164: e164,
      npa: npaNxx?.npa ?? null,
      nxx: npaNxx?.nxx ?? null,
      predictedCarrier,
      lineType,
      confidence,
      verificationStatus: "predicted",
      usedCache: false,
      verified: false,
      budgetExceeded: false,
      error: err instanceof ProviderNotConfiguredError ? err.message : `Verification failed: ${(err as Error).message}`,
    };
  }
}

async function recordLookup(
  organizationId: string,
  requestedBy: string | undefined,
  original: string,
  e164: string,
  predictedCarrier: string | null,
  confidence: number,
  usedCache: boolean,
  verificationId: string | null
) {
  const npaNxx = parseNpaNxx(e164);
  await pool.query(
    `insert into coverage_lookups (organization_id, requested_by, phone_original, phone_e164, npa, nxx, predicted_carrier, confidence, used_cache, verification_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      organizationId,
      requestedBy ?? null,
      original,
      e164,
      npaNxx?.npa ?? null,
      npaNxx?.nxx ?? null,
      predictedCarrier,
      confidence,
      usedCache,
      verificationId,
    ]
  );
}

async function getOrCreateBudget(organizationId: string) {
  const existing = await pool.query("select * from coverage_budgets where organization_id = $1", [organizationId]);
  if (existing.rows.length > 0) return existing.rows[0];
  const created = await pool.query(
    "insert into coverage_budgets (organization_id, budget_usd) values ($1, $2) returning *",
    [organizationId, DEFAULT_BUDGET_USD]
  );
  return created.rows[0];
}

async function updateAccuracyStats(
  organizationId: string,
  predicted: string | null,
  actual: string | null,
  hadPrediction: boolean
) {
  if (!hadPrediction || !predicted) return; // only counts as a "prediction" if we had one to check
  const correct = predicted && actual && predicted.toLowerCase().includes(actual.toLowerCase());
  await pool.query(
    `insert into coverage_accuracy_stats (organization_id, total_predictions, verified_predictions, correct_predictions, incorrect_predictions)
     values ($1, 1, 1, $2, $3)
     on conflict (organization_id) do update set
       total_predictions = coverage_accuracy_stats.total_predictions + 1,
       verified_predictions = coverage_accuracy_stats.verified_predictions + 1,
       correct_predictions = coverage_accuracy_stats.correct_predictions + $2,
       incorrect_predictions = coverage_accuracy_stats.incorrect_predictions + $3,
       updated_at = now()`,
    [organizationId, correct ? 1 : 0, correct ? 0 : 1]
  );
}

export async function getCoverageStats(organizationId: string) {
  const stats = await pool.query("select * from coverage_accuracy_stats where organization_id = $1", [
    organizationId,
  ]);
  const budget = await getOrCreateBudget(organizationId);
  const row = stats.rows[0] ?? {
    total_predictions: 0,
    verified_predictions: 0,
    correct_predictions: 0,
    incorrect_predictions: 0,
  };
  const observedAccuracy =
    Number(row.verified_predictions) > 0 ? Number(row.correct_predictions) / Number(row.verified_predictions) : null;
  return {
    totalPredictions: Number(row.total_predictions),
    verifiedPredictions: Number(row.verified_predictions),
    correctPredictions: Number(row.correct_predictions),
    incorrectPredictions: Number(row.incorrect_predictions),
    observedAccuracy,
    budget: {
      budgetUsd: Number(budget.budget_usd),
      spentUsd: Number(budget.spent_usd),
      remainingUsd: Number(budget.budget_usd) - Number(budget.spent_usd),
    },
  };
}
