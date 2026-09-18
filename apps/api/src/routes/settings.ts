import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { encryptSecret } from "../utils/crypto.js";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

const SUPPORTED_PROVIDERS = [
  "openai",
  "vapi",
  "cartesia",
  "twilio",
  "plivo",
  "exotel",
  "google_places",
  "smtp",
  "resend",
  "storage",
] as const;

// Returns which providers are configured — never the secret values themselves.
settingsRouter.get("/credentials", async (req: AuthedRequest, res) => {
  const result = await pool.query<{ provider: string; is_active: boolean; updated_at: string; metadata: any }>(
    "select provider, is_active, updated_at, metadata from api_credentials where organization_id = $1",
    [req.auth!.organizationId]
  );
  const configured = new Map(result.rows.map((r) => [r.provider, r]));
  res.json({
    providers: SUPPORTED_PROVIDERS.map((key) => ({
      provider: key,
      configured: configured.has(key),
      isActive: configured.get(key)?.is_active ?? false,
      updatedAt: configured.get(key)?.updated_at ?? null,
      metadata: configured.get(key)?.metadata ?? {},
    })),
  });
});

const credentialSchema = z.object({
  provider: z.enum(SUPPORTED_PROVIDERS),
  // Free-form key/value secret payload (e.g. { apiKey } or { authId, authToken }).
  value: z.record(z.string()),
  metadata: z.record(z.any()).optional(),
});

settingsRouter.put("/credentials", requireRole("company_admin"), async (req: AuthedRequest, res) => {
  const parsed = credentialSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { provider, value, metadata } = parsed.data;

  let encrypted: string;
  try {
    encrypted = encryptSecret(JSON.stringify(value));
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }

  await pool.query(
    `insert into api_credentials (organization_id, provider, encrypted_value, metadata, created_by)
     values ($1, $2, $3, $4, $5)
     on conflict (organization_id, provider)
     do update set encrypted_value = excluded.encrypted_value, metadata = excluded.metadata, updated_at = now(), is_active = true`,
    [req.auth!.organizationId, provider, encrypted, JSON.stringify(metadata ?? {}), req.auth!.userId]
  );

  await pool.query(
    `insert into audit_logs (organization_id, actor_user_id, action, entity_type)
     values ($1, $2, 'credentials.updated', $3)`,
    [req.auth!.organizationId, req.auth!.userId, provider]
  );

  res.json({ message: `${provider} credentials saved.` });
});

settingsRouter.delete("/credentials/:provider", requireRole("company_admin"), async (req: AuthedRequest, res) => {
  await pool.query("delete from api_credentials where organization_id = $1 and provider = $2", [
    req.auth!.organizationId,
    req.params.provider,
  ]);
  res.status(204).end();
});
