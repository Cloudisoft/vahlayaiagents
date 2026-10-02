import { Readable } from "node:stream";
import { pool, withTransaction } from "../db/pool.js";
import { decideDisposition } from "./dispositionEngine.js";
import { looksLikeVoicemail } from "./voicemailDetector.js";
import { DNC_CODES, ensureDefaultDispositions } from "../services/dispositionsService.js";
import { publishEvent, signalSlotFreed } from "../services/events.js";
import { getStorageDriver, recordFile } from "../services/storageService.js";
import { normalizeCallRecording } from "../services/audioProcessingService.js";
import { spokenAgentName } from "./placeholders.js";

export interface CallReport {
  endedReason: string | null;
  durationSeconds: number | null;
  messages: Array<{ role: string; text: string; secondsFromStart: number }>;
  recordingUrl: string | null;
  summary: string | null;
  successEvaluation: unknown;
  cost: number | null;
}

// Normalises both an end-of-call-report webhook message and a GET /call
// object (used by reconciliation when a webhook was lost) into one shape.
export function reportFromVapi(obj: any): CallReport {
  const call = obj?.call ?? obj ?? {};
  const artifact = obj?.artifact ?? call.artifact ?? {};
  const analysis = obj?.analysis ?? call.analysis ?? {};
  const startedAt = obj?.startedAt ?? call.startedAt;
  const endedAt = obj?.endedAt ?? call.endedAt;
  const duration =
    typeof obj?.durationSeconds === "number"
      ? obj.durationSeconds
      : startedAt && endedAt
        ? (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000
        : null;
  const messages = (artifact.messages ?? obj?.messages ?? [])
    .filter((m: any) => ["user", "bot", "assistant"].includes(m.role))
    .map((m: any) => ({
      role: m.role === "bot" ? "assistant" : m.role,
      text: String(m.message ?? m.content ?? "").trim(),
      secondsFromStart: Number(m.secondsFromStart ?? 0),
    }))
    .filter((m: any) => m.text.length > 0);
  return {
    endedReason: obj?.endedReason ?? call.endedReason ?? null,
    durationSeconds: duration,
    messages,
    recordingUrl: artifact.recordingUrl ?? obj?.recordingUrl ?? call.recordingUrl ?? null,
    summary: analysis.summary ?? obj?.summary ?? null,
    successEvaluation: analysis.successEvaluation ?? null,
    cost: typeof (obj?.cost ?? call.cost) === "number" ? (obj?.cost ?? call.cost) : null,
  };
}

function evaluationToScore(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(n <= 10 ? n * 10 : n);
}

export async function finalizeCall(callId: string, report: CallReport | null, opts: { endedReasonOverride?: string } = {}) {
  const r = await pool.query(
    `select c.*, cmp.max_attempts, cmp.retry_delay_minutes, cmp.retry_on_voicemail,
            cl.id as campaign_lead_id, cl.attempts as lead_attempts,
            cd.key as existing_disposition_key, v.name as voice_name
     from calls c
     left join campaigns cmp on cmp.id = c.campaign_id
     left join campaign_leads cl on cl.last_call_id = c.id
     left join call_dispositions cd on cd.id = c.disposition_id
     left join voices v on v.id = c.voice_id
     where c.id = $1`,
    [callId]
  );
  const call = r.rows[0];
  if (!call) return;

  // Idempotent: a call is finalized once. Later signals (a late
  // end-of-call-report after a sweep closed it) only fill in artifacts.
  if (call.status === "completed" && call.ended_at) {
    if (report) await storeArtifacts(call, report);
    return;
  }

  const messages = report?.messages ?? [];
  const customerSpoke = call.customer_spoke || messages.some((m) => m.role === "user");
  const answered = call.answered || customerSpoke;
  const endedReason = opts.endedReasonOverride ?? report?.endedReason ?? call.ended_reason ?? null;
  const transcriptVoicemail = looksLikeVoicemail(messages);
  const voicemailDetected = call.voicemail_detected || endedReason === "voicemail" || transcriptVoicemail;
  const voicemailMethod = call.voicemail_detected || endedReason === "voicemail" ? "audio" : transcriptVoicemail ? "transcript" : null;
  const duration =
    report?.durationSeconds ?? (call.started_at ? (Date.now() - new Date(call.started_at).getTime()) / 1000 : 0);
  const talkSeconds = answered ? Math.max(0, Math.round(duration)) : 0;
  const transferStatus = endedReason === "assistant-forwarded-call" ? "connected" : call.transfer_status;

  const decision = decideDisposition(
    {
      dncRequested: call.dnc_requested,
      voicemailDetected,
      transferStatus,
      endedReason,
      answered,
      customerSpoke,
      talkSeconds,
      aiOutcome: call.ai_outcome,
    },
    {
      maxAttempts: call.max_attempts ?? 3,
      retryDelayMinutes: call.retry_delay_minutes ?? 60,
      retryOnVoicemail: call.retry_on_voicemail ?? true,
    },
    call.lead_attempts ?? 0,
    call.callback_at ? new Date(call.callback_at) : null,
    new Date(),
    call.disposition_source === "manual" ? call.existing_disposition_key : null
  );

  await ensureDefaultDispositions(call.organization_id);
  await withTransaction(async (client) => {
    const disp = await client.query<{ id: string }>(
      "select id from call_dispositions where organization_id = $1 and key = $2",
      [call.organization_id, decision.key]
    );
    await client.query(
      `update calls set status = 'completed', ended_at = coalesce(ended_at, now()), ended_reason = $2,
         duration_seconds = $3, talk_seconds = $4, answered = $5, customer_spoke = $6,
         voicemail_detected = $7, voicemail_method = $8, transfer_status = $9,
         disposition_id = case when disposition_source = 'manual' then disposition_id else coalesce($10, disposition_id) end,
         cost_usd = coalesce($11, cost_usd), last_signal_at = now()
       where id = $1`,
      [
        callId,
        endedReason,
        Math.round(duration),
        talkSeconds,
        answered,
        customerSpoke,
        voicemailDetected,
        voicemailMethod,
        transferStatus,
        disp.rows[0]?.id ?? null,
        report?.cost ?? null,
      ]
    );

    if (call.campaign_lead_id) {
      await client.query(
        `update campaign_leads set status = $2, next_attempt_at = $3, last_disposition = $4 where id = $1`,
        [
          call.campaign_lead_id,
          DNC_CODES.includes(decision.key) ? "dnc" : decision.retry ? "retry_scheduled" : "done",
          decision.nextAttemptAt,
          decision.key,
        ]
      );
    }
    if (call.lead_id) {
      await client.query(
        `update leads set call_status = $2, is_dnc = is_dnc or $3, updated_at = now() where id = $1`,
        [call.lead_id, decision.key, DNC_CODES.includes(decision.key)]
      );
    }
    if (DNC_CODES.includes(decision.key) && call.to_number) {
      await client.query(
        `insert into dnc_entries (organization_id, phone_e164, reason) values ($1,$2,'Requested during call')
         on conflict (organization_id, phone_e164) do nothing`,
        [call.organization_id, call.to_number]
      );
    }
    if (report?.cost) {
      await client.query(
        `insert into usage (organization_id, category, units, cost_usd, metadata) values ($1,'vapi',$2,$3,$4)`,
        [call.organization_id, Math.round(duration), report.cost, JSON.stringify({ callId })]
      );
    }
  });

  if (report) await storeArtifacts(call, report);

  await publishEvent(call.organization_id, { type: "call_ended", callId, disposition: decision.key, campaignId: call.campaign_id });
  if (call.campaign_id) await signalSlotFreed(call.campaign_id);
}

async function storeArtifacts(call: any, report: CallReport) {
  const speaker = spokenAgentName(call.voice_name) || "Agent";
  if (report.messages.length > 0) {
    const turns = report.messages.map((m) => ({
      speaker: m.role === "assistant" ? speaker : "Customer",
      role: m.role,
      text: m.text,
      ts: m.secondsFromStart,
    }));
    await pool.query(
      `insert into call_transcripts (call_id, full_text, turns, summary) values ($1,$2,$3,$4)
       on conflict (call_id) do update set full_text = excluded.full_text, turns = excluded.turns,
         summary = coalesce(excluded.summary, call_transcripts.summary)`,
      [call.id, turns.map((t) => `${t.speaker}: ${t.text}`).join("\n"), JSON.stringify(turns), report.summary]
    );
  }
  if (report.summary || report.successEvaluation != null) {
    await pool.query(
      `update calls set summary = coalesce($2, summary), evaluation_score = coalesce($3, evaluation_score),
         evaluation = coalesce($4, evaluation) where id = $1`,
      [call.id, report.summary, evaluationToScore(report.successEvaluation), JSON.stringify({ successEvaluation: report.successEvaluation })]
    );
  }
  if (report.recordingUrl) {
    storeRecording(call, report.recordingUrl).catch((err) =>
      pool.query(`insert into system_logs (organization_id, level, source, message) values ($1,'error','vapi.recording',$2)`, [
        call.organization_id,
        `Recording for call ${call.id} failed: ${(err as Error).message}`,
      ])
    );
  }
}

async function storeRecording(call: any, url: string) {
  const existing = await pool.query("select file_id from call_recordings where call_id = $1 and file_id is not null", [call.id]);
  if (existing.rows.length > 0) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const raw = Buffer.from(await res.arrayBuffer());
  const ext = (new URL(url).pathname.split(".").pop() || "wav").toLowerCase();
  const mp3 = await normalizeCallRecording(raw, ext);
  const key = `${call.organization_id}/calls/${call.id}.mp3`;
  const stored = await getStorageDriver().put(key, Readable.from(mp3), "audio/mpeg");
  const fileId = await recordFile({
    organizationId: call.organization_id,
    key: stored.key,
    fileName: `call-${call.id}.mp3`,
    fileType: "mp3",
    mimeType: "audio/mpeg",
    size: stored.size,
  });
  await pool.query(
    `insert into call_recordings (call_id, file_id, provider_recording_url, processing_status)
     values ($1,$2,$3,'completed')
     on conflict (call_id) do update set file_id = excluded.file_id, provider_recording_url = excluded.provider_recording_url,
       processing_status = 'completed'`,
    [call.id, fileId, url]
  );
}
