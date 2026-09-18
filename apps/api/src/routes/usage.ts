import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { getTelephonyProvider } from "../telephony/index.js";
import { env } from "../config/env.js";

export const usageRouter = Router();
usageRouter.use(requireAuth);

usageRouter.get("/", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.organizationId;

  const byCategory = await pool.query(
    `select category, sum(units) as units, sum(cost_usd) as cost_usd, count(*) as events
     from usage where organization_id = $1 group by category order by cost_usd desc`,
    [orgId]
  );

  const storageBytes = await pool.query(
    `select coalesce(sum(file_size), 0) as total_bytes, count(*) as file_count from files where organization_id = $1`,
    [orgId]
  );

  // Plivo (India calling) and Twilio (US calling) both expose real account
  // balance endpoints; other providers (VAPI, Cartesia) don't have a simple
  // public balance API, so we report "unavailable" for those rather than
  // fabricating a number.
  async function fetchBalance(providerKey: string) {
    try {
      const provider = await getTelephonyProvider(orgId, providerKey);
      return { balanceUsd: await provider.getBalance(), error: null as string | null };
    } catch (err) {
      return { balanceUsd: null, error: (err as Error).message };
    }
  }
  const [plivoBalance, twilioBalance] = await Promise.all([fetchBalance("plivo"), fetchBalance("twilio")]);

  res.json({
    byCategory: byCategory.rows,
    storage: {
      totalBytes: Number(storageBytes.rows[0].total_bytes),
      fileCount: Number(storageBytes.rows[0].file_count),
      driver: env.storage.driver,
    },
    balances: {
      plivo: plivoBalance,
      twilio: twilioBalance,
      vapi: { balanceUsd: null, note: "VAPI does not expose a public balance API." },
      cartesia: { balanceUsd: null, note: "Cartesia does not expose a public balance API." },
      openai: { balanceUsd: null, note: "OpenAI does not expose a real-time balance API; see usage above for spend tracked by this platform." },
    },
  });
});
