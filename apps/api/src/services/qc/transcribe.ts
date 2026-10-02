import path from "node:path";
import { readFile } from "node:fs/promises";
import { chatJson, recordUsage, resolveOpenAiKey } from "../openaiService.js";
import { audibleSecondsBetween, cutChunk, type Interval } from "./audio.js";

export interface Segment {
  start: number; // seconds from the start of the original recording
  end: number;
  speaker: string; // diarized label, unique across the call (e.g. "c1-A")
  role: "Agent" | "Customer" | "Other";
  text: string;
}

export class TranscriptionError extends Error {
  constructor(public userMessage: string, public technical: string) {
    super(technical);
    this.name = "TranscriptionError";
  }
}

export class TranscriptIncompleteError extends Error {
  constructor(public userMessage: string, public technical: string, public details: Record<string, unknown>) {
    super(technical);
    this.name = "TranscriptIncompleteError";
  }
}

// 10-minute pieces keep every request well inside the API's size and
// length limits; timestamps are shifted back onto the full recording.
const CHUNK_SEC = 600;
const DIARIZE_MODEL = "gpt-4o-transcribe-diarize";
const PRICE_PER_MIN = 0.006;

async function postTranscription(apiKey: string, file: string, form: Record<string, string>): Promise<any> {
  const body = new FormData();
  body.append("file", new Blob([new Uint8Array(await readFile(file))], { type: "audio/mpeg" }), path.basename(file));
  for (const [k, v] of Object.entries(form)) body.append(k, v);
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8 * 60_000);
    try {
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      lastErr = `HTTP ${res.status}: ${text.slice(0, 500)}`;
      // Client errors won't succeed on retry.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastErr = (err as Error).name === "AbortError" ? "timed out after 8 minutes" : (err as Error).message;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw new TranscriptionError("The transcription service failed. You can retry this audit.", `OpenAI transcription failed: ${lastErr}`);
}

