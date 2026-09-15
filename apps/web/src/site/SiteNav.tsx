import { NOT_MEASURED } from "../lib/siteModel";
import { useUtcClock, type MetaState } from "../lib/useMeta";
import type { WakeState } from "../lib/useWake";

/**
 * THE MARKETING NAV.
 *
 * `CodeFlow ⌗ ENGINE CARTOGRAPH` · 01 Resolve · 02 Grounding · 03 Numbers · status pill · ⌘K ·
 * Open workbench.
 *
 * THE STATUS PILL IS THE ONE THING HERE THAT COULD LIE, so it is the one thing built carefully. The
 * version is the analyzer version the SERVER reported, never a constant compiled into this bundle —
 * those two disagree the moment a deployment is mid-rollout, and the server's answer is the one that
 * matters.
 *
 * WHAT THE PILL NOW REPORTS, and why it changed. It used to read `meta.status`, which answers "did
 * /api/meta return". On a free tier where the backend sleeps, the honest answer for the first thirty
 * seconds of a visit is neither "connecting" nor "offline" — it is "the service is asleep and we are
 * waking it", and those are different in the one way a visitor cares about: the second is worth
 * waiting for. So the pill reads the WAKE state (`useWake`, a real `GET /health`) and the meta fetch
 * only supplies the version.
 *
 *   waking   "WARMING" — a wake request is in flight. Not a lie and not a dead end.
 *   ready    "READY", green. /health answered; the backend is reachable.
 *   offline  "OFFLINE", grey. Every wake attempt failed. On a free tier this usually means the
 *            monthly instance-hour cap was reached, which no amount of waiting fixes.
 *
 * There is deliberately no fourth "connecting" state. A frozen spinner that never resolves is the
 * failure mode this replaces, and three states that each state a fact leave nowhere for one to hide.
 */

export interface SiteNavProps {
  meta: MetaState;
  /** The real `GET /health` result. What the pill reports — see the module note. */
  wake: WakeState;
  activeSection: string | null;
  onNavigate(section: string): void;
  onOpenPalette(): void;
  onOpenWorkbench(): void;
}

const SECTIONS = [
  { id: "resolve", num: "01", label: "Resolve" },
  { id: "grounding", num: "02", label: "Grounding" },
  { id: "numbers", num: "03", label: "Numbers" },
] as const;

export function SiteNav({ meta, wake, activeSection, onNavigate, onOpenPalette, onOpenWorkbench }: SiteNavProps) {
  const clock = useUtcClock(meta.facts?.serverTime ?? null);
  // Green means REACHED, not "meta parsed". A deployment can answer /health while /api/meta is still
  // failing, and the useful fact for a visitor is the first one.
  const live = wake.status === "ready";

  return (
    <nav className="nav" aria-label="Primary">
      <button type="button" className="nav-brand" onClick={() => onNavigate("top")}>
        <span className="nav-brand-mark" aria-hidden="true">
          ⌗
        </span>
        CodeFlow
        <span className="nav-brand-sub">engine Cartograph</span>
      </button>

      <div className="nav-links">
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className="nav-link"
            aria-current={activeSection === section.id}
            onClick={() => onNavigate(section.id)}
          >
            <span className="nav-link-num">{section.num}</span>
            {section.label}
          </button>
        ))}
      </div>

      <div className="nav-right">
        <span
          className="pill"
          data-live={live}
          data-wake={wake.status}
          title={
            wake.status === "waking"
              ? "The analysis backend sleeps when idle. Waking it — this takes about 30-50 seconds."
              : wake.status === "offline"
                ? "The analysis backend did not answer. Cached demo repositories still work."
                : (meta.status === "error" ? meta.error : undefined)
          }
        >
          <span className="pill-dot" aria-hidden="true" />
          {wake.status === "waking" ? "WARMING" : wake.status === "offline" ? "OFFLINE" : "READY"}
          <span className="pill-sep">·</span>
          {/* The SERVER's analyzer version, not a constant from this bundle. */}
          <span className="mono">v{meta.facts?.analyzerVersion ?? NOT_MEASURED}</span>
          <span className="pill-sep">·</span>
          <span className="mono">{clock}</span>
        </span>
        <button type="button" className="kbd" onClick={onOpenPalette} aria-label="Open command palette">
          ⌘K
        </button>
        <button type="button" className="btn btn-primary" onClick={onOpenWorkbench}>
          Open workbench <span aria-hidden="true">→</span>
        </button>
      </div>
    </nav>
  );
}
