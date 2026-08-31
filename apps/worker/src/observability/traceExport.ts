import {
  createMemoryTraceExporter,
  createMultiExporter,
  exportersFromEnv,
  type MemoryTraceExporter,
  type TraceExporter,
} from "@codeflow/observability";

/**
 * TRACE EXPORT AT THE COMPOSITION ROOT (V3-P5 task 2 — wired here in V3-FINAL).
 *
 * WHAT WAS WRONG. `pipelineJobProcessor` already accepted a `traceExporter` and already built a full
 * `TraceReport` per job. Nothing ever PASSED one. So every run recorded spans, cost and an
 * interaction graph, and then dropped all of it except two header lines on stdout — a built feature
 * with no live path, which is indistinguishable from an unbuilt one from a user's side.
 *
 * WHAT THIS DOES. Resolves the exporter exactly once, at boot, from env:
 *
 *   - ALWAYS a bounded in-memory replay buffer. No network, no key, no dependency — so this is safe
 *     as the DEFAULT and safe in tests, and it is what makes `/metrics` able to say "this instance
 *     has exported N traces, the last one cost $X". Without it the default would be `undefined`,
 *     i.e. the state this function exists to fix.
 *   - PLUS Langfuse and/or Helicone when their env is configured, fanned out through
 *     `createMultiExporter` so one backend failing cannot cost the other or the buffer.
 *
 * THE NETWORK SEND IS DEFERRED, deliberately and by construction: it activates only when
 * LANGFUSE_* / HELICONE_API_KEY are set, which no test sets and no default provides. Confirming it
 * against a real Langfuse or Helicone project needs the owner's keys and is a GO_LIVE.md step, not
 * something this suite can honestly claim. What IS tested here is the resolution logic and the
 * payload — with an INJECTED `fetch`, so the assertion is on the request that would be sent.
 */

export interface ResolvedTraceExport {
  /** Hand this to `runAnalysisJob`. Never null — the memory buffer is always present. */
  exporter: TraceExporter;
  /** The replay buffer itself, for `/metrics`. */
  buffer: MemoryTraceExporter;
  /** True when a REMOTE backend was configured from env (Langfuse and/or Helicone). */
  remoteConfigured: boolean;
  /** One line for the boot log — an operator should not have to guess which backends are live. */
  description: string;
}

export interface ResolveTraceExportOptions {
  /** Retained reports. Bounded: a trace report holds every span of a run. */
  maxReports?: number;
  /** Injectable so the suite can assert the outbound request without a network. */
  fetchImpl?: typeof fetch;
  onError?(error: unknown): void;
}

export function resolveTraceExport(
  env: Record<string, string | undefined>,
  options: ResolveTraceExportOptions = {},
): ResolvedTraceExport {
  const buffer = createMemoryTraceExporter({
    ...(options.maxReports !== undefined ? { maxReports: options.maxReports } : {}),
  });

  const onError =
    options.onError ??
    ((error: unknown) => {
      // Logged and swallowed. An exporter that can fail the run it observes is worse than no
      // exporter, and it fails in exactly the situation the trace is most needed.
      console.warn(`[worker] trace export failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
    });

  const remote = exportersFromEnv(env, {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    onError,
  });

  if (!remote) {
    return {
      exporter: buffer,
      buffer,
      remoteConfigured: false,
      description: "trace export: in-memory replay buffer only (no LANGFUSE_*/HELICONE_API_KEY configured)",
    };
  }

  // Buffer FIRST in the list so a local replay is retained even if the remote send is the thing
  // that fails; `createMultiExporter` isolates them from each other regardless.
  return {
    exporter: createMultiExporter([buffer, remote]),
    buffer,
    remoteConfigured: true,
    description: `trace export: in-memory replay buffer + ${remote.id}`,
  };
}
