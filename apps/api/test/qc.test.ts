import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test";
const { audibleIntervals, decodedDuration } = await import("../src/services/qc/audio.js");
const { transcribeFull, TranscriptIncompleteError } = await import("../src/services/qc/transcribe.js");
const { renderQcPdf } = await import("../src/services/qc/pdf.js");

const ORG = "00000000-0000-0000-0000-000000000000";

// Three minutes of continuous sound, so every stretch counts as audible.
async function makeAudio(dir: string, seconds: number) {
  const out = path.join(dir, "tone.mp3");
  const r = spawnSync(ffmpegPath as unknown as string, ["-y", "-v", "error", "-f", "lavfi", "-i", `anoisesrc=d=${seconds}:a=0.3`, "-ac", "1", "-ar", "16000", out]);
  assert.equal(r.status, 0, r.stderr?.toString());
  return out;
}

// Fake OpenAI: transcription calls are answered by `onTranscribe`, chat
// calls (speaker roles) by a fixed mapping.
function mockOpenAI(onTranscribe: (call: number) => any) {
  let n = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.includes("/audio/transcriptions")) return new Response(JSON.stringify(onTranscribe(n++)), { status: 200 });
    if (u.includes("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ roles: { "c0-A": "Agent", "c0-B": "Customer" } }) }, finish_reason: "stop" }] }), { status: 200 });
    }
    return real(url);
  }) as typeof fetch;
  return () => (globalThis.fetch = real);
}
const seg = (start: number, end: number, speaker = "A", text = "we are talking about your internet and phone plan today okay") => ({ start, end, speaker, text });

test("a transcript that stops early is marked incomplete, never accepted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qc-test-"));
  const restore = mockOpenAI((call) =>
    call === 0
      ? { segments: Array.from({ length: 12 }, (_, i) => seg(i * 5, i * 5 + 4, i % 2 ? "B" : "A")) } // stops at 60 s
      : { segments: [seg(0, 8)] } // recovery finds speech but not all of it
  );
  try {
    const file = await makeAudio(dir, 180);
    const duration = await decodedDuration(file);
    const audible = await audibleIntervals(file, duration);
    await assert.rejects(
      transcribeFull({ organizationId: ORG, source: file, workDir: dir, durationSec: duration, audible }),
      (err: unknown) => err instanceof TranscriptIncompleteError && /missing speech/i.test((err as Error & { userMessage: string }).userMessage)
    );
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a full transcript passes and keeps timestamps, speakers and order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qc-test-"));
  const restore = mockOpenAI(() => ({ segments: Array.from({ length: 36 }, (_, i) => seg(i * 5, i * 5 + 4.5, i % 2 ? "B" : "A")) }));
  try {
    const file = await makeAudio(dir, 180);
    const duration = await decodedDuration(file);
    const audible = await audibleIntervals(file, duration);
    const t = await transcribeFull({ organizationId: ORG, source: file, workDir: dir, durationSec: duration, audible });
    assert.equal(t.segments.length, 36);
    assert.ok(t.coverage > 0.98);
    assert.deepEqual(new Set(t.segments.map((s) => s.role)), new Set(["Agent", "Customer"]));
    assert.ok(t.segments.every((s, i) => i === 0 || s.start >= t.segments[i - 1].start));
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an HTTP 200 without segments is a transcription failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qc-test-"));
  const restore = mockOpenAI(() => ({ text: "hello" }));
  try {
    const file = await makeAudio(dir, 30);
    const duration = await decodedDuration(file);
    await assert.rejects(
      transcribeFull({ organizationId: ORG, source: file, workDir: dir, durationSec: duration, audible: await audibleIntervals(file, duration) }),
      /No segments/
    );
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("PDF renders a long transcript without truncation or blank pages", async () => {
  const transcript = Array.from({ length: 2500 }, (_, i) => ({ start: i * 1.2, end: i * 1.2 + 1, speaker: "x", role: i % 2 ? "Customer" : "Agent", text: `Line ${i} — “quoted” text with résumé and emoji 😀 and a long sentence that wraps across the page width to test flowing text.` }));
  const empty = { title: "t", detail: "d", rating: "green" as const, evidence: [] };
  const pdf = await renderQcPdf({
    id: "r1",
    fileName: "call.mp3",
    agentName: "Sam",
    businessName: "Acme",
    createdAt: new Date(),
    originalDurationSec: 3000,
    transcriptCoverage: 1,
    transcript: transcript as any,
    report: {
      callType: "Upgrade", callTypeTags: ["Internet"], agentName: "Sam", customerName: "Jo", businessName: "Acme",
      scores: { overall: 72, compliance: 60, communication: 80, sales: 70, resolution: 75, customerExperience: 78, rules: 50 },
      categoryWeights: { communication: 0.25, resolution: 0.25, customer_experience: 0.25, compliance: 0.15, sales: 0.1 }, rulesWeight: 0.4,
      pass: true, needsReview: false, dimensions: [], rules: [{ rule: "R", mandatory: true, result: "FAIL", explanation: "", evidence: [] }],
      complianceChecks: [], callTypeRules: [], risks: [], sentiment: { customer: "Neutral", agent: "Helpful", trajectory: "" },
      executiveSummary: "Summary ".repeat(200), wentWell: [empty], toImprove: [], coaching: [], keyMoments: [],
      findings: { green: [empty], yellow: [], red: [] }, evidenceStats: { cited: 0, verified: 0 }, model: "x",
    },
  });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const pages = (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
  assert.ok(pages > 30, `expected many pages, got ${pages}`);
  // Every page has content: no blank pages from overflowing footers.
  assert.ok(pdf.length / pages > 1500);
});
