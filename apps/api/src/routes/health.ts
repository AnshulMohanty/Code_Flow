import { Router } from "express";
import { warmupRegistry } from "@codeflow/analyzers";

/**
 * `/health` — LIVENESS and READINESS, reported separately (V3-P5 task 1).
 *
 * WHY `warmedUp` IS ITS OWN FIELD. A container that accepts traffic before its caches are warm
 * serves its first users a latency that looks like a bug: the tree-sitter WASM grammars alone are a
 * one-time cost paid by whichever request arrives first. Splitting the two lets an orchestrator hold
 * traffic back until the process is genuinely ready, and lets the ping-to-prevent-cold-sleep hook
 * verify it STAYED ready rather than merely alive.
 *
 * `status` stays `"ok"` while cold, deliberately. The process IS alive and CAN serve — a cold
 * request is slow, not broken — so reporting `"error"` would make a liveness probe kill a healthy
 * container mid-warm-up, which is the opposite of what readiness reporting is for.
 */
export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  const warmup = warmupRegistry.state();
  res.json({
    status: "ok",
    service: "codeflow-api",
    version: process.env.npm_package_version || "0.0.0",
    timestamp: new Date().toISOString(),
    // Readiness, separate from liveness above.
    warmedUp: warmup.warmedUp,
    warming: warmup.warming,
    warmup: {
      ...(warmup.durationMs !== undefined ? { durationMs: warmup.durationMs } : {}),
      ...(warmup.warmedAt ? { warmedAt: warmup.warmedAt } : {}),
      // Per-task, so a stuck or failed warm-up names itself instead of hiding behind one boolean.
      tasks: warmup.tasks.map((task) => ({
        name: task.name,
        status: task.status,
        required: task.required,
        ...(task.durationMs !== undefined ? { durationMs: task.durationMs } : {}),
        ...(task.error ? { error: task.error } : {}),
      })),
    },
  });
});
