import type { AttributeValue, RecordedSpan, TraceExporter, TraceReport } from "./contracts.js";

/**
 * OPTIONAL trace exporters (V3-P5 task 2). Off in tests, never a hard dependency.
 *
 * THE ONE RULE EVERY EXPORTER HERE OBEYS: **it must not throw, and it must not block the run.** An
 * observability layer that can fail the thing it observes is worse than no observability, and it
 * fails in exactly the situation you most need the trace. So every `export` catches everything and
 * reports through `onError`.
 *
 * NO SDK IS IMPORTED. Langfuse, Helicone and OTel all reach the same shape — a POST of a structured
 * payload, or a span-per-span push into a provider — so what is here is a `fetch`-based exporter
 * (the pattern the LLM adapters already use, with no SDK) and an OTel BRIDGE that takes an INJECTED
 * tracer-provider. That keeps this package at zero dependencies and puts the one-line install in
 * GO_LIVE.md rather than in every consumer's node_modules.
 */

export interface HttpExporterOptions {
  /** Where to POST. */
  endpoint: string;
  /** Auth header value, e.g. `Bearer ...` or a Basic credential. Read from env by the caller. */
  authorization?: string;
  /** Extra headers (Helicone wants a couple). */
  headers?: Record<string, string>;
  /** Injectable, so the suite can assert the payload without a network. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  onError?(error: unknown): void;
  /** Milliseconds before giving up. An exporter that hangs holds a worker's shutdown open. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;

/**
 * A generic JSON exporter — the shape Langfuse and Helicone both accept for a batch ingest.
 *
 * `id` names the endpoint host rather than "http", so a trace's provenance is readable in a log.
 */
export function createHttpTraceExporter(options: HttpExporterOptions): TraceExporter {
  const host = safeHost(options.endpoint);
  return {
    id: `http:${host}`,
    async export(report: TraceReport): Promise<void> {
      const doFetch = options.fetchImpl ?? globalThis.fetch;
      if (typeof doFetch !== "function") {
        options.onError?.(new Error("no fetch implementation available"));
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const response = await doFetch(options.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.authorization ? { authorization: options.authorization } : {}),
            ...options.headers,
          },
          body: JSON.stringify(toExportPayload(report)),
          signal: controller.signal,
        });
        if (!response.ok) options.onError?.(new Error(`trace export failed: HTTP ${response.status}`));
      } catch (error) {
        // Swallowed by design — see the module note. A failed export must never fail the run.
        options.onError?.(error);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The wire payload. Flat and self-describing, because a backend's ingest is not a place to be clever
 * and a trace nobody can read in raw form is a trace nobody can debug.
 */
export function toExportPayload(report: TraceReport): Record<string, unknown> {
  return {
    traceId: report.traceId,
    durationMs: report.durationMs,
    complete: report.complete,
    cost: report.cost,
    costByKind: report.costByKind,
    spans: report.spans.map((span) => ({
      id: span.id,
      parentId: span.parentId,
      name: span.name,
      kind: span.kind,
      startMs: span.startMs,
      durationMs: span.durationMs,
      status: span.status,
      ...(span.error ? { error: span.error } : {}),
      attributes: span.attributes,
      ...(span.events.length ? { events: span.events } : {}),
      ...(span.usage ? { usage: span.usage } : {}),
    })),
    interactions: report.interactions,
    errors: report.errors,
  };
}

/**
 * The minimum an OTel tracer-provider must expose for the bridge. Structurally satisfied by
 * `@opentelemetry/api`'s `Tracer` as it already is — so a consumer passes
 * `trace.getTracer("codeflow")` and this package still depends on nothing.
 */
export interface OtelTracerLike {
  startSpan(
    name: string,
    options?: { startTime?: number; attributes?: Record<string, AttributeValue>; root?: boolean },
  ): OtelSpanLike;
}

export interface OtelSpanLike {
  setAttribute(key: string, value: AttributeValue): unknown;
  addEvent(name: string, attributes?: Record<string, AttributeValue>): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  end(endTime?: number): void;
}

/** OTel's `SpanStatusCode`. Inlined rather than imported, so no dependency is needed for two ints. */
const OTEL_STATUS = { UNSET: 0, OK: 1, ERROR: 2 } as const;

/**
 * Replay a finished trace into an injected OTel tracer.
 *
 * REPLAY RATHER THAN LIVE INSTRUMENTATION, deliberately. Instrumenting live would mean every call
 * site holding an OTel span and this package depending on the API — and it would export a partial
 * trace whenever a run failed midway. Replaying a COMPLETE recorded trace at the end keeps the hot
 * path dependency-free and guarantees the exported trace is the same one the tests assert on.
 *
 * The honest cost: OTel sees the run only after it finishes, so a live dashboard lags by one run. For
 * a batch pipeline whose runs are seconds-to-minutes, that is the right trade; for a streaming
 * service it would not be.
 */
export function createOtelReplayExporter(options: {
  tracer: OtelTracerLike;
  /** Absolute epoch ms the trace's relative times are measured from. */
  epochMs?: number;
  onError?(error: unknown): void;
}): TraceExporter {
  return {
    id: "otel-replay",
    async export(report: TraceReport): Promise<void> {
      const epoch = options.epochMs ?? Date.now() - report.durationMs;
      try {
        // Parent-before-child order, which the start-order sort already gives us: a child span
        // replayed before its parent exists would be reparented to nothing by most backends.
        for (const span of report.spans) {
          const otelSpan = options.tracer.startSpan(span.name, {
            startTime: epoch + span.startMs,
            attributes: {
              ...span.attributes,
              "codeflow.kind": span.kind,
              "codeflow.span_id": span.id,
              ...(span.parentId ? { "codeflow.parent_id": span.parentId } : {}),
              ...usageAttributes(span),
            },
            ...(span.parentId ? {} : { root: true }),
          });
          for (const event of span.events) otelSpan.addEvent(event.name, event.attributes);
          otelSpan.setStatus({
            code: span.status === "error" ? OTEL_STATUS.ERROR : span.status === "ok" ? OTEL_STATUS.OK : OTEL_STATUS.UNSET,
            ...(span.error ? { message: span.error } : {}),
          });
          otelSpan.end(epoch + (span.endMs ?? span.startMs));
        }
      } catch (error) {
        options.onError?.(error);
      }
    },
  };
}

/** Usage as flat OTel attributes. `measured` travels with them — a cost attribute that dropped the
 *  honesty flag would let an estimate be queried as though it were measured. */
function usageAttributes(span: RecordedSpan): Record<string, AttributeValue> {
  if (!span.usage) return {};
  return {
    "codeflow.tokens.input": span.usage.inputTokens,
    "codeflow.tokens.output": span.usage.outputTokens,
    ...(span.usage.cacheReadTokens !== undefined ? { "codeflow.tokens.cache_read": span.usage.cacheReadTokens } : {}),
    "codeflow.tokens.measured": span.usage.measured,
  };
}

/**
 * Fan a report out to several exporters. Never throws, never lets one failure stop another — an
 * exporter that took its siblings down with it would make adding a second one a liability.
 */
export function createMultiExporter(exporters: readonly TraceExporter[]): TraceExporter {
  return {
    id: `multi:${exporters.map((exporter) => exporter.id).join("+") || "none"}`,
    async export(report: TraceReport): Promise<void> {
      await Promise.all(
        exporters.map(async (exporter) => {
          try {
            await exporter.export(report);
          } catch {
            /* each exporter already handles its own errors; this is the belt to that braces */
          }
        }),
      );
    },
  };
}

/**
 * Build exporters from env, honestly.
 *
 * Returns null when nothing is configured — and null is the DEFAULT, which is what "off in tests"
 * means in practice: the suite sets no env, so no exporter exists and no code path can reach a
 * network. A no-op exporter object would have been the other option and is worse, because then
 * "observability is on" and "observability is configured" stop being distinguishable.
 */
export function exportersFromEnv(
  env: Record<string, string | undefined>,
  options: { fetchImpl?: typeof fetch; onError?(error: unknown): void } = {},
): TraceExporter | null {
  const exporters: TraceExporter[] = [];

  if (env.LANGFUSE_HOST && env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) {
    exporters.push(
      createHttpTraceExporter({
        endpoint: `${env.LANGFUSE_HOST.replace(/\/$/, "")}/api/public/ingestion`,
        // Basic auth, which is what Langfuse's public ingest expects.
        authorization: `Basic ${base64(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`)}`,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.onError ? { onError: options.onError } : {}),
      }),
    );
  }

  if (env.HELICONE_API_KEY) {
    exporters.push(
      createHttpTraceExporter({
        endpoint: env.HELICONE_ENDPOINT || "https://api.helicone.ai/custom/v1/log",
        authorization: `Bearer ${env.HELICONE_API_KEY}`,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.onError ? { onError: options.onError } : {}),
      }),
    );
  }

  return exporters.length === 0 ? null : exporters.length === 1 ? exporters[0] : createMultiExporter(exporters);
}

function base64(value: string): string {
  // `Buffer` in Node, `btoa` in a browser — this package is imported by both the worker and (via
  // the shared packages) potentially a browser build, so neither is assumed.
  const globalBuffer = (globalThis as { Buffer?: { from(input: string, enc: string): { toString(enc: string): string } } }).Buffer;
  if (globalBuffer) return globalBuffer.from(value, "utf8").toString("base64");
  return btoa(value);
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
