import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pool } from "../../db/pool.js";
import { chatJson } from "../openaiService.js";
import { notify } from "../notifyService.js";
import { getStorageDriver, recordFile } from "../storageService.js";
import { voiceCredentials } from "../cartesiaService.js";
import { createVapiCall, getVapiCall, vapiServerUrl, vapiWebhookSecret } from "../../voiceai/vapiClient.js";
import { vapiVoiceConfig } from "../../voiceai/assistantBuilder.js";
import { reportFromVapi, type CallReport } from "../../voiceai/callFinalizer.js";
import { normalizeE164 } from "../../utils/phone.js";
import { auditDecision, logActivity, setStage } from "./activity.js";
import { clampScore, cleanQuotes } from "./evidence.js";
import { createMessage, formatInZone } from "./messaging.js";

export const EVAL_MODEL = "gpt-4o";
const NO_ANSWER = /did-not-answer|customer-busy|voicemail|no-answer|failed-to-connect|unanswered/i;

export interface InterviewQuestion {
  question: string;
  purpose?: string;
}

export interface InterviewSettings {
  questions?: InterviewQuestion[];
  durationMinutes?: number;
  interviewerName?: string;
  voiceId?: string | null; // voices.id
  evaluationCriteria?: Array<{ key: string; label: string; weight: number }>;
  nextRoundThreshold?: number;
  holdThreshold?: number;
  slotMinutes?: number;
  days?: number[]; // 0=Sun … 6=Sat
  startHour?: number;
  endHour?: number;
  maxPerSlot?: number;
  timeZone?: string; // the hiring team's zone; candidates pick in their own
}

export const DEFAULT_EVAL_CRITERIA = [
  { key: "communication", label: "Communication", weight: 25 },
  { key: "role_knowledge", label: "Role knowledge", weight: 30 },
  { key: "experience", label: "Relevant experience", weight: 25 },
  { key: "motivation", label: "Motivation & fit", weight: 20 },
];

export function interviewSettings(job: { interview_settings?: any }): Required<Omit<InterviewSettings, "voiceId" | "questions">> & Pick<InterviewSettings, "voiceId" | "questions"> {
  const s = (job.interview_settings ?? {}) as InterviewSettings;
  return {
    questions: Array.isArray(s.questions) ? s.questions.filter((q) => q?.question?.trim()) : [],
    durationMinutes: Math.min(45, Math.max(5, Number(s.durationMinutes) || 15)),
    interviewerName: (s.interviewerName || "Alex").slice(0, 30),
    voiceId: s.voiceId ?? null,
    evaluationCriteria: Array.isArray(s.evaluationCriteria) && s.evaluationCriteria.length ? s.evaluationCriteria : DEFAULT_EVAL_CRITERIA,
    nextRoundThreshold: Number(s.nextRoundThreshold) || 75,
    holdThreshold: Number(s.holdThreshold) || 60,
    slotMinutes: [15, 20, 30, 45, 60].includes(Number(s.slotMinutes)) ? Number(s.slotMinutes) : 30,
    days: Array.isArray(s.days) && s.days.length ? s.days.map(Number) : [1, 2, 3, 4, 5],
    startHour: Number.isFinite(Number(s.startHour)) ? Number(s.startHour) : 9,
    endHour: Number.isFinite(Number(s.endHour)) ? Number(s.endHour) : 17,
    maxPerSlot: Math.max(1, Number(s.maxPerSlot) || 3),
    timeZone: s.timeZone || "America/New_York",
  };
}

// ---------- scheduling ----------

// Wall-clock time in a zone → UTC instant.
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asZone = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
  return new Date(guess - (asZone - guess));
}

