import { createServer, type Server } from "node:http";
import type { WarmupState } from "@codeflow/analyzers";
import { describeScaleRule, type ScalingConfig } from "../config/scaling.js";

/**
 * THE WORKER'S LIVENESS / READINESS / METRICS ENDPOINT (V3-P5 task 5).
 *
 * The worker has no HTTP surface by design — it pulls jobs off Redis — and that is exactly why it
 * had no HEALTHCHECK while the API did. Two things forced one:
 *
 *   - A container HEALTHCHECK needs something to ask. The alternatives were considered: a heartbeat
 *     FILE touched by the job loop is checkable by `docker`, but an autoscaler cannot read it, and
 *     `pgrep node` proves only that the process exists — which is true of a worker wedged on a dead
 *     Redis connection, the single most likely way this process fails while looking alive.
 *   - An autoscaler needs a METRIC, over HTTP. Queue depth. See `scaling.ts` for why depth, not CPU.
 *
 * THE HANDLER IS SEPARATED FROM THE SOCKET, deliberately: `handleHealthRequest` is a pure function
 * of injected state, so the hermetic suite tests the actual response bodies and status codes without
 * binding a port. `startHealthServer` is the thin binding that remains, and what can be wrong in it
 * (the port, the shutdown) is not logic.
 *
 * READINESS AND LIVENESS ARE DIFFERENT ANSWERS, and conflating them is how a rolling deploy takes a
 * service down:
 *   - `/health` (LIVENESS) is 200 while the process is running and its consumer is open. A cold,
 *     un-warmed worker is LIVE — killing it would only restart the cold start.
 *   - `/ready` (READINESS) is 503 until warm-up completes. A scale-out instance must not be counted
 *     as capacity while it is still loading WASM grammars.
 */

export interface WorkerHealthState {
  /** Warm-up state from the shared registry. */
  warmup(): WarmupState;
  /** Queue depth: waiting + delayed. Null when it cannot be read (a dead Redis, most likely). */
  queueDepth(): Promise<number | null>;
  /** Jobs this instance is running right now. */
  activeJobs(): number;
  /** Whether the BullMQ consumer is still open (false once shutdown starts). */
  consumerRunning(): boolean;
}

export interface HealthResponse {
  status: number;
  contentType: string;
  body: string;
}

const JSON_TYPE = "application/json";

/**
 * Answer one request. Pure: everything it reports comes from `state`.
 *
 * Unknown paths get 404 rather than a catch-all 200 — a healthcheck misconfigured to hit `/healthz`
 * (the WEB app's path) must fail loudly, not report the process healthy by accident.
 */
export async function handleHealthRequest(path: string, state: WorkerHealthState): Promise<HealthResponse> {
  const warmup = state.warmup();

  if (path === "/health") {
    const consumerRunning = state.consumerRunning();
    return {
      // A worker whose consumer has closed is NOT live: it will never take another job, so a
      // supervisor should replace it rather than leave a process that only looks like capacity.
      status: consumerRunning ? 200 : 503,
      contentType: JSON_TYPE,
      body: json({
        status: consumerRunning ? "ok" : "stopping",
        role: "worker",
        // Reported on the liveness endpoint too, because "live but cold" is the state an operator
        // most often needs to distinguish and it is invisible from outside otherwise.
        warmedUp: warmup.warmedUp,
        warming: warmup.warming,
        activeJobs: state.activeJobs(),
      }),
    };
  }

  if (path === "/ready") {
    const ready = state.consumerRunning() && warmup.warmedUp;
    return {
      status: ready ? 200 : 503,
      contentType: JSON_TYPE,
      body: json({
        ready,
        warmedUp: warmup.warmedUp,
        warming: warmup.warming,
        // Per-task, so a failed OPTIONAL warm-up (which does not block readiness) is still visible
        // rather than hidden behind an aggregate boolean.
        tasks: warmup.tasks.map((task) => ({ name: task.name, status: task.status, durationMs: task.durationMs })),
      }),
    };
  }

  if (path === "/metrics") {
    const depth = await state.queueDepth();
    return {
      // 200 EVEN WHEN DEPTH IS NULL, and this is the load-bearing decision in this file. A scaler
      // that gets a 5xx from its metrics endpoint typically holds the last known value or refuses
      // to act; either way an unreadable queue must not be reported as depth 0, which would scale
      // the fleet IN precisely when Redis is broken and the backlog is invisible. So: 200, `null`,
      // and an explicit reason a scaler's rule can test for.
      status: 200,
      contentType: JSON_TYPE,
      body: json({
        queueDepth: depth,
        queueDepthAvailable: depth !== null,
        ...(depth === null ? { reason: "queue depth unreadable (Redis unavailable) - do NOT treat as zero" } : {}),
        activeJobs: state.activeJobs(),
        warmedUp: warmup.warmedUp,
      }),
    };
  }

  return { status: 404, contentType: JSON_TYPE, body: json({ error: `unknown path ${path}` }) };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Bind the health server. Returns null when disabled (port 0), which is the default: a deployment
 * that does not need the endpoint should not open a socket for it.
 */
export function startHealthServer(config: ScalingConfig, state: WorkerHealthState): Server | null {
  if (!config.healthPort) return null;

  const server = createServer((request, response) => {
    // Path only — a query string on a healthcheck URL is noise, and matching the full URL would
    // 404 a perfectly good `/health?probe=1`.
    const path = (request.url ?? "/").split("?")[0];
    void handleHealthRequest(path, state)
      .then((result) => {
        response.writeHead(result.status, { "content-type": result.contentType, "cache-control": "no-store" });
        response.end(result.body);
      })
      .catch((error: unknown) => {
        // A throwing health endpoint must ANSWER, not hang: a hung probe is indistinguishable from
        // a hung process and burns the whole probe timeout on every interval.
        response.writeHead(500, { "content-type": JSON_TYPE });
        response.end(json({ status: "error", error: error instanceof Error ? error.message : String(error) }));
      });
  });

  // The health server must never be the thing keeping a draining process alive.
  server.unref();
  server.listen(config.healthPort, () => {
    console.log(`[worker] health server on :${config.healthPort} (/health, /ready, /metrics)`);
    console.log(describeScaleRule(config));
  });
  server.on("error", (error: Error) => {
    // A taken port is an operator problem, not a reason to lose the worker: without this listener
    // the EADDRINUSE would be an unhandled 'error' event and take the process down — i.e. a
    // misconfigured health port would cost all of the worker's actual capacity.
    console.error(`[worker] health server failed to bind :${config.healthPort}: ${error.message}`);
  });

  return server;
}
