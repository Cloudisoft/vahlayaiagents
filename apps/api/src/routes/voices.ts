import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { syncCartesiaVoices } from "../services/cartesiaService.js";

export const voicesRouter = Router();
voicesRouter.use(requireAuth);

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
