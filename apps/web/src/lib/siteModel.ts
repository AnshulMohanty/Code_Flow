import type { AnalysisResult, PipelineStageId, RunMode, StageRunRecord } from "@codeflow/shared-types";

/**
 * THE MEASURED READ-MODEL (V3-FINAL) — every number the site and workbench chrome display.
 *
 * ONE RULE, and it is the whole reason this file exists: a figure is either read from something the
 * pipeline actually produced, or it is `null` and renders as an em-dash. There is no third branch.
 * The design shows confident numbers in large type — files parsed, edges resolved, p50 latency, cost
 * per index — and large type is exactly where a plausible-looking guess does the most damage. So the
 * types below make "not measured" a first-class value rather than something a component has to
 * remember to handle.
 *
 * The PROTOTYPE's numbers (12,481 files · 38,204 edges · 412ms · $0.19) are sample data for
 * `vercel/next.js`. They are the visual contract for LAYOUT and never appear in a shipped view.
 */

// ── The six-stage pipeline the design draws ──────────────────────────────────

/**
 * The design's pipeline card has six rows: clone / parse / resolve / index / embed / ground.
 *
 * The real pipeline has EIGHT stages, and the mapping is not cosmetic — it is stated here so the row
 * a user reads is traceable to the stage that produced its number:
 *
 *   clone   ← ingest                     (the clone IS ingest's work)
 *   parse   ← map-structure + inventory  (discovery + symbol extraction: one "parse" to a reader)
 *   resolve ← connect                    (the import graph)
 *   index   ← analyze                    (metrics + the symbol/centrality tables)
 *   embed   ← rag                        (chunk + embed)
 *   ground  ← synthesize                 (the citation index is sealed when synthesis grounds)
 *
 * A row whose stages did not run reports `status: "skipped"` and renders an em-dash, which is what
 * the design's `ground —` state is: not a spinner, a fact about a run that had no AI configured.
 */
export const PIPELINE_ROWS = [
  { id: "clone", label: "clone", stages: ["ingest"] },
  { id: "parse", label: "parse", stages: ["map-structure", "inventory"] },
  { id: "resolve", label: "resolve", stages: ["connect"] },
  { id: "index", label: "index", stages: ["analyze"] },
  { id: "embed", label: "embed", stages: ["rag"] },
  { id: "ground", label: "ground", stages: ["synthesize"] },
] as const satisfies ReadonlyArray<{ id: string; label: string; stages: readonly PipelineStageId[] }>;

export type PipelineRowId = (typeof PIPELINE_ROWS)[number]["id"];

export type PipelineRowStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface PipelineRow {
  id: PipelineRowId;
  label: string;
  /** The one-line detail the design shows, built from real counts. Null when nothing is known yet. */
  detail: string | null;
  /** Summed real duration of the contributing stages. Null until at least one has finished. */
  durationMs: number | null;
  status: PipelineRowStatus;
}

// ── The four headline stats ──────────────────────────────────────────────────

export interface MeasuredStat {
  label: string;
  /** Null ⇒ the view renders an em-dash. Never a placeholder. */
  value: number | null;
  /** How to render it. */
  format: "count" | "ms" | "usd";
  /** Shown when `value` is null: WHY it is not known. A blank em-dash is honest but unhelpful. */
  absentReason?: string;
  /** For a cost: false when any contributing usage was a provider estimate. */
  measured?: boolean;
}

export interface RunNumbers {
  filesParsed: MeasuredStat;
  edgesResolved: MeasuredStat;
  p50AnswerMs: MeasuredStat;
  costPerIndex: MeasuredStat;
}

// ── Grounding state ─────────────────────────────────────────────────────────

export type GroundingState = "grounded" | "partial" | "refused";

export interface GroundingReport {
  state: GroundingState;
  headline: string;
  /** The honest reason, built from the run's real degradations and resolution counts. */
  detail: string;
}

// ── The whole model ─────────────────────────────────────────────────────────

export interface MetaFacts {
  analyzerVersion: string;
  build: string | null;
  answerLatency: { p50Ms: number | null; p95Ms: number | null; sampleCount: number; scope: string };
  indexed: Array<{ analysisId: string; repoFullName: string; commitSha: string; fileCount: number; completedAt: string }>;
  serverTime: string;
}

export interface SiteModel {
  repoFullName: string;
  commitSha: string | null;
  /** Short sha for chrome. Null when the run recorded none. */
  shortSha: string | null;
  runMode: RunMode | null;
  rows: PipelineRow[];
  numbers: RunNumbers;
  grounding: GroundingReport;
  /** Total wall-clock of the run, summed from real per-stage durations. Null when none finished. */
  totalMs: number | null;
  /** Warnings the run recorded, verbatim. The UI shows them; it does not soften them. */
  warnings: string[];
}

