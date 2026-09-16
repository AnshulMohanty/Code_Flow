import { useCountUp, useReveal, useRevealAttrs } from "../lib/motion";
import { formatStat, NOT_MEASURED, type MeasuredStat, type RunNumbers } from "../lib/siteModel";

/**
 * SECTION 03 — "Measured, not marketed."
 *
 * Four stats in very large type, which is precisely where a plausible guess does the most damage. So
 * each one is either read from something the pipeline produced or rendered as an em-dash WITH THE
 * REASON underneath. A grey dash on its own is honest but useless; "no paid provider call on this
 * run" tells a reader what to do about it.
 *
 * The design's own aside says it: "the numbers move because they're read, not written." A build with
 * no analysis loaded shows four em-dashes, and that is the correct screenshot.
 *
 * THE FIGURES COUNT UP when the section is scrolled to, and ONLY the measured ones. `useCountUp`
 * takes `number | null` and returns `null` unchanged, so an em-dash never animates - a stat that
 * ticked from 0 up to something would read as a measurement no matter what the caption said.
 */

export interface SectionNumbersProps {
  numbers: RunNumbers | null;
  /** For the aside — which repository and commit these numbers are from. */
  provenance: string | null;
}

const EMPTY: RunNumbers = {
  filesParsed: { label: "FILES PARSED", value: null, format: "count", absentReason: "no analysis has been run yet" },
  edgesResolved: { label: "EDGES RESOLVED", value: null, format: "count", absentReason: "no analysis has been run yet" },
  p50AnswerMs: { label: "P50 ANSWER LATENCY", value: null, format: "ms", absentReason: "nobody has asked a question yet" },
  costPerIndex: { label: "COST PER FULL INDEX", value: null, format: "usd", absentReason: "no analysis has been run yet" },
};

export function SectionNumbers({ numbers, provenance }: SectionNumbersProps) {
  const stats = numbers ?? EMPTY;
  const head = useRevealAttrs<HTMLDivElement>("clip");
  const grid = useReveal<HTMLDivElement>();

  return (
    <section className="section" id="numbers">
      <div className="shell">
        <p className="eyebrow" style={{ marginBottom: 20 }}>
          03 — Numbers
        </p>
        <div className="section-head" {...head}>
          <h2 className="display display-l">
            Measured,
            <br />
            not marketed<span className="dot" aria-hidden="true" />
          </h2>
          <p className="aside">
            {provenance
              ? `Last full run on ${provenance}. The numbers move because they're read, not written.`
              : "Nothing has been analysed yet, so there is nothing to report. The numbers appear when they are measured — not before."}
          </p>
        </div>

        <div className="stats" ref={grid.ref}>
          <Stat stat={stats.filesParsed} counting={grid.revealed} order={0} />
          <Stat stat={stats.edgesResolved} counting={grid.revealed} order={1} />
          <Stat stat={stats.p50AnswerMs} unit="ms" counting={grid.revealed} order={2} />
          <Stat stat={stats.costPerIndex} counting={grid.revealed} order={3} />
        </div>
      </div>
    </section>
  );
}

function Stat({
  stat,
  unit,
  counting,
  order,
}: {
  stat: MeasuredStat;
  unit?: string;
  counting: boolean;
  order: number;
}) {
  const measured = stat.value !== null;
  // The count runs on the stat's own value and is then formatted by the SAME formatter as the
  // final figure, so the intermediate frames use the same units, precision and thousands rule the
  // settled number does. Formatting the animation separately is how a stat ends up counting up in
  // one format and landing in another.
  const counted = useCountUp(stat.value, { active: counting });
  // Counts and milliseconds are whole numbers at every frame; only a dollar figure keeps its
  // decimals. `count()` is `toLocaleString`, so an un-rounded frame renders "12,480.317".
  const shown =
    counted === null
      ? stat
      : { ...stat, value: stat.format === "usd" ? counted : Math.round(counted) };
  return (
    <div
      className="stat"
      data-measured={measured}
      data-reveal="up"
      data-revealed={counting}
      style={{ transitionDelay: `${order * 80}ms` }}
    >
      <p className="stat-value">
        {formatStat(shown)}
        {measured && unit ? <span className="stat-unit">{unit}</span> : null}
      </p>
      <p className="stat-label">{stat.label}</p>
      {/* The reason a figure is absent, or the honesty flag on a cost that IS present. Both matter:
          an estimated dollar amount presented as measured is the same failure as a fabricated one. */}
      {!measured && stat.absentReason ? (
        <p className="stat-note">
          {NOT_MEASURED} {stat.absentReason}
        </p>
      ) : stat.measured === false ? (
        <p className="stat-note">estimated — a provider reported no usage counter</p>
      ) : null}
    </div>
  );
}