// Bookable slots for the next `days` days in the hiring team's zone, minus
// full slots. A slot must be at least 2 hours away.
export async function availableSlots(organizationId: string, job: any, days = 10, excludeSessionId?: string): Promise<string[]> {
  const s = interviewSettings(job);
  const taken = await pool.query<{ at: Date; n: number }>(
    `select scheduled_at as at, count(*)::int as n from interview_sessions
     where organization_id = $1 and scheduling_status = 'scheduled' and scheduled_at > now() and ($2::uuid is null or id <> $2)
     group by scheduled_at`,
    [organizationId, excludeSessionId ?? null]
  );
  const full = new Set(taken.rows.filter((t) => t.n >= s.maxPerSlot).map((t) => new Date(t.at).toISOString()));
  const out: string[] = [];
  const earliest = Date.now() + 2 * 3600_000;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: s.timeZone }).format(new Date()); // YYYY-MM-DD
  const [ty, tm, td] = today.split("-").map(Number);
  for (let i = 0; i <= days; i++) {
    const day = new Date(Date.UTC(ty, tm - 1, td + i));
    if (!s.days.includes(day.getUTCDay())) continue;
    for (let min = s.startHour * 60; min + s.slotMinutes <= s.endHour * 60; min += s.slotMinutes) {
      const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(min / 60), min % 60, s.timeZone);
      if (at.getTime() < earliest) continue;
      const iso = at.toISOString();
      if (!full.has(iso)) out.push(iso);
    }
  }
  return out;
}

// HR approves an interview invitation. Creates (or reuses) the interview
// with a private scheduling link and queues the invite on the chosen
// channels. Nothing is sent unless HR calls this.
export async function inviteToInterview(params: { organizationId: string; applicationId: string; userId: string; channels: Array<"email" | "sms">; subject?: string; emailBody?: string; smsBody?: string }) {
  const app = await pool.query(
    `select a.id, a.stage, j.interview_settings, c.email, c.phone from applications a join jobs j on j.id = a.job_id join candidates c on c.id = a.candidate_id
     where a.id = $1 and a.organization_id = $2`,
    [params.applicationId, params.organizationId]
  );
  const a = app.rows[0];
  if (!a) throw new Error("Application not found.");
  if (!interviewSettings(a).questions?.length) throw new Error("Add interview questions to this job before inviting candidates.");
  if (["REJECTED", "HIRED"].includes(a.stage)) throw new Error("This candidate is already rejected or hired.");
  let session = (
    await pool.query("select id from interview_sessions where application_id = $1 and call_status in ('pending') and scheduling_status in ('invited','scheduled') order by created_at desc limit 1", [params.applicationId])
  ).rows[0];
  if (!session) {
    session = (
      await pool.query(
        `insert into interview_sessions (organization_id, application_id, interview_type, telephony_provider, phone_number, phone_normalized, status, schedule_token, scheduling_status)
         values ($1,$2,'ai_voice','vapi',$3,$4,'pending',$5,'invited') returning id`,
        [params.organizationId, params.applicationId, a.phone, a.phone ? normalizeE164(a.phone) : null, crypto.randomBytes(18).toString("base64url")]
      )
    ).rows[0];
  }
  const sent: string[] = [];
  for (const ch of params.channels) {
    if (ch === "email" && !a.email) continue;
    if (ch === "sms" && !a.phone) continue;
    await createMessage({
      organizationId: params.organizationId,
      applicationId: params.applicationId,
      channel: ch,
      kind: "invite",
      subject: ch === "email" ? params.subject : undefined,
      body: ch === "email" ? params.emailBody : params.smsBody,
      createdBy: params.userId,
      approvedBy: params.userId,
    });
    sent.push(ch);
  }
  if (!sent.length) throw new Error("The candidate has no email or phone number to send the invitation to.");
  if (!["SCHEDULED", "AI_INTERVIEW"].includes(a.stage)) {
    await setStage({ organizationId: params.organizationId, applicationId: params.applicationId, stage: "INTERVIEW_INVITED", actorUserId: params.userId, reason: `Invitation sent by ${sent.join(" + ")}` });
  }
  return { sessionId: session.id as string, channels: sent };
}

