import type { AnalysisResult } from "@codeflow/shared-types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AskBlock, PipelineCard } from "../components/PipelineCard";
import { CommandPalette, usePaletteHotkey, type PaletteItem } from "../components/CommandPalette";
import { copyWithToast } from "../components/Toast";
import { buildGraphModel } from "../lib/graphModel";
import { buildHeroGraph } from "../lib/heroGraph";
import { hasFinePointer, useReveal, useRevealAttrs } from "../lib/motion";
import { buildSiteModel, count, formatMs } from "../lib/siteModel";
import { suggestedQuestions } from "../lib/questions";
import type { MetaState } from "../lib/useMeta";
import { analyzeBlockedReason, type WakeState } from "../lib/useWake";
import type { AskState, AnalysisState } from "../lib/useAnalysis";
import { BUDGET_COPY, isMapOnlyRun, visitorBanners, type AiAvailability, type AiChoice } from "../lib/aiMode";
import { snapshotLabel, type DemoSnapshot } from "../lib/demoSnapshot";
import { DemoStrip } from "./DemoStrip";
import { HeroGraph, type HeroHover } from "./HeroGraph";
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
 * with none active, and section 03's four stats are em-dashes. That is the correct first screenshot
 * for a build with nothing at all to show.
 *
 * THE DEMO SNAPSHOT SITS BETWEEN THOSE TWO STATES, and the distinction it has to hold is the whole
 * reason it is safe. When a build ships a generated snapshot (see lib/demoSnapshot.ts) the views
 * render its REAL numbers rather than em-dashes — because they are real numbers about a real
 * repository at a pinned commit, not invented ones. What makes that different from the deleted
 * "Use Mock Data" button is that the snapshot can never be mistaken for the visitor's own run: a
 * banner names the repository, the commit, the date it was produced and what it is MISSING, and it
 * is rendered wherever the snapshot is. A live analysis replaces it the moment one exists.
 *
 * THE HERO GRAPH follows the same rule. It is the design's interactive map, drawn from that same
 * result (live, else the snapshot) and LABELLED with its repository and commit. With neither there
 * is no graph at all — an unlabelled decorative mesh on this page would be the product contradicting
 * itself in its own hero.
 *
 * A build with NO snapshot is unchanged — same empty state, same four em-dashes.
 */

export interface MarketingSiteProps {
  meta: MetaState;
  /** Whether the backend has answered yet. Drives the status pill and gates the analyze button. */
  wake: WakeState;
  /** The bundled pre-computed analysis, or null when this build has none. */
  demo: DemoSnapshot | null;
  analysis: AnalysisState;
  ask: AskState;
  onAnalyze(input: { owner: string; repo: string }): void;
  onAsk(question: string): void;
  onOpenWorkbench(): void;
  /** The Map only / Map + AI switch, or null when the server does not offer modes. */
  mode?: { choice: AiChoice; availability: AiAvailability; onChange(choice: AiChoice): void } | null;
  modeBadge?: { label: string; title: string; ai: boolean } | null;
}

/** The fully offline CLI. Same deterministic pipeline, no server and no key. */
export const OFFLINE_CLI_COMMAND = "npx codeflow-local analyze .";

