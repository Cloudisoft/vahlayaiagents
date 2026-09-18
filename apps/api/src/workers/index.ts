// Worker process bootstrap. Run with `npm run worker --workspace=apps/api`.
// Each module (HR resume parsing, Coverage bulk lookups, LeadGen discovery,
// Voice AI transcription, Call Auditor) registers its own queue processor
// here as that module is built. Phase 1 ships the harness with no queues
// registered yet — registerWorker() below is where Phase 2+ hooks in.
import { isQueueEnabled } from "../services/queue.js";
import { startResumeWorker } from "./resumeWorker.js";
import { startCoverageWorker } from "./coverageWorker.js";
import { startLeadgenWorker } from "./leadgenWorker.js";
import { tickCampaignDialer } from "../voiceai/callQueueService.js";
import { pool } from "../db/pool.js";

if (!isQueueEnabled()) {
  console.warn(
    "[worker] REDIS_URL is not set. Background processing is disabled until it is configured — " +
      "no jobs will run. This process will stay idle."
  );
} else {
  startResumeWorker();
  startCoverageWorker();
  startLeadgenWorker();
  console.log("[worker] Redis connected. resume-processing, coverage-bulk-lookup and leadgen-discovery workers started.");
}

// Voice AI campaign dialer: independent of Redis — it only needs the
// database and telephony credentials, and enforces concurrency itself by
// counting in-flight calls per campaign (spec §36). Runs every 15s.
const DIALER_INTERVAL_MS = 15000;
setInterval(() => {
  tickCampaignDialer().catch((err) =>
    pool.query(`insert into system_logs (level, source, message) values ('error','campaign_dialer_tick',$1)`, [
      (err as Error).message,
    ])
  );
}, DIALER_INTERVAL_MS);
console.log(`[worker] Campaign dialer running every ${DIALER_INTERVAL_MS / 1000}s.`);

// Keep the process alive.
setInterval(() => {}, 1 << 30);
