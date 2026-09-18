// Worker process bootstrap. Run with `npm run worker --workspace=apps/api`.
// Each module (HR resume parsing, Coverage bulk lookups, LeadGen discovery,
// Voice AI transcription, Call Auditor) registers its own queue processor
// here as that module is built. Phase 1 ships the harness with no queues
// registered yet — registerWorker() below is where Phase 2+ hooks in.
import { isQueueEnabled } from "../services/queue.js";
import { startResumeWorker } from "./resumeWorker.js";
import { startCoverageWorker } from "./coverageWorker.js";

if (!isQueueEnabled()) {
  console.warn(
    "[worker] REDIS_URL is not set. Background processing is disabled until it is configured — " +
      "no jobs will run. This process will stay idle."
  );
} else {
  startResumeWorker();
  startCoverageWorker();
  console.log("[worker] Redis connected. resume-processing and coverage-bulk-lookup workers started.");
}

// Keep the process alive.
setInterval(() => {}, 1 << 30);
