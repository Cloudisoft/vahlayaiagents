import nodemailer from "nodemailer";
import { env, isConfigured } from "../config/env.js";

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  organizationId?: string;
}

// Provider-agnostic: SMTP via nodemailer, or Resend via HTTP API. Selected by
// EMAIL_PROVIDER. Throws a real, descriptive error when unconfigured rather
// than silently "succeeding" — callers are responsible for surfacing this.
export async function sendEmail(params: SendEmailParams): Promise<{ provider: string; messageId: string }> {
  if (env.email.provider === "resend") {
    return sendViaResend(params);
  }
  return sendViaSmtp(params);
}

async function sendViaSmtp(params: SendEmailParams) {
  if (!isConfigured(env.email.smtpHost, env.email.smtpUser, env.email.smtpPass, env.email.smtpFrom)) {
    throw new Error(
      "SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM in Settings → Email."
    );
  }
  const transport = nodemailer.createTransport({
    host: env.email.smtpHost,
    port: env.email.smtpPort,
    secure: env.email.smtpPort === 465,
    auth: { user: env.email.smtpUser, pass: env.email.smtpPass },
  });
  const info = await transport.sendMail({
    from: env.email.smtpFrom,
    to: params.to,
    subject: params.subject,
    html: params.html,
  });
  return { provider: "smtp", messageId: info.messageId };
}

async function sendViaResend(params: SendEmailParams) {
  if (!isConfigured(env.email.resendApiKey, env.email.resendFrom)) {
    throw new Error("Resend is not configured. Set RESEND_API_KEY and RESEND_FROM in Settings → Email.");
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.email.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.email.resendFrom,
      to: params.to,
      subject: params.subject,
      html: params.html,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend API error (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { id: string };
  return { provider: "resend", messageId: data.id };
}
