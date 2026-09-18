import { registerWorker, markJobStatus } from "../services/queue.js";
import { lookupPhone } from "../services/coverageService.js";

export function startCoverageWorker() {
  return registerWorker("coverage-bulk-lookup", async (job) => {
    const { phones, requestedBy, backgroundJobId, organizationId } = job.data as {
      phones: string[];
      requestedBy: string;
      backgroundJobId: string;
      organizationId: string;
    };
    await markJobStatus(backgroundJobId, "processing");
    try {
      const results = [];
      for (const phone of phones) {
        results.push(await lookupPhone({ organizationId, requestedBy, rawPhone: phone }));
      }
      await markJobStatus(backgroundJobId, "completed", { result: { count: results.length } });
    } catch (err) {
      await markJobStatus(backgroundJobId, "failed", { error: (err as Error).message });
      throw err;
    }
  });
}