async function transcribeChunk(apiKey: string, file: string, offset: number, chunkIndex: number): Promise<Omit<Segment, "role">[]> {
  const data = await postTranscription(apiKey, file, {
    model: DIARIZE_MODEL,
    response_format: "diarized_json",
    chunking_strategy: "auto",
  });
  // An HTTP 200 isn't proof of a transcript: the body must have segments.
  if (!Array.isArray(data?.segments)) {
    throw new TranscriptionError("The transcription service returned an unexpected response.", `No segments in response: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return data.segments
    .map((s: any) => ({
      start: offset + Number(s.start ?? 0),
      end: offset + Number(s.end ?? s.start ?? 0),
      speaker: `c${chunkIndex}-${s.speaker ?? "?"}`,
      text: String(s.text ?? "").trim(),
    }))
    .filter((s: Segment) => s.text.length > 0 && Number.isFinite(s.start));
}

// Re-transcribes one window of the recording (same diarizing model), used
// to recover speech the first pass skipped.
async function transcribeWindow(apiKey: string, source: string, workDir: string, start: number, end: number): Promise<Omit<Segment, "role">[]> {
  const out = path.join(workDir, `gap-${Math.round(start)}.mp3`);
  await cutChunk(source, out, start, Math.max(1, end - start));
  const segs = await transcribeChunk(apiKey, out, start, 0);
  return segs.map((s) => ({ ...s, speaker: `g${Math.round(start)}-${s.speaker.split("-").pop()}` }));
}

const words = (t: string) => t.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;

export interface TranscriptResult {
  segments: Segment[];
  transcriptEnd: number;
  coverage: number; // transcriptEnd / original duration
  notes: string[];
}

// Transcribes the whole converted recording chunk by chunk, then proves the
// transcript is complete: it must reach the last audible moment, and no
// audible stretch may be missing — any suspicious gap is re-transcribed, and
// only accepted as silence/music if that finds no speech.
export async function transcribeFull(params: {
  organizationId: string;
  source: string; // converted 16 kHz mono file
  workDir: string;
  durationSec: number;
  audible: Interval[];
  onProgress?: (msg: string) => Promise<void>;
}): Promise<TranscriptResult> {
  const apiKey = await resolveOpenAiKey(params.organizationId).catch((err) => {
    throw new TranscriptionError("OpenAI isn't configured. Add the API key in Settings.", (err as Error).message);
  });
  const { durationSec, audible } = params;
  const notes: string[] = [];
  let raw: Omit<Segment, "role">[] = [];
  const chunks = Math.max(1, Math.ceil(durationSec / CHUNK_SEC));
  let done = 0;
  const transcribePart = async (i: number) => {
    const start = i * CHUNK_SEC;
    const len = Math.min(CHUNK_SEC, durationSec - start);
    if (len <= 0.5) return [] as Omit<Segment, "role">[];
    const file = path.join(params.workDir, `chunk-${i}.mp3`);
    await cutChunk(params.source, file, start, len);
    let segs = await transcribeChunk(apiKey, file, start, i);
    // A part whose transcript stops well before its audio does is retried once.
    const chunkAudibleEnd = Math.min(start + len, audible.filter((a) => a.start < start + len).reduce((m, a) => Math.max(m, Math.min(a.end, start + len)), start));
    const segEnd = segs.reduce((m, s) => Math.max(m, s.end), start);
    if (chunkAudibleEnd - segEnd > Math.max(20, len * 0.05)) {
      notes.push(`Part ${i + 1}: transcript ended at ${fmt(segEnd)} but audio continues to ${fmt(chunkAudibleEnd)}; re-transcribed.`);
      const again = await transcribeChunk(apiKey, file, start, i);
      if (again.reduce((m, s) => Math.max(m, s.end), start) > segEnd) segs = again;
    }
    done++;
    await params.onProgress?.(`Transcribed ${done} of ${chunks} part(s)`);
    return segs;
  };
  // Three parts at a time; order is restored by timestamp afterwards.
  await params.onProgress?.(`Transcribing ${chunks} part(s)`);
  const queue = Array.from({ length: chunks }, (_, i) => i);
  const results: Array<Omit<Segment, "role">[]> = [];
  await Promise.all(
    Array.from({ length: Math.min(3, chunks) }, async () => {
      for (let i = queue.shift(); i !== undefined; i = queue.shift()) results[i] = await transcribePart(i);
    })
  );
  for (const r of results) if (r) raw.push(...r);
  await recordUsage(params.organizationId, "openai", Math.round(durationSec), (durationSec / 60) * PRICE_PER_MIN, { model: DIARIZE_MODEL, purpose: "qc_transcription" }).catch(() => undefined);
  raw.sort((a, b) => a.start - b.start);

  // Gap check against the speech map: any audible stretch with no
  // transcript is re-transcribed. Speech found there is merged in; a stretch
  // that yields no speech is recorded as music/tones/noise.
  const tolerance = Math.max(15, durationSec * 0.02);
  const audibleEnd = audible.length ? audible[audible.length - 1].end : durationSec;
  const findGaps = (segs: Array<{ start: number; end: number }>): Interval[] => {
    const sorted = [...segs].sort((a, b) => a.start - b.start);
    const out: Interval[] = [];
    let cursor = 0;
    for (const s of [...sorted, { start: audibleEnd, end: audibleEnd }]) {
      const minGap = s.start === audibleEnd && s.end === audibleEnd ? tolerance : 30;
      if (s.start - cursor > minGap && audibleSecondsBetween(audible, cursor, s.start) > Math.min(25, minGap)) out.push({ start: cursor, end: s.start });
      cursor = Math.max(cursor, s.end);
    }
    return out;
  };
  const nonSpeech: Interval[] = [];
  for (const g of findGaps(raw)) {
    await params.onProgress?.(`Checking untranscribed audio at ${fmt(g.start)}–${fmt(g.end)}`);
    const found = await transcribeWindow(apiKey, params.source, params.workDir, g.start, g.end);
    const wc = found.reduce((n, s) => n + words(s.text), 0);
    // Music and tones transcribe to nothing (or a stray word or two); any
    // real words mean people were talking there.
    const perMin = wc / Math.max((g.end - g.start) / 60, 0.5);
    if (wc >= 8 && perMin >= 4) {
      raw.push(...found);
      notes.push(`Recovered ${wc} words at ${fmt(g.start)}–${fmt(g.end)} that the first pass missed.`);
    } else {
      nonSpeech.push(g);
      notes.push(`${fmt(g.start)}–${fmt(g.end)} has sound but no speech (hold music, tones or noise).`);
    }
  }
  raw.sort((a, b) => a.start - b.start);

  if (raw.length === 0) {
    if (audibleSecondsBetween(audible, 0, durationSec) > 20 && nonSpeech.length === 0) {
      throw new TranscriptIncompleteError("No speech could be transcribed even though the recording has sound. Retry, or check the file.", "Empty transcript for audible recording.", { durationSec, audibleEnd });
    }
    throw new TranscriptIncompleteError("No speech was found in this recording — there's nothing to audit.", "Empty transcript (silence/non-speech only).", { durationSec, notes });
  }
  // Whatever speech is still untranscribed after recovery means the
  // transcript is incomplete; the audit must not run on part of the call.
  const missing = findGaps(raw).filter((g) => !nonSpeech.some((n) => n.start <= g.start + 1 && n.end >= g.end - 1));
  const transcriptEnd = raw.reduce((m, s) => Math.max(m, s.end), 0);
  if (missing.length) {
    const g = missing[0];
    throw new TranscriptIncompleteError(
      `The transcript is missing speech at ${fmt(g.start)}–${fmt(g.end)} of this ${fmt(durationSec)} recording, so no audit was produced. Retry to transcribe again.`,
      `Untranscribed audible speech after recovery: ${missing.map((m) => `${m.start.toFixed(1)}-${m.end.toFixed(1)}s`).join(", ")}; transcript end ${transcriptEnd.toFixed(1)}s, audible end ${audibleEnd.toFixed(1)}s.`,
      { missing, transcriptEnd, audibleEnd, durationSec }
    );
  }

  const segments = await assignRoles(params.organizationId, raw);
  return { segments, transcriptEnd, coverage: Math.min(1, transcriptEnd / durationSec), notes };
}

// Each 10-minute part labels its speakers A/B independently, so which label
// is the agent is decided per part from what each speaker says.
async function assignRoles(organizationId: string, raw: Omit<Segment, "role">[]): Promise<Segment[]> {
  const bySpeaker = new Map<string, string[]>();
  for (const s of raw) {
    if (s.speaker === "gap") continue;
    const list = bySpeaker.get(s.speaker) ?? [];
    if (list.join(" ").length < 600) list.push(s.text);
    bySpeaker.set(s.speaker, list);
  }
  let mapping: Record<string, "Agent" | "Customer" | "Other"> = {};
  if (bySpeaker.size > 0) {
    const r = await chatJson<{ roles: Record<string, string> }>({
      organizationId,
      model: "gpt-4o-mini",
      system:
        "You label speakers in a call-centre recording. The Agent is the company representative (introduces the company, pitches, verifies, offers). The Customer is the person called/calling. Other = IVR, voicemail, hold message or a third party. Speakers are grouped by part (c0-, c1-…); each part's labels are independent. JSON only.",
      user: `Speakers and sample lines:\n${[...bySpeaker.entries()].map(([k, v]) => `${k}: ${v.join(" | ")}`).join("\n")}\n\nRespond: {"roles": {"<speaker id>": "Agent"|"Customer"|"Other"}}`,
    });
    mapping = Object.fromEntries(
      Object.entries(r.roles ?? {}).map(([k, v]) => [k, v === "Agent" || v === "Customer" ? v : "Other"])
    ) as typeof mapping;
  }
  return raw.map((s) => ({ ...s, role: mapping[s.speaker] ?? (s.speaker === "gap" ? "Other" : "Other") }));
}

export function fmt(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