export async function sessionByToken(token: string) {
  const r = await pool.query(
    `select s.*, a.job_id, a.stage, a.organization_id as org_id, c.first_name, c.phone as candidate_phone, j.title, j.interview_settings, o.name as org_name, o.settings as org_settings
     from interview_sessions s join applications a on a.id = s.application_id join candidates c on c.id = a.candidate_id
     join jobs j on j.id = a.job_id join organizations o on o.id = a.organization_id
     where s.schedule_token = $1`,
    [token]
  );
  return r.rows[0] ?? null;
}

// The candidate books (or moves) their interview from the public link.
export async function bookInterview(token: string, slotIso: string, candidateTz: string) {
  const s = await sessionByToken(token);
  if (!s) throw new Error("This interview link is not valid.");
  if (s.scheduling_status === "cancelled" || ["REJECTED", "HIRED"].includes(s.stage)) throw new Error("This interview is no longer available.");
  if (s.call_status !== "pending") throw new Error("This interview has already taken place.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidateTz });
  } catch {
    candidateTz = interviewSettings(s).timeZone;
  }
  const slots = await availableSlots(s.org_id, s, 14, s.id);
  const at = new Date(slotIso);
  if (Number.isNaN(at.getTime()) || !slots.includes(at.toISOString())) throw new Error("That time is no longer available. Please choose another.");
  const moved = s.scheduling_status === "scheduled";
  await pool.query(
    `update interview_sessions set scheduled_at = $2, time_zone = $3, scheduling_status = 'scheduled', reminder_24h_at = null, reminder_1h_at = null, call_attempts = 0, error = null
     where id = $1`,
    [s.id, at, candidateTz]
  );
  await setStage({ organizationId: s.org_id, applicationId: s.application_id, stage: "SCHEDULED", reason: `${moved ? "Rescheduled" : "Booked"} by candidate for ${formatInZone(at, candidateTz)}` });
  await sendWorkflow(s.org_id, s.application_id, "confirmation");
  await notify(s.org_id, { type: "hr_interview_booked", title: moved ? "Interview rescheduled" : "Interview booked", body: `${s.first_name || "A candidate"} · ${s.title} · ${formatInZone(at, interviewSettings(s).timeZone)}`, link: `/hr/applications/${s.application_id}` }).catch(() => undefined);
  return { scheduledAt: at.toISOString(), timeZone: candidateTz };
}

// Confirmations and reminders follow an HR-approved invite (workflow rule):
// email always when we have one, SMS only when an HR sender number is set.
async function sendWorkflow(organizationId: string, applicationId: string, kind: "confirmation" | "reminder") {
  const o = await pool.query("select settings from organizations where id = $1", [organizationId]);
  const channels: Array<"email" | "sms"> = ["email"];
  if (o.rows[0]?.settings?.hr?.smsFrom) channels.push("sms");
  for (const ch of channels) {
    await createMessage({ organizationId, applicationId, channel: ch, kind, workflow: true }).catch(() => undefined);
  }
}

export async function sendDueReminders() {
  const due24 = await pool.query(
    `update interview_sessions set reminder_24h_at = now()
     where scheduling_status = 'scheduled' and call_status = 'pending' and reminder_24h_at is null
       and scheduled_at between now() + interval '3 hours' and now() + interval '24 hours'
       and created_at < scheduled_at - interval '24 hours'
     returning organization_id, application_id`
  );
  const due1 = await pool.query(
    `update interview_sessions set reminder_1h_at = now()
     where scheduling_status = 'scheduled' and call_status = 'pending' and reminder_1h_at is null
       and scheduled_at between now() + interval '10 minutes' and now() + interval '70 minutes'
     returning organization_id, application_id`
  );
  for (const r of [...due24.rows, ...due1.rows]) await sendWorkflow(r.organization_id, r.application_id, "reminder");
}

// ---------- the call ----------

