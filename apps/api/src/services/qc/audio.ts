import { spawn } from "node:child_process";
import path from "node:path";
import { readdir } from "node:fs/promises";
import ffmpegPathModule from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const FFMPEG = ffmpegPathModule as unknown as string;
const FFPROBE = (ffprobeStatic as { path: string }).path;

export class AudioError extends Error {
  constructor(public userMessage: string, public technical: string) {
    super(technical);
    this.name = "AudioError";
  }
}

function exec(bin: string, args: string[], timeoutMs = 30 * 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(bin)} exited with code ${code}: ${stderr.slice(-800)}`));
    });
  });
}

export interface ProbeResult {
  durationSec: number;
  formatName: string;
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  bitRate: number | null;
}

// The true duration of the file as stored. Prefers the audio stream's own
// duration, falling back to the container's; a file with neither is not
// trusted.
export async function probe(file: string): Promise<ProbeResult> {
  let out: string;
  try {
    out = (await exec(FFPROBE, ["-v", "error", "-show_entries", "format=duration,format_name,bit_rate:stream=codec_type,codec_name,sample_rate,channels,duration", "-of", "json", file], 120_000)).stdout;
  } catch (err) {
    throw new AudioError("This file couldn't be read as audio. It may be corrupt or not an audio recording.", `ffprobe failed: ${(err as Error).message}`);
  }
  const j = JSON.parse(out || "{}");
  const stream = (j.streams ?? []).find((s: any) => s.codec_type === "audio");
  if (!stream) throw new AudioError("No audio track was found in this file.", `ffprobe: no audio stream (${out.slice(0, 300)})`);
  const durations = [Number(stream.duration), Number(j.format?.duration)].filter((d) => Number.isFinite(d) && d > 0);
  if (durations.length === 0) throw new AudioError("The recording's length couldn't be determined; the file may be damaged.", `ffprobe: no duration (${out.slice(0, 300)})`);
  return {
    durationSec: Math.max(...durations),
    formatName: j.format?.format_name ?? "unknown",
    codec: stream.codec_name ?? null,
    sampleRate: stream.sample_rate ? Number(stream.sample_rate) : null,
    channels: stream.channels ? Number(stream.channels) : null,
    bitRate: j.format?.bit_rate ? Number(j.format.bit_rate) : null,
  };
}

// Decodes every sample of the original into one normalised file for
// transcription (16 kHz mono MP3). Nothing is trimmed; the result's
// duration is checked against the original by the caller.
export async function convertForTranscription(input: string, output: string): Promise<void> {
  try {
    await exec(FFMPEG, ["-y", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", output]);
  } catch (err) {
    throw new AudioError("The recording couldn't be converted for transcription. It may be corrupt or use an unsupported codec.", `ffmpeg conversion failed: ${(err as Error).message}`);
  }
}

// The decoded length by actually reading every frame (container headers
// can lie, especially for VBR MP3s and WebM).
export async function decodedDuration(file: string): Promise<number> {
  try {
    const { stderr } = await exec(FFMPEG, ["-v", "info", "-nostats", "-i", file, "-f", "null", "-"], 15 * 60_000);
    const times = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    const last = times[times.length - 1];
    if (last) return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
  } catch (err) {
    throw new AudioError("The converted audio couldn't be verified.", `ffmpeg decode check failed: ${(err as Error).message}`);
  }
  return (await probe(file)).durationSec;
}

export interface Interval {
  start: number;
  end: number;
}

// Where there's sound (speech, music, noise) as opposed to silence, so
// transcript coverage is judged against what can actually be transcribed.
export async function audibleIntervals(file: string, durationSec: number): Promise<Interval[]> {
  let stderr: string;
  try {
    stderr = (await exec(FFMPEG, ["-v", "info", "-nostats", "-i", file, "-af", "silencedetect=noise=-38dB:d=1.5", "-f", "null", "-"], 15 * 60_000)).stderr;
  } catch (err) {
    throw new AudioError("The recording couldn't be analysed for speech.", `ffmpeg silencedetect failed: ${(err as Error).message}`);
  }
  const silences: Interval[] = [];
  let open: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (e && open !== null) {
      silences.push({ start: open, end: Number(e[1]) });
      open = null;
    }
  }
  if (open !== null) silences.push({ start: open, end: durationSec });
  const audible: Interval[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) audible.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < durationSec) audible.push({ start: cursor, end: durationSec });
  return audible.filter((a) => a.end - a.start >= 0.3);
}

export function audibleSecondsBetween(audible: Interval[], from: number, to: number): number {
  let total = 0;
  for (const a of audible) total += Math.max(0, Math.min(a.end, to) - Math.max(a.start, from));
  return total;
}

// Exact, re-encoded pieces (not stream copies, which snap to frames and can
// drop or repeat audio at the cut).
export async function cutChunk(input: string, output: string, start: number, length: number): Promise<void> {
  try {
    await exec(FFMPEG, ["-y", "-v", "error", "-ss", start.toFixed(3), "-t", length.toFixed(3), "-i", input, "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", output]);
  } catch (err) {
    throw new AudioError("The recording couldn't be split for transcription.", `ffmpeg chunking failed at ${start}s: ${(err as Error).message}`);
  }
}

export async function listFiles(dir: string) {
  return readdir(dir);
}
