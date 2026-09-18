import { Queue, Worker, type Processor } from "bullmq";
import { Redis as IORedis } from "ioredis";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";

let connection: IORedis | null = null;
function getConnection(): IORedis | null {
  if (!env.redisUrl) return null;
  if (!connection) connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
  return connection;
}

export function isQueueEnabled(): boolean {
  return Boolean(env.redisUrl);
}

const queues = new Map<string, Queue>();

export function getQueue(name: string): Queue {
  const conn = getConnection();
  if (!conn) {
    throw new Error(
      `Background queue "${name}" is unavailable: REDIS_URL is not configured. Set it in Settings/env to enable async processing.`
    );
  }
  if (!queues.has(name)) {
    queues.set(name, new Queue(name, { connection: conn }));
  }
  return queues.get(name)!;
}

export interface EnqueueParams {
  queueName: string;
  jobType: string;
  organizationId?: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}

// Enqueues a job and records it in background_jobs for status tracking/UI,
// independent of BullMQ's own internal state.
export async function enqueueJob(params: EnqueueParams): Promise<string> {
  const jobRow = await pool.query<{ id: string }>(
    `insert into background_jobs (organization_id, queue_name, job_type, payload, max_attempts)
     values ($1, $2, $3, $4, $5) returning id`,
    [params.organizationId ?? null, params.queueName, params.jobType, JSON.stringify(params.payload), params.maxAttempts ?? 3]
  );
  const jobId = jobRow.rows[0].id;

  const queue = getQueue(params.queueName);
  await queue.add(
    params.jobType,
    { ...params.payload, organizationId: params.organizationId, backgroundJobId: jobId },
    { attempts: params.maxAttempts ?? 3, backoff: { type: "exponential", delay: 5000 } }
  );

  return jobId;
}

export async function markJobStatus(
  backgroundJobId: string,
  status: "processing" | "completed" | "failed",
  extra?: { result?: unknown; error?: string }
) {
  const columns: string[] = ["status = $2"];
  const values: unknown[] = [backgroundJobId, status];
  if (status === "processing") columns.push("started_at = now()");
  if (status === "completed" || status === "failed") columns.push("finished_at = now()");
  if (extra?.result !== undefined) {
    columns.push(`result = $${values.length + 1}`);
    values.push(JSON.stringify(extra.result));
  }
  if (extra?.error !== undefined) {
    columns.push(`error = $${values.length + 1}`);
    values.push(extra.error);
  }
  await pool.query(`update background_jobs set ${columns.join(", ")} where id = $1`, values);
}

export function registerWorker(queueName: string, processor: Processor) {
  const conn = getConnection();
  if (!conn) {
    console.warn(`[worker] REDIS_URL not set — worker for "${queueName}" not started.`);
    return null;
  }
  return new Worker(queueName, processor, { connection: conn });
}
