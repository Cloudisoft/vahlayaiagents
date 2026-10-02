import { pool } from "../../db/pool.js";

// Recency: evidence halves in weight every HALF_LIFE_DAYS, because numbers
// get ported and reassigned. Twilio validations count double.
export const HALF_LIFE_DAYS = 180;
const Z = 1.96;

// Trust thresholds, set from the holdout backtest (see runHoldout): a
// prefix needs both enough numbers and a clear majority to be trusted.
export const TRUST = { minKnown: 15, trustedWilson: 0.8, probableWilson: 0.6, probableMinKnown: 5, driftMinValidations: 3, driftRate: 0.34 };

// Rebuild per-number state from its observations. Newest known line type
// wins (a newer Twilio result therefore overrides an older guess); the
// number of distinct known types seen is kept as a conflict signal.
export async function rebuildPhones(phones: string[] | null): Promise<number> {
  const r = await pool.query(
    `insert into phone_intelligence (phone_e164, npa, nxx, line_type, carrier, carrier_raw, observed_at, source, verified,
       observations, conflicts, twilio_validated_at, updated_at)
     select o.phone_e164, min(o.npa), min(o.nxx),
       (array_agg(o.line_type order by (o.line_type <> 'unknown') desc, o.observed_at desc, (o.source = 'twilio') desc))[1],
       (array_agg(o.carrier order by (o.carrier is not null) desc, o.observed_at desc))[1],
       (array_agg(o.carrier_raw order by (o.carrier_raw is not null) desc, o.observed_at desc))[1],
       max(o.observed_at),
       (array_agg(o.source order by o.observed_at desc))[1],
       bool_or(o.source = 'twilio'),
       count(*)::int,
       greatest(count(distinct o.line_type) filter (where o.line_type <> 'unknown') - 1, 0)::int,
       max(o.observed_at) filter (where o.source = 'twilio'),
       now()
     from phone_observations o
     ${phones ? "where o.phone_e164 = any($1::text[])" : ""}
     group by o.phone_e164
     on conflict (phone_e164) do update set
       npa = excluded.npa, nxx = excluded.nxx, line_type = excluded.line_type, carrier = excluded.carrier,
       carrier_raw = excluded.carrier_raw, observed_at = excluded.observed_at, source = excluded.source,
       verified = excluded.verified, observations = excluded.observations, conflicts = excluded.conflicts,
       twilio_validated_at = excluded.twilio_validated_at, updated_at = now()`,
    phones ? [phones] : []
  );
  return r.rowCount ?? 0;
}

// Prefix statistics from per-number state (each number counted once, so a
// number looked up ten times can't dominate its prefix).
export async function recomputePrefixes(prefixes: Array<{ npa: string; nxx: string }> | null): Promise<number> {
  const filter = prefixes ? "and (p.npa, p.nxx) in (select * from unnest($1::text[], $2::text[]))" : "";
  const params = prefixes ? [prefixes.map((x) => x.npa), prefixes.map((x) => x.nxx)] : [];
  const r = await pool.query(
    `with base as (
       select p.npa, p.nxx, p.line_type, p.carrier, p.observed_at, p.conflicts,
              power(0.5, greatest(extract(epoch from now() - p.observed_at), 0) / 86400.0 / ${HALF_LIFE_DAYS})
                * case when p.verified then 2 else 1 end as w
       from phone_intelligence p where p.npa is not null ${filter}
     ), agg as (
       select npa, nxx, count(*)::int as total_obs,
         count(*) filter (where line_type <> 'unknown')::int as known_obs,
         count(*) filter (where line_type = 'mobile')::int as mobile_n,
         count(*) filter (where line_type = 'landline')::int as landline_n,
         count(*) filter (where line_type = 'voip')::int as voip_n,
         count(*) filter (where line_type = 'unknown')::int as unknown_n,
         coalesce(sum(w) filter (where line_type = 'mobile'), 0) as w_mobile,
         coalesce(sum(w) filter (where line_type = 'landline'), 0) as w_landline,
         coalesce(sum(w) filter (where line_type = 'voip'), 0) as w_voip,
         coalesce(sum(w) filter (where line_type = 'unknown'), 0) as w_unknown,
         count(*) filter (where conflicts > 0)::int as conflicted_numbers,
         min(observed_at) as first_seen, max(observed_at) as last_seen
       from base group by npa, nxx
     ), carriers as (
       select npa, nxx, jsonb_object_agg(carrier, n) as dist,
              (array_agg(carrier order by n desc))[1] as top_carrier,
              max(n)::float / nullif(sum(n), 0) as top_share
       from (select npa, nxx, carrier, count(*) as n from base where carrier is not null group by npa, nxx, carrier) c
       group by npa, nxx
     )
     insert into prefix_intelligence as pi (npa, nxx, total_obs, known_obs, mobile_n, landline_n, voip_n, unknown_n,
       w_mobile, w_landline, w_voip, w_unknown, carrier_dist, top_carrier, top_carrier_share, conflicted_numbers,
       first_seen, last_seen, updated_at)
     select a.npa, a.nxx, a.total_obs, a.known_obs, a.mobile_n, a.landline_n, a.voip_n, a.unknown_n,
       a.w_mobile, a.w_landline, a.w_voip, a.w_unknown, coalesce(c.dist, '{}'::jsonb), c.top_carrier, c.top_share,
       a.conflicted_numbers, a.first_seen, a.last_seen, now()
     from agg a left join carriers c using (npa, nxx)
     on conflict (npa, nxx) do update set
       total_obs = excluded.total_obs, known_obs = excluded.known_obs, mobile_n = excluded.mobile_n,
       landline_n = excluded.landline_n, voip_n = excluded.voip_n, unknown_n = excluded.unknown_n,
       w_mobile = excluded.w_mobile, w_landline = excluded.w_landline, w_voip = excluded.w_voip, w_unknown = excluded.w_unknown,
       carrier_dist = excluded.carrier_dist, top_carrier = excluded.top_carrier, top_carrier_share = excluded.top_carrier_share,
       conflicted_numbers = excluded.conflicted_numbers, first_seen = excluded.first_seen, last_seen = excluded.last_seen,
       updated_at = now()`,
    params
  );
  await scorePrefixes(prefixes);
  return r.rowCount ?? 0;
}

