import type { AnalysisResult } from "@codeflow/shared-types";
import { RadialGraph } from "./RadialGraph";
import { Hud } from "./Hud";
import { CitationChip } from "./Citation";
import type { GraphModel } from "../lib/graphModel";
import { count, formatMs, NOT_MEASURED, type SiteModel } from "../lib/siteModel";
import { moduleLabel } from "../lib/citation";

/**
 * THE DARK WORKBENCH CARD — the design's centrepiece, embedded in the light page.
 *
 * Header `cartograph run — <repo>` · HUD · replay. Left: the six pipeline rows with their REAL
 * per-stage milliseconds and an honest-state line. Right: the radial graph. Below: one grounded
 * answer with its citation chips.
 *
 * EVERY NUMBER IN HERE IS READ, and the ones that are not measured render as an em-dash — including
 * the `ground —` row the design shows, which is not a spinner but a fact about a run with no chat
 * provider configured. See `siteModel.ts` for the row→stage mapping.
 */

export interface PipelineCardProps {
  model: SiteModel;
  graph: GraphModel;
  result: AnalysisResult;
  jobId: string | null;
  selectedId: string | null;
  onSelect(fileId: string | null): void;
  /** Re-run the analysis. Absent ⇒ no replay control (nothing to re-run). */
  onReplay?: (() => void) | undefined;
  /** The grounded answer block. Optional so the card is reusable in the workbench without it. */
  ask?: React.ReactNode;
}

export function PipelineCard({
  model,
  graph,
  result,
  jobId,
  selectedId,
  onSelect,
  onReplay,
  ask,
}: PipelineCardProps) {
  const selected = selectedId ? graph.nodes.find((node) => node.id === selectedId) : null;
  const importers = selectedId ? graph.links.filter((link) => link.target === selectedId).length : 0;
  const domainOf = selected?.role ?? null;

  return (
    <div className="card dark">
      <header className="card-bar">
        <span className="card-lights" aria-hidden="true">
          <span className="card-light" />
          <span className="card-light" />
          <span className="card-light" />
        </span>
        <span className="card-title">cartograph run — {model.repoFullName}</span>
        <div className="card-bar-right">
          <Hud numbers={model.numbers} jobId={jobId} />
          {onReplay ? (
            <button type="button" className="chip-btn" onClick={onReplay}>
              <span aria-hidden="true">↻</span> replay
            </button>
          ) : null}
        </div>
      </header>

      <div className="card-body">
        <div className="card-left">
          <p className="panel-label">
            Pipeline
            <span className="panel-label-right mono">{formatMs(model.totalMs)} total</span>
          </p>

          <ol className="rows" aria-label="Pipeline stages">
            {model.rows.map((row, index) => (
              <li className="row" key={row.id} data-status={row.status}>
                <span className="row-num">{String(index + 1).padStart(2, "0")}</span>
                <span className="row-name">{row.label}</span>
                <span className="row-detail" title={row.detail ?? undefined}>
                  {row.detail ?? ""}
                </span>
                <span className="row-ms">
                  {row.status === "failed" ? "failed" : row.durationMs === null ? NOT_MEASURED : `${row.durationMs}ms`}
                </span>
              </li>
            ))}
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
            {/* Warnings VERBATIM. Softening a warning in a UI is how a degraded run looks fine. */}
            {model.warnings.length > 0 ? (
              <ul className="honest-detail" style={{ listStyle: "none", padding: 0, margin: "8px 0 0 26px" }}>
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
            caption="Dependency graph · rings = how foundational"
            readout={
              selected
                ? `${moduleLabel(selected.id)} → ${count(importers)} importer${importers === 1 ? "" : "s"} · ${domainOf}`
                : `${count(graph.nodeCount)} modules · ${count(graph.linkCount)} resolved edges${
                    graph.unresolvedCount > 0 ? ` · ${count(graph.unresolvedCount)} unresolved` : ""
                  }`
            }
          />
        </div>
      </div>

      {ask ?? null}
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

      {disabledReason ? (
        <p className="ask-body" data-refused="true">
          {disabledReason}
        </p>
      ) : answer ? (
        <>
          <p className="ask-body" data-refused={!answer.answered}>
            {answer.text}
          </p>
          {answer.citations.length > 0 ? (
            <div className="cited">
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
        <p className="ask-body" data-refused="true">
          Ask anything about this repository. Every answer cites the file and line it read, or refuses.
        </p>
      )}
    </section>
  );
}
