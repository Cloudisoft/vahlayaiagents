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
    assistantId: null,
    squadId: null,
    workflowId: null,
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

export async function createVapiAssistant(organizationId: string, body: Record<string, unknown>): Promise<VapiAssistant> {
  return request<VapiAssistant>(await resolveVapiKey(organizationId), "POST", "/assistant", body);
}

export async function updateVapiAssistant(organizationId: string, id: string, body: Record<string, unknown>): Promise<VapiAssistant> {
  return request<VapiAssistant>(await resolveVapiKey(organizationId), "PATCH", `/assistant/${id}`, body);
}

export async function updateVapiPhoneNumber(organizationId: string, id: string, body: Record<string, unknown>): Promise<VapiPhoneNumber> {
  return request<VapiPhoneNumber>(await resolveVapiKey(organizationId), "PATCH", `/phone-number/${id}`, body);
}

// VAPI has no balance endpoint for API keys; month-to-date spend comes from
// its analytics API, which is what the dashboard's usage figure is built on.
export async function vapiSpend(organizationId: string, from: Date, to: Date): Promise<{ cost: number; calls: number }> {
  const r = await request<Array<{ result: Array<{ sumCost?: number; countId?: string | number }> }>>(
    await resolveVapiKey(organizationId),
    "POST",
    "/analytics",
    {
      queries: [
        {
          table: "call",
          name: "spend",
          operations: [
            { operation: "sum", column: "cost" },
            { operation: "count", column: "id" },
          ],
          timeRange: { start: from.toISOString(), end: to.toISOString() },
        },
      ],
    }
  );
  const row = r[0]?.result?.[0] ?? {};
  return { cost: Number(row.sumCost ?? 0), calls: Number(row.countId ?? 0) };
}

// The models VAPI accepts, read from VAPI's own published API schema so the
// list tracks what VAPI supports without a code change.
export interface ModelCatalog {
  providers: Array<{ provider: string; label: string; models: string[] }>;
  fetchedAt: string;
}
const CATALOG_PROVIDERS: Array<[string, string, string]> = [
  ["openai", "OpenAI", "OpenAIModel"],
  ["anthropic", "Anthropic", "AnthropicModel"],
  ["google", "Google", "GoogleModel"],
  ["groq", "Groq", "GroqModel"],
];
let catalogCache: { at: number; value: ModelCatalog } | null = null;

export async function vapiModelCatalog(): Promise<ModelCatalog> {
  if (catalogCache && Date.now() - catalogCache.at < 6 * 3600_000) return catalogCache.value;
  const res = await fetch(`${VAPI_BASE}/api-json`, { headers: { "User-Agent": "VahlaySmartAI/1.0" } });
  if (!res.ok) throw new VapiApiError(res.status, "Could not load VAPI's model list.");
  const spec = (await res.json()) as any;
  const schemas = spec?.components?.schemas ?? {};
  const providers = CATALOG_PROVIDERS.map(([provider, label, schema]) => {
    const all: string[] = schemas[schema]?.properties?.model?.enum ?? [];
    // Region-pinned deployments ("gpt-4o:westus") and realtime/audio models
    // aren't usable for a phone agent's text model.
    const models = all.filter((m) => !m.includes(":") && !/realtime|audio|live/i.test(m));
    return { provider, label, models };
  }).filter((p) => p.models.length > 0);
  const value = { providers, fetchedAt: new Date().toISOString() };
  catalogCache = { at: Date.now(), value };
  return value;
}

export async function deleteVapiAssistant(organizationId: string, id: string): Promise<void> {
  await request(await resolveVapiKey(organizationId), "DELETE", `/assistant/${id}`);
}

// Asks VAPI to accept this exact voice config (as calls will send it) by
// creating and deleting a throwaway assistant, so a voice VAPI can't use is
// caught at Save rather than failing every call.
export async function checkVapiVoice(organizationId: string, voice: Record<string, unknown>, credentials?: Array<Record<string, string>>): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const a = await createVapiAssistant(organizationId, {
      name: "vahlay-voice-check",
      voice,
      ...(credentials?.length ? { credentials } : {}),
    });
    await deleteVapiAssistant(organizationId, a.id).catch(() => undefined);
    return { ok: true };
  } catch (err) {
    if (err instanceof VapiApiError && err.status >= 400 && err.status < 500) {
      let msg = err.body;
      try {
        const j = JSON.parse(err.body);
        msg = Array.isArray(j.message) ? j.message.join("; ") : j.message ?? err.body;
      } catch {
        // plain text
      }
      return { ok: false, error: String(msg).slice(0, 300) };
    }
    throw err;
  }
}
