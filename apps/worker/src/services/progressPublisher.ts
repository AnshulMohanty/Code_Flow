import type { Job } from "bullmq";
import type { PipelineRunStatus, ProgressEvent, ProgressMessage, ProgressPublisher } from "@codeflow/shared-types";

/**
 * Worker-side progress publisher backed by BullMQ. Each call to `job.updateProgress`
 * is delivered to the API process as a `QueueEvents` "progress" event (see
 * apps/api/src/queues/progressChannel.ts). The BullMQ job id equals our domain jobId
 * (set when enqueuing), so the API can filter by jobId.
 */
export function createBullmqProgressPublisher(job: Job): ProgressPublisher {
  return {
    async publishProgress(jobId: string, event: ProgressEvent) {
      const message: ProgressMessage = { kind: "progress", jobId, event };
      await job.updateProgress(message);
    },
    async publishDone(jobId: string, status: PipelineRunStatus) {
      const message: ProgressMessage = { kind: "done", jobId, status };
      await job.updateProgress(message);
    },
  };
}