// Dominant type, Wilson lower bound (so 2-of-2 never looks like 100%),
// calibrated confidence and trust state, including drift downgrades.
export async function scorePrefixes(prefixes: Array<{ npa: string; nxx: string }> | null) {
  const filter = prefixes ? "where (npa, nxx) in (select * from unnest($1::text[], $2::text[]))" : "";
  const params = prefixes ? [prefixes.map((x) => x.npa), prefixes.map((x) => x.nxx)] : [];
  await pool.query(
    `with s as (
       select npa, nxx, known_obs, twilio_validations, twilio_contradictions, conflicted_numbers, total_obs, last_seen,
         greatest(w_mobile, w_landline, w_voip) as w_dom,
         (w_mobile + w_landline + w_voip) as w_known,
         case when greatest(w_mobile, w_landline, w_voip) = 0 then null
              when w_mobile >= w_landline and w_mobile >= w_voip then 'mobile'
              when w_landline >= w_voip then 'landline' else 'voip' end as dom
       from prefix_intelligence ${filter}
     ), w as (
       select *, case when w_known > 0 then w_dom / w_known end as p from s
     ), b as (
       select *, case when p is null or known_obs = 0 then 0 else
         (p + ${Z * Z}/(2.0*known_obs) - ${Z}*sqrt(greatest(p*(1-p)/known_obs + ${Z * Z}/(4.0*known_obs*known_obs), 0))) / (1 + ${Z * Z}/known_obs::float)
       end as wl from w
     )
     update prefix_intelligence pi set
       dominant_type = b.dom,
       dominant_share = b.p,
       wilson_lower = b.wl,
       contradiction_rate = (b.conflicted_numbers + b.twilio_contradictions)::float / greatest(b.total_obs + b.twilio_validations, 1),
       trust = case
         when b.twilio_validations >= ${TRUST.driftMinValidations}
              and b.twilio_contradictions::float / b.twilio_validations >= ${TRUST.driftRate} then 'drifting'
         when b.known_obs >= ${TRUST.minKnown} and b.wl >= ${TRUST.trustedWilson} and b.last_seen > now() - interval '540 days' then 'trusted'
         when b.known_obs >= ${TRUST.probableMinKnown} and b.wl >= ${TRUST.probableWilson} then 'probable'
         else 'uncertain' end,
       confidence = least(0.99, greatest(0,
         coalesce((select c.correct::float / nullif(c.n, 0) from intel_calibration c
                   where c.signal = 'prefix' and c.bucket = least(9, floor(b.wl * 10)::int) and c.n >= 30), b.wl)
         * case when b.twilio_validations >= ${TRUST.driftMinValidations}
                 and b.twilio_contradictions::float / b.twilio_validations >= ${TRUST.driftRate} then 0.7 else 1 end
         * case when b.last_seen < now() - interval '540 days' then 0.9 else 1 end)),
       updated_at = now()
     from b where pi.npa = b.npa and pi.nxx = b.nxx`,
    params
  );
}

export async function recomputeCarriers(carriers: string[] | null) {
  await pool.query(
    `with a as (
       select carrier, count(*)::int as total,
         count(*) filter (where line_type = 'mobile')::int as m,
         count(*) filter (where line_type = 'landline')::int as l,
         count(*) filter (where line_type = 'voip')::int as v,
         count(*) filter (where line_type = 'unknown')::int as u
       from phone_intelligence where carrier is not null ${carriers ? "and carrier = any($1::text[])" : ""}
       group by carrier
     ), d as (
       select *, greatest(m, l, v) as dom_n, (m + l + v) as known,
         case when greatest(m, l, v) = 0 then null when m >= l and m >= v then 'mobile' when l >= v then 'landline' else 'voip' end as dom
       from a
     )
     insert into carrier_statistics (carrier, total, mobile_n, landline_n, voip_n, unknown_n, dominant_type, dominant_share, confidence, updated_at)
     select carrier, total, m, l, v, u, dom,
       case when known > 0 then dom_n::float / known end,
       case when known = 0 then 0 else
         (dom_n::float/known + ${Z * Z}/(2.0*known) - ${Z}*sqrt(greatest((dom_n::float/known)*(1-dom_n::float/known)/known + ${Z * Z}/(4.0*known*known), 0))) / (1 + ${Z * Z}/known::float)
       end,
       now()
     from d
     on conflict (carrier) do update set total = excluded.total, mobile_n = excluded.mobile_n, landline_n = excluded.landline_n,
       voip_n = excluded.voip_n, unknown_n = excluded.unknown_n, dominant_type = excluded.dominant_type,
       dominant_share = excluded.dominant_share, confidence = excluded.confidence, updated_at = now()`,
    carriers ? [carriers] : []
  );
}