const EM_DASH_REASONS = {
  noRag: "no Q&A index was built on this run",
  noAsk: "nobody has asked a question on this server yet",
  noSpend: "this run made no paid provider call",
  unpriced: "no model price is configured (LLM_PRICING)",
  noRun: "no analysis has been run yet",
} as const;

/**
 * Build the model from a real result plus the server's meta facts.
 *
 * `meta` may be null — the page renders before `/api/meta` resolves — and every figure sourced from
 * it then reports absent rather than zero.
 */
export function buildSiteModel(result: AnalysisResult, meta: MetaFacts | null): SiteModel {
  const records = new Map<PipelineStageId, StageRunRecord>(
    (result.pipeline?.stages ?? []).map((record) => [record.stage, record]),
  );

  const rows = PIPELINE_ROWS.map((row) => buildRow(row, records, result));
  const finished = rows.map((row) => row.durationMs).filter((ms): ms is number => ms !== null);

  return {
    repoFullName: repoName(result),
    commitSha: result.commitSha ?? null,
    shortSha: result.commitSha ? result.commitSha.slice(0, 7) : null,
    runMode: result.runMode ?? null,
    rows,
    numbers: buildNumbers(result, meta),
    grounding: buildGrounding(result),
    totalMs: finished.length > 0 ? finished.reduce((sum, ms) => sum + ms, 0) : null,
    warnings: result.warnings ?? [],
  };
}

function buildRow(
  row: (typeof PIPELINE_ROWS)[number],
  records: Map<PipelineStageId, StageRunRecord>,
  result: AnalysisResult,
): PipelineRow {
  const contributing = row.stages.map((stage) => records.get(stage)).filter((record): record is StageRunRecord => !!record);

  // A row nobody reported on is PENDING; one whose stages were all skipped is SKIPPED. Those are
  // different facts — "still working" versus "never going to run" — and the design's `ground —`
  // state is the second one.
  let status: PipelineRowStatus = "pending";
  if (contributing.length > 0) {
    if (contributing.some((record) => record.status === "failed")) status = "failed";
    else if (contributing.every((record) => record.status === "skipped")) status = "skipped";
    else if (contributing.every((record) => record.status === "completed")) status = "done";
    else status = "running";
  } else if (row.stages.every((stage) => !records.has(stage))) {
    // No record at all for an AI stage means it was never registered (no provider key configured).
    status = row.stages.some((stage) => stage === "rag" || stage === "synthesize") ? "skipped" : "pending";
  }

  const durations = contributing.map((record) => record.durationMs).filter((ms): ms is number => ms !== undefined);

  return {
    id: row.id,
    label: row.label,
    detail: rowDetail(row.id, result, status),
    durationMs: durations.length > 0 ? durations.reduce((sum, ms) => sum + ms, 0) : null,
    status,
  };
}

/**
 * The one-line detail beside a row. Every number here is a real count off a real slice; a row whose
 * slice is absent gets `null` and renders nothing rather than a zero, because "0 files" and "we do
 * not know how many files" are different claims.
 */
function rowDetail(id: PipelineRowId, result: AnalysisResult, status: PipelineRowStatus): string | null {
  switch (id) {
    case "clone": {
      const sha = result.commitSha ? result.commitSha.slice(0, 7) : null;
      return sha ? `git clone --depth=1 · ${sha}` : null;
    }
    case "parse": {
      const files = result.structure?.fileCount ?? result.graph?.nodes.length;
      const symbols = result.inventory?.symbolCount;
      if (files === undefined) return null;
      return symbols === undefined
        ? `tree-sitter · ${count(files)} files`
        : `tree-sitter · ${count(files)} files · ${count(symbols)} symbols`;
    }
    case "resolve": {
      const graph = result.graph;
      if (!graph) return null;
      const unresolved = graph.resolution.unresolved;
      // The unresolved count is REPORTED, not hidden: an import graph with unresolved edges is
      // partially known, and the design's PARTIAL grounding state is about exactly this.
      return unresolved > 0
        ? `import graph · ${count(graph.edges.length)} edges · ${count(unresolved)} unresolved`
        : `import graph · ${count(graph.edges.length)} edges`;
    }
    case "index": {
      const perFile = result.metrics?.perFile.length;
      if (!perFile) return null;
      const clusters = result.metrics?.clusters?.count;
      return clusters ? `metrics · ${count(perFile)} files · ${count(clusters)} communities` : `metrics · ${count(perFile)} files`;
    }
    case "embed": {
      const rag = result.ai?.rag;
      if (!rag) return status === "skipped" ? "no embedding provider configured" : null;
      return `chunks · ${count(rag.chunks.length)} vectors · dim ${rag.embeddingDim}`;
    }
    case "ground": {
      const synthesis = result.ai?.synthesis;
      if (!synthesis) return status === "skipped" ? "no chat provider configured" : null;
      const dropped = synthesis.droppedCitations ?? 0;
      return dropped > 0
        ? `citation index sealed · ${count(dropped)} ungrounded dropped`
        : "citation index sealed";
    }
  }
}

