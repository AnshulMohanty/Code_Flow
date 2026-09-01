import type { AnalysisResult } from "@codeflow/shared-types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AskBlock, PipelineCard } from "../components/PipelineCard";
import { CommandPalette, usePaletteHotkey, type PaletteItem } from "../components/CommandPalette";
import { buildGraphModel } from "../lib/graphModel";
import { buildSiteModel, count } from "../lib/siteModel";
import { moduleLabel } from "../lib/citation";
import { suggestedQuestions } from "../lib/questions";
import type { MetaState } from "../lib/useMeta";
import type { AskState, AnalysisState } from "../lib/useAnalysis";
import { HeroMesh } from "./HeroMesh";
import { LanguageTicker } from "./LanguageTicker";
import { RepoField } from "./RepoField";
import { SectionGrounding } from "./SectionGrounding";
import { SectionNumbers } from "./SectionNumbers";
import { SiteNav } from "./SiteNav";

/**
 * SURFACE A — the marketing site (paper/light), with a dark workbench card embedded in section 01.
 *
 * Everything after the hero is driven by a REAL analysis. Before one exists, section 01 shows an
 * honest empty state instead of the card, section 02's three grounding states read as descriptions
 * with none active, and section 03's four stats are em-dashes. That is the correct first screenshot:
 * a page about measured numbers that has nothing to measure yet should say so.
 */

export interface MarketingSiteProps {
  meta: MetaState;
  analysis: AnalysisState;
  ask: AskState;
  onAnalyze(input: { owner: string; repo: string }): void;
  onAsk(question: string): void;
  onOpenWorkbench(): void;
}

export function MarketingSite({ meta, analysis, ask, onAnalyze, onAsk, onOpenWorkbench }: MarketingSiteProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  usePaletteHotkey(() => setPaletteOpen(true));

  const result = analysis.result;
  const graph = useMemo(() => (result ? buildGraphModel(result) : null), [result]);
  const model = useMemo(() => (result ? buildSiteModel(result, meta.facts) : null), [result, meta.facts]);

  const navigate = useCallback((section: string) => {
    const target = section === "top" ? rootRef.current : document.getElementById(section);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSection(section === "top" ? null : section);
  }, []);

  // Which section is in view, for the nav's `aria-current`. IntersectionObserver rather than a
  // scroll listener: it does not run on every frame, and it is absent in jsdom, where the nav simply
  // has no active section (which is correct rather than broken).
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActiveSection(visible[0].target.id);
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    for (const id of ["resolve", "grounding", "numbers"]) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [result]);

  const paletteItems = usePaletteItems(result, {
    onNavigate: navigate,
    onOpenWorkbench,
    onSelectModule: (fileId) => {
      setSelectedId(fileId);
      navigate("resolve");
    },
  });

  const busy = analysis.phase === "starting" || analysis.phase === "running";
  const questions = useMemo(() => suggestedQuestions(result), [result]);

  return (
    <div ref={rootRef}>
      <SiteNav
        meta={meta}
        activeSection={activeSection}
        onNavigate={navigate}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenWorkbench={onOpenWorkbench}
      />

      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <header className="hero">
        <div className="shell hero-inner">
          <HeroMesh />
          <div className="hero-eyebrow">
            <p className="eyebrow">⌗ Repository cartography</p>
            <span className="hero-eyebrow-rule" aria-hidden="true" />
            <p className="eyebrow" style={{ color: "var(--oxblood)" }}>
              Hover any module ↗
            </p>
          </div>

          <h1 className="display display-xl">
            See what breaks
            <br />
            before you <span className="accent">ship it</span>
            <span className="dot" aria-hidden="true" />
          </h1>

          <div className="hero-grid">
            <p className="aside">
              Cartograph resolves your repo into a real dependency map — foundations at the centre — then
              answers questions with the file and line it read.
            </p>
            <div>
              <RepoField onAnalyze={onAnalyze} busy={busy} error={analysis.error} />
              <p className="subline">
                <span className="subline-ok">✓ deterministic pass first</span>
                {model?.totalMs !== undefined && model?.totalMs !== null ? (
                  <span>~{Math.round(model.totalMs / 1000)}s last index</span>
                ) : (
                  <span>index time is reported after a run, not promised before one</span>
                )}
                {meta.facts?.build ? <span>⌗{meta.facts.build.slice(0, 7)}</span> : null}
              </p>
            </div>
          </div>
        </div>
      </header>

      <LanguageTicker />

      {/* ── 01 Resolve ─────────────────────────────────────────────────────── */}
      <section className="section" id="resolve">
        <div className="shell">
          <p className="eyebrow" style={{ marginBottom: 20 }}>
            01 — Resolve
          </p>
          <div className="section-head">
            <h2 className="display display-l">
              Six passes,
              <br />
              then it speaks<span className="dot" aria-hidden="true" />
            </h2>
            <p className="aside">
              Nothing is generated until the graph is sealed. Watch the rail fill — the answer waits for
              it.
            </p>
          </div>

          {model && graph && result ? (
            <PipelineCard
              model={model}
              graph={graph}
              result={result}
              jobId={analysis.jobId}
              selectedId={selectedId}
              onSelect={setSelectedId}
              ask={
                <AskBlock
                  suggestions={questions}
                  question={ask.question}
                  answer={
                    ask.answer
                      ? {
                          text: ask.answer.answer,
                          answered: ask.answer.answered,
                          citations: ask.answer.citations,
                        }
                      : null
                  }
                  busy={ask.busy}
                  disabledReason={askDisabledReason(result, ask)}
                  onAsk={onAsk}
                  result={result}
                />
              }
            />
          ) : (
            <div className="empty light">
              <p className="empty-title">{busy ? "Resolving…" : "Nothing resolved yet"}</p>
              <p className="empty-body">
                {busy
                  ? "The six passes run in order; each row fills with its real duration as the stage reports."
                  : "Paste a public repository above. This card fills with that run's real per-stage timings, its resolved graph, and one grounded answer — never with sample data."}
              </p>
            </div>
          )}
        </div>
      </section>

      <SectionGrounding grounding={model?.grounding ?? null} />

      <SectionNumbers
        numbers={model?.numbers ?? null}
        provenance={model ? `${model.repoFullName}${model.shortSha ? ` @ ${model.shortSha}` : ""}` : null}
      />

      {/* ── CTA ────────────────────────────────────────────────────────────── */}
      <section className="cta dark">
        <div className="shell">
          <h2 className="display display-xl">
            Paste a repo<span className="dot" aria-hidden="true" />
          </h2>
          <div className="cta-actions">
            <button type="button" className="btn btn-primary" onClick={onOpenWorkbench}>
              Open the workbench <span aria-hidden="true">→</span>
            </button>
            <p className="cta-note">
              no signup for public repos ·{" "}
              {model?.totalMs != null ? `${Math.round(model.totalMs / 1000)}s last index` : "index time reported per run"} ·
              ⌘K anywhere
            </p>
          </div>
        </div>
      </section>

      <footer className="footer dark">
        <span>⌗ CodeFlow · engine Cartograph</span>
        {/* Identity, and only what is real. A missing build or index sha renders as `—` rather than
            as an invented hash — a footer is exactly where a fabricated id reads as provenance. */}
        <span>build ⌗{meta.facts?.build?.slice(0, 7) ?? "—"}</span>
        <span>analyzer v{meta.facts?.analyzerVersion ?? "—"}</span>
        <span>index ⌗{model?.shortSha ?? "—"}</span>
        <span>
          graph {graph ? `${count(graph.nodeCount)}n · ${count(graph.linkCount)}e` : "—"}
        </span>
        <span className="footer-right">Read the code, not the vibes.</span>
      </footer>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
        placeholder={result ? "Search modules, sections and actions…" : "Search sections and actions…"}
      />
    </div>
  );
}

