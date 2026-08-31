import type { CostBreakdown, TraceExporter, TraceReport } from "./contracts.js";

/**
 * THE DEFAULT EXPORTER: a bounded in-memory replay buffer (V3-P5 task 2, wired V3-FINAL).
 *
 * WHY THIS EXISTS AT ALL, given `exportersFromEnv` deliberately returns null when nothing is
 * configured. Null is the right answer to "is a BACKEND configured?" — it keeps "observability is
 * on" distinguishable from "observability is configured", which is the reason that function refuses
 * to hand back a no-op object. But a composition root still has to decide what `traceExporter`
 * is when the answer is null, and leaving it `undefined` is how V3-P5 shipped: a recording tracer
 * ran on every job, produced a full report, and then the report reached NOTHING except two header
 * lines on stdout. The trace was real and unreachable.
 *
 * So the default is this: an exporter that sends nowhere (no network, no key, no dependency) and
 * KEEPS the last few reports, plus counters. That makes three separate claims checkable from
 * outside the process — a trace was produced, it was exported, and here is what it cost — which is
 * what the versioned blackboard does for the fan-out and this does for the run.
 *
 * BOUNDED, and this is the load-bearing constraint. A worker is long-lived and a trace report holds
 * every span of a run, so an unbounded buffer is a memory leak that grows with throughput — the
 * exact failure mode an observability layer must not introduce into the thing it observes. Oldest
 * reports are dropped first and the drop is COUNTED (`droppedReports`), so a replay that cannot
 * reach far enough back says so instead of looking complete.
 *
 * The counters are cumulative and survive the ring: `exported` counts every report ever handed
 * over, not the number retained.
 */

export interface MemoryTraceExporterStats {
  /** Every report ever exported through this instance, including ones since dropped from the ring. */
  exported: number;
  /** Reports evicted to stay within `maxReports`. > 0 means replay cannot reach the whole session. */
  droppedReports: number;
  /** Reports currently retained and replayable. */
  retained: number;
  /** The most recent report's identity + headline facts, or null before the first export. */
  last: {
    traceId: string;
    durationMs: number;
    spans: number;
    complete: boolean;
    errors: number;
    cost: CostBreakdown;
  } | null;
}

export interface MemoryTraceExporter extends TraceExporter {
  /** Retained reports, oldest first. The replay surface. */
  reports(): TraceReport[];
  stats(): MemoryTraceExporterStats;
  /** Test seam: forget everything, counters included. */
  reset(): void;
}

/** Small on purpose: this is a replay window for the runs still in living memory, not storage. */
const DEFAULT_MAX_REPORTS = 5;

export function createMemoryTraceExporter(options: { maxReports?: number } = {}): MemoryTraceExporter {
  const maxReports = Math.max(1, options.maxReports ?? DEFAULT_MAX_REPORTS);
  let retained: TraceReport[] = [];
  let exported = 0;
  let droppedReports = 0;

  return {
    id: "memory-replay",

    async export(report: TraceReport): Promise<void> {
      // No try/catch around a push, and no `structuredClone` either: a `TraceReport` is produced by
      // `RecordingTracer.report()`, which already builds a fresh object per call, so there is no
      // live reference for a later writer to mutate. Cloning here would double the memory of the
      // one thing in this file that has to stay bounded.
      exported += 1;
      retained.push(report);
      if (retained.length > maxReports) {
        droppedReports += retained.length - maxReports;
        retained = retained.slice(retained.length - maxReports);
      }
    },

    reports: () => [...retained],

    stats(): MemoryTraceExporterStats {
      const last = retained.at(-1) ?? null;
      return {
        exported,
        droppedReports,
        retained: retained.length,
        last: last
          ? {
              traceId: last.traceId,
              durationMs: last.durationMs,
              spans: last.spans.length,
              complete: last.complete,
              errors: last.errors.length,
              cost: last.cost,
            }
          : null,
      };
    },

    reset() {
      retained = [];
      exported = 0;
      droppedReports = 0;
    },
  };
}
