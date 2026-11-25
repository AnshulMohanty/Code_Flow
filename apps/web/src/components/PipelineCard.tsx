import type { AnalysisResult } from "@codeflow/shared-types";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { RadialGraph } from "./RadialGraph";
import { Hud } from "./Hud";
import { CitationChip } from "./Citation";
import type { GraphModel } from "../lib/graphModel";
import { count, formatMs, NOT_MEASURED, type PipelineRow, type PipelineRowStatus, type SiteModel } from "../lib/siteModel";
import { moduleLabel } from "../lib/citation";
import { prefersReducedMotion, useTypewriter } from "../lib/motion";
import { ragCoverageNote } from "../lib/aiMode";

/**
 * THE DARK WORKBENCH CARD — the design's centrepiece, embedded in the light page.
 *
 * Header `cartograph run — <repo>` · HUD. Left: the six pipeline rows with their REAL per-stage
 * milliseconds and an honest-state line. Right: the radial graph. Below: one grounded answer with
 * its citation chips.
 *
 * EVERY NUMBER IN HERE IS READ, and the ones that are not measured render as an em-dash — including
 * the `ground —` row the design shows, which is not a spinner but a fact about a run with no chat
 * provider configured. See `siteModel.ts` for the row→stage mapping.
 *
 * THE RAIL IS A REPLAY, and it says so. When the card scrolls into view the six rows fill in order,
 * then the answer types out, then the citations appear — the design's "the answer waits for the
 * graph". Every value that appears is the finished run's recorded value; only the PACING is
 * animated, and it is paced on the log of each stage's real duration so a 40-second clone still
 * reads as longer than a 15ms metrics pass. "↻ replay" plays it again. Under reduced motion the card
 * simply shows the finished run.
 */

export interface PipelineCardProps {
  model: SiteModel;
  graph: GraphModel;
  result: AnalysisResult;
  jobId: string | null;
  selectedId: string | null;
  onSelect(fileId: string | null): void;
  /** The grounded answer block. Optional so the card is reusable in the workbench without it. */
  ask?: React.ReactNode;
}

type RailPhase = "waiting" | "rail" | "typing" | "done";

interface RailState {
  /** Whether this subtree is animated at all. False outside the card (the workbench reuses AskBlock). */
  animate: boolean;
  phase: RailPhase;
  onTyped(): void;
}

const RailContext = createContext<RailState>({ animate: false, phase: "done", onTyped: () => {} });

/** On-screen time for one row: log-paced on the REAL duration, bounded so the whole rail reads in ~4s. */
export function railPaceMs(durationMs: number | null): number {
  if (durationMs === null) return 160;
  return Math.round(Math.max(260, Math.min(1100, 220 + 150 * Math.log10(1 + Math.max(0, durationMs)))));
}