// Independent measurement: hold out 10% of known numbers (by hash), build
// statistics from the other 90% and predict the held-out ones — at the
// prefix, neighbouring-prefix and area-code level. The per-bucket results
// become the calibration that turns raw scores into honest probabilities.
const LEVELS: Array<{ signal: string; key: string }> = [
  { signal: "prefix", key: "npa || nxx" },
  { signal: "neighbor", key: "npa || substr(nxx, 1, 2)" },
  { signal: "area", key: "npa" },
];

export async function runHoldout(): Promise<{ evaluated: number; correct: number }> {
  let summary = { evaluated: 0, correct: 0 };
  for (const level of LEVELS) {
    const r = await pool.query(
      `with base as (
         select phone_e164, ${level.key} as k, line_type,
           power(0.5, greatest(extract(epoch from now() - observed_at), 0) / 86400.0 / ${HALF_LIFE_DAYS}) * case when verified then 2 else 1 end as w,
           (('x' || substr(md5(phone_e164), 1, 7))::bit(28)::int % 10) = 0 as held
         from phone_intelligence where npa is not null and line_type <> 'unknown'
       ), train as (
         select k, count(*) as n,
           coalesce(sum(w) filter (where line_type = 'mobile'), 0) as wm, coalesce(sum(w) filter (where line_type = 'landline'), 0) as wl,
           coalesce(sum(w) filter (where line_type = 'voip'), 0) as wv, sum(w) as wk
         from base where not held group by k
       ), scored as (
         select k, n, case when wm >= wl and wm >= wv then 'mobile' when wl >= wv then 'landline' else 'voip' end as dom,
           greatest(wm, wl, wv) / wk as p
         from train
       ), pred as (
         select h.line_type as actual, s.dom,
           ${level.signal === "prefix"
             ? `least(9, floor(((s.p + ${Z * Z}/(2.0*s.n) - ${Z}*sqrt(greatest(s.p*(1-s.p)/s.n + ${Z * Z}/(4.0*s.n*s.n), 0))) / (1 + ${Z * Z}/s.n::float)) * 10)::int)`
             : "least(9, floor(s.p * 10)::int)"} as bucket
         from base h join scored s using (k) where h.held ${level.signal === "prefix" ? "" : "and s.n >= 10"}
       )
       select bucket, actual, count(*)::int as n, count(*) filter (where dom = actual)::int as ok,
         (select count(*) from base where held)::int as held_total
       from pred group by bucket, actual`
    );
    const byBucket: Record<string, { n: number; correct: number }> = {};
    const byType: Record<string, { n: number; correct: number }> = {};
    let heldTotal = 0;
    for (const row of r.rows) {
      heldTotal = row.held_total;
      byBucket[row.bucket] = byBucket[row.bucket] ?? { n: 0, correct: 0 };
      byBucket[row.bucket].n += row.n;
      byBucket[row.bucket].correct += row.ok;
      byType[row.actual] = byType[row.actual] ?? { n: 0, correct: 0 };
      byType[row.actual].n += row.n;
      byType[row.actual].correct += row.ok;
    }
    const evaluated = Object.values(byBucket).reduce((a, b) => a + b.n, 0);
    const correct = Object.values(byBucket).reduce((a, b) => a + b.correct, 0);
    await pool.query("delete from intel_calibration where signal = $1", [level.signal]);
    for (const [bucket, v] of Object.entries(byBucket)) {
      await pool.query("insert into intel_calibration (signal, bucket, n, correct) values ($1, $2, $3, $4)", [level.signal, Number(bucket), v.n, v.correct]);
    }
    if (level.signal === "prefix") {
      summary = { evaluated, correct };
      await pool.query(
        "insert into intel_quality_runs (kind, evaluated, correct, coverage, by_type, by_bucket) values ('holdout', $1, $2, $3, $4, $5)",
        [evaluated, correct, heldTotal ? evaluated / heldTotal : null, JSON.stringify(byType), JSON.stringify(byBucket)]
      );
    }
  }
  return summary;
}

// Full rebuild: numbers -> prefixes -> carriers -> holdout calibration ->
// re-score with the new calibration.
export async function rebuildAll() {
  await rebuildPhones(null);
  await recomputePrefixes(null);
  await recomputeCarriers(null);
  await runHoldout();
  await scorePrefixes(null);
}