function buildNumbers(result: AnalysisResult, meta: MetaFacts | null): RunNumbers {
  const files = result.structure?.fileCount ?? result.graph?.nodes.length ?? null;
  const edges = result.graph?.resolution.resolved ?? result.graph?.edges.length ?? null;

  const p50 = meta?.answerLatency.p50Ms ?? null;
  const cost = result.cost ?? null;

  return {
    filesParsed: {
      label: "FILES PARSED",
      value: files,
      format: "count",
      ...(files === null ? { absentReason: EM_DASH_REASONS.noRun } : {}),
    },
    edgesResolved: {
      label: "EDGES RESOLVED",
      value: edges,
      format: "count",
      ...(edges === null ? { absentReason: EM_DASH_REASONS.noRun } : {}),
    },
    p50AnswerMs: {
      label: "P50 ANSWER LATENCY",
      value: p50,
      format: "ms",
      ...(p50 === null ? { absentReason: EM_DASH_REASONS.noAsk } : {}),
    },
    costPerIndex: {
      label: "COST PER FULL INDEX",
      // `usd: null` on a real cost means UNPRICED, not free — a distinct absent reason from
      // "nothing was spent", and the two must not collapse into the same em-dash.
      value: cost?.usd ?? null,
      format: "usd",
      ...(cost ? { measured: cost.measured } : {}),
      ...(cost === null
        ? { absentReason: EM_DASH_REASONS.noSpend }
        : cost.usd === null
          ? { absentReason: `${EM_DASH_REASONS.unpriced} for ${cost.unpricedModels.join(", ")}` }
          : {}),
    },
  };
}

/**
 * The three grounding states, wired to the run's ACTUAL mode and degradations.
 *
 * These are not three decorative badges — they are the run's real delivered scope:
 *   GROUNDED  a full run: the deterministic graph resolved and the AI stages ran.
 *   PARTIAL   the deterministic pass held but something was not fully known — unresolved dynamic
 *             imports, or an AI stage that did not run.
 *   REFUSED   the deterministic pass itself failed, so there is nothing to cite from.
 */
function buildGrounding(result: AnalysisResult): GroundingReport {
  const status = result.pipeline?.status;
  const graph = result.graph;

  if (status === "failed" || status === "aborted" || !graph) {
    const reason = result.pipeline?.statusReason;
    return {
      state: "refused",
      headline: "REFUSED",
      detail:
        reason === "budget-exhausted"
          ? "At capacity — the daily budget was reached, and no answer is guessed in the gap."
          : reason === "repo-too-large"
            ? "Repository is over the configured size limit; nothing was indexed rather than partially indexed."
            : (result.warnings ?? [])[0] ?? "A required stage failed, so there is nothing to cite from.",
    };
  }

  const unresolved = graph.resolution.unresolved;
  const degradations = result.degradations ?? [];
  const deterministicOnly = result.runMode === "deterministic-only";

  if (deterministicOnly || unresolved > 0 || degradations.length > 0 || status === "partial") {
    const parts: string[] = [];
    if (unresolved > 0) parts.push(`${count(unresolved)} unresolved import${unresolved === 1 ? "" : "s"} (static pass only)`);
    if (deterministicOnly) parts.push("AI stages did not run, so nothing beyond the deterministic graph is claimed");
    for (const notice of degradations) parts.push(notice.detail);
    return {
      state: "partial",
      headline: "PARTIAL",
      detail: parts.length > 0 ? parts.join(" · ") : "Some of the run was degraded; see the warnings.",
    };
  }

  return {
    state: "grounded",
    headline: "GROUNDED",
    detail: `Resolved from the deterministic import graph — ${count(graph.resolution.resolved)} edges, every one to a real file.`,
  };
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** The em-dash a null figure renders as. One constant, so it cannot drift between views. */
export const NOT_MEASURED = "—";

export function formatStat(stat: MeasuredStat): string {
  if (stat.value === null) return NOT_MEASURED;
  switch (stat.format) {
    case "count":
      return count(stat.value);
    case "ms":
      return `${Math.round(stat.value)}`;
    case "usd":
      // Four decimals, because a single index can legitimately cost fractions of a cent and
      // rounding it to $0.00 would read as free.
      return `$${stat.value.toFixed(stat.value < 0.01 ? 4 : 2)}`;
  }
}

export function formatMs(ms: number | null): string {
  return ms === null ? NOT_MEASURED : `${Math.round(ms)}ms`;
}

function repoName(result: AnalysisResult): string {
  const repo = result.repository;
  return repo.owner ? `${repo.owner}/${repo.name}` : repo.name;
}
