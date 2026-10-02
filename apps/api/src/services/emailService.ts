import nodemailer from "nodemailer";
import { env, isConfigured } from "../config/env.js";
import { getOrgCredential } from "./credentialsService.js";

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  organizationId?: string;
}

interface EmailConfig {
  provider: "smtp" | "resend";
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  apiKey?: string;
  from?: string;
}

// Org settings (Settings → Email) win over server env. Throws a real,
// descriptive error when nothing is configured rather than "succeeding".
export async function resolveEmailConfig(organizationId?: string): Promise<EmailConfig> {
  if (organizationId) {
    const resend = await getOrgCredential(organizationId, "resend");
    if (resend?.apiKey) return { provider: "resend", apiKey: resend.apiKey, from: resend.from || env.email.resendFrom };
    const smtp = await getOrgCredential(organizationId, "smtp");
    if (smtp?.host) return { provider: "smtp", host: smtp.host, port: Number(smtp.port || 587), user: smtp.user, pass: smtp.pass, from: smtp.from };
  }
  if (env.email.provider === "resend") return { provider: "resend", apiKey: env.email.resendApiKey, from: env.email.resendFrom };
  return { provider: "smtp", host: env.email.smtpHost, port: env.email.smtpPort, user: env.email.smtpUser, pass: env.email.smtpPass, from: env.email.smtpFrom };
}

export async function sendEmail(params: SendEmailParams): Promise<{ provider: string; messageId: string }> {
  const cfg = await resolveEmailConfig(params.organizationId);
  return cfg.provider === "resend" ? sendViaResend(cfg, params) : sendViaSmtp(cfg, params);
}

async function sendViaSmtp(cfg: EmailConfig, params: SendEmailParams) {
  if (!isConfigured(cfg.host, cfg.user, cfg.pass, cfg.from)) {
    throw new Error("Email is not configured. Add SMTP (host, user, password, from) or Resend in Settings → Email.");
  }
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  const info = await transport.sendMail({ from: cfg.from, to: params.to, subject: params.subject, html: params.html, text: params.text });
  return { provider: "smtp", messageId: info.messageId };
}

async function sendViaResend(cfg: EmailConfig, params: SendEmailParams) {
  if (!isConfigured(cfg.apiKey, cfg.from)) {
    throw new Error("Resend is not fully configured. Add the API key and a From address in Settings → Email.");
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: cfg.from, to: params.to, subject: params.subject, html: params.html, text: params.text }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend API error (${response.status}): ${body.slice(0, 300)}`);
  }
  const data = (await response.json()) as { id: string };
  return { provider: "resend", messageId: data.id };
}
