import { QueueEvents } from "bullmq";
import type { ProgressMessage, ProgressSubscriber } from "@codeflow/shared-types";
import { ANALYSIS_QUEUE_NAME, createRedisConnectionOptions, isRedisQueueEnabled } from "./queueConnection.js";

let testOverride: ProgressSubscriber | null = null;
let bullmqSubscriber: ProgressSubscriber | null = null;

/** Tests inject an in-memory subscriber here (mirrors setAnalysisQueueEnqueueForTests). */
export function setProgressSubscriberForTests(subscriber: ProgressSubscriber | null) {
  testOverride = subscriber;
}

export function getProgressSubscriber(): ProgressSubscriber {
  if (testOverride) return testOverride;
  bullmqSubscriber ??= createBullmqProgressSubscriber();
  return bullmqSubscriber;
}

/**
 * Production subscriber: a single shared BullMQ `QueueEvents` listener. The worker
 * publishes progress via `job.updateProgress(ProgressMessage)`, which BullMQ delivers
 * here as a "progress" event. Each SSE connection attaches a listener filtered to its
 * jobId and detaches on unsubscribe.
 */
function createBullmqProgressSubscriber(): ProgressSubscriber {
  let queueEvents: QueueEvents | null = null;
  const ensure = () => {
    queueEvents ??= new QueueEvents(ANALYSIS_QUEUE_NAME, { connection: createRedisConnectionOptions() });
    return queueEvents;
  };

  return {
    subscribe(jobId, handler) {
      if (!isRedisQueueEnabled()) {
        // No Redis in this environment — nothing to stream.
        return () => {};
      }
      const events = ensure();
      const listener = (args: { jobId: string; data: unknown }) => {
        const message = args.data as ProgressMessage | undefined;
        if (message && message.jobId === jobId) {
          handler(message);
        }
      };
      events.on("progress", listener);
      return () => {
        events.off("progress", listener);
      };
    },
  };
}
