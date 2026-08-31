import { describe, expect, it } from "vitest";
import { createMemoryTraceExporter } from "../memoryExporter.js";
import { createRecordingTracer } from "../tracer.js";
import type { TraceReport } from "../contracts.js";

function traceWith(traceId: string, usage?: { inputTokens: number; outputTokens: number; measured: boolean }): TraceReport {
  let t = 0;
  const tracer = createRecordingTracer({
    traceId,
    clock: () => (t += 5),
    pricing: { "test-model": { inputPerMillion: 1, outputPerMillion: 2 } },
  });
  const run = tracer.startSpan("run", "run");
  const provider = run.child("provider:complete", "provider", { model: "test-model" });
  if (usage) provider.recordUsage(usage);
  provider.end();
  run.end();
  return tracer.report();
}

describe("createMemoryTraceExporter — the network-free default", () => {
  it("never throws and reports nothing before the first export", async () => {
    const exporter = createMemoryTraceExporter();
    expect(exporter.id).toBe("memory-replay");
    expect(exporter.stats()).toEqual({ exported: 0, droppedReports: 0, retained: 0, last: null });
    expect(exporter.reports()).toEqual([]);
  });

  it("retains reports oldest-first, so a replay reads the session in order", async () => {
    const exporter = createMemoryTraceExporter();
    await exporter.export(traceWith("a"));
    await exporter.export(traceWith("b"));
    expect(exporter.reports().map((report) => report.traceId)).toEqual(["a", "b"]);
    expect(exporter.stats().last?.traceId).toBe("b");
  });

  it("DROPS oldest-first past the bound and COUNTS the drop — the leak this cannot become", async () => {
    const exporter = createMemoryTraceExporter({ maxReports: 2 });
    for (const id of ["a", "b", "c", "d"]) await exporter.export(traceWith(id));
    expect(exporter.reports().map((report) => report.traceId)).toEqual(["c", "d"]);
    expect(exporter.stats()).toMatchObject({ exported: 4, retained: 2, droppedReports: 2 });
  });

  it("clamps a nonsense bound to 1 rather than retaining nothing or everything", async () => {
    const exporter = createMemoryTraceExporter({ maxReports: 0 });
    await exporter.export(traceWith("a"));
    await exporter.export(traceWith("b"));
    expect(exporter.reports().map((report) => report.traceId)).toEqual(["b"]);
  });

  it("carries the cost breakdown through, `measured` flag included", async () => {
    const exporter = createMemoryTraceExporter();
    await exporter.export(traceWith("paid", { inputTokens: 1_000_000, outputTokens: 0, measured: true }));
    const last = exporter.stats().last;
    expect(last?.cost.usd).toBeCloseTo(1, 6);
    expect(last?.cost.measured).toBe(true);
  });

  it("propagates measured:false rather than smoothing an estimate into a measurement", async () => {
    const exporter = createMemoryTraceExporter();
    await exporter.export(traceWith("est", { inputTokens: 1000, outputTokens: 10, measured: false }));
    expect(exporter.stats().last?.cost.measured).toBe(false);
  });

  it("reset() forgets the counters too, so a suite cannot leak state between cases", async () => {
    const exporter = createMemoryTraceExporter();
    await exporter.export(traceWith("a"));
    exporter.reset();
    expect(exporter.stats()).toEqual({ exported: 0, droppedReports: 0, retained: 0, last: null });
  });
});
