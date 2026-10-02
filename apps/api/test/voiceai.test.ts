import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCall, decideDisposition, type CallFacts } from "../src/voiceai/dispositionEngine.js";
import { normalizePlaceholders, renderTemplate, spokenAgentName, cleanIntroName, leadTemplateVars } from "../src/voiceai/placeholders.js";
import { isWithinWindow, parseWindow, resolveTimeZone, timeZoneForState, zonedLocalToUtc } from "../src/voiceai/callingWindow.js";
import { looksLikeVoicemail } from "../src/voiceai/voicemailDetector.js";
import { chunkKnowledge, searchKnowledge } from "../src/voiceai/knowledgeBase.js";
import { buildVapiCall, transferDestinations, withDisclosure, VOICEMAIL_BEEP_MAX_SECONDS, VOICEMAIL_FREQUENCY_MIN_SECONDS, type CampaignSnapshot } from "../src/voiceai/assistantBuilder.js";
import { detectPcmFormat } from "../src/services/realtimeService.js";
import { mapRow, normalizeCustomerType } from "../src/leadgen/leadImport.js";

const base: CallFacts = {
  dncRequested: false,
  voicemailDetected: false,
  transferStatus: null,
  endedReason: "customer-ended-call",
  answered: true,
  customerSpoke: true,
  talkSeconds: 60,
  aiOutcome: null,
};

test("disposition: first matching rule wins in playbook order", () => {
  assert.equal(classifyCall({ ...base, dncRequested: true, voicemailDetected: true }), "DNC");
  assert.equal(classifyCall({ ...base, voicemailDetected: true, transferStatus: "connected" }), "AA");
  assert.equal(classifyCall({ ...base, transferStatus: "connected", aiOutcome: "FL" }), "XFER");
  assert.equal(classifyCall({ ...base, transferStatus: "connected" }), "XFER");
  assert.equal(classifyCall({ ...base, transferStatus: "failed" }), "DA");
  assert.equal(classifyCall({ ...base, endedReason: "twilio-failed-to-connect-call-invalid-number" }), "ADC");
});

test("disposition: unanswered is no-answer even with 'no customer audio'", () => {
  assert.equal(classifyCall({ ...base, answered: false, customerSpoke: false, endedReason: "customer-did-not-give-microphone-permission-no-customer-audio" }), "NA");
  assert.equal(classifyCall({ ...base, answered: false, endedReason: "customer-busy" }), "AB");
});

test("disposition: answered calls", () => {
  assert.equal(classifyCall({ ...base, customerSpoke: false, talkSeconds: 3 }), "HangUp");
  assert.equal(classifyCall({ ...base, endedReason: "pipeline-error-openai", talkSeconds: 4 }), "DA");
  assert.equal(classifyCall({ ...base, aiOutcome: "NI" }), "NI");
  assert.equal(classifyCall(base), "PU");
});

test("retry rules: no-answer retries until max, voicemail obeys setting, callbacks override cap", () => {
  const rules = { maxAttempts: 3, retryDelayMinutes: 60, retryOnVoicemail: false };
  const now = new Date("2026-10-01T15:00:00Z");
  const na = decideDisposition({ ...base, answered: false }, rules, 1, null, now);
  assert.equal(na.retry, true);
  assert.equal(na.nextAttemptAt?.toISOString(), "2026-10-01T16:00:00.000Z");
  assert.equal(decideDisposition({ ...base, answered: false }, rules, 3, null, now).retry, false);
  assert.equal(decideDisposition({ ...base, voicemailDetected: true }, rules, 1, null, now).retry, false);
  assert.equal(decideDisposition({ ...base, voicemailDetected: true }, { ...rules, retryOnVoicemail: true }, 1, null, now).retry, true);
  const cbAt = new Date("2026-10-03T14:00:00Z");
  const cb = decideDisposition({ ...base, aiOutcome: "CALLBK" }, rules, 5, cbAt, now);
  assert.deepEqual([cb.retry, cb.nextAttemptAt?.toISOString()], [true, cbAt.toISOString()]);
});

test("retry rules: manual disposition is never overwritten", () => {
  const d = decideDisposition({ ...base, dncRequested: true }, { maxAttempts: 3, retryDelayMinutes: 60, retryOnVoicemail: true }, 0, null, new Date(), "FL");
  assert.equal(d.key, "FL");
});

