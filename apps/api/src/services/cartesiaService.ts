import { env } from "../config/env.js";
import { getOrgCredential } from "./credentialsService.js";
import { pool } from "../db/pool.js";

export class ProviderNotConfiguredError extends Error {
  constructor() {
    super("Cartesia is not configured. Add an API key in Settings → AI Providers to load the voice library.");
    this.name = "ProviderNotConfiguredError";
  }
}

// Fetches the real Cartesia voice catalog and caches it into the shared
// `voices` table (shared across orgs — voice catalogs aren't org-specific).
// Never returns a fabricated voice list when the key is missing.
export async function syncCartesiaVoices(organizationId: string): Promise<number> {
  const cred = await getOrgCredential(organizationId, "cartesia");
  const apiKey = cred?.apiKey ?? env.cartesiaApiKey;
  if (!apiKey) throw new ProviderNotConfiguredError();

  const res = await fetch("https://api.cartesia.ai/voices", {
    headers: { "X-API-Key": apiKey, "Cartesia-Version": "2024-06-10" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cartesia API error (${res.status}): ${text}`);
  }
  const voices = (await res.json()) as Array<{ id: string; name: string; language?: string; description?: string }>;

  for (const v of voices) {
    await pool.query(
      `insert into voices (provider, provider_voice_id, name, language, style)
       values ('cartesia', $1, $2, $3, $4)
       on conflict (provider, provider_voice_id) do update set name = excluded.name, language = excluded.language, style = excluded.style`,
      [v.id, v.name, v.language ?? null, v.description ?? null]
    );
  }
  return voices.length;
}
