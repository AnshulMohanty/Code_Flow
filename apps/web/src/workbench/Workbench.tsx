import type { AnalysisResult } from "@codeflow/shared-types";
import { useCallback, useMemo, useState } from "react";
import { CommandPalette, usePaletteHotkey, type PaletteItem } from "../components/CommandPalette";
import { Hud } from "../components/Hud";
import { ModeBadge } from "../components/ModeSwitch";
import { mentionsEnvVar, visitorBanners, type AiAvailability, type AiChoice } from "../lib/aiMode";
import { buildGraphModel } from "../lib/graphModel";
import { buildSiteModel, count, formatMs, NOT_MEASURED } from "../lib/siteModel";
import { askDisabledReason } from "../site/MarketingSite";
import { RepoField } from "../site/RepoField";
import { DemoStrip } from "../site/DemoStrip";
import type { AnalysisState, AskState } from "../lib/useAnalysis";
import type { MetaState } from "../lib/useMeta";
import { analyzeBlockedReason, type WakeState } from "../lib/useWake";
import { hasDomainLanes, TabDomains } from "./TabDomains";
import { TabExplore } from "./TabExplore";
import { TabImpact } from "./TabImpact";
import { TabSystem } from "./TabSystem";

/**
 * SURFACE B — THE WORKBENCH (dark).
 *
 * Three phases, and they are the run's real phases rather than a wizard:
 *   STEP 01  no analysis — point at a repo, with the deployment's REAL indexed list beside it.
 *   STEP 02  resolving — the six rows filling from live per-stage events.
 *   TABS     ready — 01 SYSTEM · 02 EXPLORE · 03 IMPACT · 04 DOMAINS.
 *
 * The tabs appear only once there is a result, because a tab that opens onto nothing is worse than a
 * tab that is not there. The `p50 · $ · cURL` HUD is present throughout and reports em-dashes until
 * the figures exist.
 */

export type WorkbenchTab = "system" | "explore" | "impact" | "domains";

const TABS: Array<{ id: WorkbenchTab; num: string; label: string }> = [
  { id: "system", num: "01", label: "System" },
  { id: "explore", num: "02", label: "Explore" },
  { id: "impact", num: "03", label: "Impact" },
  { id: "domains", num: "04", label: "Domains" },
];

/**
 * Which tabs this run can actually fill.
 *
 * DOMAINS IS CONDITIONAL. Its content is `result.ai.domains`, produced only by the bounded specialist
 * fan-out — which is 5N+1 provider calls where the single-shot stage is 1, so it is OFF by default
 * and off on every free deployment. A tab that exists only to explain that a feature was not enabled
 * is worse than no tab: it reads as something broken rather than something optional.
 *
 * The parser's structural roles used to live on that tab and now live on TAB 01, so hiding it costs
 * no measured data — which is the only reason hiding it is acceptable here. See TabDomains.tsx.
 */
function visibleTabs(result: AnalysisResult | null): typeof TABS {
  if (!result || hasDomainLanes(result)) return TABS;
  return TABS.filter((tab) => tab.id !== "domains");
}

export interface WorkbenchProps {
  meta: MetaState;
  /** Whether the backend has answered yet. Gates the analyze field — see `EntryStep`. */
  wake: WakeState;
  analysis: AnalysisState;
  ask: AskState;
  onAnalyze(input: { owner: string; repo: string }): void;
  onAsk(question: string): void;
  onExit(): void;
  /** The Map only / Map + AI switch, or null when the server does not offer modes. */
  mode?: WorkbenchMode | null;
  modeBadge?: { label: string; title: string; ai: boolean } | null;
}

export type WorkbenchMode = { choice: AiChoice; availability: AiAvailability; onChange(choice: AiChoice): void };

