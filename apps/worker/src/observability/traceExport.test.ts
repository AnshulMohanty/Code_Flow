import { describe, expect, it, vi } from "vitest";
import { createRecordingTracer } from "@codeflow/observability";
import { resolveTraceExport } from "./traceExport.js";
import { handleHealthRequest, type WorkerHealthState } from "../health/healthServer.js";

/**
 * These tests exist because V3-P5 shipped a recording tracer with NO exporter on the live path. So
 * the thing under test is not "does an exporter work" (that is `@codeflow/observability`'s suite) —
 * it is "is one actually resolved, handed over, and visible from outside the process".
 *
 * HERMETIC: no env is read from the real process, `fetch` is injected everywhere a remote backend is
 * exercised, and the default path touches no network at all.
 */

function reportFrom(): ReturnType<ReturnType<typeof createRecordingTracer>["report"]> {
  let t = 0;
  const tracer = createRecordingTracer({ traceId: "trace-x", clock: () => (t += 10) });
  const run = tracer.startSpan("run", "run");
  const stage = run.child("stage:connect", "stage");
  stage.end();
  run.end();
  return tracer.report();
}

describe("resolveTraceExport — the default", () => {
  it("ALWAYS returns an exporter, so a composition root can never leave it undefined", () => {
    const resolved = resolveTraceExport({});
    expect(resolved.exporter).toBeDefined();
    expect(resolved.exporter.id).toBe("memory-replay");
  });

  it("configures NO remote backend from empty env — the network send stays deferred", () => {
    const resolved = resolveTraceExport({});
    expect(resolved.remoteConfigured).toBe(false);
    expect(resolved.description).toContain("no LANGFUSE_*/HELICONE_API_KEY configured");
  });

  it("does not reach a network on the default path", async () => {
    const fetchImpl = vi.fn();
    const resolved = resolveTraceExport({}, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await resolved.exporter.export(reportFrom());
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolved.buffer.stats().exported).toBe(1);
  });

  it("retains the report for replay and reports the cost honestly", async () => {
    const resolved = resolveTraceExport({});
    await resolved.exporter.export(reportFrom());
    const stats = resolved.buffer.stats();
    expect(stats.retained).toBe(1);
    expect(stats.last?.traceId).toBe("trace-x");
    expect(stats.last?.spans).toBe(2);
    // No paid span ⇒ no usage ⇒ `measured` stays true and the total is 0, not a guess.
    expect(stats.last?.cost.measured).toBe(true);
  });

  it("BOUNDS the buffer and counts what it dropped, so replay never looks complete when it is not", async () => {
    const resolved = resolveTraceExport({}, { maxReports: 2 });
    for (let i = 0; i < 5; i++) await resolved.exporter.export(reportFrom());
    const stats = resolved.buffer.stats();
    expect(stats.retained).toBe(2);
    expect(stats.exported).toBe(5); // cumulative, survives the ring
    expect(stats.droppedReports).toBe(3);
  });
});

describe("resolveTraceExport — a configured remote backend", () => {
  it("fans out to Langfuse ALONGSIDE the buffer, so a remote failure costs neither", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const resolved = resolveTraceExport(
      {
        LANGFUSE_HOST: "https://cloud.langfuse.example/",
        LANGFUSE_PUBLIC_KEY: "pk",
        LANGFUSE_SECRET_KEY: "sk",
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(resolved.remoteConfigured).toBe(true);
    await resolved.exporter.export(reportFrom());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloud.langfuse.example/api/public/ingestion");
    expect((init.headers as Record<string, string>).authorization).toMatch(/^Basic /);
    expect(JSON.parse(init.body as string).traceId).toBe("trace-x");
    // The local buffer got it too.
    expect(resolved.buffer.stats().exported).toBe(1);
  });

  it("swallows a remote failure — an exporter must never fail the run it observes", async () => {
    const errors: unknown[] = [];
    const resolved = resolveTraceExport(
      { HELICONE_API_KEY: "hk" },
      {
        fetchImpl: (async () => {
          throw new Error("network down");
        }) as unknown as typeof fetch,
        onError: (error) => errors.push(error),
      },
    );
    await expect(resolved.exporter.export(reportFrom())).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    // And the local replay still happened, which is the point of putting the buffer first.
    expect(resolved.buffer.stats().exported).toBe(1);
  });
});

describe("/metrics surfaces the export counters", () => {
  function stateWith(resolved: ReturnType<typeof resolveTraceExport>): WorkerHealthState {
    return {
      warmup: () => ({ warmedUp: true, warming: false, tasks: [] }),
      queueDepth: async () => 0,
      activeJobs: () => 0,
      consumerRunning: () => true,
      traceExport: () => ({
        remoteConfigured: resolved.remoteConfigured,
        exporterId: resolved.exporter.id,
        stats: resolved.buffer.stats(),
      }),
    };
  }

  it("reports 0 exported before any run, and the count after one", async () => {
    const resolved = resolveTraceExport({});
    const before = JSON.parse((await handleHealthRequest("/metrics", stateWith(resolved))).body);
    expect(before.traceExport.exported).toBe(0);
    expect(before.traceExport.last).toBeNull();
    expect(before.traceExport.remoteConfigured).toBe(false);

    await resolved.exporter.export(reportFrom());
    const after = JSON.parse((await handleHealthRequest("/metrics", stateWith(resolved))).body);
    expect(after.traceExport.exported).toBe(1);
    expect(after.traceExport.last.traceId).toBe("trace-x");
    expect(after.traceExport.last.complete).toBe(true);
  });

  it("omits the block entirely when a wiring supplies no exporter — never a fake zero", async () => {
    const body = JSON.parse(
      (
        await handleHealthRequest("/metrics", {
          warmup: () => ({ warmedUp: true, warming: false, tasks: [] }),
          queueDepth: async () => 0,
          activeJobs: () => 0,
          consumerRunning: () => true,
        })
      ).body,
    );
    expect(body.traceExport).toBeUndefined();
  });
});
