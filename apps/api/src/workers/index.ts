// Worker process bootstrap. Run with `npm run worker --workspace=apps/api`.
import { isQueueEnabled } from "../services/queue.js";
import { startResumeWorker } from "./resumeWorker.js";
import { startCoverageWorker } from "./coverageWorker.js";
import { startLeadgenWorker } from "./leadgenWorker.js";
import { startAuditorWorker } from "./auditorWorker.js";
import { startDialer } from "../voiceai/dialer.js";

if (!isQueueEnabled()) {
  console.warn(
    "[worker] REDIS_URL is not set. Background processing is disabled until it is configured — " +
      "no jobs will run. This process will stay idle."
  );
} else {
  startResumeWorker();
  startCoverageWorker();
  startLeadgenWorker();
  startAuditorWorker();
  console.log("[worker] Redis connected. resume-processing, coverage-bulk-lookup, leadgen-discovery and call-audit workers started.");
}

// Voice AI campaign dialer (VAPI). Independent of Redis: it needs only the
// database, holds a DB lease so a single process dials, and enforces each
// campaign's concurrency server-side.
startDialer();