test("placeholders normalise and unknown ones vanish", () => {
  assert.equal(normalizePlaceholders("Hi [First Name], {Company} / {{ current-provider }}"), "Hi {{first_name}}, {{company_name}} / {{current_provider}}");
  assert.equal(normalizePlaceholders("{Account Rep}", ["account_rep"]), "{{account_rep}}");
  assert.equal(normalizePlaceholders("{Unknown Thing}"), "{Unknown Thing}");
  assert.equal(renderTemplate("Hi {{first_name}}, {{nope}} this is {{agent_name}}.", { first_name: "Sam", agent_name: "Ray" }), "Hi Sam, this is Ray.");
  assert.equal(renderTemplate("Hi {{first_name}}, how are you?", {}), "Hi, how are you?");
});

test("agent and intro names", () => {
  assert.equal(spokenAgentName("Ray - Conversationalist"), "Ray");
  assert.equal(spokenAgentName("Katie"), "Katie");
  assert.equal(cleanIntroName("Spectrum Business (Copy)"), "Spectrum Business");
  const vars = leadTemplateVars({ lead: { first_name: "Sam", business_name: "Beta", custom_fields: { account_rep: "Bob" } }, agentName: "Ray", introName: "X", callbackNumber: null });
  assert.equal(vars.company_name, "Beta");
  assert.equal(vars.account_rep, "Bob");
});

