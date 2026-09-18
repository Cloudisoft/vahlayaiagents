import { registerWorker, markJobStatus } from "../services/queue.js";
import { processApplication } from "../services/applicationPipeline.js";

export function startResumeWorker() {
  return registerWorker("resume-processing", async (job) => {
    const { applicationId, backgroundJobId } = job.data as { applicationId: string; backgroundJobId: string };
    await markJobStatus(backgroundJobId, "processing");
    try {
      await processApplication(applicationId);
      await markJobStatus(backgroundJobId, "completed");
    } catch (err) {
      await markJobStatus(backgroundJobId, "failed", { error: (err as Error).message });
      throw err;
    }
  });
}
