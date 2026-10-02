import { pool } from "../db/pool.js";
import { chatJson } from "../services/openaiService.js";
import { getVapiCall } from "./vapiClient.js";
import { finalizeCall, reportFromVapi } from "./callFinalizer.js";
import type { CampaignSnapshot } from "./assistantBuilder.js";

// A coaching review of one AI conversation: how the agent did against its
// SOP and what it should have done differently. Built only from the real
// transcript; nothing is scored when there's no conversation to judge.
export interface CallReview {
  overallScore: number;
  sopAdherence: { score: number; followed: string[]; deviations: string[] };
  summary: string;
  whatWentWell: string[];
  whatWentPoorly: string[];
  missedOpportunities: string[];
  incorrectStatements: string[];
  customerObjections: string[];
  betterResponses: Array<{ moment: string; agentSaid: string; better: string }>;
  recommendedImprovement: string;
  model: string;
}

const MIN_TALK_SECONDS = 15;
const REVIEW_MODEL = "gpt-4o-mini";

export async function reviewCall(callId: string, opts: { force?: boolean } = {}): Promise<CallReview | null> {
  // Claim the call so the API and the worker never review it twice at once.
  const claim = await pool.query(
    `update calls set ai_review_at = now(), ai_review_error = null
     where id = $1 and (${opts.force ? "true" : "ai_review is null"})
       and (ai_review_at is null or ai_review is not null or ai_review_at < now() - interval '10 minutes')
     returning id, organization_id, campaign_version_id, ai_outcome, talk_seconds, summary`,
    [callId]
  );
  const call = claim.rows[0];
  if (!call) return null;

  try {
    const t = await pool.query("select turns from call_transcripts where call_id = $1", [callId]);
    const turns: Array<{ speaker: string; role?: string; text: string }> = t.rows[0]?.turns ?? [];
    const spoke = turns.filter((x) => x.role === "user" || x.speaker === "Customer").length;
    if (turns.length < 2 || spoke === 0) {
      await pool.query("update calls set ai_review_error = 'No conversation to review.' where id = $1", [callId]);
      return null;
    }
    const v = call.campaign_version_id
      ? await pool.query<{ snapshot: CampaignSnapshot }>("select snapshot from campaign_versions where id = $1", [call.campaign_version_id])
      : { rows: [] as Array<{ snapshot: CampaignSnapshot }> };
    const snap = v.rows[0]?.snapshot;
    const sop = [snap?.agent.systemPrompt, snap?.script ? `Campaign script:\n${snap.script}` : null].filter(Boolean).join("\n\n").slice(0, 14000);
    const disp = await pool.query(
      "select cd.key, cd.label from calls c join call_dispositions cd on cd.id = c.disposition_id where c.id = $1",
      [callId]
    );

    const review = await chatJson<Omit<CallReview, "model">>({
      organizationId: call.organization_id,
      model: REVIEW_MODEL,
      system: `You are a senior call-center QA coach reviewing a call handled by an AI voice agent.
Judge the agent ONLY on what is in the transcript. The SOP/script is the standard: check whether the agent followed its steps, order and required statements.
Be concrete and quote short phrases. "betterResponses" should show, for the 1-4 weakest agent turns, what the agent said and a better line it could have said, following the SOP.
If something didn't happen, don't claim it did. Scores are 0-100. Respond with JSON only.`,
      user: `SOP / script the agent had to follow:
${sop || "(no SOP was attached to this call)"}

Call result: ${disp.rows[0] ? `${disp.rows[0].key} (${disp.rows[0].label})` : call.ai_outcome ?? "unknown"}, talk time ${call.talk_seconds ?? 0}s.

Transcript:
${turns.map((x) => `${x.role === "user" || x.speaker === "Customer" ? "Customer" : "Agent"}: ${x.text}`).join("\n").slice(0, 20000)}

Respond with JSON:
{"overallScore": number, "sopAdherence": {"score": number, "followed": string[], "deviations": string[]},
 "summary": string, "whatWentWell": string[], "whatWentPoorly": string[], "missedOpportunities": string[],
 "incorrectStatements": string[], "customerObjections": string[],
 "betterResponses": [{"moment": string, "agentSaid": string, "better": string}], "recommendedImprovement": string}`,
    });
    const clean: CallReview = {
      overallScore: clamp(review.overallScore),
      sopAdherence: {
        score: clamp(review.sopAdherence?.score),
        followed: list(review.sopAdherence?.followed),
        deviations: list(review.sopAdherence?.deviations),
      },
      summary: String(review.summary ?? ""),
      whatWentWell: list(review.whatWentWell),
      whatWentPoorly: list(review.whatWentPoorly),
      missedOpportunities: list(review.missedOpportunities),
      incorrectStatements: list(review.incorrectStatements),
      customerObjections: list(review.customerObjections),
      betterResponses: Array.isArray(review.betterResponses)
        ? review.betterResponses.slice(0, 6).map((b) => ({ moment: String(b.moment ?? ""), agentSaid: String(b.agentSaid ?? ""), better: String(b.better ?? "") }))
        : [],
      recommendedImprovement: String(review.recommendedImprovement ?? ""),
      model: REVIEW_MODEL,
    };
    await pool.query("update calls set ai_review = $2, ai_review_at = now(), ai_review_error = null where id = $1", [callId, JSON.stringify(clean)]);
    return clean;
  } catch (err) {
    await pool.query("update calls set ai_review_error = $2 where id = $1", [callId, (err as Error).message.slice(0, 500)]);
    throw err;
  }
}