test("calling window in lead time zone with lunch break", () => {
  const w = parseWindow({ days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", useLeadTimeZone: true, lunchBreak: { start: "12:00", end: "13:00" } });
  const tz = resolveTimeZone(w, "America/New_York", { state: "TX" });
  assert.equal(tz, "America/Chicago");
  // Thu 2026-10-01 10:30 CDT = 15:30Z
  assert.equal(isWithinWindow(w, tz, new Date("2026-10-01T15:30:00Z")), true);
  // 12:30 CDT lunch
  assert.equal(isWithinWindow(w, tz, new Date("2026-10-01T17:30:00Z")), false);
  // 08:30 CDT, too early
  assert.equal(isWithinWindow(w, tz, new Date("2026-10-01T13:30:00Z")), false);
  // Saturday
  assert.equal(isWithinWindow(w, tz, new Date("2026-10-03T16:00:00Z")), false);
  assert.equal(timeZoneForState("california"), "America/Los_Angeles");
  assert.equal(timeZoneForState("ZZ"), null);
});

test("zonedLocalToUtc handles DST on both sides", () => {
  assert.equal(zonedLocalToUtc("2026-10-02T14:30", "America/Chicago")?.toISOString(), "2026-10-02T19:30:00.000Z");
  assert.equal(zonedLocalToUtc("2027-01-05T09:00", "America/New_York")?.toISOString(), "2027-01-05T14:00:00.000Z");
  assert.equal(zonedLocalToUtc("garbage", "America/New_York"), null);
});

test("backup voicemail detector", () => {
  assert.equal(looksLikeVoicemail([{ role: "user", text: "You've reached Acme, please leave a message after the tone.", secondsFromStart: 3 }]), true);
  assert.equal(looksLikeVoicemail([{ role: "user", text: "Hello, this is Sam.", secondsFromStart: 2 }]), false);
  assert.equal(looksLikeVoicemail([{ role: "user", text: "please leave a message", secondsFromStart: 60 }]), false);
  assert.equal(looksLikeVoicemail([{ role: "assistant", text: "please leave a message", secondsFromStart: 2 }]), false);
});

test("knowledge search returns relevant chunk or nothing", () => {
  const chunks = chunkKnowledge("Installation is free on new bundles.\n\nPrice lock lasts 3 years.", [{ question: "Is there a contract?", answer: "No contract." }]);
  assert.match(searchKnowledge(chunks, "is installation free?")[0], /Installation/);
  assert.match(searchKnowledge(chunks, "contract")[0], /No contract/);
  assert.deepEqual(searchKnowledge(chunks, "what is the weather"), []);
});

test("VAPI payload respects platform limits and renders the greeting", () => {
  const snapshot: CampaignSnapshot = {
    campaignId: "c1",
    version: 2,
    introName: "an authorized Spectrum Business reseller",
    callbackNumber: "+13023423925",
    script: "Mention {{current_provider}}.",
    knowledgeText: "",
    transferNumber: "+13025550100",
    maxCallDurationSeconds: 600,
    llmModel: "gpt-4o-mini",
    agent: {
      id: "a1",
      name: "Spectrum Business Outbound",
      systemPrompt: "Be helpful.",
      personality: null,
      tone: "conversational",
      greeting: null,
      faqs: [],
      objectionHandling: [],
      fallbackBehavior: null,
      transferNumber: null,
      temperature: 0.4,
      voice: { provider: "cartesia", providerVoiceId: "v1", name: "Ray - Conversationalist" },
    },
  };
  const { payload, optionalPaths } = buildVapiCall({
    snapshot,
    lead: { first_name: "Sam", business_name: "Beta", current_provider: "AT&T", state: "TX" },
    customerNumber: "+12145550199",
    vapiPhoneNumberId: "pn1",
    leadTimeZone: "America/Chicago",
    metadata: { vahlayCallId: "x" },
  });
  const a = payload.assistant;
  assert.equal(a.firstMessage, "Hi, am I speaking with Sam? This is Ray from an authorized Spectrum Business reseller. How are you doing today?");
  assert.match(a.model.messages[0].content, /## Source of truth/);
  assert.match(a.model.messages[0].content, /Email on file: none/);
  assert.equal(a.backgroundSound, "office");

  // No name on the lead: no name check, just who's calling.
  const anon = buildVapiCall({
    snapshot: { ...snapshot, backgroundSound: false },
    lead: { business_name: "Beta" },
    customerNumber: "+12145550199",
    vapiPhoneNumberId: "pn1",
    leadTimeZone: "America/Chicago",
    metadata: { vahlayCallId: "y" },
  }).payload.assistant;
  assert.equal(anon.firstMessage, "Hi, this is Ray from an authorized Spectrum Business reseller. How are you doing today?");
  assert.equal(anon.backgroundSound, "off");
  assert.equal(a.voicemailMessage, undefined);
  assert.equal(a.voicemailDetection.beepMaxAwaitSeconds, 0);
  assert.ok(a.voicemailDetection.backoffPlan.frequencySeconds >= VOICEMAIL_FREQUENCY_MIN_SECONDS);
  assert.ok(a.voicemailDetection.beepMaxAwaitSeconds <= VOICEMAIL_BEEP_MAX_SECONDS);
  assert.equal(a.voice.model, "sonic-3");
  assert.ok(a.model.messages[0].content.includes("Mention AT&T."));
  assert.ok(a.model.tools.some((t: any) => t.type === "transferCall"));
  assert.ok(optionalPaths.every((p) => p[0] === "assistant"));
  assert.equal(payload.phoneNumberId, "pn1");
});

test("live-listen PCM format detection", () => {
  assert.deepEqual(detectPcmFormat(16000 * 2 * 2), { sampleRate: 16000, channels: 2, ambiguous: true });
  assert.equal(detectPcmFormat(8000 * 2 * 1.02).sampleRate, 8000);
  assert.equal(detectPcmFormat(48000 * 2 * 2).channels, 2);
});

test("lead import maps telecom headers and keeps custom columns", () => {
  const { fields, custom } = mapRow({ "Company Name": "Acme", "Contact": "Jane Doe", "Phone Number": "(214) 555-0101", "Current Provider": "Spectrum", "Account Rep": "Bob" });
  assert.deepEqual([fields.business_name, fields.first_name, fields.last_name, fields.main_phone], ["Acme", "Jane", "Doe", "(214) 555-0101"]);
  assert.deepEqual(custom, { account_rep: "Bob" });
  assert.equal(normalizeCustomerType("ALC", undefined), "alc");
  assert.equal(normalizeCustomerType("Non-ALC", "Spectrum"), "non_alc");
  assert.equal(normalizeCustomerType(undefined, "Charter Spectrum"), "alc");
  assert.equal(normalizeCustomerType(undefined, "AT&T"), "non_alc");
});

test("escalation matrix transfer destinations and recording disclosure", () => {
  const d = transferDestinations("+13025550100", { support: "+13025550101", manager: "+13025550103" });
  assert.deepEqual(d.map((x) => x.number), ["+13025550100", "+13025550101", "+13025550103"]);
  assert.match(String(d[1].description), /^Support team/);
  assert.equal(transferDestinations(null, {}).length, 0);
  assert.equal(
    withDisclosure("Hi Sam, this is Hari with Vahlay. How are you today?", true),
    "Hi Sam, this is Hari with Vahlay. This call may be recorded for quality purposes. How are you today?"
  );
  assert.equal(withDisclosure("Hello there", false), "Hello there");
});

test("calls use the AI agent's name; the voice name is only a fallback", async () => {
  const { callerName } = await import("../src/voiceai/placeholders.js");
  assert.equal(callerName("Ray — Spectrum Business", "Hari - Sales"), "Ray");
  assert.equal(callerName("Ray", "Hari"), "Ray");
  assert.equal(callerName("Mary Ann - Sales", "Ray"), "Mary Ann");
  assert.equal(callerName("Spectrum Business Outbound", "Ray - Conversationalist"), "Ray");
  assert.equal(callerName("", "Ray - Conversationalist"), "Ray");
});
