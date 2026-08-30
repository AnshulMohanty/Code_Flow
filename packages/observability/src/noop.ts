import type { AttributeValue, RecordedSpan, Span, Tracer } from "./contracts.js";

/**
 * A tracer that records nothing.
 *
 * For a call site that must always hold a `Tracer` and should not branch on its absence — threading
 * `tracer?: Tracer` through a deep call chain means every level re-implements the same optional
 * check, and one of them eventually gets it wrong.
 *
 * Deliberately NOT the default for a run: a no-op tracer and an unconfigured exporter are different
 * conditions, and collapsing them would make "observability is on" indistinguishable from
 * "observability is configured". A run uses the RECORDING tracer and decides separately whether to
 * export it.
 */
export function createNoopTracer(): Tracer {
  const span: Span = {
    id: "noop",
    setAttribute() {},
    setAttributes() {},
    addEvent() {},
    recordUsage() {},
    setStatus() {},
    end() {},
    child(): Span {
      return span;
    },
  };
  return {
    id: "noop-tracer",
    startSpan(_name: string, _kind: RecordedSpan["kind"], _attributes?: Record<string, AttributeValue>): Span {
      return span;
    },
  };
}