export function interviewerPrompt(p: { jobTitle: string; company: string; candidateFirstName: string; interviewer: string; jd: string; questions: InterviewQuestion[]; minutes: number }) {
  return `You are ${p.interviewer}, an AI interviewer conducting a first-round phone screen for ${p.company} for the role of ${p.jobTitle}.

## How to run the interview
1. Greet ${p.candidateFirstName || "the candidate"}, say you're an AI interviewer for ${p.company}, that the call is recorded for the hiring team, and that it takes about ${p.minutes} minutes. Ask if now is still a good time. If not, call request_reschedule and end politely.
2. Ask the structured questions below, in order, one at a time. Wait for the full answer.
3. After an answer you may ask ONE short follow-up if the answer was vague or you need a concrete example. Then move on.
4. Keep track of time; if you are running long, skip follow-ups, never skip structured questions.
5. When finished, ask if they have a quick question about the next steps; say the hiring team will review and be in touch. Then end the call.

## Rules
- Never tell the candidate how they did, never promise or rule out the job, never discuss salary offers.
- Never ask about age, family, religion, nationality, health, disability, or any protected characteristic.
- Don't answer questions about the role you can't answer from the description below; say the hiring team will follow up.
- Be warm, concise, and natural. One question at a time.
- If the candidate wants to stop, thank them and end the call.

## Structured questions
${p.questions.map((q, i) => `${i + 1}. ${q.question}${q.purpose ? `  (assessing: ${q.purpose})` : ""}`).join("\n")}

## Role description (for context)
${p.jd.slice(0, 5000)}`;
}

export async function claimDueInterview(): Promise<string | null> {
  const r = await pool.query<{ id: string }>(
    `update interview_sessions set call_status = 'calling', locked_at = now(), call_attempts = call_attempts + 1
     where id = (select id from interview_sessions
                 where scheduling_status = 'scheduled' and call_status = 'pending'
                   and scheduled_at <= now() and scheduled_at > now() - interval '45 minutes'
                 order by scheduled_at limit 1 for update skip locked)
     returning id`
  );
  return r.rows[0]?.id ?? null;
}

async function failCall(sessionId: string, org: string, applicationId: string, msg: string) {
  await pool.query("update interview_sessions set call_status = 'failed', error = $2, locked_at = null where id = $1", [sessionId, msg.slice(0, 500)]);
  await logActivity({ organizationId: org, applicationId, kind: "error", title: "AI interview call could not start", detail: { error: msg } });
  await notify(org, { type: "hr_interview_failed", title: "AI interview didn't start", body: msg.slice(0, 160), link: `/hr/applications/${applicationId}` }).catch(() => undefined);
}

