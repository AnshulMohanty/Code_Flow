// @codeflow/observability — traces, cost and replay (V3-P5 task 2).
//
// A `Tracer` interface with an in-memory RECORDER as the hermetic default, so the suite asserts
// against real recorded spans; OpenTelemetry / Langfuse / Helicone are INJECTED adapters, so this
// package depends on nothing and a deployment that wants them wires them at the composition root.
//
// Cost is MEASURED, not estimated: every figure comes from V3-P0's provider read-back, and
// `measured: false` propagates to the report rather than being smoothed away.

export type {
  AttributeValue,
  CostBreakdown,
  InteractionEdge,
  InteractionGraph,
  InteractionNode,
  ModelPricing,
  PricingTable,
  RecordedSpan,
  RecordingTracer,
  Span,
  SpanEvent,
  SpanStatus,
  TraceClock,
  TraceExporter,
  TraceReport,
  Tracer,
} from "./contracts.js";

export {
  addUsage,
  buildInteractionGraph,
  computeCost,
  createRecordingTracer,
  renderTrace,
  type RecordingTracerOptions,
} from "./tracer.js";

export {
  createVersionedBlackboard,
  renderBlackboardHistory,
  type BlackboardRead,
  type BlackboardVersion,
  type VersionedBlackboard,
  type VersionedBlackboardOptions,
  type VersionedBlackboardReport,
} from "./versionedBlackboard.js";

export {
  createHttpTraceExporter,
  createMultiExporter,
  createOtelReplayExporter,
  exportersFromEnv,
  toExportPayload,
  type HttpExporterOptions,
  type OtelSpanLike,
  type OtelTracerLike,
} from "./exporters.js";

// The DEFAULT exporter when no backend is configured: bounded, in-memory, no network. See its
// module note on why `exportersFromEnv` returning null still needs something to fall back TO.
export {
  createMemoryTraceExporter,
  type MemoryTraceExporter,
  type MemoryTraceExporterStats,
} from "./memoryExporter.js";

// A no-op tracer, for a call site that must always have one. Distinct from "no tracer configured" —
// see `exportersFromEnv` on why those two must stay distinguishable.
export { createNoopTracer } from "./noop.js";
