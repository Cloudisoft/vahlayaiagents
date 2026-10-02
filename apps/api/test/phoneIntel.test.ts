import { test } from "node:test";
import assert from "node:assert/strict";
import { lineTypeFromHistorical, lineTypeFromTwilio, normalizeCarrier, npaNxx } from "../src/services/phoneIntel/normalize.js";
import { resolveLocal, verificationReason } from "../src/services/phoneIntel/engine.js";
import { normalizeE164 } from "../src/utils/phone.js";

test("historical and Twilio line types map to mobile/landline/voip/unknown", () => {
  assert.equal(lineTypeFromHistorical("W"), "mobile");
  assert.equal(lineTypeFromHistorical("L"), "landline");
  assert.equal(lineTypeFromHistorical("V"), "voip");
  assert.equal(lineTypeFromHistorical("U"), "unknown");
  assert.equal(lineTypeFromHistorical("", "y"), "mobile");
  assert.equal(lineTypeFromTwilio("fixedVoip"), "voip");
  assert.equal(lineTypeFromTwilio("nonFixedVoip"), "voip");
  assert.equal(lineTypeFromTwilio("tollFree"), "unknown");
});

test("carrier names group into operating companies", () => {
  assert.equal(normalizeCarrier("Cellco Partnership dba Verizon"), "Verizon Wireless");
  assert.equal(normalizeCarrier("New Cingular Wireless PCS, LLC"), "AT&T Wireless");
  assert.equal(normalizeCarrier("Time Warner Cbl Info Svcs (Ca)"), "Charter / Spectrum");
  assert.equal(normalizeCarrier("Bandwidth.Com CLEC, LLC - Ca"), "Bandwidth");
  assert.equal(normalizeCarrier("Unknown"), null);
});

