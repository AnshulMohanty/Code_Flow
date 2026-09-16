/**
 * EMBEDDED-WORKER MODE — one process instead of two, for a free tier that has no worker service.
 *
 * THE CONSTRAINT THIS EXISTS FOR. Render has no free `worker` service type, and Railway's free
 * allowance is one service's worth of usage. The default two-process split is the right architecture
 * — the worker holds a job for minutes and needs to scale on queue depth while the API scales on
 * request volume — but it is not deployable for free, and an architecture nobody can run is not
 * better than one they can.
 *
 * SO THE SPLIT STAYS THE DEFAULT and this is opt-in. Everything about the worker is unchanged when
 * the flag is off: the module is not even imported (the caller uses a dynamic import), so a normal
 * API deployment pays nothing for this — not a dependency load, not a millisecond of cold start.
 *
 * WHAT IS GENUINELY WORSE IN THIS MODE, stated here rather than discovered in production:
 *   - A long analysis and an HTTP request share one event loop. Parsing is CPU-bound, so p99 latency
 *     on /api/meta gets worse while a job runs. Concurrency is therefore forced to 1.
 *   - Scaling is all-or-nothing: more capacity means more copies of BOTH, which is exactly the
 *     coupling the two-service split removes.
 *   - A worker crash takes the API with it. In split mode BullMQ re-delivers to another instance.
 *
 * WHAT IS BETTER, and it is not a small thing on a free tier: the API and the worker share a HEAP.
 * With no Postgres, retrieval falls back to a per-process in-memory index — which in split mode
 * means the worker writes an index the API cannot read, and every question is refused. In this mode
 * they can be handed the SAME store instance, so Q&A works without a database at all.
 */

export interface EmbeddedWorkerDecision {
  /** Start the BullMQ consumer inside this process? */
  embedded: boolean;
  /** Jobs at a time. Forced to 1 when embedded — see the note above on the shared event loop. */
  concurrency: number;
  /** Surfaced at boot, never swallowed. An operator who turned this on should see it acknowledged. */
  notes: string[];
}

/**
 * Read the flag. A pure function of an env record so the decision — including the concurrency
 * clamp, which is the part with a real cost — is testable without starting anything.
 */
export function resolveEmbeddedWorker(
  environment: Record<string, string | undefined> = process.env,
): EmbeddedWorkerDecision {
  const raw = (environment.RUN_WORKER_IN_PROCESS || "").trim().toLowerCase();
  const embedded = raw === "true" || raw === "1" || raw === "yes";
  const notes: string[] = [];

  if (!embedded) {
    if (raw && raw !== "false" && raw !== "0" && raw !== "no") {
      // A typo here silently produces the opposite deployment from the one intended, and the
      // symptom is "jobs queue and nothing happens" — which looks like a Redis problem.
      notes.push(
        `RUN_WORKER_IN_PROCESS="${environment.RUN_WORKER_IN_PROCESS}" is not a recognised boolean; ` +
          "treating it as FALSE. The BullMQ consumer must run as a separate process.",
      );
    }
    return { embedded: false, concurrency: 0, notes };
  }

  notes.push(
    "RUN_WORKER_IN_PROCESS=true — the BullMQ consumer runs INSIDE this API process. Intended for a " +
      "single-service free-tier deployment; the two-process split is the default and the right shape " +
      "for anything that needs to scale.",
  );

  // NOT configurable. WORKER_CONCURRENCY is honoured in split mode, where a slow job costs only
  // queue throughput. Here a second concurrent parse competes with every HTTP request on one event
  // loop, and the API is the thing a human is waiting on.
  if (environment.WORKER_CONCURRENCY && environment.WORKER_CONCURRENCY.trim() !== "1") {
    notes.push(
      `WORKER_CONCURRENCY=${environment.WORKER_CONCURRENCY} is IGNORED in embedded mode: concurrency is ` +
        "forced to 1 so a CPU-bound parse cannot starve the HTTP server sharing its event loop.",
    );
  }

  return { embedded: true, concurrency: 1, notes };
}
