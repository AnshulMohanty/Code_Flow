import type { CostBreakdown, TokenUsage } from "@codeflow/shared-types";

/**
 * `@codeflow/observability` — traces, cost and replay (V3-P5 task 2).
 *
 * WHY THIS IS NOT A DIRECT OPENTELEMETRY DEPENDENCY. `@opentelemetry/api` is pure JS and small, but
 * on its own it is a NO-OP: spans go nowhere without an SDK, an exporter and a collector. Depending
 * on it here would add a dependency to every consumer while changing nothing observable, and the
 * hermetic suite would still need a recorder to assert against.
 *
 * So the shape is the one every other seam in this repo uses: a `Tracer` INTERFACE with an
 * in-memory recorder as the default, and OTel as an INJECTED adapter. `@codeflow/observability`
 * depends on nothing, the suite asserts against real recorded spans, and a deployment that wants
 * OTel passes a tracer at the composition root. The span model here is deliberately OTel-SHAPED
 * (name, parent, attributes, events, status, start/end) so the adapter is a field-for-field mapping
 * rather than a translation.
 *
 * COST IS MEASURED, NOT ESTIMATED. Every cost figure here comes from `TokenUsage` — the provider's
 * own read-back from V3-P0 — and `measured: false` propagates all the way to the report. A trace
 * that silently mixed estimates with measurements would be worse than one with gaps in it, because
 * a gap is visible.
 */

// -- Spans ----------------------------------------------------------------------------

export type SpanStatus = "unset" | "ok" | "error";

/** OTel-shaped attribute values. Deliberately narrow: an attribute holding an object is an
 *  attribute nobody can query on, and every backend flattens it badly. */
export type AttributeValue = string | number | boolean;

export interface SpanEvent {
  name: string;
  /** Milliseconds since the run started, not a wall-clock stamp — see `TraceClock`. */
  atMs: number;
  attributes?: Record<string, AttributeValue>;
}

export interface RecordedSpan {
  /** Unique within a trace. */
  id: string;
  /** Parent span id, or null for the root. */
  parentId: string | null;
  name: string;
  /**
   * What KIND of thing this span is. Not free-form: a fixed set is what makes a trace queryable
   * ("show me every agent span with tokens > 5000") instead of a pile of strings.
   */
  kind: "run" | "stage" | "agent" | "tool" | "provider" | "retrieval" | "internal";
  startMs: number;
  endMs?: number;
  durationMs?: number;
  status: SpanStatus;
  /** Present when `status === "error"`. */
  error?: string;
  attributes: Record<string, AttributeValue>;
  events: SpanEvent[];
  /** Provider usage attributed to THIS span, when it made a paid call. */
  usage?: TokenUsage;
}

export interface Span {
  readonly id: string;
  setAttribute(key: string, value: AttributeValue): void;
  setAttributes(attributes: Record<string, AttributeValue>): void;
  addEvent(name: string, attributes?: Record<string, AttributeValue>): void;
  /** Attribute provider usage to this span. Called with the provider's OWN read-back. */
  recordUsage(usage: TokenUsage): void;
  setStatus(status: SpanStatus, error?: string): void;
  /** Idempotent — ending a span twice is a bug in the caller, not a reason to corrupt the trace. */
  end(): void;
  /** Start a child span. */
  child(name: string, kind: RecordedSpan["kind"], attributes?: Record<string, AttributeValue>): Span;
}

export interface Tracer {
  readonly id: string;
  startSpan(name: string, kind: RecordedSpan["kind"], attributes?: Record<string, AttributeValue>): Span;
}

/**
 * Injectable clock. Milliseconds RELATIVE to tracer creation rather than absolute, for two reasons:
 * a trace is read as "what happened when, relative to the start", and relative times make a
 * recorded trace comparable across runs and assertable in a test without freezing the wall clock.
 */
export type TraceClock = () => number;

// -- Cost ------------------------------------------------------------------------------

/**
 * Price per million tokens, per model. Injected rather than hardcoded: prices change, they differ
 * per account, and a stale table baked into a build would report confident wrong money. An unpriced
 * model is reported as unpriced — never as zero, which would read as free.
 */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Optional, usually cheaper. Falls back to `inputPerMillion` when absent. */
  cacheReadPerMillion?: number;
}

export type PricingTable = Record<string, ModelPricing>;

/**
 * Re-exported from shared-types rather than declared here: the ANALYSIS RESULT carries a cost too,
 * and two structurally identical cost types is how a `measured` flag ends up honoured on one and
 * dropped on the other. Computation still lives in this package (`computeCost`); only the shape is
 * shared.
 */
export type { CostBreakdown } from "@codeflow/shared-types";

// -- The interaction graph -------------------------------------------------------------

/**
 * WHO CALLED WHOM (V3-P5 task 2). Derived from the span tree rather than recorded separately, so it
 * cannot drift from the trace — a second hand-maintained structure would be a second thing to get
 * wrong.
 *
 * This is what makes a fan-out debuggable: 5N specialist spans in a flat list is unreadable, whereas
 * "supervisor ← 5 specialists × 12 communities, 3 of which refused" is a shape a human can hold.
 */
export interface InteractionEdge {
  from: string;
  to: string;
  /** How many times this call happened. */
  count: number;
  totalDurationMs: number;
  /** Summed usage across those calls. */
  usage: TokenUsage;
}

export interface InteractionNode {
  name: string;
  kind: RecordedSpan["kind"];
  calls: number;
  totalDurationMs: number;
  usage: TokenUsage;
  errors: number;
}

export interface InteractionGraph {
  nodes: InteractionNode[];
  edges: InteractionEdge[];
}

// -- The full trace --------------------------------------------------------------------

export interface TraceReport {
  traceId: string;
  /** Every span, in START order — so a reader follows the run rather than the tree. */
  spans: RecordedSpan[];
  /** Total wall-clock of the root span. */
  durationMs: number;
  cost: CostBreakdown;
  /** Cost per span kind, so "where did the money go" is answerable without arithmetic. */
  costByKind: Partial<Record<RecordedSpan["kind"], CostBreakdown>>;
  interactions: InteractionGraph;
  /** Spans that ended with an error. */
  errors: Array<{ span: string; error: string }>;
  /** True when every span has been ended. A false here means the trace is incomplete and any
   *  duration read from it is a lower bound. */
  complete: boolean;
}

/** A tracer that can produce a report. The in-memory recorder; an OTel adapter cannot, which is
 *  why the interfaces are separate. */
export interface RecordingTracer extends Tracer {
  report(): TraceReport;
  reset(): void;
}

// -- Optional exporters ----------------------------------------------------------------

/**
 * Where a finished trace can be sent. Langfuse/Helicone/OTel all fit this shape.
 *
 * OFF BY DEFAULT and never a hard dependency: an exporter that ran in tests would make the suite
 * depend on a network, and an exporter that threw would take down the run it was observing. So
 * `export` is fire-and-forget from the caller's point of view and MUST NOT throw.
 */
export interface TraceExporter {
  readonly id: string;
  export(report: TraceReport): Promise<void>;
}