export async function startInterviewCall(sessionId: string) {
  const r = await pool.query(
    `select s.*, a.organization_id as org, c.first_name, c.last_name, c.phone as cphone, j.title, j.description, j.responsibilities, j.interview_settings,
            o.name as org_name, o.settings as org_settings
     from interview_sessions s join applications a on a.id = s.application_id join candidates c on c.id = a.candidate_id
     join jobs j on j.id = a.job_id join organizations o on o.id = a.organization_id where s.id = $1`,
    [sessionId]
  );
  const s = r.rows[0];
  if (!s) return;
  const cfg = interviewSettings(s);
  const to = normalizeE164(s.cphone ?? s.phone_number ?? "");
  if (!to) return failCall(sessionId, s.org, s.application_id, "The candidate's phone number is missing or invalid.");
  if (!cfg.questions?.length) return failCall(sessionId, s.org, s.application_id, "This job has no interview questions.");
  const numberId = s.org_settings?.hr?.voiceNumberId;
  const num = numberId
    ? (await pool.query("select vapi_phone_number_id, phone_e164 from phone_numbers where id = $1 and organization_id = $2", [numberId, s.org])).rows[0]
    : null;
  if (!num?.vapi_phone_number_id) return failCall(sessionId, s.org, s.application_id, "No interview calling number is set (HR → Settings), or it isn't connected to VAPI.");
  const voiceRow = cfg.voiceId ? (await pool.query("select provider, provider_voice_id from voices where id = $1", [cfg.voiceId])).rows[0] : null;
  const voice = voiceRow ? { provider: voiceRow.provider, providerVoiceId: voiceRow.provider_voice_id } : null;
  const company = s.org_settings?.hr?.companyName || s.org_name;

  const assistant: Record<string, any> = {
    name: `Interview – ${String(s.title).slice(0, 28)}`,
    firstMessage: `Hi${s.first_name ? ` ${s.first_name}` : ""}, this is ${cfg.interviewerName}, an AI interviewer calling from ${company} about your application for ${s.title}. This call is recorded for the hiring team. Is now still a good time for about ${cfg.durationMinutes} minutes?`,
    firstMessageMode: "assistant-speaks-first",
    model: {
      provider: "openai",
      model: "gpt-4o",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: interviewerPrompt({
            jobTitle: s.title,
            company,
            candidateFirstName: s.first_name,
            interviewer: cfg.interviewerName,
            jd: [s.description, s.responsibilities].filter(Boolean).join("\n\n"),
            questions: cfg.questions,
            minutes: cfg.durationMinutes,
          }),
        },
      ],
      tools: [
        { type: "endCall" },
        {
          type: "function",
          function: {
            name: "request_reschedule",
            description: "The candidate can't talk now and wants another time.",
            parameters: { type: "object", properties: { reason: { type: "string" } } },
          },
        },
      ],
    },
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    startSpeakingPlan: { waitSeconds: 0.6, smartEndpointingPlan: { provider: "livekit" } },
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: Math.round(cfg.durationMinutes * 60 * 1.6),
    backgroundSound: "off",
    endCallMessage: "Thanks for your time today. The hiring team will review and be in touch. Goodbye!",
    voicemailDetection: { provider: "vapi", backoffPlan: { startAtSeconds: 2.5, frequencySeconds: 2.5, maxRetries: 5 }, beepMaxAwaitSeconds: 0 },
    artifactPlan: { recordingEnabled: true },
    server: { url: vapiServerUrl(), headers: { "x-vapi-secret": vapiWebhookSecret() } },
    serverMessages: ["status-update", "tool-calls", "end-of-call-report"],
    metadata: { hrInterviewId: sessionId },
  };
  if (voice) {
    assistant.voice = vapiVoiceConfig(voice);
    const creds = await voiceCredentials(s.org, voice);
    if (creds.length) assistant.credentials = creds;
  }
  try {
    const call = await createVapiCall({
      organizationId: s.org,
      payload: { phoneNumberId: num.vapi_phone_number_id, customer: { number: to }, assistant, metadata: { hrInterviewId: sessionId } },
      optionalPaths: [["assistant", "startSpeakingPlan", "smartEndpointingPlan"], ["assistant", "transcriber"], ["assistant", "voice", "model"], ["assistant", "backgroundSound"]],
    });
    await pool.query("update interview_sessions set vapi_call_id = $2, provider_call_id = $2, started_at = now(), status = 'calling', error = null where id = $1", [sessionId, call.id]);
    await setStage({ organizationId: s.org, applicationId: s.application_id, stage: "AI_INTERVIEW", reason: `Calling ${to} from ${num.phone_e164}` });
  } catch (err) {
    await failCall(sessionId, s.org, s.application_id, `VAPI refused the call: ${(err as Error).message}`);
  }
}

// ---------- webhook / results ----------

export async function handleInterviewWebhook(message: any): Promise<unknown> {
  const id = message?.call?.metadata?.hrInterviewId ?? message?.call?.assistantOverrides?.metadata?.hrInterviewId ?? message?.assistant?.metadata?.hrInterviewId;
  const byVapi = message?.call?.id
    ? (await pool.query("select id from interview_sessions where vapi_call_id = $1", [message.call.id])).rows[0]?.id
    : null;
  const sessionId = (typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? id : null) ?? byVapi;
  if (!sessionId) return null;
  if (message.type === "status-update") {
    if (message.status === "in-progress") {
      await pool.query("update interview_sessions set call_status = 'in_progress', status = 'in_progress' where id = $1 and call_status = 'calling'", [sessionId]);
    }
    return {};
  }
  if (message.type === "tool-calls") {
    const results = [];
    for (const tc of message.toolCallList ?? message.toolCalls ?? []) {
      const name = tc.function?.name ?? tc.name;
      if (name === "request_reschedule") {
        const s = (await pool.query("select organization_id, application_id from interview_sessions where id = $1", [sessionId])).rows[0];
        if (s) await logActivity({ organizationId: s.organization_id, applicationId: s.application_id, kind: "interview", title: "Candidate asked to reschedule during the call", detail: { reason: tc.function?.arguments?.reason ?? null } });
        results.push({ toolCallId: tc.id, result: "Noted. Tell the candidate they can pick a new time with the link they received, thank them, and end the call." });
      } else {
        results.push({ toolCallId: tc.id, result: "OK" });
      }
    }
    return { results };
  }
  if (message.type === "end-of-call-report") {
    await finalizeInterview(sessionId, reportFromVapi(message));
    return {};
  }
  return {};
}

