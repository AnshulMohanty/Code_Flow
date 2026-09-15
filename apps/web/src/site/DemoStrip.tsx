import { DEMO_REPOS, demoFullName, type DemoRepo } from "../lib/demoRepos";

/**
 * THE CURATED DEMO STRIP — four repositories that are already in the analysis cache.
 *
 * WHY IT IS HERE. A first-time visitor arrives at a static page and a backend that may be asleep for
 * another thirty seconds. "Paste a URL and wait" is where people leave. These four have been
 * pre-warmed (scripts/prewarm-demos.mjs), so clicking one is a cache hit rather than a clone, a
 * parse and two provider stages.
 *
 * THEY STAY CLICKABLE WHILE THE BACKEND IS WAKING, which is the whole reason the strip exists and
 * the one way it differs from the analyze field beside it. A cached result needs the API but not the
 * queue and not a provider, so it is the thing that works soonest — and offering it is what turns
 * "come back in a minute" into "here, look at this meanwhile".
 *
 * THE COPY UNDER EACH ONE IS A FACT ABOUT THE REPOSITORY, not a sales line. These are real projects
 * a reader may know, and telling them "one file, heavily commented" says something checkable;
 * telling them "blazing fast insights" does not.
 */

export interface DemoStripProps {
  onAnalyze(input: { owner: string; repo: string }): void;
  /** Which one is currently on screen, if any — so the strip shows the selection. */
  activeFullName?: string | null;
  /** Rendered above the buttons. The caller decides the framing. */
  caption?: string;
}

export function DemoStrip({ onAnalyze, activeFullName, caption }: DemoStripProps) {
  return (
    <div className="demo-strip">
      <p className="eyebrow demo-strip-caption">{caption ?? "Already indexed — open one instantly"}</p>
      <div className="demo-strip-items">
        {DEMO_REPOS.map((demo) => (
          <DemoButton
            key={demoFullName(demo)}
            demo={demo}
            active={activeFullName === demoFullName(demo)}
            onSelect={() => onAnalyze({ owner: demo.owner, repo: demo.repo })}
          />
        ))}
      </div>
    </div>
  );
}

function DemoButton({ demo, active, onSelect }: { demo: DemoRepo; active: boolean; onSelect(): void }) {
  return (
    <button type="button" className="demo-item" onClick={onSelect} aria-current={active} data-language={demo.language}>
      <span className="demo-item-label">{demo.label}</span>
      <span className="demo-item-note">{demo.note}</span>
      <span className="demo-item-lang">{demo.language}</span>
    </button>
  );
}
