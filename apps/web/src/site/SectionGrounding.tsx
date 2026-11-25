import { useReveal, useRevealAttrs } from "../lib/motion";
import type { GroundingReport, GroundingState } from "../lib/siteModel";

/**
 * SECTION 02 — "No citation, no answer."
 *
 * Three states, and they are not three marketing tiles: they are the run's real `runMode`,
 * `pipeline.status` and `graph.resolution` rendered as the three things this engine can honestly
 * say. The one the CURRENT run is in gets the emphasis; the other two are shown greyed, because they
 * are real product states rather than hypotheticals — but a page that emphasised all three equally
 * would tell a reader nothing about the run in front of them.
 *
 * Before any run there is no state to be in, so all three render as descriptions with no active one.
 * That is honest: the states describe what the engine does, and nothing has happened yet.
 */

const STATES: Array<{ id: GroundingState; mark: string; label: string; description: string }> = [
  {
    id: "grounded",
    mark: "✓",
    label: "Grounded",
    description: "Resolved from the deterministic import graph. Every claim points at a file and a line range that exists.",
  },
  {
    id: "partial",
    mark: "◐",
    label: "Partial",
    description:
      "Static pass only — unresolved dynamic imports, or an AI stage that did not run. What is known is stated; what is not is named.",
  },
  {
    id: "refused",
    mark: "✕",
    label: "Refused",
    description: "A required stage failed, or the tier is at capacity. No guessing in the gap.",
  },
];

export interface SectionGroundingProps {
  /** The run's real state, or null before any run. */
  grounding: GroundingReport | null;
}

export function SectionGrounding({ grounding }: SectionGroundingProps) {
  // Two lines, two wipes: the second starts 150ms after the first, the design's typesetting beat.
  const head = useReveal<HTMLHeadingElement>();
  const aside = useRevealAttrs<HTMLParagraphElement>("up");
  const states = useReveal<HTMLDivElement>();

  return (
    <section className="section section-band" id="grounding">
      <div className="shell">
        <p className="eyebrow">02 — Grounding</p>
        <h2 className="display display-xxl" ref={head.ref}>
          <span className="hero-line" data-reveal="clip" data-revealed={head.revealed}>
            No citation,
          </span>{" "}
          <span className="hero-line" data-reveal="clip" data-revealed={head.revealed} style={{ transitionDelay: "150ms" }}>
            no answer<span className="stop">.</span>
          </span>
        </h2>
        <p className="aside aside-lead" {...aside} style={{ transitionDelay: "380ms" }}>
          If Cartograph can&rsquo;t point at a line, it says so and tells you why. That&rsquo;s the whole
          product.
        </p>

        <div className="states" ref={states.ref}>
          {STATES.map((state, index) => {
            const active = grounding?.state === state.id;
            return (
              <div
                className="state"
                key={state.id}
                data-state={state.id}
                // No run yet ⇒ nothing is dimmed: the three are descriptions, not a verdict.
                data-active={grounding === null ? "true" : active}
                // Reveal is driven by the ROW, staggered per card: the three arrive left to right,
                // so the eye reads them in the order the copy assumes rather than all at once.
                data-reveal="up"
                data-revealed={states.revealed}
                style={{ transitionDelay: `${80 + index * 100}ms` }}
              >
                <p className="state-head">
                  <span aria-hidden="true">{state.mark}</span>
                  {state.label}
                </p>
                <p className="state-body">{state.description}</p>
                {/* The design's mono cause/next lines — ONLY on the state this run is in, and only
                    from the run's real grounding report. The other two cards are descriptions of
                    states this run is not in, and a cause for them would be invented. */}
                {active ? (
                  <p className="state-trace">
                    <span className="state-active-tag">this run</span>
                    <br />
                    cause: <span className="state-trace-value">{grounding.cause}</span>
                    <br />
                    next: {grounding.next}
                  </p>
                ) : null}
                {active ? <p className="sr-only">{grounding.detail}</p> : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