// Recovers calls whose end-of-call webhook never arrived.
export async function sweepStuckInterviews() {
  const r = await pool.query(
    `select id, organization_id, vapi_call_id from interview_sessions
     where call_status in ('calling','in_progress') and vapi_call_id is not null and started_at < now() - interval '20 minutes'
     limit 10`
  );
  for (const s of r.rows) {
    try {
      const call = await getVapiCall(s.organization_id, s.vapi_call_id);
      if (call.status === "ended") await finalizeInterview(s.id, reportFromVapi(call));
    } catch (err) {
      console.error("[hr] interview sweep:", (err as Error).message);
    }
  }
  // A call that never got an id (crash between claim and create).
  await pool.query("update interview_sessions set call_status = 'failed', error = 'The call could not be started.' where call_status = 'calling' and vapi_call_id is null and locked_at < now() - interval '10 minutes'");
}

async function storeRecording(sessionId: string, org: string, url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`recording download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = url.split("?")[0].split(".").pop()?.slice(0, 4) || "wav";
  const key = `${org}/hr-interviews/${sessionId}.${ext}`;
  const stored = await getStorageDriver().put(key, Readable.from(buf), res.headers.get("content-type") ?? "audio/wav");
  const fileId = await recordFile({ organizationId: org, key: stored.key, fileName: `interview-${sessionId}.${ext}`, fileType: ext, mimeType: res.headers.get("content-type") ?? undefined, size: stored.size });
  await pool.query("update interview_sessions set recording_file_id = $2 where id = $1", [sessionId, fileId]);
}

export async function finalizeInterview(sessionId: string, report: CallReport) {
  const r = await pool.query(
    `update interview_sessions set call_status = case when call_status in ('calling','in_progress') then 'ended' else call_status end
     where id = $1 and call_status in ('calling','in_progress') returning *`,
    [sessionId]
  );
  const s = r.rows[0];
  if (!s) return; // already finalized
  const org = s.organization_id;
  const transcript = report.messages.map((m) => `${m.role === "assistant" ? "Interviewer" : "Candidate"}: ${m.text}`).join("\n");
  const candidateWords = report.messages.filter((m) => m.role === "user").reduce((n, m) => n + m.text.split(/\s+/).length, 0);
  await pool.query(
    `update interview_sessions set ended_at = now(), duration_seconds = $2, ended_reason = $3, transcript = $4, transcript_segments = $5, recording_url = $6, locked_at = null
     where id = $1`,
    [sessionId, report.durationSeconds != null ? Math.round(report.durationSeconds) : null, report.endedReason, transcript, JSON.stringify(report.messages), report.recordingUrl]
  );
  if (report.recordingUrl) {
    storeRecording(sessionId, org, report.recordingUrl).catch((err) =>
      pool.query(`insert into system_logs (organization_id, level, source, message) values ($1,'error','hr.recording',$2)`, [org, (err as Error).message]).catch(() => undefined)
    );
  }

  // Nobody picked up: one automatic retry 15 minutes later, then HR decides.
  if (candidateWords < 5 && NO_ANSWER.test(report.endedReason ?? "")) {
    if (s.call_attempts < 2) {
      await pool.query("update interview_sessions set call_status = 'pending', status = 'pending', scheduled_at = now() + interval '15 minutes' where id = $1", [sessionId]);
      await logActivity({ organizationId: org, applicationId: s.application_id, kind: "interview", title: "No answer — retrying in 15 minutes", detail: { endedReason: report.endedReason } });
    } else {
      await pool.query("update interview_sessions set call_status = 'no_answer', status = 'no_answer' where id = $1", [sessionId]);
      await setStage({ organizationId: org, applicationId: s.application_id, stage: "SCHEDULED", reason: "Candidate didn't answer twice; needs a new time" });
      await notify(org, { type: "hr_interview_no_answer", title: "Candidate didn't answer", body: "The AI interview call wasn't answered (2 attempts).", link: `/hr/applications/${s.application_id}` }).catch(() => undefined);
    }
    return;
  }

  await logActivity({ organizationId: org, applicationId: s.application_id, kind: "interview", title: `AI interview call ended (${Math.round((report.durationSeconds ?? 0) / 60)} min)`, detail: { endedReason: report.endedReason, durationSeconds: report.durationSeconds } });
  await evaluateInterview(sessionId).catch(async (err) => {
    await pool.query("update interview_sessions set error = $2, processing_status = 'eval_failed' where id = $1", [sessionId, `Evaluation failed: ${(err as Error).message}`.slice(0, 500)]);
    await logActivity({ organizationId: org, applicationId: s.application_id, kind: "error", title: "Interview evaluation failed", detail: { error: (err as Error).message } });
  });
}

interface AiEval {
  questions: Array<{ index: number; asked: boolean; answered: boolean; answer_quote: string | null }>;
  criteria: Array<{ key: string; score: number; rationale: string; evidence: string[] }>;
  strengths: Array<{ point: string; evidence: string }>;
  concerns: Array<{ point: string; evidence: string | null }>;
  summary: string;
}

// Scores the interview from the transcript only. Evidence must be the
// candidate's own words. An interview missing too much is "incomplete" and
// can only be recommended for HR review.
export async function evaluateInterview(sessionId: string) {
  const r = await pool.query(
    `select s.*, j.title, j.description, j.interview_settings, a.organization_id as org from interview_sessions s join applications a on a.id = s.application_id join jobs j on j.id = a.job_id where s.id = $1`,
    [sessionId]
  );
  const s = r.rows[0];
  if (!s) throw new Error("Interview not found.");
  const cfg = interviewSettings(s);
  const msgs: Array<{ role: string; text: string }> = s.transcript_segments ?? [];
  const candidateText = msgs.filter((m) => m.role === "user").map((m) => m.text).join("\n");
  const ai = await chatJson<AiEval>({
    organizationId: s.org,
    model: EVAL_MODEL,
    temperature: 0,
    seed: 13,
    maxTokens: 4000,
    system: `You evaluate a recorded first-round job interview for a hiring team. Use ONLY the transcript. Evidence quotes must be copied EXACTLY from the CANDIDATE's lines. Do not reward things the candidate did not say. Ignore accent, grammar quirks, and any protected characteristic. Refer to the candidate as "the candidate"; never assume pronouns. Scores 0-100. JSON only.`,
    user: `Role: ${s.title}
Role description: ${String(s.description ?? "").slice(0, 3000)}

Structured questions:
${(cfg.questions ?? []).map((q, i) => `${i + 1}. ${q.question}`).join("\n")}

Criteria: ${cfg.evaluationCriteria.map((c) => `${c.key} (${c.label})`).join(", ")}

TRANSCRIPT
"""
${msgs.map((m) => `${m.role === "assistant" ? "Interviewer" : "Candidate"}: ${m.text}`).join("\n").slice(0, 30000)}
"""

Return JSON:
{"questions":[{"index":number (1-based),"asked":bool,"answered":bool (candidate gave a substantive answer),"answer_quote":exact candidate quote|null}],
 "criteria":[{"key":string,"score":number,"rationale":string,"evidence":[exact candidate quotes]}],
 "strengths":[{"point":string,"evidence":exact candidate quote}],
 "concerns":[{"point":string,"evidence":exact candidate quote|null}],
 "summary":"3-5 factual sentences"}`,
  });

  const qs = (cfg.questions ?? []).map((q, i) => {
    const got = (ai.questions ?? []).find((x) => Number(x.index) === i + 1);
    const quote = got?.answer_quote && cleanQuotes(candidateText, [got.answer_quote]).verified[0];
    return { question: q.question, asked: Boolean(got?.asked), answered: Boolean(got?.answered && quote), evidence: quote || null };
  });
  const answered = qs.filter((q) => q.answered).length;
  const coverage = qs.length ? answered / qs.length : 0;
  const candidateWords = candidateText.split(/\s+/).filter(Boolean).length;
  const complete = coverage >= 0.8 && candidateWords >= 60;
  const reasons: string[] = [];
  if (coverage < 0.8) reasons.push(`${answered} of ${qs.length} structured questions were answered`);
  if (candidateWords < 60) reasons.push(`the candidate spoke only ${candidateWords} words`);

  let quotes = 0;
  let verified = 0;
  const criteria = cfg.evaluationCriteria.map((c) => {
    const got = (ai.criteria ?? []).find((x) => x.key === c.key);
    const ev = cleanQuotes(candidateText, got?.evidence);
    quotes += ev.verified.length + ev.rejected.length;
    verified += ev.verified.length;
    let score = clampScore(got?.score);
    const capped = ev.verified.length === 0 && score > 30;
    if (capped) score = 30;
    return { key: c.key, label: c.label, weight: c.weight, score, rationale: String(got?.rationale ?? "").slice(0, 1000), evidence: ev.verified, capped };
  });
  const strengths = (ai.strengths ?? []).filter((x) => x?.point && cleanQuotes(candidateText, [x.evidence]).verified.length).slice(0, 8);
  const concerns = (ai.concerns ?? []).filter((x) => x?.point).map((x) => ({ point: x.point, evidence: x.evidence && cleanQuotes(candidateText, [x.evidence]).verified.length ? x.evidence : null })).slice(0, 8);
  const totalW = criteria.reduce((a, c) => a + c.weight, 0) || 1;
  const overall = Math.round(criteria.reduce((a, c) => a + c.score * c.weight, 0) / totalW);
  const recommendation = !complete ? "HR_REVIEW" : overall >= cfg.nextRoundThreshold ? "NEXT_ROUND" : overall >= cfg.holdThreshold ? "HOLD" : "DO_NOT_ADVANCE";
  const evaluation = { overall, complete, criteria, questions: qs, strengths, concerns, summary: String(ai.summary ?? "").slice(0, 2000), evidenceStats: { quotes, verified }, model: EVAL_MODEL };
  const completeness = { complete, coverage, answered, total: qs.length, candidateWords, reasons };

  await pool.query(
    `update interview_sessions set evaluation = $2, completeness = $3, ai_recommendation = $4, overall_score = $5, summary = $6,
       call_status = $7, status = $7, processing_status = 'evaluated', recommended_action = $4,
       communication_score = $8
     where id = $1`,
    [sessionId, JSON.stringify(evaluation), JSON.stringify(completeness), recommendation, overall, evaluation.summary, complete ? "completed" : "incomplete", criteria.find((c) => c.key === "communication")?.score ?? null]
  );
  await setStage({ organizationId: s.org, applicationId: s.application_id, stage: "EVALUATED", reason: complete ? `AI interview scored ${overall}` : `Interview incomplete: ${reasons.join("; ")}` });
  await auditDecision({ organizationId: s.org, actorUserId: null, action: "hr.ai_interview_evaluation", entityId: s.application_id, after: { overall, recommendation, complete, model: EVAL_MODEL } });
  await notify(s.org, {
    type: "hr_interview_evaluated",
    title: complete ? "Interview evaluated" : "Interview incomplete",
    body: complete ? `${s.title}: ${overall}/100 · ${recommendation.replace(/_/g, " ")}` : `${s.title}: ${reasons.join("; ")}`,
    link: `/hr/applications/${s.application_id}`,
  }).catch(() => undefined);
}