/** Drives the replay: which row is running, and when the answer may speak. */
function useRail(rows: PipelineRow[]) {
  const still = prefersReducedMotion() || typeof IntersectionObserver === "undefined";
  const [phase, setPhase] = useState<RailPhase>(still ? "done" : "waiting");
  const [cursor, setCursor] = useState(still ? rows.length : -1);
  const [run, setRun] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // Start once, when the card is a quarter in view — the design's trigger.
  useEffect(() => {
    if (still) return;
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRun((current) => (current === 0 ? 1 : current));
          observer.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [still]);

  useEffect(() => {
    if (still || run === 0) return;
    const timers: number[] = [];
    setPhase("rail");
    setCursor(0);
    let at = 160;
    rows.forEach((row, index) => {
      at += row.status === "done" ? railPaceMs(row.durationMs) : 180;
      timers.push(window.setTimeout(() => setCursor(index + 1), at));
      at += 60;
    });
    timers.push(window.setTimeout(() => setPhase("typing"), at + 140));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
    // `rows` is read at the start of each replay only; a new result remounts the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, still]);

  const replay = useCallback(() => {
    if (still) return;
    setPhase("waiting");
    setCursor(-1);
    setRun((current) => current + 1);
  }, [still]);

  const shownStatus = (row: PipelineRow, index: number): PipelineRowStatus => {
    if (phase === "typing" || phase === "done") return row.status;
    if (phase === "waiting" || index > cursor) return "pending";
    if (index === cursor) return row.status === "done" ? "running" : row.status;
    return row.status;
  };

  return { ref, phase, setPhase, replay, shownStatus, still };
}

export function PipelineCard({ model, graph, result, jobId, selectedId, onSelect, ask }: PipelineCardProps) {
  const selected = selectedId ? graph.nodes.find((node) => node.id === selectedId) : null;
  const importers = selectedId ? graph.links.filter((link) => link.target === selectedId).length : 0;
  const domainOf = selected?.role ?? null;
  const rail = useRail(model.rows);
  const { setPhase } = rail;
  const context = useMemo<RailState>(
    () => ({ animate: !rail.still, phase: rail.phase, onTyped: () => setPhase((current) => (current === "typing" ? "done" : current)) }),
    [rail.still, rail.phase, setPhase],
  );

  return (
    <div className="card dark" ref={rail.ref} data-rail={rail.phase}>
      <header className="card-bar">
        <span className="card-lights" aria-hidden="true">
          <span className="card-light" />
          <span className="card-light" />
          <span className="card-light" />
        </span>
        <span className="card-title">cartograph run — {model.repoFullName}</span>
        <div className="card-bar-right">
          <Hud numbers={model.numbers} jobId={jobId} />
        </div>
      </header>

      <div className="card-body">
        <div className="card-left">
          <div className="panel-label">
            Pipeline
            <span className="panel-label-right mono">{formatMs(model.totalMs)} total</span>
            {rail.still ? null : (
              <button
                type="button"
                className="chip-btn"
                onClick={rail.replay}
                title="Replay this run's recorded stages. Nothing is re-analysed."
              >
                <span aria-hidden="true">↻</span> replay
              </button>
            )}
          </div>

          <ol className="rows" aria-label="Pipeline stages">
            {model.rows.map((row, index) => {
              const shown = rail.shownStatus(row, index);
              return (
                <li className="row" key={row.id} data-status={shown}>
                  <span className="row-num">{String(index + 1).padStart(2, "0")}</span>
                  <span className="row-name">{row.label}</span>
                  <span className="row-detail" title={row.detail ?? undefined}>
                    {row.detail ?? ""}
                  </span>
                  <span className="row-ms">
                    {shown === "failed"
                      ? "failed"
                      : shown === "running"
                        ? "…"
                        : shown === "pending" || row.durationMs === null
                          ? NOT_MEASURED
                          : `${row.durationMs}ms`}
                  </span>
                </li>
              );
            })}
          </ol>

          <div className="honest" data-state={model.grounding.state}>
            <p className="panel-label">Honest state</p>
            <p className="honest-line">
              <span className="honest-mark" aria-hidden="true">
                {model.grounding.state === "grounded" ? "✓" : model.grounding.state === "partial" ? "◐" : "✕"}
              </span>
              <span>
                {model.grounding.state === "grounded"
                  ? "Grounded — every claim below resolved to an indexed line."
                  : model.grounding.state === "partial"
                    ? "Partial — some of this run is not fully known, and it says which part."
                    : "Refused — there is nothing to cite from, so nothing is claimed."}
              </span>
            </p>
            <p className="honest-detail">{model.grounding.detail}</p>
            {/* Warnings VERBATIM (operator-only ones, which name env vars, are filtered in the model
                and restated by the banners). Softening a warning is how a degraded run looks fine. */}
            {model.warnings.length > 0 ? (
              <ul className="honest-detail honest-warnings">
                {model.warnings.slice(0, 3).map((warning) => (
                  <li key={warning}>· {warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        <div className="card-right">
          <RadialGraph
            model={graph}
            selectedId={selectedId}
            onSelect={onSelect}
            assembled={rail.phase !== "waiting"}
            caption="Dependency graph · rings = how foundational"
            readout={
              selected
                ? `${moduleLabel(selected.id)} → ${count(importers)} importer${importers === 1 ? "" : "s"} · ${domainOf}`
                : `${count(graph.nodeCount)} modules · ${count(graph.linkCount)} file-to-file edges${
                    graph.unresolvedCount > 0 ? ` · ${count(graph.unresolvedCount)} unresolved` : ""
                  }`
            }
          />
          {/* The answer sits under the graph it was drawn from, as the design lays it out. */}
          <RailContext.Provider value={context}>{ask ?? null}</RailContext.Provider>
        </div>
      </div>
    </div>
  );
}

/**
 * The grounded-answer block under the card.
 *
 * `answer` is null before anyone has asked. That renders as a prompt, not as a sample answer: a
 * pre-filled "here is what we found" would be the prototype's hardwired copy shipped as output.
 */
export interface AskBlockProps {
  suggestions: readonly string[];
  question: string | null;
  answer: {
    text: string;
    answered: boolean;
    citations: Array<{ fileId: string; startLine?: number; endLine?: number }>;
  } | null;
  busy: boolean;
  disabledReason: string | null;
  onAsk(question: string): void;
  result: AnalysisResult;
}

export function AskBlock({
  suggestions,
  question,
  answer,
  busy,
  disabledReason,
  onAsk,
  result,
}: AskBlockProps) {
  const rail = useContext(RailContext);
  return (
    <section className="ask" aria-label="Ask the repository">
      <div className="ask-head">
        <span className="ask-kicker">Ask //</span>
        {question ? (
          <span className="ask-question">{question}</span>
        ) : (
          <div className="ask-suggestions">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="chip"
                disabled={busy || disabledReason !== null}
                onClick={() => onAsk(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
        {busy ? <span className="spinner" aria-label="Answering" /> : null}
      </div>
      {/* Only when the index was capped: a question about an unindexed file would otherwise get a
          refusal that looks like the product failing rather than a stated limit. */}
      {ragCoverageNote(result) && !disabledReason ? <p className="ask-coverage">{ragCoverageNote(result)}</p> : null}

      {disabledReason ? (
        <SpokenText className="ask-body" refused text={disabledReason} />
      ) : answer ? (
        <>
          <SpokenText className="ask-body" refused={!answer.answered} text={answer.text} />
          {answer.citations.length > 0 && rail.phase === "done" ? (
            <div className="cited" data-arrive={rail.animate}>
              <span className="cited-label" aria-hidden="true">
                ⌗ cited
              </span>
              {answer.citations.map((citation) => (
                <CitationChip
                  key={`${citation.fileId}:${citation.startLine ?? 0}`}
                  fileId={citation.fileId}
                  {...(citation.startLine !== undefined ? { startLine: citation.startLine } : {})}
                  {...(citation.endLine !== undefined ? { endLine: citation.endLine } : {})}
                  repository={result.repository}
                  commitSha={result.commitSha ?? null}
                />
              ))}
            </div>
          ) : answer.answered ? null : (
            // An answered:false response with no citations is the honest-refusal path, and saying so
            // is better than an empty chip row that looks like a rendering bug.
            <p className="honest-detail" style={{ margin: "12px 0 0" }}>
              No citation resolved, so nothing was claimed.
            </p>
          )}
        </>
      ) : (
        <SpokenText
          className="ask-body"
          refused
          text="Ask anything about this repository. Every answer cites the file and line it read, or refuses."
        />
      )}
    </section>
  );
}

/**
 * A paragraph that is TYPED OUT inside the card's replay and simply rendered everywhere else.
 *
 * The full sentence is always in the accessibility tree (an sr-only copy); the typed characters are
 * `aria-hidden`, so a screen reader never reads half a sentence that happens to be mid-animation.
 */
function SpokenText({ text, refused, className }: { text: string; refused: boolean; className: string }) {
  const rail = useContext(RailContext);
  const speaking = rail.animate && (rail.phase === "typing" || rail.phase === "done");
  const typed = useTypewriter(text, speaking);
  const { onTyped, phase } = rail;

  useEffect(() => {
    if (rail.animate && phase === "typing" && typed.done) onTyped();
  }, [rail.animate, phase, typed.done, onTyped]);

  if (!rail.animate) {
    return (
      <p className={className} data-refused={refused}>
        {text}
      </p>
    );
  }
  return (
    <p className={className} data-refused={refused} data-typing={speaking && !typed.done}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{typed.shown}</span>
    </p>
  );
}
