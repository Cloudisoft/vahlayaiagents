import { pool } from "../db/pool.js";
import { getTelephonyProvider } from "../telephony/index.js";
import { normalizeIndiaE164 } from "../utils/phone.js";
import { env } from "../config/env.js";

const MAX_ATTEMPTS = 3;

// VahlayHR -> Interview Engine -> Telephony Abstraction -> Plivo/Twilio/... -> Candidate
// This module owns interview logic (question order, behavior, scoring). It
// never talks to a telephony SDK directly — only the TelephonyProvider
// interface — so swapping providers never touches this file.
export async function createInterviewSession(applicationId: string): Promise<string> {
  const appResult = await pool.query(
    `select a.id, a.organization_id, a.job_id, a.candidate_id, c.phone, o.settings
     from applications a
     join candidates c on c.id = a.candidate_id
     join organizations o on o.id = a.organization_id
     where a.id = $1`,
    [applicationId]
  );
  if (appResult.rows.length === 0) throw new Error("Application not found.");
  const app = appResult.rows[0];

  const normalized = normalizeIndiaE164(app.phone ?? "");
  if (!normalized) {
    throw new Error(`Candidate phone "${app.phone}" is not a valid Indian mobile number — cannot schedule interview call.`);
  }

  const priorAttempts = await pool.query(
    "select count(*) as count from interview_sessions where application_id = $1",
    [applicationId]
  );
  const attemptNumber = Number(priorAttempts.rows[0].count) + 1;
  if (attemptNumber > MAX_ATTEMPTS) {
    throw new Error(`Maximum interview call attempts (${MAX_ATTEMPTS}) reached for this application.`);
  }

  const providerKey = app.settings?.telephonyProvider ?? "plivo";

  const sessionResult = await pool.query(
    `insert into interview_sessions (organization_id, application_id, telephony_provider, phone_number,
       phone_normalized, status, attempt_number)
     values ($1,$2,$3,$4,$5,'pending',$6)
     returning id`,
    [app.organization_id, applicationId, providerKey, app.phone, normalized, attemptNumber]
  );
  const sessionId = sessionResult.rows[0].id;

  const fromNumber = app.settings?.outboundCallerId;
  if (!fromNumber) {
    await pool.query("update interview_sessions set status = 'failed' where id = $1", [sessionId]);
    throw new Error(
      "No outbound caller ID configured for this organization. Set organizations.settings.outboundCallerId."
    );
  }

  const provider = await getTelephonyProvider(app.organization_id, providerKey);
  const webhookBase = `${env.apiUrl.replace(/\/$/, "")}/api/webhooks/${providerKey}`;

  const { providerCallId } = await provider.createCall({
    to: normalized,
    from: fromNumber,
    answerUrl: `${webhookBase}/answer/${sessionId}`,
    webhookUrl: `${webhookBase}/hangup/${sessionId}`,
  });

  await pool.query(
    "update interview_sessions set status = 'calling', provider_call_id = $1, started_at = now() where id = $2",
    [providerCallId, sessionId]
  );

  return sessionId;
}
