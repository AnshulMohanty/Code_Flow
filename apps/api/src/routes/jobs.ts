import { Router } from "express";
import type { EventLogStore, ProgressMessage, ProgressSubscriber } from "@codeflow/shared-types";
import { getAnalysisJob, getAnalysisJobProgress } from "../services/analysisJobService.js";
import { getProgressSubscriber } from "../queues/progressChannel.js";
import { getEventLogStore } from "../queues/eventLogStore.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const jobsRouter = Router();

/** Minimal response sink the SSE writer needs (subset of Express Response). */
export interface SseSink {
  write(chunk: string): void;
  end(): void;
}

/**
 * Stream a job's progress as SSE: REPLAY the buffered event log in order (so a late
 * connection still sees every stage from Ingest — the #20 fix), then TAIL the live channel.
 * The replay/live boundary is deduped on the monotonic `stageIndex` (one authoritative event
 * per stage) plus the terminal `done`, so each stage is written exactly once, in order.
 *
 * To avoid a gap between the log snapshot and the live attach, we subscribe FIRST and queue
 * live messages while replaying, then drain them (deduped) and continue live. When no
 * `eventLog` is provided the behaviour is the original live-only stream (back-compat).
 *
 * Returns a `close` fn for connection teardown.
 */
export function streamProgress(
  res: SseSink,
  jobId: string,
  subscriber: ProgressSubscriber,
  eventLog?: EventLogStore,
): () => void {
  let closed = false;
  let unsubscribe: () => void = () => {};
  let lastIndex = 0; // highest stageIndex already written (monotonic dedupe key)
  let terminalWritten = false;
  let replaying = Boolean(eventLog);
  const pending: ProgressMessage[] = []; // live messages buffered during replay

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    res.end();
  };

  const writeMessage = (message: ProgressMessage) => {
    if (closed || terminalWritten) return;
    if (message.kind === "progress") {
      // Dedupe the replay/live boundary: one authoritative event per stage (P1 contract).
      if (message.event.stageIndex <= lastIndex) return;
      lastIndex = message.event.stageIndex;
      res.write("event: progress\n");
      res.write(`data: ${JSON.stringify(message.event)}\n\n`);
      return;
    }
    terminalWritten = true;
    res.write("event: done\n");
    res.write(`data: ${JSON.stringify({ jobId: message.jobId, status: message.status })}\n\n`);
    close();
  };

  // Subscribe BEFORE reading the log so no event emitted during replay is lost; queue live
  // messages until the replay completes.
  unsubscribe = subscriber.subscribe(jobId, (message) => {
    if (closed) return;
    if (replaying) {
      pending.push(message);
      return;
    }
    writeMessage(message);
  });
  if (closed) unsubscribe(); // synchronous-terminal safety

  if (eventLog) {
    void eventLog.read(jobId).then((buffered) => {
      for (const message of buffered) {
        if (closed) break;
        writeMessage(message);
      }
      replaying = false;
      for (const message of pending) {
        if (closed) break;
        writeMessage(message);
      }
      pending.length = 0;
    });
  }

  return close;
}

jobsRouter.get(
  "/api/job/:id",
  asyncHandler(async (req, res) => {
    const jobId = String(req.params.id);
    res.json(await getAnalysisJobProgress(jobId));
  }),
);

/**
 * SSE stream of pipeline ProgressEvents for a job, plus a terminal `done` event
 * carrying the final run status. Events originate in the worker and reach this
 * process via the progress channel (BullMQ QueueEvents in production).
 */
jobsRouter.get(
  "/api/job/:id/events",
  asyncHandler(async (req, res) => {
    const jobId = String(req.params.id);
    // Validate the job exists BEFORE switching to SSE (so a 404 is still JSON).
    await getAnalysisJob(jobId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // Managed hosts front the app with an nginx-family proxy that BUFFERS a response body by
    // default, which turns a progress stream into one delivery at the end -- the stream still
    // "works" in tests and is useless in production. Honoured by Render and Railway, ignored
    // elsewhere, harmless either way.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const close = streamProgress(res, jobId, getProgressSubscriber(), getEventLogStore());
    req.on("close", close);
  }),
);
