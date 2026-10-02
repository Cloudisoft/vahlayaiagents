import { env } from "../config/env.js";
import { getOrgCredential } from "./credentialsService.js";
import { pool } from "../db/pool.js";

const CARTESIA = "https://api.cartesia.ai";
const VERSION = "2025-04-16";

export class ProviderNotConfiguredError extends Error {
  constructor() {
    super("Cartesia is not configured. Add an API key in Settings → AI Providers to load the voice library.");
    this.name = "ProviderNotConfiguredError";
  }
}

export async function resolveCartesiaKey(organizationId: string): Promise<string> {
  const cred = await getOrgCredential(organizationId, "cartesia");
  const apiKey = cred?.apiKey ?? env.cartesiaApiKey;
  if (!apiKey) throw new ProviderNotConfiguredError();
  return apiKey;
}

async function cartesia<T>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${CARTESIA}${path}`, {
    ...init,
    headers: { "X-API-Key": apiKey, "Cartesia-Version": VERSION, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).message ?? JSON.parse(text).error ?? text;
    } catch {
      // plain text error
    }
    throw new Error(`Cartesia API error (${res.status}): ${String(msg).slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

interface CartesiaVoice {
  id: string;
  name: string;
  language?: string;
  description?: string;
  gender?: string | null;
  is_owner?: boolean;
}

async function upsertVoice(organizationId: string, v: CartesiaVoice, cloned = false) {
  // Voices the org owns (clones) are private to it; the public library is shared.
  const owned = cloned || Boolean(v.is_owner);
  const r = await pool.query(
    `insert into voices (provider, provider_voice_id, name, language, style, description, gender, organization_id, is_cloned)
     values ('cartesia', $1, $2, $3, $4, $4, $5, $6, $7)
     on conflict (provider, provider_voice_id) do update set name = excluded.name, language = excluded.language,
       style = excluded.style, description = excluded.description, gender = excluded.gender,
       organization_id = coalesce(excluded.organization_id, voices.organization_id),
       is_cloned = voices.is_cloned or excluded.is_cloned
     returning *`,
    [v.id, v.name, v.language ?? null, v.description ?? null, v.gender ?? null, owned ? organizationId : null, owned]
  );
  return r.rows[0];
}

// The real Cartesia catalog (public voices plus the org's own clones),
// paged through completely. Never returns a fabricated list.
export async function syncCartesiaVoices(organizationId: string): Promise<number> {
  const apiKey = await resolveCartesiaKey(organizationId);
  let after: string | null = null;
  let count = 0;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ limit: "100" });
    if (after) q.set("starting_after", after);
    const r = await cartesia<{ data: CartesiaVoice[]; has_more: boolean; next_page?: string | null }>(apiKey, `/voices?${q}`);
    for (const v of r.data) {
      await upsertVoice(organizationId, v);
      count++;
    }
    if (!r.has_more || r.data.length === 0) break;
    after = r.next_page ?? r.data[r.data.length - 1].id;
  }
  return count;
}

// Import specific voices by ID (e.g. ones made in the Cartesia playground).
export async function importCartesiaVoices(organizationId: string, ids: string[]) {
  const apiKey = await resolveCartesiaKey(organizationId);
  const imported: any[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    try {
      const v = await cartesia<CartesiaVoice>(apiKey, `/voices/${encodeURIComponent(id)}`);
      imported.push(await upsertVoice(organizationId, v));
    } catch (err) {
      failed.push({ id, error: (err as Error).message });
    }
  }
  return { imported, failed };
}

// Instant voice clone from a short recording.
export async function cloneCartesiaVoice(
  organizationId: string,
  params: { audio: Buffer; fileName: string; mimeType: string; name: string; language: string; description?: string }
) {
  const apiKey = await resolveCartesiaKey(organizationId);
  const form = new FormData();
  form.append("clip", new Blob([new Uint8Array(params.audio)], { type: params.mimeType || "audio/mpeg" }), params.fileName || "sample.mp3");
  form.append("name", params.name);
  form.append("language", params.language);
  if (params.description) form.append("description", params.description);
  const v = await cartesia<CartesiaVoice>(apiKey, "/voices/clone", { method: "POST", body: form });
  return upsertVoice(organizationId, { ...v, name: v.name ?? params.name }, true);
}

export async function deleteCartesiaVoice(organizationId: string, providerVoiceId: string) {
  const apiKey = await resolveCartesiaKey(organizationId);
  await cartesia(apiKey, `/voices/${encodeURIComponent(providerVoiceId)}`, { method: "DELETE" });
}

// A short sample of the voice so it can be previewed before use.
export async function previewCartesiaVoice(organizationId: string, providerVoiceId: string, text: string): Promise<Buffer> {
  const apiKey = await resolveCartesiaKey(organizationId);
  const res = await fetch(`${CARTESIA}/tts/bytes`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Cartesia-Version": VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({
      model_id: "sonic-3",
      transcript: text,
      voice: { mode: "id", id: providerVoiceId },
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
    }),
  });
  if (!res.ok) throw new Error(`Cartesia API error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

// Cloned voices are private to the Cartesia account that made them, so
// VAPI must use that account's key for calls with them.
export async function voiceCredentials(organizationId: string, voice: { provider: string; providerVoiceId: string } | null) {
  if (!voice || voice.provider !== "cartesia") return [];
  const r = await pool.query("select organization_id from voices where provider = 'cartesia' and provider_voice_id = $1", [voice.providerVoiceId]);
  if (!r.rows[0]?.organization_id) return [];
  try {
    return [{ provider: "cartesia", apiKey: await resolveCartesiaKey(organizationId) }];
  } catch {
    return [];
  }
}
