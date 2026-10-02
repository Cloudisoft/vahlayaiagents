import express from "express";
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
import { jobsRouter } from "./routes/jobs.js";
import { publicJobsRouter } from "./routes/publicJobs.js";
import { applicationsRouter } from "./routes/applications.js";
import { plivoWebhookRouter } from "./routes/webhooks/plivo.js";
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
import { warmPool } from "./db/pool.js";
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
app.use("/api/webhooks/plivo", express.urlencoded({ extended: false }), plivoWebhookRouter);
app.use("/api/webhooks/vapi", express.json({ limit: "10mb" }), vapiWebhookRouter);

app.use(express.json({ limit: "2mb" }));

app.use("/api/auth", authRateLimit, authRouter);
app.use("/api/org", orgRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/files", filesRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/public/jobs", publicRateLimit, publicJobsRouter);
app.use("/api/applications", applicationsRouter);
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
  app.use(express.static(webDist, { index: false, maxAge: "1h" }));
  app.get(/^\/(?!api\/|ws).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(webDist, "index.html"));
  });
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: env.nodeEnv === "production" ? "Internal server error." : err.message });
});

const server = http.createServer(app);
initRealtime(server);

server.listen(env.port, () => {
  warmPool().catch(() => undefined);
  console.log(`Vahlay AI API listening on port ${env.port} (${env.nodeEnv})`);
});
