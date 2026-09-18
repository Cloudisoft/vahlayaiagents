import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ffmpegPathModule from "ffmpeg-static";

const ffmpegPath = ffmpegPathModule as unknown as string;
import { transcribeAudio } from "./openaiService.js";

const SEGMENT_SECONDS = 600; // 10 min segments, well under Whisper's 25MB request limit at 64kbps

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))));
    proc.on("error", reject);
  });
}

export async function getAudioDurationSeconds(buffer: Buffer, ext: string): Promise<number | null> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vahlay-audio-"));
  const inputPath = path.join(dir, `input.${ext}`);
  try {
    await writeFile(inputPath, buffer);
    const duration = await new Promise<number | null>((resolve) => {
      const proc = spawn(ffmpegPath, ["-i", inputPath]);
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("close", () => {
        const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
        if (!match) return resolve(null);
        resolve(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
      });
    });
    return duration;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Transcribes a (possibly long) recording by segmenting it with ffmpeg into
// chunks that fit under Whisper's real per-request size limit, transcribing
// each sequentially, and stitching the text back together with offsets.
// This is what actually makes the spec's "up to ~1 hour" claim true rather
// than something that silently fails on a real file.
export async function transcribeLongAudio(params: {
  organizationId: string;
  buffer: Buffer;
  fileExt: string;
}): Promise<{ fullText: string; segments: Array<{ startSeconds: number; text: string }> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vahlay-audio-"));
  const inputPath = path.join(dir, `input.${params.fileExt}`);
  const segmentPattern = path.join(dir, "segment-%04d.mp3");

  try {
    await writeFile(inputPath, params.buffer);
    await run(ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      "-f",
      "segment",
      "-segment_time",
      String(SEGMENT_SECONDS),
      segmentPattern,
    ]);

    const files = (await readdir(dir)).filter((f) => f.startsWith("segment-")).sort();
    const segments: Array<{ startSeconds: number; text: string }> = [];

    for (let i = 0; i < files.length; i++) {
      const chunk = await readFile(path.join(dir, files[i]));
      const { text } = await transcribeAudio({
        organizationId: params.organizationId,
        audio: chunk,
        filename: files[i],
      });
      segments.push({ startSeconds: i * SEGMENT_SECONDS, text });
    }

    return { fullText: segments.map((s) => s.text).join(" "), segments };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
