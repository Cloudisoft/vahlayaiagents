import { registerWorker, markJobStatus } from "../services/queue.js";
import { runLeadDiscovery } from "../leadgen/discoveryService.js";

export function startLeadgenWorker() {
  return registerWorker("leadgen-discovery", async (job) => {
    const { leadListId, query, backgroundJobId, organizationId } = job.data as {
      leadListId: string;
      query: any;
      backgroundJobId: string;
      organizationId: string;
    };
    await markJobStatus(backgroundJobId, "processing");
    try {
      const result = await runLeadDiscovery({ organizationId, leadListId, query });
      await markJobStatus(backgroundJobId, "completed", { result });
    } catch (err) {
      await markJobStatus(backgroundJobId, "failed", { error: (err as Error).message });
      throw err;
    }
  });
}
