import crypto from "node:crypto";
import { pool } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { getOrgCredential } from "../credentialsService.js";
import { sendEmail } from "../emailService.js";
import { logActivity } from "./activity.js";

export type Channel = "email" | "sms";
export type MessageKind = "invite" | "confirmation" | "reminder" | "next_round" | "info_request" | "rejection" | "custom";
const MAX_SEND_ATTEMPTS = 3;

// Kinds the system may send on its own, but only for an interview whose
// invitation HR approved. Everything else needs an explicit HR approval.
export const WORKFLOW_KINDS: MessageKind[] = ["confirmation", "reminder"];

export const TEMPLATES: Record<MessageKind, { subject: string; email: string; sms: string }> = {
  invite: {
    subject: "Next step for your {{job_title}} application",
    email: `Hi {{first_name}},

Thank you for applying for the {{job_title}} role at {{company}}. We'd like to invite you to a short AI-assisted phone interview (about {{duration}} minutes).

Please choose a time that works for you here:
{{schedule_link}}

At the time you choose, you'll receive a call on {{phone}}. If that number is wrong, reply to this email.

Best regards,
{{company}} Hiring Team`,
    sms: "Hi {{first_name}}, {{company}} here about your {{job_title}} application. Please pick a time for a short phone interview: {{schedule_link}} Reply STOP to opt out.",
  },
  confirmation: {
    subject: "Your interview is booked: {{interview_time}}",
    email: `Hi {{first_name}},

Your phone interview for {{job_title}} is confirmed for {{interview_time}}. We'll call you on {{phone}}.

Need a different time? Use this link: {{schedule_link}}

{{company}} Hiring Team`,
    sms: "{{company}}: your {{job_title}} phone interview is booked for {{interview_time}}. We'll call {{phone}}. Change time: {{schedule_link}}",
  },
  reminder: {
    subject: "Reminder: interview {{interview_time}}",
    email: `Hi {{first_name}},

A reminder that your phone interview for {{job_title}} is at {{interview_time}}. We'll call you on {{phone}}.

Need a different time? {{schedule_link}}

{{company}} Hiring Team`,
    sms: "Reminder from {{company}}: your {{job_title}} phone interview is at {{interview_time}}. We'll call {{phone}}.",
  },
  next_round: {
    subject: "Good news about your {{job_title}} application",
    email: `Hi {{first_name}},

Thank you for your interview for {{job_title}}. We'd like to move you to the next round. A member of our team will contact you shortly with details.

{{company}} Hiring Team`,
    sms: "Hi {{first_name}}, {{company}} would like to move you to the next round for {{job_title}}. We'll be in touch with details shortly.",
  },
  info_request: {
    subject: "A quick question about your {{job_title}} application",
    email: `Hi {{first_name}},

Thanks for applying for {{job_title}}. To continue reviewing your application, could you please reply with:

-

{{company}} Hiring Team`,
    sms: "Hi {{first_name}}, {{company}} needs a bit more information for your {{job_title}} application. Please check your email.",
  },
  rejection: {
    subject: "Your application for {{job_title}}",
    email: `Hi {{first_name}},

Thank you for your interest in the {{job_title}} role at {{company}} and for the time you spent with us. After careful review, we've decided not to move forward with your application at this time.

We wish you the very best in your search.

{{company}} Hiring Team`,
    sms: "Hi {{first_name}}, thank you for applying for {{job_title}} at {{company}}. We won't be moving forward at this time. We wish you the best.",
  },
  custom: { subject: "About your {{job_title}} application", email: "Hi {{first_name}},\n\n\n\n{{company}} Hiring Team", sms: "" },
};

export function render(tpl: string, vars: Record<string, string | null | undefined>) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? "");
}

export async function messageVars(applicationId: string) {
  const r = await pool.query(
    `select c.first_name, c.last_name, c.email, c.phone, j.title as job_title, j.interview_settings, o.name as org_name, o.settings as org_settings,
            s.schedule_token, s.scheduled_at, s.time_zone
     from applications a join candidates c on c.id = a.candidate_id join jobs j on j.id = a.job_id join organizations o on o.id = a.organization_id
     left join lateral (select * from interview_sessions where application_id = a.id order by created_at desc limit 1) s on true
     where a.id = $1`,
    [applicationId]
  );
  const x = r.rows[0];
  if (!x) throw new Error("Application not found.");
  const company = x.org_settings?.hr?.companyName || x.org_name;
  return {
    first_name: x.first_name || "there",
    full_name: [x.first_name, x.last_name].filter(Boolean).join(" "),
    email: x.email,
    phone: x.phone || "the number on your application",
    job_title: x.job_title,
    company,
    duration: String(x.interview_settings?.durationMinutes ?? 15),
    schedule_link: x.schedule_token ? `${env.appUrl.replace(/\/$/, "")}/interview/${x.schedule_token}` : "",
    interview_time: x.scheduled_at ? formatInZone(new Date(x.scheduled_at), x.time_zone || "America/New_York") : "",
  };
}

