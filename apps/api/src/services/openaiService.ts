import { env } from "../config/env.js";
import { getOrgCredential } from "./credentialsService.js";
import { pool } from "../db/pool.js";

export class ProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`${provider} is not configured. Add an API key in Settings → AI Providers.`);
    this.name = "ProviderNotConfiguredError";
  }
}

async function resolveOpenAiKey(organizationId: string): Promise<string> {
  const cred = await getOrgCredential(organizationId, "openai");
  const key = cred?.apiKey ?? env.openaiApiKey;
  if (!key) throw new ProviderNotConfiguredError("OpenAI");
  return key;
}

async function recordUsage(organizationId: string, category: string, units: number, costUsd: number, metadata: Record<string, unknown>) {
  await pool.query(
    `insert into usage (organization_id, category, units, cost_usd, metadata) values ($1, $2, $3, $4, $5)`,
    [organizationId, category, units, costUsd, JSON.stringify(metadata)]
  );
}

// Rough GPT-4o-mini pricing for usage tracking ($/1K tokens). Not billed —
// just gives orgs a real, if approximate, cost signal in Settings/Dashboard.
const PRICE_PER_1K_INPUT = 0.00015;
const PRICE_PER_1K_OUTPUT = 0.0006;

export async function chatJson<T>(params: {
  organizationId: string;
  system: string;
  user: string;
  model?: string;
}): Promise<T> {
  const apiKey = await resolveOpenAiKey(params.organizationId);
  const model = params.model ?? "gpt-4o-mini";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  if (data.usage) {
    const cost =
      (data.usage.prompt_tokens / 1000) * PRICE_PER_1K_INPUT +
      (data.usage.completion_tokens / 1000) * PRICE_PER_1K_OUTPUT;
    await recordUsage(params.organizationId, "openai", data.usage.prompt_tokens + data.usage.completion_tokens, cost, {
      model,
    });
  }

  return JSON.parse(data.choices[0].message.content) as T;
}

export async function transcribeAudio(params: {
  organizationId: string;
  audio: Buffer;
  filename: string;
}): Promise<{ text: string }> {
  const apiKey = await resolveOpenAiKey(params.organizationId);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(params.audio)]), params.filename);
  form.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form as any,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI transcription error (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { text: string };
  await recordUsage(params.organizationId, "openai", 0, 0.006 * (params.audio.length / (1024 * 1024)), {
    model: "whisper-1",
  });
  return data;
}
