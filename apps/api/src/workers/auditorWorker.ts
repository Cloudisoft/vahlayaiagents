import { registerWorker, markJobStatus } from "../services/queue.js";
import { processCallAudit } from "../services/auditPipeline.js";

export function startAuditorWorker() {
  return registerWorker("call-audit", async (job) => {
    const { auditId, backgroundJobId } = job.data as { auditId: string; backgroundJobId: string };
    await markJobStatus(backgroundJobId, "processing");
    try {
      await processCallAudit(auditId);
      await markJobStatus(backgroundJobId, "completed");
    } catch (err) {
      await markJobStatus(backgroundJobId, "failed", { error: (err as Error).message });
      throw err;
    }
  });
}
