// Worker process bootstrap. Run with `npm run worker --workspace=apps/api`.
import { isQueueEnabled } from "../services/queue.js";
import { startCoverageWorker } from "./coverageWorker.js";
import { startLeadgenWorker } from "./leadgenWorker.js";
import { startDialer } from "../voiceai/dialer.js";
import { sweepArtifactsAndReviews } from "../voiceai/callReview.js";
import { startQcWorker } from "../services/qc/pipeline.js";
import { startHrWorker } from "../services/hr/worker.js";
import { processNextBulkJob } from "../services/phoneIntel/bulkJobs.js";
import { rebuildAll } from "../services/phoneIntel/recompute.js";
import { pool } from "../db/pool.js";

if (!isQueueEnabled()) {
  console.warn(
    "[worker] REDIS_URL is not set. Background processing is disabled until it is configured — " +
      "no jobs will run. This process will stay idle."
  );
} else {
  startCoverageWorker();
  startLeadgenWorker();
  console.log("[worker] Redis connected. coverage-bulk-lookup, leadgen-discovery and call-audit workers started.");
}

// Voice AI campaign dialer (VAPI). Independent of Redis: it needs only the
// database, holds a DB lease so a single process dials, and enforces each
// campaign's concurrency server-side.
startDialer();

// Every answered call gets its VAPI recording and an AI coaching review,
// even when a webhook was missed.
setInterval(() => {
  sweepArtifactsAndReviews().catch((err) => console.error("[worker] artifact sweep:", (err as Error).message));
}, 60_000);

// Coverage bulk lookups (database-queued, no Redis needed).
let bulkBusy = false;
setInterval(async () => {
  if (bulkBusy) return;
  bulkBusy = true;
  try {
    while (await processNextBulkJob()) {
      // keep going while there are queued jobs
    }
  } catch (err) {
    console.error("[worker] bulk lookup:", (err as Error).message);
  } finally {
    bulkBusy = false;
  }
}, 5000);

// Nightly: re-weight all evidence by age and re-run the holdout so
// confidence keeps tracking reality. Once a day, guarded by an advisory lock.
setInterval(async () => {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()));
  if (hour !== 3) return;
  const c = await pool.connect();
  try {
    const got = await c.query("select pg_try_advisory_lock(774411) as ok");
    if (!got.rows[0].ok) return;
    const last = await c.query("select max(created_at) as at from intel_quality_runs where kind = 'holdout'");
    if (last.rows[0].at && Date.now() - new Date(last.rows[0].at).getTime() < 20 * 3600_000) return;
    await rebuildAll();
  } catch (err) {
    console.error("[worker] intelligence rebuild:", (err as Error).message);
  } finally {
    await c.query("select pg_advisory_unlock(774411)").catch(() => undefined);
    c.release();
  }
}, 15 * 60_000);

// QC audits: database-queued (no Redis needed), two at a time.
startQcWorker(2);

// Vahlay HR: resume screening, approved candidate messages, reminders and
// AI interview calls (database-queued).
startHrWorker(3);