function clamp(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0;
}
function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 10) : [];
}

// Pulls a finished call's recording, transcript and analysis from VAPI —
// for calls whose end-of-call report never arrived or was incomplete.
export async function refreshFromVapi(callId: string): Promise<boolean> {
  const r = await pool.query("select id, organization_id, vapi_call_id from calls where id = $1", [callId]);
  const call = r.rows[0];
  if (!call?.vapi_call_id) return false;
  const v = await getVapiCall(call.organization_id, call.vapi_call_id);
  if (v.status !== "ended") return false;
  const report = reportFromVapi(v);
  await finalizeCall(call.id, report);
  if (!report.recordingUrl) {
    await pool.query(
      `insert into call_recordings (call_id, processing_status, source) values ($1, 'unavailable', 'vapi')
       on conflict (call_id) do update set processing_status = case when call_recordings.file_id is null then 'unavailable' else call_recordings.processing_status end`,
      [call.id]
    );
  }
  return true;
}

// Background catch-up (worker): every answered call gets its VAPI recording
// and an AI review, even if a webhook was missed.
export async function sweepArtifactsAndReviews(): Promise<void> {
  const missing = await pool.query(
    `select c.id from calls c
     left join call_recordings r on r.call_id = c.id
     where c.status = 'completed' and c.vapi_call_id is not null and c.answered
       and c.ended_at < now() - interval '2 minutes' and c.ended_at > now() - interval '3 days'
       and r.call_id is null
     order by c.ended_at desc limit 5`
  );
  for (const row of missing.rows) {
    await refreshFromVapi(row.id).catch((err) =>
      pool.query(`insert into system_logs (level, source, message, metadata) values ('error','vapi.refresh',$1,$2)`, [
        (err as Error).message,
        JSON.stringify({ callId: row.id }),
      ])
    );
  }
  const pending = await pool.query(
    `select c.id from calls c
     where c.status = 'completed' and c.ai_review is null and c.ai_review_error is null and c.talk_seconds >= $1
       and c.ended_at < now() - interval '1 minute' and c.created_at > now() - interval '3 days'
       and exists (select 1 from call_transcripts t where t.call_id = c.id)
       and (c.ai_review_at is null or c.ai_review_at < now() - interval '10 minutes')
     order by c.ended_at desc limit 3`,
    [MIN_TALK_SECONDS]
  );
  for (const row of pending.rows) await reviewCall(row.id).catch(() => undefined);
}

export function shouldReview(talkSeconds: number | null | undefined) {
  return (talkSeconds ?? 0) >= MIN_TALK_SECONDS;
}
