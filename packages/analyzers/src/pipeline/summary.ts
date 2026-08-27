import type { AnalysisResultSlices, AnalysisSummary, PipelineInput } from "@codeflow/shared-types";

/**
 * Derive the `summary` slice at assembly time.
 *
 * No stage OWNS `summary` — it is a pure projection of what the deterministic stages
 * already produced, so deriving it here (rather than adding a ninth stage) keeps stage
 * ownership intact. Every number below is composed from an existing slice; nothing new
 * is measured and no value is fabricated:
 *
 *   files        ← graph.nodes.length          (Connect)
 *   connections  ← graph.edges.length          (Connect)
 *   functions    ← inventory.symbols           (Inventory), kinds "function" + "method"
 *   languages    ← distinct graph.nodes[].language
 *   circularDeps ← metrics.cycles.length       (Analyze)
 *   healthScore  ← metrics.summary             (Analyze) — see scoreHealth
 *
 * A field whose source slice is absent stays honestly empty (0 / undefined / null)
 * rather than being guessed at.
 */
export function deriveSummary(input: PipelineInput, slices: Partial<AnalysisResultSlices>): AnalysisSummary {
  const nodes = slices.graph?.nodes ?? slices.files ?? [];
  const edges = slices.graph?.edges ?? [];
  const symbols = slices.inventory?.symbols ?? [];
  const metrics = slices.metrics;

  // "functions" means callable units: top-level functions plus class methods. Classes,
  // interfaces, types, enums, variables and bare re-exports are NOT callables.
  const functions = symbols.filter((symbol) => symbol.kind === "function" || symbol.kind === "method").length;

  const languages = [...new Set(nodes.map((node) => node.language).filter((value): value is string => !!value))].sort();

  const health = metrics ? scoreHealth(metrics.summary) : null;

  return {
    repository: input.repositoryRef,
    mode: input.mode,
    files: nodes.length,
    functions,
    connections: edges.length,
    healthScore: health?.score ?? null,
    healthGrade: health?.grade ?? null,
    ...(languages.length ? { languages } : {}),
    ...(metrics ? { circularDependencies: metrics.cycles.length } : {}),
  };
}

/** A structural health verdict, or null when there is nothing to score. */
export interface HealthVerdict {
  score: number;
  grade: string;
}

/**
 * Score structural health 10–100 from Analyze's metric summary. Deterministic and
 * composed ONLY of numbers Analyze already computed — this is a weighting of existing
 * facts, not a new measurement.
 *
 * Three penalties, each scaled by repository size so a 20-file repo and a 2000-file repo
 * are judged on the same axis:
 *
 *   cycles     up to 40 pts — cycles ≥ 10% of files ⇒ full penalty (the classic smell)
 *   blast      up to 35 pts — one file transitively reaching every other ⇒ full penalty
 *   isolated   up to 15 pts — every file disconnected ⇒ full penalty
 *
 * Worst case is therefore 10, not 0: a repo that parsed and graphed successfully has
 * demonstrably *some* structure, and a flat 0 reads as a broken metric rather than a bad
 * score. Returns null for an empty graph — nothing to score, so no fabricated grade.
 */
export function scoreHealth(summary: AnalysisResultSlices["metrics"]["summary"]): HealthVerdict | null {
  const fileCount = summary.fileCount;
  if (fileCount <= 0) return null;

  const cyclePenalty = 40 * clamp01((summary.cycleCount / fileCount) * 10);
  const blastPenalty = 35 * clamp01(summary.maxBlastRadius / fileCount);
  const isolatedPenalty = 15 * clamp01(summary.isolatedFileCount / fileCount);

  const score = Math.round(100 - cyclePenalty - blastPenalty - isolatedPenalty);
  return { score, grade: gradeFor(score) };
}

function gradeFor(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? 1 : value;
}