test("E.164 normalisation and NPA-NXX", () => {
  assert.equal(normalizeE164("(407) 856-5290"), "+14078565290");
  assert.equal(normalizeE164("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizeE164("12345"), null);
  assert.deepEqual(npaNxx("+14078565290"), { npa: "407", nxx: "856" });
});

function ctx(over: Partial<any> = {}) {
  return {
    phones: new Map(),
    prefixes: new Map(),
    blocks: new Map(),
    npas: new Map(),
    carriers: new Map(),
    calib: new Map(),
    prefixEntities: new Map(),
    ...over,
  } as any;
}
const day = 86400000;

test("lookup hierarchy: fresh Twilio > phone record > prefix", () => {
  const prefix = { npa: "407", nxx: "856", dominant_type: "mobile", confidence: 0.9, trust: "trusted", top_carrier: "T-Mobile", known_obs: 50, last_seen: null, twilio_validations: 0, twilio_contradictions: 0 };
  const twilioFresh = ctx({
    phones: new Map([["+14078565290", { line_type: "landline", carrier: "AT&T (wireline)", twilio_validated_at: new Date(Date.now() - 10 * day), observed_at: new Date(), conflicts: 0 }]]),
    prefixes: new Map([["407856", prefix]]),
  });
  const a = resolveLocal("+14078565290", twilioFresh);
  assert.equal(a.source, "twilio_cache");
  assert.equal(a.lineType, "landline");

  const record = ctx({
    phones: new Map([["+14078565290", { line_type: "landline", carrier: null, observed_at: new Date(Date.now() - 100 * day), conflicts: 0 }]]),
    prefixes: new Map([["407856", prefix]]),
  });
  const b = resolveLocal("+14078565290", record);
  assert.equal(b.source, "phone_record");
  assert.ok(b.confidence > 0.95 && b.confidence < 0.99);

  const c = resolveLocal("+14078561111", ctx({ prefixes: new Map([["407856", prefix]]) }));
  assert.equal(c.source, "prefix_intelligence");
  assert.equal(c.lineType, "mobile");
  assert.equal(verificationReason(c, ctx({ prefixes: new Map([["407856", prefix]]) })), null);
});

test("conflicting history and drifting prefixes ask for validation", () => {
  const drifting = { npa: "407", nxx: "856", dominant_type: "landline", confidence: 0.6, trust: "drifting", top_carrier: null, known_obs: 30, last_seen: null, twilio_validations: 6, twilio_contradictions: 3 };
  const c1 = ctx({
    phones: new Map([["+14078565290", { line_type: "landline", carrier: null, observed_at: new Date(), conflicts: 1 }]]),
    prefixes: new Map([["407856", drifting]]),
  });
  const r = resolveLocal("+14078565290", c1);
  assert.ok(r.confidence <= 0.7);
  assert.equal(verificationReason(r, c1), "conflicting_history");
  const unknown = resolveLocal("+19995550000", ctx());
  assert.equal(unknown.source, "unknown");
  assert.equal(verificationReason(unknown, ctx()), "no_engine_answer");
});

import { applyTarget } from "../src/services/phoneIntel/engine.js";
test("precision mode: below-target answers are not classified, guesses kept", () => {
  const base = { phone: "+14078565290", npa: "407", nxx: "856", carrier: null, verified: false, twilioUsed: false, prefixTrust: "probable", reasons: [] } as any;
  const low = applyTarget({ ...base, lineType: "mobile", confidence: 0.7, source: "prefix_intelligence" }, 0.93);
  assert.equal(low.lineType, "unknown");
  assert.equal(low.likelyLineType, "mobile");
  assert.equal(low.withheld, true);
  const high = applyTarget({ ...base, lineType: "landline", confidence: 0.96, source: "phone_record" }, 0.93);
  assert.equal(high.lineType, "landline");
  const verified = applyTarget({ ...base, lineType: "voip", confidence: 1, source: "twilio_validated", verified: true }, 0.99);
  assert.equal(verified.lineType, "voip");
});

test("engine first: a confident answer is never sent to Twilio, whatever its age or prefix", () => {
  const twoYears = new Date(Date.now() - 2 * 365 * day);
  const c = ctx({ phones: new Map([["+14078565290", { line_type: "mobile", carrier: "AT&T Wireless", carrier_raw: "New Cingular Wireless PCS, LLC - FL", observed_at: twoYears, conflicts: 0 }]]) });
  const r = resolveLocal("+14078565290", c);
  assert.ok(r.confidence >= 0.9);
  // Old record and no prefix data used to force a Twilio check; now only the target decides.
  assert.equal(verificationReason(r, c, 0.9), null);
  assert.equal(verificationReason(r, c, 0.95), "new_prefix");
  assert.equal(r.carrierEntity, "New Cingular Wireless PCS");
  assert.equal(r.carrier, "AT&T Wireless");
});

test("carrier labels keep the licensed company and its network", async () => {
  const { carrierEntity, carrierLabel, normalizeCarrier } = await import("../src/services/phoneIntel/normalize.js");
  const label = (raw: string) => carrierLabel(carrierEntity(raw), normalizeCarrier(raw));
  assert.equal(label("NEW CINGULAR WIRELESS PCS, LLC - GA"), "New Cingular Wireless PCS (AT&T Wireless)");
  assert.equal(label("Pacific Bell"), "Pacific Bell (AT&T wireline)");
  assert.equal(label("Cellco Partnership dba Verizon"), "Cellco Partnership dba Verizon (Verizon Wireless)");
  assert.equal(label("T-Mobile USA, Inc."), "T-Mobile USA");
  assert.equal(normalizeCarrier("New Cell, Inc. dba Cellcom"), "Cellcom");
});

test("audits cap a signal's confidence at what it actually achieved", () => {
  const rec = { line_type: "mobile", carrier: "AT&T Wireless", carrier_raw: "New Cingular Wireless PCS, LLC", observed_at: new Date(), conflicts: 0 };
  const plain = resolveLocal("+14078565290", ctx({ phones: new Map([["+14078565290", rec]]) }));
  assert.ok(plain.confidence > 0.95);
  const capped = resolveLocal("+14078565290", ctx({ phones: new Map([["+14078565290", rec]]), measured: new Map([["phone_record", 0.9]]) }));
  assert.equal(capped.confidence, 0.9);
  assert.equal(verificationReason(capped, ctx({ phones: new Map([["+14078565290", rec]]) }), 0.93) !== null, true);
});
