import express from "express";
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

const app = express();

app.use(helmet());
app.use(cors({ origin: env.appUrl, credentials: true }));
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

// Plivo posts form-encoded webhook bodies — parse before the JSON body
// parser (which would otherwise leave req.body empty for these routes).
app.use("/api/webhooks/plivo", express.urlencoded({ extended: false }), plivoWebhookRouter);

app.use(express.json({ limit: "2mb" }));

app.use("/api/auth", authRouter);
app.use("/api/org", orgRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/files", filesRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/public/jobs", publicJobsRouter);
app.use("/api/applications", applicationsRouter);

// Additional provider webhooks land as their modules do (spec §47):
// /api/webhooks/twilio, /api/webhooks/vapi.

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: env.nodeEnv === "production" ? "Internal server error." : err.message });
});

app.listen(env.port, () => {
  console.log(`Vahlay AI API listening on port ${env.port} (${env.nodeEnv})`);
});
