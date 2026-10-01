import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { syncCartesiaVoices } from "../services/cartesiaService.js";

export const voicesRouter = Router();
voicesRouter.use(requireAuth);
voicesRouter.use(requireModuleAccess("voice_agents"));

voicesRouter.get("/", async (_req, res) => {
  const result = await pool.query("select * from voices order by provider, name");
  res.json({ voices: result.rows });
});

voicesRouter.post("/sync", async (req: AuthedRequest, res) => {
  try {
    const count = await syncCartesiaVoices(req.auth!.organizationId);
    res.json({ message: `Synced ${count} voices from Cartesia.` });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Add a specific Cartesia voice by its ID (e.g. one cloned in the Cartesia
// dashboard) without syncing the whole library.
voicesRouter.post("/", async (req: AuthedRequest, res) => {
  const providerVoiceId = typeof req.body?.providerVoiceId === "string" ? req.body.providerVoiceId.trim() : "";
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!/^[0-9a-f-]{20,}$/i.test(providerVoiceId)) return res.status(400).json({ error: "Enter a Cartesia voice ID." });
  if (!name) return res.status(400).json({ error: "Enter a display name." });
  const result = await pool.query(
    `insert into voices (provider, provider_voice_id, name) values ('cartesia',$1,$2)
     on conflict (provider, provider_voice_id) do update set name = excluded.name returning *`,
    [providerVoiceId, name]
  );
  res.status(201).json({ voice: result.rows[0] });
});
