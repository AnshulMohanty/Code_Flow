import { Router } from "express";
import { warmupRegistry } from "@codeflow/analyzers";
import { retrievalHealth } from "../services/ragQaService.js";

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
 *
 * V3-FINAL — WHAT THIS FIELD USED TO BE. V3-P5 shipped the field reading the shared
 * `warmupRegistry`, but the API process registered no tasks into it, and `warmedUp` is
 * `required.length > 0 && required.every(warm)` — so it was **structurally always false**, in every
 * API process, forever. A readiness probe wired to it would have held traffic back from a ready
 * service permanently. The API's real tasks are now registered at the composition root
 * (`../health/warmup.ts`), so the boolean reports a fact. It remains false in a process that
 * registered nothing — which is the honest answer to "did this process come up ready", not a bug.
 *
 * `retrieval` CLOSES LEDGER #32. The retrieval backend's degradation was announced in the LOGS
 * ONLY, so from outside the process "the API is up" and "the API can answer anything the worker
 * indexed" looked identical — while a memory-backed API refuses every question and returns 200 on
 * everything else. It is reported here rather than left to be inferred, and it is a SNAPSHOT: a
 * health endpoint that awaits the dependency it reports on turns one outage into two.
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
    // Ledger #32 — which retrieval index this process is actually talking to.
    retrieval: retrievalHealth(),
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
