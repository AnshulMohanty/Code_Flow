import { NOT_MEASURED } from "../lib/siteModel";
import { useUtcClock, type MetaState } from "../lib/useMeta";

/**
 * THE MARKETING NAV.
 *
 * `CodeFlow ⌗ ENGINE CARTOGRAPH` · 01 Resolve · 02 Grounding · 03 Numbers · status pill · ⌘K ·
 * Open workbench.
 *
 * THE STATUS PILL IS THE ONE THING HERE THAT COULD LIE, so it is the one thing built carefully. Its
 * dot is green ONLY when `/api/meta` actually answered; the version is the analyzer version the
 * server reported, never a constant compiled into this bundle (those two disagree the moment a
 * deployment is mid-rollout, and the server's answer is the one that matters). Before the fetch
 * resolves it reads CONNECTING; if the fetch fails it reads OFFLINE, in grey.
 */

export interface SiteNavProps {
  meta: MetaState;
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

export function SiteNav({ meta, activeSection, onNavigate, onOpenPalette, onOpenWorkbench }: SiteNavProps) {
  const clock = useUtcClock(meta.facts?.serverTime ?? null);
  const live = meta.status === "ready";

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
        <span className="pill" data-live={live} title={meta.status === "error" ? meta.error : undefined}>
          <span className="pill-dot" aria-hidden="true" />
          {meta.status === "loading" ? "CONNECTING" : meta.status === "error" ? "OFFLINE" : "READY"}
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