export function MarketingSite({
  meta,
  wake,
  demo,
  analysis,
  ask,
  onAnalyze,
  onAsk,
  onOpenWorkbench,
  mode,
  modeBadge,
}: MarketingSiteProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [heroHover, setHeroHover] = useState<HeroHover | null>(null);
  const [finePointer, setFinePointer] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // MOTION, applied to elements that already exist. Display lines wipe up (`clip`); the copy around
  // them fades up after. Every one of these degrades to "already revealed" without an
  // IntersectionObserver or under reduced motion — see lib/motion.
  const heroIn = useReveal<HTMLHeadingElement>({ threshold: 0 });
  const resolveHead = useRevealAttrs<HTMLDivElement>("up");
  const resolveTitle = useRevealAttrs<HTMLHeadingElement>("clip");
  const resolveAside = useRevealAttrs<HTMLParagraphElement>("up");
  const resolveBody = useRevealAttrs<HTMLDivElement>("up");
  const ctaHead = useRevealAttrs<HTMLSpanElement>("clip");
  const ctaActions = useRevealAttrs<HTMLDivElement>("up");

  usePaletteHotkey(() => setPaletteOpen(true));
  useEffect(() => setFinePointer(hasFinePointer()), []);

  // A LIVE run always wins. The snapshot is what fills the page before one exists — never something
  // that survives alongside one, which would leave two different repositories on screen at once.
  const live = analysis.result;
  const showingSnapshot = !live && demo !== null;
  const result = live ?? demo?.result ?? null;
  const graph = useMemo(() => (result ? buildGraphModel(result) : null), [result]);
  const model = useMemo(() => (result ? buildSiteModel(result, meta.facts) : null), [result, meta.facts]);
  const heroLayout = useMemo(() => (graph && graph.linkCount > 0 ? buildHeroGraph(graph) : null), [graph]);
  const banners = useMemo(() => visitorBanners(result), [result]);

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
  const lastIndex = model?.totalMs ?? null;
  // For the snapshot, the PROVENANCE names the repository and commit — the same identity its banner
  // states — so the map label and the banner can never disagree about which analysis this is.
  const repoLabel =
    showingSnapshot && demo
      ? `${demo.provenance.repoFullName} @ ${demo.provenance.commitSha.slice(0, 7)}`
      : model
        ? `${model.repoFullName}${model.shortSha ? ` @ ${model.shortSha}` : ""}`
        : null;

  return (
    <div ref={rootRef} className="site">
      <SiteNav
        meta={meta}
        wake={wake}
        activeSection={activeSection}
        onNavigate={navigate}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenWorkbench={onOpenWorkbench}
        modeBadge={modeBadge ?? null}
      />

      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <header className="hero" data-has-graph={heroLayout !== null}>
        {heroLayout ? <HeroGraph layout={heroLayout} onHover={setHeroHover} /> : null}
        <div className="hero-fade" aria-hidden="true" />
        {heroLayout && repoLabel ? (
          // What the graph IS, stated where the graph is. Never "representative": it is one real
          // analysis, and this says which one and how much of it is drawn.
          <p className="hero-graph-label" data-hero-graph-label="true">
            <span className="hero-graph-label-key">map</span> {repoLabel}
            <span className="hero-graph-label-sep"> · </span>
            {showingSnapshot ? "pre-computed demo, not a live run" : "your run"}
            <span className="hero-graph-label-sep"> · </span>
            {count(heroLayout.drawn)} of {count(heroLayout.total)} modules drawn
          </p>
        ) : null}

        <div className="hero-content">
          <div className="hero-eyebrow" data-reveal="up" data-revealed={heroIn.revealed}>
            <span className="hero-eyebrow-mark" aria-hidden="true">
              ⌗
            </span>
            <span>Repository cartography</span>
            <span className="hero-eyebrow-rule" aria-hidden="true" />
            {/* Only claimed when it is true: there is a graph to hover, and a pointer to hover with. */}
            {heroLayout && finePointer ? (
              <span className="hero-hover" data-active={heroHover !== null} aria-hidden="true">
                {heroHover
                  ? `${heroHover.label}  →  ${count(heroHover.downstream)} downstream · ${heroHover.hops} hop${heroHover.hops === 1 ? "" : "s"} · ${heroHover.area}`
                  : "hover any module ↗"}
              </span>
            ) : null}
          </div>

          <h1 className="display display-hero" ref={heroIn.ref}>
            <span className="hero-line" data-reveal="clip" data-revealed={heroIn.revealed}>
              See what breaks
            </span>{" "}
            <span className="hero-line" data-reveal="clip" data-revealed={heroIn.revealed} style={{ transitionDelay: "130ms" }}>
              before you <span className="accent">ship it.</span>
            </span>
          </h1>

          <div className="hero-grid">
            <p className="aside aside-hero" data-reveal="up" data-revealed={heroIn.revealed} style={{ transitionDelay: "320ms" }}>
              Cartograph resolves your repo into a real dependency map — foundations at the centre — then
              answers questions with the file and line it read.
            </p>
            <div className="hero-cta" data-reveal="up" data-revealed={heroIn.revealed} style={{ transitionDelay: "420ms" }}>
              <RepoField
                onAnalyze={onAnalyze}
                busy={busy}
                error={analysis.error}
                notReady={analyzeBlockedReason(wake)}
                mode={mode ?? null}
                errorAction={
                  analysis.errorCode === "DAILY_LIMIT" && mode
                    ? { label: "Use Map only", run: () => mode.onChange("map-only") }
                    : null
                }
              />
              <p className="subline">
                <span className="subline-ok">✓ deterministic pass first</span>
                {lastIndex !== null ? (
                  <span>
                    {lastIndex >= 1000 ? `~${Math.round(lastIndex / 1000)}s` : formatMs(lastIndex)} last index
                    {repoLabel ? ` · ${model!.repoFullName}` : ""}
                  </span>
                ) : (
                  <span>index time is reported after a run, not promised before one</span>
                )}
                {meta.facts?.build ? <span className="subline-faint">⌗{meta.facts.build.slice(0, 7)}</span> : null}
              </p>
              <DemoStrip onAnalyze={onAnalyze} activeFullName={showingSnapshot ? demo.provenance.repoFullName : null} />
            </div>
          </div>
        </div>
      </header>

      <LanguageTicker />

      {/* ── 01 Resolve ─────────────────────────────────────────────────────── */}
      <section className="section" id="resolve">
        <div className="shell">
          <div className="section-head">
            <div {...resolveHead}>
              <p className="eyebrow eyebrow-accent">01 — Resolve</p>
              <h2 className="display display-l" {...resolveTitle}>
                Six passes,
                <br />
                then it speaks.
              </h2>
            </div>
            <p className="aside" {...resolveAside} style={{ transitionDelay: "180ms" }}>
              Nothing is generated until the graph is sealed. Watch the rail fill — the answer waits for
              it.
            </p>
          </div>

          {showingSnapshot && demo ? <SnapshotBanner snapshot={demo} /> : null}
          {banners.map((banner) => (
            <p className="banner banner-light" data-tone={banner.tone} key={banner.reason} role="note">
              <span className="banner-mark" aria-hidden="true">
                {banner.tone === "info" ? "⌗" : "◐"}
              </span>
              <span>{banner.text}</span>
            </p>
          ))}

          <div {...resolveBody} style={{ transitionDelay: "120ms" }}>
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
        </div>
      </section>

      <SectionGrounding grounding={model?.grounding ?? null} />

      <SectionNumbers numbers={model?.numbers ?? null} provenance={repoLabel} />

      {/* ── CTA ────────────────────────────────────────────────────────────── */}
      <section className="cta dark">
        <div className="shell">
          <h2 className="display display-cta">
            <span className="hero-line" {...ctaHead}>
              Paste a repo<span className="stop">.</span>
            </span>
          </h2>
          <div className="cta-actions" {...ctaActions} style={{ transitionDelay: "240ms" }}>
            <button type="button" className="btn btn-light" data-magnetic="true" onClick={onOpenWorkbench}>
              Open the workbench <span aria-hidden="true">→</span>
            </button>
            <p className="cta-note">
              no signup for public repos · {lastIndex !== null ? `${formatMs(lastIndex)} last index` : "index time reported per run"} · ⌘K
              anywhere
            </p>
          </div>
          <p className="cta-cli">
            <span>Fully offline, no server and no key:</span>
            <code>{OFFLINE_CLI_COMMAND}</code>
            <button
              type="button"
              className="chip-btn"
              onClick={() => void copyWithToast(OFFLINE_CLI_COMMAND, "⌗ copied — runs the same deterministic map locally")}
            >
              copy
            </button>
          </p>

          <footer className="footer">
            <span aria-hidden="true">⌗</span>
            <span>CodeFlow · engine Cartograph</span>
            {/* Identity, and only what is real. A missing build or index sha renders as `—` rather
                than as an invented hash — a footer is exactly where a fabricated id reads as provenance. */}
            <span>build ⌗{meta.facts?.build?.slice(0, 7) ?? "—"}</span>
            <span>analyzer v{meta.facts?.analyzerVersion ?? "—"}</span>
            <span>index ⌗{model?.shortSha ?? "—"}</span>
            <span>graph {graph ? `${count(graph.nodeCount)}n · ${count(graph.linkCount)}e` : "—"}</span>
            <span className="footer-right">Read the code, not the vibes.</span>
          </footer>
        </div>
      </section>

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
  if (ask.answer?.atCapacity) return BUDGET_COPY;
  if (ask.answer?.unavailable) return ask.answer.answer;
  if (!result.ai?.rag && isMapOnlyRun(result)) {
    return "Map only run — no Q&A index was built, so there is nothing to ask against. Switch to Map + AI and analyze again to ask questions.";
  }
  if (!result.ai?.rag) {
    return "No Q&A index was built for this run, so there is nothing to ask against. The map above is the deterministic pass, which does not need a provider key.";
  }
  return null;
}

/**
 * THE PROVENANCE BANNER — what makes rendering a pre-computed analysis honest rather than a lie.
 *
 * It is not a tooltip and not a footnote. A visitor who reads nothing else has to be able to tell
 * that these numbers describe a NAMED repository at a PINNED commit, produced on a stated date, and
 * not their own run. The commit is a link, so any claim on screen can be checked against the source
 * it was read from.
 *
 * `limitations` is rendered, not summarised. A local snapshot has no AI summary and no Q&A index,
 * and a reader looking at an empty Ask block deserves to know that is the method rather than the
 * repository.
 */
function SnapshotBanner({ snapshot }: { snapshot: DemoSnapshot }) {
  const { provenance } = snapshot;
  const [owner, name] = provenance.repoFullName.split("/");
  const commitUrl =
    owner && name ? `https://github.com/${owner}/${name}/tree/${provenance.commitSha}` : null;

  return (
    <aside className="snapshot-banner" data-snapshot="true" role="note">
      <p className="snapshot-banner-title">
        <span className="snapshot-banner-mark" aria-hidden="true">
          ◐
        </span>
        Pre-computed demo — not a live run
      </p>
      <p className="snapshot-banner-body">
        {snapshotLabel(provenance)}
        {commitUrl ? (
          <>
            {" · "}
            <a href={commitUrl} target="_blank" rel="noreferrer">
              view the commit
            </a>
          </>
        ) : null}
      </p>
      <p className="snapshot-banner-body">Produced by {provenance.producedBy}.</p>
      {provenance.limitations.length > 0 ? (
        <ul className="snapshot-banner-limits">
          {provenance.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}
