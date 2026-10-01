import crypto from "node:crypto";
import { env } from "../config/env.js";
import { getOrgCredential } from "../services/credentialsService.js";
import { pool } from "../db/pool.js";

const VAPI_BASE = "https://api.vapi.ai";

export class VapiNotConfiguredError extends Error {
  constructor() {
    super("VAPI is not configured. Add your VAPI private API key in Settings → AI Providers.");
    this.name = "VapiNotConfiguredError";
  }
}

export class VapiApiError extends Error {
  constructor(
    public status: number,
    public body: string
  ) {
    super(`VAPI API error (${status}): ${body.slice(0, 500)}`);
    this.name = "VapiApiError";
  }
}

export async function resolveVapiKey(organizationId: string): Promise<string> {
  const cred = await getOrgCredential(organizationId, "vapi");
  const key = cred?.apiKey ?? env.vapiApiKey;
  if (!key) throw new VapiNotConfiguredError();
  return key;
}

// Webhook auth: VAPI sends this back as the x-vapi-secret header on every
// server message. Uses VAPI_WEBHOOK_SECRET when set, otherwise a stable
// secret derived from the credentials key so nothing extra must be configured.
export function vapiWebhookSecret(): string {
  if (env.vapiWebhookSecret) return env.vapiWebhookSecret;
  if (!env.credentialsEncryptionKey) throw new Error("Set VAPI_WEBHOOK_SECRET or CREDENTIALS_ENCRYPTION_KEY.");
  return crypto.createHmac("sha256", env.credentialsEncryptionKey).update("vapi-webhook").digest("hex");
}

export function vapiServerUrl(): string {
  return `${env.apiUrl.replace(/\/$/, "")}/api/webhooks/vapi`;
}

async function request<T>(apiKey: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${VAPI_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new VapiApiError(res.status, text);
  return (text ? JSON.parse(text) : {}) as T;
}

function stripPath(obj: any, path: string[]): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return;
    cur = cur[path[i]];
  }
  if (cur && typeof cur === "object") delete cur[path[path.length - 1]];
}

export interface VapiCall {
  id: string;
  status?: string;
  endedReason?: string;
  phoneCallProviderId?: string;
  monitor?: { listenUrl?: string; controlUrl?: string };
  [key: string]: unknown;
}

// Playbook §10: one optional setting being rejected once failed every call.
// If VAPI answers 400 we log the real provider message loudly and resend
// without the optional settings, so a call never fails over a nice-to-have.
export async function createVapiCall(params: {
  organizationId: string;
  payload: Record<string, any>;
  optionalPaths: string[][];
}): Promise<VapiCall> {
  const apiKey = await resolveVapiKey(params.organizationId);
  try {
    return await request<VapiCall>(apiKey, "POST", "/call", params.payload);
  } catch (err) {
    if (!(err instanceof VapiApiError) || err.status !== 400 || params.optionalPaths.length === 0) throw err;
    const slim = structuredClone(params.payload);
    for (const p of params.optionalPaths) stripPath(slim, p);
    await pool.query(
      `insert into system_logs (organization_id, level, source, message, metadata) values ($1,'error','vapi.optional_settings_rejected',$2,$3)`,
      [
        params.organizationId,
        `VAPI rejected the call payload; retrying without optional settings. Provider said: ${err.body.slice(0, 1000)}`,
        JSON.stringify({ strippedPaths: params.optionalPaths.map((p) => p.join(".")) }),
      ]
    );
    console.error("[vapi] optional settings rejected, retrying without them:", err.body);
    return request<VapiCall>(apiKey, "POST", "/call", slim);
  }
}

export async function getVapiCall(organizationId: string, vapiCallId: string): Promise<VapiCall> {
  return request<VapiCall>(await resolveVapiKey(organizationId), "GET", `/call/${vapiCallId}`);
}

export interface VapiPhoneNumber {
  id: string;
  number?: string;
  provider?: string;
  name?: string;
}

export async function listVapiPhoneNumbers(organizationId: string): Promise<VapiPhoneNumber[]> {
  return request<VapiPhoneNumber[]>(await resolveVapiKey(organizationId), "GET", "/phone-number?limit=1000");
}

export async function importTwilioNumberToVapi(params: {
  organizationId: string;
  number: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  name: string;
}): Promise<VapiPhoneNumber> {
  return request<VapiPhoneNumber>(await resolveVapiKey(params.organizationId), "POST", "/phone-number", {
    provider: "twilio",
    number: params.number,
    twilioAccountSid: params.twilioAccountSid,
    twilioAuthToken: params.twilioAuthToken,
    name: params.name.slice(0, 40),
    server: { url: vapiServerUrl(), headers: { "x-vapi-secret": vapiWebhookSecret() } },
  });
}

// Points an existing VAPI number's inbound webhooks at us, so a caller who
// rings back gets the assistant for that number's campaign.
export async function pointVapiNumberAtServer(organizationId: string, vapiPhoneNumberId: string): Promise<void> {
  await request(await resolveVapiKey(organizationId), "PATCH", `/phone-number/${vapiPhoneNumberId}`, {
    server: { url: vapiServerUrl(), headers: { "x-vapi-secret": vapiWebhookSecret() } },
  });
}

export interface VapiAssistant {
  id: string;
  name?: string;
  firstMessage?: string;
  model?: { model?: string; temperature?: number; messages?: Array<{ role: string; content: string }> };
  voice?: { provider?: string; voiceId?: string };
  maxDurationSeconds?: number;
}

export async function listVapiAssistants(organizationId: string): Promise<VapiAssistant[]> {
  return request<VapiAssistant[]>(await resolveVapiKey(organizationId), "GET", "/assistant?limit=1000");
}

// Live-call control (say / add-message / transfer / end-call). The control
// URL is a per-call capability URL issued by VAPI; it needs no API key.
export async function controlVapiCall(controlUrl: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(controlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new VapiApiError(res.status, await res.text());
}
