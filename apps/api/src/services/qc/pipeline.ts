import os from "node:os";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline as pump } from "node:stream/promises";
import { pool } from "../../db/pool.js";
import { getStorageDriver, recordFile } from "../storageService.js";
import { notify } from "../notifyService.js";
import { AudioError, audibleIntervals, convertForTranscription, decodedDuration, probe } from "./audio.js";
import { TranscriptIncompleteError, TranscriptionError, fmt, transcribeFull, type Segment } from "./transcribe.js";
import { analyzeTranscript, type QcReport } from "./analyze.js";
import { renderQcPdf } from "./pdf.js";

export type QcStatus =
  | "UPLOADED"
  | "VALIDATING"
  | "CONVERTING"
  | "TRANSCRIBING"
  | "VALIDATING_TRANSCRIPT"
  | "ANALYZING"
  | "SAVING_REPORT"
  | "READY"
  | "AUDIO_FAILED"
  | "TRANSCRIPTION_FAILED"
  | "TRANSCRIPT_INCOMPLETE"
  | "ANALYSIS_FAILED"
  | "PDF_FAILED";

export const FAILED_STATES: QcStatus[] = ["AUDIO_FAILED", "TRANSCRIPTION_FAILED", "TRANSCRIPT_INCOMPLETE", "ANALYSIS_FAILED", "PDF_FAILED"];
// Where a queued job may (re)start. Analysis and PDF retries reuse the saved
// transcript; anything earlier reprocesses the audio from the original.
const START_STATES: QcStatus[] = ["UPLOADED", "ANALYZING", "SAVING_REPORT"];
const STALE_MINUTES = 30;

export const DEFAULT_MANDATORY_RULE = "The new account will be created under the second point-of-contact person's information.";

export async function ensureDefaultRules(organizationId: string) {
  await pool.query(
    `insert into audit_rules (organization_id, rule, mandatory)
     select $1, $2, true where not exists (select 1 from audit_rules where organization_id = $1)`,
    [organizationId, DEFAULT_MANDATORY_RULE]
  );
}

class StageError extends Error {
  constructor(public status: QcStatus, public userMessage: string, public technical: string) {
    super(technical);
  }
}

const legacyStatus = (s: QcStatus) => (s === "READY" ? "completed" : FAILED_STATES.includes(s) ? "failed" : s === "UPLOADED" ? "pending" : "processing");

async function setStatus(id: string, status: QcStatus, message: string | null = null) {
  await pool.query(
    "update call_audits set status = $2, processing_status = $3, status_message = $4, locked_at = now(), updated_at = now() where id = $1",
    [id, status, legacyStatus(status), message]
  );
}

async function logStage(id: string, stage: string, info: Record<string, unknown>) {
  const entry = { stage, at: new Date().toISOString(), ...info };
  console.log(`[qc ${id.slice(0, 8)}] ${stage}`, JSON.stringify(info));
  await pool.query("update call_audits set stage_log = stage_log || $2::jsonb, locked_at = now() where id = $1", [id, JSON.stringify([entry])]);
}

async function download(key: string, dest: string): Promise<number> {
  const stream = await getStorageDriver().open(key);
  await pump(stream as NodeJS.ReadableStream, createWriteStream(dest));
  return (await stat(dest)).size;
}

// Takes the next queued audit (or one whose worker died mid-way).
export async function claimNextAudit(): Promise<string | null> {
  const r = await pool.query(
    `update call_audits set locked_at = now(), attempts = attempts + 1, started_at = coalesce(started_at, now())
     where id = (select id from call_audits
                 where status = any($1::text[]) and (locked_at is null or locked_at < now() - make_interval(mins => $2))
                    or (status = any($3::text[]) and locked_at < now() - make_interval(mins => $2))
                 order by created_at limit 1 for update skip locked)
     returning id`,
    [START_STATES, STALE_MINUTES, ["VALIDATING", "CONVERTING", "TRANSCRIBING", "VALIDATING_TRANSCRIPT"]]
  );
  return r.rows[0]?.id ?? null;
}

