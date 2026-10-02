import express from "express";
// Route handlers are async; this makes Express 4 send their errors to the
// error handler below instead of crashing the process.
import "express-async-errors";
import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import compression from "compression";
import { env } from "./config/env.js";
import { authRouter } from "./routes/auth.js";
import { orgRouter } from "./routes/org.js";
import { settingsRouter } from "./routes/settings.js";
import { filesRouter } from "./routes/files.js";
import { hrRouter } from "./routes/hr.js";
import { publicHrRouter } from "./routes/publicHr.js";
import { publicJobsRouter } from "./routes/publicJobs.js";
import { vapiWebhookRouter } from "./routes/webhooks/vapi.js";
import { coverageRouter } from "./routes/coverage.js";
import { leadgenRouter } from "./routes/leadgen.js";
import { agentsRouter } from "./routes/agents.js";
import { voicesRouter } from "./routes/voices.js";
import { phoneNumbersRouter } from "./routes/phoneNumbers.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { dispositionsRouter } from "./routes/dispositions.js";
import { callsRouter } from "./routes/calls.js";
import { voiceInsightsRouter } from "./routes/voiceInsights.js";
import { auditorRouter } from "./routes/auditor.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { usageRouter } from "./routes/usage.js";
import { notificationsRouter } from "./routes/notifications.js";
import { initRealtime } from "./services/realtimeService.js";
import { pool, warmPool } from "./db/pool.js";
import { authRateLimit, publicRateLimit } from "./middleware/rateLimit.js";

const app = express();

app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "connect-src": ["'self'", "wss:", "ws:"],
        "media-src": ["'self'", "https:", "blob:"],
        "img-src": ["'self'", "data:", "https:"],
        "style-src": ["'self'", "'unsafe-inline'"],
      },
    },
  })
);
app.use(cors({ origin: env.appUrl, credentials: true }));
app.use(compression());
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

// Plivo posts form-encoded webhook bodies (India HR interviews) — parse
// before the JSON body parser. VAPI (US Voice AI campaigns) posts JSON, and
// end-of-call reports can be large.
app.use("/api/public/hr", publicRateLimit, publicHrRouter);
app.use("/api/webhooks/vapi", express.json({ limit: "10mb" }), vapiWebhookRouter);

app.use(express.json({ limit: "2mb" }));

app.use("/api/auth", authRateLimit, authRouter);
app.use("/api/org", orgRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/files", filesRouter);
app.use("/api/hr", hrRouter);
app.use("/api/public/jobs", publicRateLimit, publicJobsRouter);
app.use("/api/coverage", coverageRouter);
app.use("/api/leadgen", leadgenRouter);
app.use("/api/voice/agents", agentsRouter);
app.use("/api/voice/voices", voicesRouter);
app.use("/api/voice/phone-numbers", phoneNumbersRouter);
app.use("/api/voice/campaigns", campaignsRouter);
app.use("/api/voice/dispositions", dispositionsRouter);
app.use("/api/voice/calls", callsRouter);
app.use("/api/voice/insights", voiceInsightsRouter);
app.use("/api/auditor", auditorRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/usage", usageRouter);
app.use("/api/notifications", notificationsRouter);

// In production the API also serves the built web app (same origin, so the
// refresh cookie and the /ws sockets need no CORS).
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  // Vite fingerprints everything under /assets, so it can be cached forever;
  // index.html must always be revalidated so new deploys show up at once.
  app.use("/assets", express.static(path.join(webDist, "assets"), { immutable: true, maxAge: "365d", index: false }));
  // A file from an older deploy that no longer exists must be a 404, not
  // index.html — the browser would try to run the HTML as code and the page
  // would go blank. The client reloads onto the new version on a 404.
  app.use("/assets", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).type("text/plain").send("Not found");
  });
  app.use(express.static(webDist, { index: false, maxAge: "1h" }));
  app.get(/^\/(?!api\/|ws).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(webDist, "index.html"));
  });
}

app.use((err: Error & { code?: string }, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Malformed ids/values from the client (bad uuid, enum, number…) are 400s.
  if (err.code && ["22P02", "22007", "22008", "22003", "23502", "23503"].includes(err.code)) {
    return res.status(400).json({ error: "Invalid request." });
  }
  // Upload problems (too large, wrong type) and bad JSON are the client's to fix.
  if (err.name === "MulterError" || /^(Upload an|Unsupported )/.test(err.message)) {
    return res.status(400).json({ error: err.name === "MulterError" && err.code === "LIMIT_FILE_SIZE" ? "That file is too large." : err.message });
  }
  if ((err as any).type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON body." });
  if ((err as any).type === "entity.too.large") return res.status(413).json({ error: "Request is too large." });
  console.error(err);
  // Kept server-side for admins (Settings → System health); never sent to the browser.
  const org = (req as express.Request & { auth?: { organizationId?: string } }).auth?.organizationId ?? null;
  pool
    .query("insert into system_logs (organization_id, level, source, message, metadata) values ($1,'error','http',$2,$3)", [
      org,
      String(err.message ?? err).slice(0, 2000),
      JSON.stringify({ method: req.method, path: req.path, stack: String(err.stack ?? "").slice(0, 3000) }),
    ])
    .catch(() => undefined);
  res.status(500).json({ error: env.nodeEnv === "production" ? "Internal server error." : err.message });
});

const server = http.createServer(app);
initRealtime(server);

server.listen(env.port, () => {
  warmPool().catch(() => undefined);
  console.log(`Vahlay AI API listening on port ${env.port} (${env.nodeEnv})`);
});