/**
 * Palette entries: real modules from the loaded analysis, plus navigation.
 *
 * A module entry only exists when an analysis is loaded, so the palette can never offer to jump to a
 * file that is not in front of the user.
 */
export function usePaletteItems(
  result: AnalysisResult | null,
  actions: { onNavigate(section: string): void; onOpenWorkbench(): void; onSelectModule(fileId: string): void },
): PaletteItem[] {
  return useMemo(() => {
    const items: PaletteItem[] = [
      { id: "go:workbench", label: "Open the workbench", kind: "go", run: actions.onOpenWorkbench },
      { id: "go:resolve", label: "01 Resolve", kind: "go", run: () => actions.onNavigate("resolve") },
      { id: "go:grounding", label: "02 Grounding", kind: "go", run: () => actions.onNavigate("grounding") },
      { id: "go:numbers", label: "03 Numbers", kind: "go", run: () => actions.onNavigate("numbers") },
    ];
    for (const node of result?.graph?.nodes ?? []) {
      items.push({
        id: `module:${node.id}`,
        label: node.id,
        kind: "module",
        run: () => actions.onSelectModule(node.id),
      });
    }
    return items;
  }, [result, actions]);
}

/**
 * Why the Ask block is unavailable, in the user's terms — or null when it works.
 *
 * Each branch is a real state the API distinguishes, and each says what would change it. "Q&A
 * unavailable" with no reason is the kind of dead end that makes a product feel broken when it is
 * actually behaving correctly.
 */
export function askDisabledReason(result: AnalysisResult, ask: AskState): string | null {
  if (ask.error) return ask.error;
  if (ask.answer?.atCapacity) {
    return "Demo at capacity — the daily AI budget has been reached. The deterministic map above is unaffected.";
  }
  if (ask.answer?.unavailable) return ask.answer.answer;
  if (!result.ai?.rag) {
    return "No Q&A index was built for this run, so there is nothing to ask against. The map above is the deterministic pass, which does not need a provider key.";
  }
  return null;
}
