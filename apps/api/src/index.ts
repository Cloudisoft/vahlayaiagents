import express from "express";
import http from "node:http";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { env } from "./config/env.js";
import { authRouter } from "./routes/auth.js";
import { orgRouter } from "./routes/org.js";
import { settingsRouter } from "./routes/settings.js";
import { filesRouter } from "./routes/files.js";
import { jobsRouter } from "./routes/jobs.js";
import { publicJobsRouter } from "./routes/publicJobs.js";
import { applicationsRouter } from "./routes/applications.js";
import { plivoWebhookRouter } from "./routes/webhooks/plivo.js";
import { plivoVoiceAgentWebhookRouter } from "./routes/webhooks/plivoVoiceAgent.js";
import { twilioVoiceAgentWebhookRouter } from "./routes/webhooks/twilioVoiceAgent.js";
import { coverageRouter } from "./routes/coverage.js";
import { leadgenRouter } from "./routes/leadgen.js";
import { agentsRouter } from "./routes/agents.js";
import { voicesRouter } from "./routes/voices.js";
import { phoneNumbersRouter } from "./routes/phoneNumbers.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { dispositionsRouter } from "./routes/dispositions.js";
import { callsRouter } from "./routes/calls.js";
import { auditorRouter } from "./routes/auditor.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { usageRouter } from "./routes/usage.js";
import { notificationsRouter } from "./routes/notifications.js";
import { initRealtime } from "./services/realtimeService.js";
import { authRateLimit, publicRateLimit } from "./middleware/rateLimit.js";

const app = express();

app.use(helmet());
app.use(cors({ origin: env.appUrl, credentials: true }));
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

// Plivo and Twilio both post form-encoded webhook bodies — parse before the
// JSON body parser (which would otherwise leave req.body empty for these
// routes). Plivo carries India HR interviews; Twilio carries US Voice AI
// campaign calls (see telephony/index.ts).
app.use("/api/webhooks/plivo/voice-agent", express.urlencoded({ extended: false }), plivoVoiceAgentWebhookRouter);
app.use("/api/webhooks/plivo", express.urlencoded({ extended: false }), plivoWebhookRouter);
app.use("/api/webhooks/twilio/voice-agent", express.urlencoded({ extended: false }), twilioVoiceAgentWebhookRouter);

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
app.use("/api/auditor", auditorRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/usage", usageRouter);
app.use("/api/notifications", notificationsRouter);

// Additional provider webhooks land as their modules do (spec §47):
// /api/webhooks/vapi.

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: env.nodeEnv === "production" ? "Internal server error." : err.message });
});

const server = http.createServer(app);
initRealtime(server);

server.listen(env.port, () => {
  console.log(`Vahlay AI API listening on port ${env.port} (${env.nodeEnv})`);
});