export function formatInZone(d: Date, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
}

// Creates a message. Drafts wait for HR; `approvedBy` queues it for sending
// at once. Workflow messages (confirmations/reminders) are queued without a
// person only when the interview invitation itself was approved by HR.
export async function createMessage(params: {
  organizationId: string;
  applicationId: string;
  channel: Channel;
  kind: MessageKind;
  subject?: string | null;
  body?: string | null;
  createdBy?: string | null;
  approvedBy?: string | null;
  workflow?: boolean;
}) {
  const vars = await messageVars(params.applicationId);
  const tpl = TEMPLATES[params.kind];
  const to = params.channel === "email" ? vars.email : (await pool.query("select c.phone from applications a join candidates c on c.id = a.candidate_id where a.id = $1", [params.applicationId])).rows[0]?.phone;
  if (!to) throw new Error(params.channel === "email" ? "This candidate has no email address on file." : "This candidate has no phone number on file.");
  const body = render(params.body ?? (params.channel === "email" ? tpl.email : tpl.sms), vars).trim();
  if (!body) throw new Error("The message is empty.");
  const subject = params.channel === "email" ? render(params.subject ?? tpl.subject, vars) : null;
  if (params.workflow && !WORKFLOW_KINDS.includes(params.kind)) throw new Error("Only confirmations and reminders can be sent by workflow.");
  const queued = Boolean(params.approvedBy) || Boolean(params.workflow);
  const app = await pool.query("select candidate_id from applications where id = $1 and organization_id = $2", [params.applicationId, params.organizationId]);
  if (!app.rows[0]) throw new Error("Application not found.");
  const r = await pool.query<{ id: string }>(
    `insert into candidate_messages (organization_id, application_id, candidate_id, channel, kind, to_address, subject, body, status, approved_by, approved_at, created_by, open_token)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [
      params.organizationId,
      params.applicationId,
      app.rows[0].candidate_id,
      params.channel,
      params.kind,
      to,
      subject,
      body,
      queued ? "queued" : "draft",
      params.approvedBy ?? null,
      queued ? new Date() : null,
      params.createdBy ?? null,
      crypto.randomBytes(16).toString("hex"),
    ]
  );
  await logActivity({
    organizationId: params.organizationId,
    applicationId: params.applicationId,
    actorUserId: params.createdBy ?? null,
    kind: "message",
    title: `${queued ? (params.workflow ? "Scheduled" : "Approved") : "Drafted"} ${params.kind.replace("_", " ")} ${params.channel}`,
    detail: { messageId: r.rows[0].id, channel: params.channel, kind: params.kind, workflow: Boolean(params.workflow) },
  });
  return r.rows[0].id;
}

export async function approveMessages(organizationId: string, ids: string[], userId: string) {
  const r = await pool.query(
    `update candidate_messages set status = 'queued', approved_by = $3, approved_at = now(), next_attempt_at = null
     where organization_id = $1 and id = any($2::uuid[]) and status in ('draft','failed') returning id, application_id, kind, channel`,
    [organizationId, ids, userId]
  );
  for (const m of r.rows) {
    await logActivity({ organizationId, applicationId: m.application_id, actorUserId: userId, kind: "message", title: `Approved ${m.kind.replace("_", " ")} ${m.channel}`, detail: { messageId: m.id } });
  }
  return r.rowCount ?? 0;
}

function emailHtml(body: string, openToken: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const linked = esc(body).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, "<br>");
  const pixel = `${env.apiUrl.replace(/\/$/, "")}/api/public/hr/o/${openToken}.gif`;
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#111">${linked}</div><img src="${pixel}" width="1" height="1" alt="" style="display:none">`;
}

async function twilioCreds(organizationId: string) {
  const cred = await getOrgCredential(organizationId, "twilio");
  const sid = cred?.accountSid ?? env.twilio.accountSid;
  const token = cred?.authToken ?? env.twilio.authToken;
  if (!sid || !token) throw new Error("Twilio is not configured (Settings → Telephony).");
  return { sid, token };
}

async function smsFrom(organizationId: string): Promise<string> {
  const o = await pool.query("select settings from organizations where id = $1", [organizationId]);
  const from = o.rows[0]?.settings?.hr?.smsFrom as string | undefined;
  if (!from) throw new Error("No SMS sender number is set. Choose one in HR → Settings.");
  const owned = await pool.query("select 1 from phone_numbers where organization_id = $1 and phone_e164 = $2", [organizationId, from]);
  if (!owned.rows[0]) throw new Error("The HR SMS sender number is no longer on this account.");
  return from;
}

async function sendSms(organizationId: string, to: string, body: string) {
  const { sid, token } = await twilioCreds(organizationId);
  const from = await smsFrom(organizationId);
  const form = new URLSearchParams({ To: to, From: from, Body: body, StatusCallback: `${env.apiUrl.replace(/\/$/, "")}/api/public/hr/sms-status` });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (!res.ok || !data.sid) throw new Error(`Twilio SMS error (${res.status}): ${data.message ?? "unknown"}`);
  return data.sid;
}

// Sends one queued message. Transient failures back off and retry; after
// MAX_SEND_ATTEMPTS the message is marked failed with the provider's error.
export async function sendNextMessage(): Promise<boolean> {
  const claim = await pool.query(
    `update candidate_messages set attempts = attempts + 1, next_attempt_at = now() + interval '10 minutes'
     where id = (select id from candidate_messages where status = 'queued' and approved_at is not null
                 and (next_attempt_at is null or next_attempt_at <= now())
                 order by created_at limit 1 for update skip locked)
     returning *`
  );
  const m = claim.rows[0];
  if (!m) return false;
  try {
    let providerId: string;
    let provider: string;
    if (m.channel === "email") {
      const out = await sendEmail({ organizationId: m.organization_id, to: m.to_address, subject: m.subject ?? "", text: m.body, html: emailHtml(m.body, m.open_token) });
      providerId = out.messageId;
      provider = out.provider;
    } else {
      providerId = await sendSms(m.organization_id, m.to_address, m.body);
      provider = "twilio";
    }
    await pool.query(
      "update candidate_messages set status = 'sent', sent_at = now(), provider = $2, provider_message_id = $3, error = null, next_attempt_at = null where id = $1",
      [m.id, provider, providerId]
    );
    await logActivity({ organizationId: m.organization_id, applicationId: m.application_id, kind: "message_sent", title: `Sent ${m.kind.replace("_", " ")} ${m.channel}`, detail: { messageId: m.id, to: m.to_address } });
  } catch (err) {
    const msg = (err as Error).message.slice(0, 500);
    const permanent = /not configured|no sms sender|no longer on this account|21211|21614|invalid/i.test(msg);
    if (!permanent && m.attempts < MAX_SEND_ATTEMPTS) {
      await pool.query("update candidate_messages set error = $2, next_attempt_at = now() + make_interval(mins => $3) where id = $1", [m.id, msg, m.attempts * 2]);
    } else {
      await pool.query("update candidate_messages set status = 'failed', error = $2, next_attempt_at = null where id = $1", [m.id, msg]);
      await logActivity({ organizationId: m.organization_id, applicationId: m.application_id, kind: "error", title: `${m.channel === "email" ? "Email" : "SMS"} failed`, detail: { messageId: m.id, error: msg } });
    }
  }
  return true;
}

const ORDER = ["draft", "queued", "sent", "delivered", "opened", "replied"];
// Status only moves forward (an "opened" email never goes back to "delivered").
export async function advanceStatus(where: { id?: string; providerMessageId?: string; openToken?: string }, status: string) {
  const col = where.id ? "id" : where.providerMessageId ? "provider_message_id" : "open_token";
  const val = where.id ?? where.providerMessageId ?? where.openToken;
  const stamp = status === "delivered" ? "delivered_at" : status === "opened" ? "opened_at" : status === "replied" ? "replied_at" : null;
  if (status === "failed") {
    await pool.query(`update candidate_messages set status = 'failed', error = coalesce(error, 'Carrier reported the message as undelivered.') where ${col} = $1 and status in ('queued','sent')`, [val]);
    return;
  }
  const rank = ORDER.indexOf(status);
  if (rank < 0) return;
  const r = await pool.query(
    `update candidate_messages set status = case when array_position($2::text[], status) < $3 then $4 else status end
       ${stamp ? `, ${stamp} = coalesce(${stamp}, now())` : ""}
     where ${col} = $1 and status in ('sent','delivered','opened','replied') returning id, organization_id, application_id, kind, channel`,
    [val, ORDER, rank + 1, status]
  );
  const m = r.rows[0];
  if (m && (status === "opened" || status === "replied")) {
    await logActivity({ organizationId: m.organization_id, applicationId: m.application_id, kind: "message_" + status, title: `Candidate ${status === "opened" ? "opened" : "replied to"} ${m.kind.replace("_", " ")} ${m.channel}`, detail: { messageId: m.id } });
  }
}

export function verifyTwilioSignature(authToken: string, signature: string | undefined, url: string, params: Record<string, string>) {
  if (!signature) return false;
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac("sha1", authToken).update(data).digest("base64");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