export function Workbench({ meta, wake, analysis, ask, onAnalyze, onAsk, onExit, mode, modeBadge }: WorkbenchProps) {
  const [tab, setTab] = useState<WorkbenchTab>("system");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  usePaletteHotkey(() => setPaletteOpen(true));

  const result = analysis.result;
  const graph = useMemo(() => (result ? buildGraphModel(result) : null), [result]);
  const model = useMemo(() => (result ? buildSiteModel(result, meta.facts) : null), [result, meta.facts]);

  const tabs = useMemo(() => visibleTabs(result), [result]);

  // A tab that disappears under the user must not leave the panel blank. This cannot happen from the
  // tab bar (the tab is gone before there is a result to hide it for), but it can from a command
  // palette entry or a restored state, so the fallback is real rather than defensive decoration.
  const activeTab: WorkbenchTab = tabs.some((entry) => entry.id === tab) ? tab : "system";

  const jump = useCallback((next: WorkbenchTab, fileId?: string) => {
    setTab(next);
    if (fileId) setSelectedId(fileId);
  }, []);

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = tabs.map((entry) => ({
      id: `tab:${entry.id}`,
      label: `${entry.num} ${entry.label}`,
      kind: "tab",
      run: () => setTab(entry.id),
    }));
    items.push({ id: "go:site", label: "Back to the site", kind: "go", run: onExit });
    for (const node of result?.graph?.nodes ?? []) {
      items.push({
        id: `module:${node.id}`,
        label: node.id,
        kind: "module",
        // A module chosen from the palette lands on IMPACT: that is the view where naming one module
        // answers something, and dropping the user on a diagram with a dot highlighted would not.
        run: () => jump("impact", node.id),
      });
    }
    return items;
  }, [result, onExit, jump]);

  const busy = analysis.phase === "starting" || analysis.phase === "running";
  const banners = useMemo(() => visitorBanners(result), [result]);

  return (
    <div className="wb dark">
      <header className="wb-bar">
        <span className="nav-brand-mark" aria-hidden="true">
          ⌗
        </span>
        <strong style={{ fontFamily: "var(--display)", letterSpacing: "-0.03em" }}>CodeFlow</strong>
        <span className="wb-repo">{result ? model?.repoFullName : (analysis.target ?? "no repository")}</span>

        {result ? (
          <div className="wb-tabs" role="tablist" aria-label="Workbench views">
            {tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                className="wb-tab"
                aria-selected={activeTab === entry.id}
                onClick={() => setTab(entry.id)}
              >
                {entry.num} {entry.label.toUpperCase()}
              </button>
            ))}
          </div>
        ) : null}

        <div className="wb-right">
          <ModeBadge badge={modeBadge ?? null} />
          {model ? <Hud numbers={model.numbers} jobId={analysis.jobId} /> : null}
          <button type="button" className="kbd" onClick={() => setPaletteOpen(true)} aria-label="Open command palette">
            ⌘K
          </button>
          <button type="button" className="btn btn-ghost" onClick={onExit}>
            <span aria-hidden="true">←</span> site
          </button>
        </div>
      </header>

      <main className="wb-main">
        {analysis.phase === "failed" ? (
          <div className="banner" data-tone={analysis.errorCode === "DAILY_LIMIT" ? "partial" : "refused"} role="alert">
            <span className="banner-mark" aria-hidden="true">
              {analysis.errorCode === "DAILY_LIMIT" ? "◐" : "✕"}
            </span>
            <span>{analysis.error ?? "The analysis failed."}</span>
            {analysis.errorCode === "DAILY_LIMIT" && mode ? (
              <button type="button" className="link-btn" onClick={() => mode.onChange("map-only")}>
                Use Map only
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Honest degradation, carried from the run itself and shown before anything else — in this
            app's own words, one line per reason. The worker's `detail` strings are operator text
            (they can name environment variables) and are never rendered to a visitor. */}
        {banners.map((banner) => (
          <div className="banner" data-tone={banner.tone} key={banner.reason} role="note">
            <span className="banner-mark" aria-hidden="true">
              {banner.tone === "info" ? "⌗" : "◐"}
            </span>
            <span>{banner.text}</span>
          </div>
        ))}

        {!result && !busy ? (
          <EntryStep meta={meta} wake={wake} onAnalyze={onAnalyze} error={analysis.error} mode={mode ?? null} />
        ) : !result ? (
          <ResolvingStep analysis={analysis} meta={meta} />
        ) : graph && model ? (
          <>
            {activeTab === "system" ? (
              <TabSystem
                result={result}
                graph={graph}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onOpenImpact={(fileId) => jump("impact", fileId)}
              />
            ) : null}
            {activeTab === "explore" ? (
              <TabExplore
                result={result}
                graph={graph}
                selectedId={selectedId}
                onSelect={setSelectedId}
                ask={ask}
                onAsk={onAsk}
                askDisabledReason={askDisabledReason(result, ask)}
              />
            ) : null}
            {activeTab === "impact" ? (
              <TabImpact result={result} graph={graph} selectedId={selectedId} onSelect={setSelectedId} />
            ) : null}
            {activeTab === "domains" ? <TabDomains result={result} graph={graph} onSelect={(id) => jump("impact", id ?? undefined)} /> : null}
          </>
        ) : null}
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={paletteItems} />
    </div>
  );
}

/**
 * STEP 01 — "Give me a URL. I'll give you the map."
 *
 * The `indexed:` row is the deployment's REAL analysis history from `/api/meta`, newest first. A
 * hardcoded list of well-known repositories there would be the prototype's sample data shipped as
 * the user's own history — which is the most convincing way a UI can lie.
 */
export function EntryStep({
  meta,
  wake,
  onAnalyze,
  error,
  mode,
}: {
  meta: MetaState;
  wake: WakeState;
  onAnalyze(input: { owner: string; repo: string }): void;
  error: string | null;
  mode?: WorkbenchMode | null;
}) {
  const indexed = meta.facts?.indexed ?? [];
  return (
    <div className="wb-entry">
      <p className="wb-step">Step 01 — point at a repo</p>
      <h1 className="display display-entry">
        Give me a URL. I&rsquo;ll give you the map.
      </h1>
      <RepoField onAnalyze={onAnalyze} autoFocus error={error} notReady={analyzeBlockedReason(wake)} mode={mode ?? null} />
      <p className="wb-recents">
        <span>indexed:</span>
        {meta.status === "loading" ? (
          <span className="chip-count">loading…</span>
        ) : meta.status === "error" ? (
          // Not "nothing yet": we do not know, because the server did not answer. Saying it has
          // analysed nothing would be a claim about a server we could not reach.
          <span className="chip-count">unknown — the server did not answer</span>
        ) : indexed.length === 0 ? (
          <span className="chip-count">
            nothing yet — this deployment has not analysed a repository
          </span>
        ) : (
          indexed.map((entry) => (
            <button
              key={entry.analysisId}
              type="button"
              className="chip"
              onClick={() => {
                const [owner, repo] = entry.repoFullName.split("/");
                if (owner && repo) onAnalyze({ owner, repo });
              }}
              title={`${entry.repoFullName} · ${count(entry.fileCount)} files · ${entry.commitSha.slice(0, 7)}`}
            >
              {entry.repoFullName}
            </button>
          ))
        )}
      </p>
      <DemoStrip onAnalyze={onAnalyze} caption="cached demos — open one instantly:" />
    </div>
  );
}

/**
 * STEP 02 — RESOLVING. The six rows, filling from live per-stage events.
 *
 * The `ground` row shows an em-dash until the citation index is actually sealed, and it keeps showing
 * one on a run with no chat provider — because that is not "still working", it is "never going to
 * run". A spinner there would be the UI waiting for something that is not coming.
 */
export function ResolvingStep({ analysis, meta }: { analysis: AnalysisState; meta: MetaState }) {
  // The rows are built from the LIVE event stream, using the same row→stage mapping the finished
  // view uses — so a stage's number does not move when the run completes.
  const rows = useMemo(() => liveRows(analysis), [analysis]);
  const total = rows.reduce((sum, row) => sum + (row.durationMs ?? 0), 0);

  return (
    <>
      <p className="wb-step">Step 02 — resolving</p>
      <div className="wb-head">
        <h1 className="display display-m">{analysis.target ?? "resolving"}</h1>
        <p className="wb-head-note">
          {analysis.progress?.currentStep ?? "queued"} ·{" "}
          {total > 0 ? formatMs(total) : NOT_MEASURED}
          {meta.facts ? ` · analyzer v${meta.facts.analyzerVersion}` : ""}
        </p>
      </div>

      <ol className="rows" aria-label="Pipeline stages" style={{ maxWidth: 820 }}>
        {rows.map((row, index) => (
          <li className="row" key={row.id} data-status={row.status}>
            <span className="row-num">{String(index + 1).padStart(2, "0")}</span>
            <span className="row-name">{row.label}</span>
            <span className="row-detail" title={row.detail ?? undefined}>
              {row.detail ?? ""}
            </span>
            <span className="row-ms">
              {row.status === "failed"
                ? "failed"
                : row.status === "running"
                  ? "…"
                  : row.durationMs === null
                    ? NOT_MEASURED
                    : `${row.durationMs}ms`}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

interface LiveRow {
  id: string;
  label: string;
  detail: string | null;
  durationMs: number | null;
  status: "pending" | "running" | "done" | "skipped" | "failed";
}

/**
 * The six rows, from the live event map.
 *
 * Uses the SAME row→stage grouping as the finished view (`PIPELINE_ROWS`), so a duration a user watched
 * arrive does not change when the run settles. A stage the job reported as SKIPPED renders skipped,
 * not pending — the distinction the `skippedStages` field exists to carry.
 */
export function liveRows(analysis: AnalysisState): LiveRow[] {
  const ROWS: Array<{ id: string; label: string; stages: string[] }> = [
    { id: "clone", label: "clone", stages: ["ingest"] },
    { id: "parse", label: "parse", stages: ["map-structure", "inventory"] },
    { id: "resolve", label: "resolve", stages: ["connect"] },
    { id: "index", label: "index", stages: ["analyze"] },
    { id: "embed", label: "embed", stages: ["rag"] },
    { id: "ground", label: "ground", stages: ["synthesize"] },
  ];
  const skipped = new Set(analysis.progress?.skippedStages ?? []);

  return ROWS.map((row) => {
    const events = row.stages.map((stage) => analysis.events.get(stage)).filter((event) => event !== undefined);
    const allSkipped = row.stages.every((stage) => skipped.has(stage as never));

    let status: LiveRow["status"] = "pending";
    if (allSkipped) status = "skipped";
    else if (events.some((event) => event!.status === "failed")) status = "failed";
    else if (events.length === row.stages.length && events.every((event) => event!.status === "completed")) status = "done";
    else if (events.length > 0) status = "running";

    const durations = events.map((event) => event!.durationMs).filter((ms): ms is number => ms !== undefined);
    // Stage details are written by the worker; one that names an environment variable is operator
    // advice and is dropped here rather than shown to a visitor.
    const detail = events
      .map((event) => event!.detail)
      .filter((text): text is string => Boolean(text) && !mentionsEnvVar(text!))
      .join(" · ");

    return {
      id: row.id,
      label: row.label,
      detail: allSkipped
        ? analysis.requestedWithAi === false
          ? "map only — AI not requested"
          : "not configured for this run"
        : detail || null,
      durationMs: durations.length > 0 ? durations.reduce((sum, ms) => sum + ms, 0) : null,
      status,
    };
  });
}