export async function runAudit(id: string): Promise<QcStatus> {
  const r = await pool.query(
    `select ca.*, f.file_path, f.file_name as source_name, f.mime_type as source_mime, f.file_size as source_size
     from call_audits ca left join files f on f.id = ca.source_file_id where ca.id = $1`,
    [id]
  );
  const audit = r.rows[0];
  if (!audit) return "AUDIO_FAILED";
  // A stale in-progress state means the previous run died; start that over.
  let from: QcStatus = START_STATES.includes(audit.status) ? audit.status : "UPLOADED";
  if (from !== "UPLOADED" && !audit.transcript) from = "UPLOADED";
  if (from === "SAVING_REPORT" && !audit.report) from = "ANALYZING";
  const workDir = await mkdtemp(path.join(os.tmpdir(), "vahlay-qc-"));
  let stage: QcStatus = from;
  const t0 = Date.now();
  try {
    let segments: Segment[] = audit.transcript ?? [];
    let durationSec: number = audit.original_duration_sec ?? 0;

    if (from === "UPLOADED") {
      await pool.query(
        `update call_audits set error_technical = null, failed_stage = null, transcript = null, transcript_text = null,
           transcript_end_sec = null, transcript_coverage = null, report = null, pass = null, needs_review = null, overall_score = null
         where id = $1`,
        [id]
      );
      // VALIDATING: the stored original is readable, non-empty and real audio.
      stage = "VALIDATING";
      await setStatus(id, stage, "Checking the recording");
      let key: string | null = audit.file_path;
      let name: string = audit.original_file_name ?? audit.source_name ?? "recording";
      if (!key && audit.call_id) {
        const rec = await pool.query(
          "select f.file_path, f.file_name from call_recordings cr join files f on f.id = cr.file_id where cr.call_id = $1",
          [audit.call_id]
        );
        key = rec.rows[0]?.file_path ?? null;
        name = rec.rows[0]?.file_name ?? name;
      }
      if (!key) throw new StageError("AUDIO_FAILED", "There's no recording attached to this audit.", "No source file key.");
      const ext = (path.extname(name) || ".bin").toLowerCase();
      const original = path.join(workDir, `original${ext}`);
      let size: number;
      try {
        size = await download(key, original);
      } catch (err) {
        throw new StageError("AUDIO_FAILED", "The uploaded recording couldn't be read from storage.", `Storage read failed: ${(err as Error).message}`);
      }
      if (size === 0) throw new StageError("AUDIO_FAILED", "The uploaded file is empty.", "Zero-byte source file.");
      await logStage(id, "upload", { bytes: size, file: name });
      const info = await probe(original);
      durationSec = info.durationSec;
      if (durationSec < 1) throw new StageError("AUDIO_FAILED", "The recording is shorter than one second.", `Duration ${durationSec}s.`);
      await pool.query("update call_audits set original_duration_sec = $2, audio_info = $3 where id = $1", [id, durationSec, JSON.stringify(info)]);
      await logStage(id, "ffprobe", { sourceDurationSec: durationSec, format: info.formatName, codec: info.codec, sampleRate: info.sampleRate, channels: info.channels });

      // CONVERTING: decode everything, then prove nothing was lost.
      stage = "CONVERTING";
      await setStatus(id, stage, `Converting ${fmt(durationSec)} of audio`);
      const converted = path.join(workDir, "converted.mp3");
      await convertForTranscription(original, converted);
      const sourceDecoded = await decodedDuration(original);
      // A header promising far more audio than the file holds means the
      // upload is cut off; auditing it would silently skip the rest.
      if (info.durationSec - sourceDecoded > Math.max(5, info.durationSec * 0.02)) {
        throw new StageError(
          "AUDIO_FAILED",
          `This file looks incomplete: it is labelled ${fmt(info.durationSec)} long but only ${fmt(sourceDecoded)} of audio is in it. Re-upload the complete recording.`,
          `Header duration ${info.durationSec}s vs decoded ${sourceDecoded}s.`
        );
      }
      const convertedDuration = await decodedDuration(converted);
      // Headers can understate (e.g. VBR MP3); the decoded length is the truth.
      durationSec = Math.max(durationSec, sourceDecoded);
      const tol = Math.max(1.5, durationSec * 0.005);
      await logStage(id, "ffmpeg", { sourceDecodedSec: sourceDecoded, convertedDurationSec: convertedDuration, toleranceSec: tol });
      if (Math.abs(convertedDuration - durationSec) > tol) {
        throw new StageError(
          "AUDIO_FAILED",
          `Conversion produced ${fmt(convertedDuration)} of audio from a ${fmt(durationSec)} recording, so it was stopped rather than audit part of the call.`,
          `Converted ${convertedDuration}s vs source ${durationSec}s (tolerance ${tol}s).`
        );
      }
      const audible = await audibleIntervals(converted, convertedDuration);
      const audibleEnd = audible.length ? audible[audible.length - 1].end : 0;
      await pool.query("update call_audits set original_duration_sec = $2, converted_duration_sec = $3, audible_end_sec = $4 where id = $1", [id, durationSec, convertedDuration, audibleEnd]);
      await logStage(id, "converted duration", { convertedDurationSec: convertedDuration, audibleEndSec: audibleEnd, audibleIntervals: audible.length });

      // TRANSCRIBING (+ coverage proof inside).
      stage = "TRANSCRIBING";
      await setStatus(id, stage, "Transcribing the full recording");
      const t = await transcribeFull({
        organizationId: audit.organization_id,
        source: converted,
        workDir,
        durationSec: convertedDuration,
        audible,
        onProgress: async (msg) => {
          await pool.query("update call_audits set status_message = $2, locked_at = now() where id = $1", [id, msg]);
        },
      });
      await logStage(id, "transcription", { segments: t.segments.length, transcriptEndSec: t.transcriptEnd, notes: t.notes });

      // VALIDATING_TRANSCRIPT: final structural checks before it's saved.
      stage = "VALIDATING_TRANSCRIPT";
      await setStatus(id, stage, "Validating transcript coverage");
      segments = t.segments;
      const outOfRange = segments.filter((s) => s.start < -1 || s.end > convertedDuration + 3);
      if (outOfRange.length) {
        throw new StageError("TRANSCRIPT_INCOMPLETE", "The transcript's timestamps don't line up with the recording. Retry to transcribe again.", `${outOfRange.length} segment(s) outside 0-${convertedDuration}s.`);
      }
      const roles = new Set(segments.map((s) => s.role));
      await pool.query(
        `update call_audits set transcript = $2, transcript_text = $3, transcript_end_sec = $4, transcript_coverage = $5, transcript_model = $6 where id = $1`,
        [id, JSON.stringify(segments), segments.map((s) => `[${fmt(s.start)}] ${s.role}: ${s.text}`).join("\n"), t.transcriptEnd, t.coverage, "gpt-4o-transcribe-diarize"]
      );
      await logStage(id, "coverage", { coveragePct: Math.round(t.coverage * 1000) / 10, transcriptEndSec: t.transcriptEnd, sourceDurationSec: durationSec, roles: [...roles] });
    }

    let report: QcReport | null = from === "SAVING_REPORT" ? audit.report : null;
    if (!report) {
      stage = "ANALYZING";
      await setStatus(id, stage, "Auditing the full transcript");
      await ensureDefaultRules(audit.organization_id);
      const rules = await pool.query("select rule, mandatory from audit_rules where organization_id = $1 and active order by created_at", [audit.organization_id]);
      try {
        report = await analyzeTranscript({
          organizationId: audit.organization_id,
          segments,
          durationSec,
          rules: rules.rows,
          agentName: audit.agent_name,
          businessName: audit.business_name,
        });
      } catch (err) {
        throw new StageError("ANALYSIS_FAILED", "The AI audit couldn't be completed. Retry — the transcript is kept.", `Analysis failed: ${(err as Error).message}`);
      }
      await logStage(id, "analysis", { overall: report.scores.overall, pass: report.pass, evidence: report.evidenceStats });
    }

    stage = "SAVING_REPORT";
    await setStatus(id, stage, "Saving the report");
    await pool.query(
      `update call_audits set report = $2, overall_score = $3, pass = $4, needs_review = $5,
         criterion_scores = $6, strengths = $7, improvements = $8, missed_opportunities = $9, key_moments = $10, coaching_notes = $11
       where id = $1`,
      [
        id,
        JSON.stringify(report),
        report.scores.overall,
        report.pass,
        report.needsReview,
        JSON.stringify(report.dimensions.map((d) => ({ criterionId: d.key, criterionName: d.label, score: d.score ?? 0, passed: (d.score ?? 100) >= 70, notes: d.finding }))),
        report.wentWell.map((f) => f.title),
        report.toImprove.map((f) => f.title),
        report.findings.red.map((f) => f.title),
        JSON.stringify(report.keyMoments),
        report.coaching.map((c) => c.recommendation).join("\n"),
      ]
    );
    await logStage(id, "database", { saved: true });

    // PDF from what was just saved, not from memory.
    const saved = (await pool.query("select * from call_audits where id = $1", [id])).rows[0];
    let pdf: Buffer;
    try {
      pdf = await renderQcPdf({
        id,
        fileName: saved.original_file_name,
        agentName: saved.agent_name,
        businessName: saved.business_name,
        createdAt: new Date(saved.created_at),
        originalDurationSec: Number(saved.original_duration_sec),
        transcriptCoverage: Number(saved.transcript_coverage),
        report: saved.report,
        transcript: saved.transcript,
      });
      if (pdf.length < 1000 || pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error(`Rendered PDF looks invalid (${pdf.length} bytes).`);
      const key = `${saved.organization_id}/audits/${id}/qc-report.pdf`;
      const stored = await getStorageDriver().put(key, Readable.from(pdf), "application/pdf");
      const fileId = await recordFile({ organizationId: saved.organization_id, key: stored.key, fileName: "qc-report.pdf", fileType: "pdf", mimeType: "application/pdf", size: stored.size });
      await pool.query("update call_audits set pdf_file_id = $2 where id = $1", [id, fileId]);
      await logStage(id, "pdf", { bytes: pdf.length });
    } catch (err) {
      throw new StageError("PDF_FAILED", "The report was saved but its PDF couldn't be generated. Retry to build the PDF.", `PDF failed: ${(err as Error).message}`);
    }

    await pool.query(
      "update call_audits set status = 'READY', processing_status = 'completed', status_message = null, completed_at = now(), locked_at = null, updated_at = now() where id = $1",
      [id]
    );
    await logStage(id, "ready", { totalMs: Date.now() - t0 });
    await notify(audit.organization_id, {
      type: "audit_completed",
      title: `QC ${report.pass ? "PASS" : "FAIL"} · ${report.scores.overall}/100`,
      body: `${audit.original_file_name ?? "Call"} (${fmt(durationSec)})`,
      link: `/qc?audit=${id}`,
    }).catch(() => undefined);
    return "READY";
  } catch (err) {
    const e =
      err instanceof StageError
        ? err
        : err instanceof AudioError
          ? new StageError("AUDIO_FAILED", err.userMessage, err.technical)
          : err instanceof TranscriptIncompleteError
            ? new StageError("TRANSCRIPT_INCOMPLETE", err.userMessage, `${err.technical} ${JSON.stringify(err.details)}`)
            : err instanceof TranscriptionError
              ? new StageError("TRANSCRIPTION_FAILED", err.userMessage, err.technical)
              : new StageError(
                  stage === "ANALYZING" ? "ANALYSIS_FAILED" : stage === "SAVING_REPORT" ? "PDF_FAILED" : stage === "TRANSCRIBING" || stage === "VALIDATING_TRANSCRIPT" ? "TRANSCRIPTION_FAILED" : "AUDIO_FAILED",
                  "Processing failed. You can retry this audit.",
                  (err as Error).stack ?? String(err)
                );
    await pool.query(
      `update call_audits set status = $2, processing_status = 'failed', status_message = $3, error_technical = $4, failed_stage = $5,
         locked_at = null, updated_at = now() where id = $1`,
      [id, e.status, e.userMessage, e.technical.slice(0, 4000), stage]
    );
    await logStage(id, "failed", { status: e.status, stage, error: e.technical.slice(0, 1000) });
    await notify(audit.organization_id, {
      type: "audit_failed",
      title: `QC ${e.status.replace(/_/g, " ").toLowerCase()}`,
      body: `${audit.original_file_name ?? "Recording"}: ${e.userMessage}`.slice(0, 240),
      link: `/qc?audit=${id}`,
    }).catch(() => undefined);
    await pool.query(`insert into system_logs (organization_id, level, source, message, metadata) values ($1,'error','qc_pipeline',$2,$3)`, [
      audit.organization_id,
      e.technical.slice(0, 2000),
      JSON.stringify({ auditId: id, stage, status: e.status }),
    ]).catch(() => undefined);
    return e.status;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Queue a failed audit again from the right stage.
export async function retryAudit(id: string, organizationId: string): Promise<QcStatus | null> {
  const r = await pool.query("select status, transcript is not null as has_t, report is not null as has_r from call_audits where id = $1 and organization_id = $2", [id, organizationId]);
  const a = r.rows[0];
  if (!a) return null;
  const next: QcStatus = a.status === "PDF_FAILED" && a.has_r ? "SAVING_REPORT" : a.status === "ANALYSIS_FAILED" && a.has_t ? "ANALYZING" : "UPLOADED";
  await pool.query(
    "update call_audits set status = $2, processing_status = 'pending', status_message = 'Queued for retry', locked_at = null, updated_at = now() where id = $1",
    [id, next]
  );
  return next;
}

// Worker loop: a couple of audits at a time; one failure never stops the rest.
export function startQcWorker(concurrency = 2) {
  let running = 0;
  const tick = async () => {
    while (running < concurrency) {
      const id = await claimNextAudit().catch(() => null);
      if (!id) return;
      running++;
      runAudit(id)
        .catch((err) => console.error("[qc] unexpected", err))
        .finally(() => {
          running--;
          void tick();
        });
    }
  };
  setInterval(() => void tick(), 3000);
  void tick();
}
