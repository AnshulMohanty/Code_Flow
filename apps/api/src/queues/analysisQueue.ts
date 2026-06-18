import { Queue } from "bullmq";
import type { AnalysisJobPayload } from "@codeflow/shared-types";
import { ANALYSIS_QUEUE_NAME, createRedisConnectionOptions, isRedisQueueEnabled } from "./queueConnection.js";

export interface EnqueueResult {
  enqueued: boolean;
  reason?: string;
}

type EnqueueOverride = (payload: AnalysisJobPayload) => Promise<EnqueueResult>;

let queue: Queue<AnalysisJobPayload> | null = null;
let enqueueOverride: EnqueueOverride | null = null;

export async function enqueueAnalysisJob(payload: AnalysisJobPayload): Promise<EnqueueResult> {
  if (enqueueOverride) {
    return enqueueOverride(payload);
  }

  if (!isRedisQueueEnabled()) {
    return { enqueued: false, reason: "Redis queue disabled for this environment." };
  }

  try {
    const analysisQueue = getAnalysisQueue();
    await Promise.race([
      analysisQueue.add("analyze", payload, {
        jobId: payload.jobId,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400, count: 1000 },
      }),
      timeoutAfter(1500),
    ]);
    return { enqueued: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown Redis queue error.";
    return { enqueued: false, reason };
  }
}

export function setAnalysisQueueEnqueueForTests(override: EnqueueOverride | null) {
  enqueueOverride = override;
}

export async function closeAnalysisQueue() {
  if (queue) {
    await queue.close();
    queue = null;
  }
}

function getAnalysisQueue() {
  queue ??= new Queue<AnalysisJobPayload>(ANALYSIS_QUEUE_NAME, {
    connection: createRedisConnectionOptions(),
  });
  return queue;
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Redis queue connection timed out.")), ms);
  });
}
