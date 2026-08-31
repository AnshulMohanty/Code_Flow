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
  return (
    <section className="section" id="grounding">
      <div className="shell">
        <p className="eyebrow" style={{ marginBottom: 20 }}>
          02 — Grounding
        </p>
        <div className="section-head">
          <h2 className="display display-l">
            No citation,
            <br />
            no answer<span className="dot" aria-hidden="true" />
          </h2>
          <p className="aside">
            If Cartograph can&rsquo;t point at a line, it says so and tells you why. That&rsquo;s the whole
            product.
          </p>
        </div>
      </div>

      <div className="shell">
        <div className="states">
          {STATES.map((state) => {
            const active = grounding?.state === state.id;
            return (
              <div
                className="state"
                key={state.id}
                data-state={state.id}
                // No run yet ⇒ nothing is dimmed: the three are descriptions, not a verdict.
                data-active={grounding === null ? "true" : active}
              >
                <p className="state-head">
                  <span aria-hidden="true">{state.mark}</span>
                  {state.label}
                </p>
                <p className="state-body">{state.description}</p>
                {active ? (
                  <span className="state-active-tag">
                    this run · {grounding.detail}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
