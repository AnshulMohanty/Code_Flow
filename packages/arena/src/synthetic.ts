import { buildImportGraph, getTransitiveDependencies } from "@codeflow/graph";
import type { AnalysisResult } from "@codeflow/shared-types";
import type { OracleQuestionKind, TaskSpec } from "./contracts.js";
import { truthFor } from "./verifiers/graphOracle.js";

/**
 * THE SYNTHETIC-DATA FLYWHEEL (V3-P2, task 4 — design doc §5.3.3).
 *
 * THE PROBLEM IT SOLVES. The golden set is 18 authored questions across two repositories,
 * because authoring ground truth by hand is slow and every question costs a human reading
 * code. That ceiling is the real limit on how much the eval can tell us — and it does not
 * scale to a new repository at all.
 *
 * THE OBSERVATION THAT BREAKS IT. For a whole class of questions the answer is ALREADY A FACT
 * in the analysis result. "Which files import `src/db.ts`?" is not a matter of opinion; it is a
 * set of edges. So for those questions we can generate the question AND its exact label, for
 * any indexed repository, for free, with no model and no human.
 *
 * THE RULE THAT MAKES IT TRUSTWORTHY: **labels come from the ORACLE, never from a model.**
 * `truthFor` derives the answer from the graph with the same traversals the product uses. A
 * model-labelled synthetic set would be a way of measuring how well retrieval agrees with a
 * model's guesses — which is not what an eval is for, and is worse than no eval because it
 * looks like one. Everything generated here is exact or it is not generated.
 *
 * DETERMINISM. No RNG anywhere. Targets are selected by a documented, stated ordering (degree
 * descending, then fileId ascending) and truncated — so the same result always produces the
 * same questions in the same order, and two runs of the eval are comparable.
 *
 * WHAT IT CANNOT DO, stated plainly: it generates only questions the graph can answer exactly.
 * It cannot generate "why is this designed this way", "is this code correct", or anything
 * needing judgement. It grows the mechanical half of the eval so human authoring effort can go
 * entirely to the half that needs a human. It does not replace the authored golden set.
 */

/** One generated question, with its oracle-derived label and mined hard negatives. */
export interface SyntheticQuestion {
  /** Deterministic: `syn-<kind>-<n>`, numbered in generation order. */
  id: string;
  /** Natural-language phrasing — what a retrieval system actually receives. */
  question: string;
  kind: OracleQuestionKind;
  /** The file the question is about. Absent for `entry-points`, which is repo-wide. */
  fileId?: string;
  /**
   * The EXACT answer, derived from the graph. Sorted. May be empty — see `negativeControl`.
   */
  expectedFileIds: string[];
  /**
   * True when the exact answer is the EMPTY SET, e.g. "which files import this?" for a file
   * nothing imports. These are the most valuable questions the flywheel produces: a correct
   * answer is a refusal, and they are generated with certainty rather than guessed at.
   */
  negativeControl: boolean;
  /**
   * HARD NEGATIVES: files that are plausible, adjacent, and WRONG — mined from the graph, one
   * strategy per question kind (see `mineHardNegatives`). Guaranteed disjoint from
   * `expectedFileIds`.
   *
   * Random negatives teach nothing: any retriever separates `src/db.ts` from `README.md`. A
   * hard negative is a file in the same neighbourhood, or the same relationship in the wrong
   * DIRECTION — which is exactly what a retriever confuses.
   */
  hardNegativeFileIds: string[];
  /** Why those negatives are hard, for a human reading the generated set. */
  hardNegativeStrategy: string;
}

export interface GenerateSyntheticOptions {
  result: AnalysisResult;
  /** Which kinds to generate. Defaults to all five the oracle can answer exactly. */
  kinds?: readonly OracleQuestionKind[];
  /** Max questions per kind. Default 5. */
  perKind?: number;
  /** Max hard negatives per question. Default 3. */
  hardNegativesPerQuestion?: number;
  /**
   * Max generated negative controls (empty-answer questions) per kind. Default 1.
   *
   * Bounded on purpose: in most repositories the majority of files are imported by nobody, so
   * an unbounded generator would produce a set that is almost entirely refusals — and a
   * retrieval score dominated by refusals says nothing about retrieval.
   */
  negativeControlsPerKind?: number;
}

const ALL_KINDS: readonly OracleQuestionKind[] = [
  "imports-of",
  "who-calls",
  "blast-radius",
  "cycle-through",
  "entry-points",
];

const DEFAULT_PER_KIND = 5;
const DEFAULT_HARD_NEGATIVES = 3;
const DEFAULT_NEGATIVE_CONTROLS = 1;

/**
 * Natural-language templates, one per kind.
 *
 * Phrased the way a developer asks, not the way the graph stores it — "what breaks if I change
 * X" rather than "reverse transitive closure of X". The point of a retrieval eval is to test
 * retrieval against real phrasing; a question worded in the schema's own vocabulary would be
 * trivially easy and would measure nothing.
 */
function phrase(kind: OracleQuestionKind, fileId?: string): string {
  switch (kind) {
    case "imports-of":
      return `Which files import ${fileId}?`;
    case "who-calls":
      return `Which files call into ${fileId}?`;
    case "blast-radius":
      return `What breaks if I change ${fileId}?`;
    case "cycle-through":
      return `Which files are in a dependency cycle with ${fileId}?`;
    case "entry-points":
      return "Where does execution start in this repository?";
    default:
      return "";
  }
}

/**
 * Generate questions with exact labels from an analysis result. Pure and deterministic.
 */
export function generateSyntheticQuestions(options: GenerateSyntheticOptions): SyntheticQuestion[] {
  const { result } = options;
  const kinds = options.kinds ?? ALL_KINDS;
  const perKind = options.perKind ?? DEFAULT_PER_KIND;
  const negativeControlsPerKind = options.negativeControlsPerKind ?? DEFAULT_NEGATIVE_CONTROLS;
  const hardNegativeCount = options.hardNegativesPerQuestion ?? DEFAULT_HARD_NEGATIVES;

  const candidates = orderedCandidates(result);
  const out: SyntheticQuestion[] = [];

  for (const kind of kinds) {
    if (kind === "entry-points") {
      // Repo-wide: exactly one question, and only when the repo actually has entry points.
      const truth = truthFor("entry-points", result);
      if (truth.length === 0) continue;
      out.push(
        build({
          kind,
          index: 0,
          expectedFileIds: truth,
          result,
          hardNegativeCount,
        }),
      );
      continue;
    }

    let answered = 0;
    let negatives = 0;
    for (const fileId of candidates) {
      if (answered >= perKind && negatives >= negativeControlsPerKind) break;
      const truth = truthFor(kind, result, fileId);
      const isNegative = truth.length === 0;
      if (isNegative) {
        if (negatives >= negativeControlsPerKind) continue;
        negatives += 1;
      } else {
        if (answered >= perKind) continue;
        answered += 1;
      }
      out.push(
        build({
          kind,
          index: out.length,
          fileId,
          expectedFileIds: truth,
          result,
          hardNegativeCount,
        }),
      );
    }
  }

  // Renumber in final order so ids are stable and readable (`syn-imports-of-0`, ...).
  const perKindCounter = new Map<OracleQuestionKind, number>();
  return out.map((question) => {
    const n = perKindCounter.get(question.kind) ?? 0;
    perKindCounter.set(question.kind, n + 1);
    return { ...question, id: `syn-${question.kind}-${n}` };
  });
}

interface BuildArgs {
  kind: OracleQuestionKind;
  index: number;
  fileId?: string;
  expectedFileIds: string[];
  result: AnalysisResult;
  hardNegativeCount: number;
}

function build(args: BuildArgs): SyntheticQuestion {
  const mined = mineHardNegatives(args);
  return {
    id: `syn-${args.kind}-${args.index}`,
    question: phrase(args.kind, args.fileId),
    kind: args.kind,
    ...(args.fileId ? { fileId: args.fileId } : {}),
    expectedFileIds: args.expectedFileIds,
    negativeControl: args.expectedFileIds.length === 0,
    hardNegativeFileIds: mined.fileIds,
    hardNegativeStrategy: mined.strategy,
  };
}

/**
 * Candidate target files, in a DETERMINISTIC order: total degree descending, then fileId
 * ascending.
 *
 * Degree-first is a deliberate bias, not a convenience. A file nothing touches produces a
 * question with an empty answer, and a set of those measures nothing; the well-connected files
 * are where imports, calls, blast radius and cycles all actually have content. Sorting by
 * fileId alone would generate questions about alphabetically-early leaf files.
 */
function orderedCandidates(result: AnalysisResult): string[] {
  const degree = new Map<string, number>();
  for (const node of result.graph?.nodes ?? []) degree.set(node.id, 0);
  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
  for (const edge of result.graph?.edges ?? []) {
    bump(edge.from);
    bump(edge.to);
  }
  for (const edge of result.graph?.cpgEdges ?? []) {
    bump(edge.from);
    bump(edge.to);
  }
  return [...degree.keys()].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b));
}

/**
 * Mine plausible-but-wrong files, with a strategy chosen per kind.
 *
 * The unifying idea: every strategy below picks files that are either the SAME RELATIONSHIP IN
 * THE WRONG DIRECTION, or in the SAME NEIGHBOURHOOD without the relationship. Those are the two
 * ways a retriever actually goes wrong on graph questions, and a negative that does not
 * represent a real confusion is a negative that costs compute and teaches nothing.
 *
 * Every result is filtered to exclude the target itself and everything in the truth set, so a
 * "negative" can never secretly be a correct answer.
 */
export function mineHardNegatives(args: BuildArgs): { fileIds: string[]; strategy: string } {
  const { kind, fileId, expectedFileIds, result } = args;
  const forbidden = new Set([...(fileId ? [fileId] : []), ...expectedFileIds]);
  const take = (ids: string[], strategy: string) => ({
    fileIds: [...new Set(ids)].filter((id) => !forbidden.has(id)).sort().slice(0, args.hardNegativeCount),
    strategy,
  });

  switch (kind) {
    case "imports-of": {
      // THE REVERSE DIRECTION. Files that the target imports — the single most common confusion
      // in "who depends on what", and a retriever that only knows "these two files are related"
      // cannot tell them apart.
      if (!fileId) return take([], "none");
      const outgoing = (result.graph?.edges ?? []).filter((edge) => edge.from === fileId).map((edge) => edge.to);
      return take(outgoing, "files the target IMPORTS (the reverse direction of the question)");
    }

    case "who-calls": {
      // SAME COMMUNITY, NO CALL EDGE. Louvain communities are low-coupling by construction, so
      // a same-community file is genuinely nearby in the code's own structure — and a retriever
      // working from semantic similarity will happily return it.
      if (!fileId) return take([], "none");
      const community = sameCommunity(result, fileId);
      const callers = new Set((result.graph?.cpgEdges ?? []).filter((edge) => edge.to === fileId).map((edge) => edge.from));
      return take(
        community.filter((id) => !callers.has(id)),
        "same Louvain community, but with no call edge into the target",
      );
    }

    case "blast-radius": {
      // UPSTREAM instead of downstream. The target's transitive DEPENDENCIES are exactly the
      // files a reader confuses with its dependents — same subgraph, opposite arrow.
      if (!fileId || !result.graph) return take([], "none");
      const live = buildImportGraph({ nodes: result.graph.nodes, edges: result.graph.edges });
      const upstream = getTransitiveDependencies(live, fileId).map((entry) => entry.node.id);
      return take(upstream, "the target's transitive DEPENDENCIES (upstream, not downstream)");
    }

    case "cycle-through": {
      // Same community, not in a cycle with the target. Cycle membership is a strong structural
      // claim that a similarity-based retriever has no way to check.
      if (!fileId) return take([], "none");
      return take(sameCommunity(result, fileId), "same Louvain community, but not in a cycle with the target");
    }

    case "entry-points": {
      // The MOST CONNECTED non-entry-point files. Hubs look like entry points to anything
      // reasoning from centrality, and telling them apart is the actual skill being tested.
      const entries = new Set(expectedFileIds);
      return take(
        orderedCandidates(result).filter((id) => !entries.has(id)),
        "the most-connected files that are NOT entry points (hubs look like entry points)",
      );
    }

    default:
      return take([], "none");
  }
}

/** Members of the target's Louvain community, excluding the target. Empty when the result has
 *  no cluster assignment (a pre-V3-P1 analysis, or a graph with no edges). */
function sameCommunity(result: AnalysisResult, fileId: string): string[] {
  const clusters = result.metrics?.clusters;
  if (!clusters) return [];
  const own = clusters.assignments.find((entry) => entry.fileId === fileId);
  if (!own) return [];
  return clusters.assignments
    .filter((entry) => entry.cluster === own.cluster && entry.fileId !== fileId)
    .map((entry) => entry.fileId);
}

/**
 * Convert generated questions into Arena `TaskSpec`s, so the same set can be run through the
 * graph-oracle verifier — including against itself.
 *
 * That round trip is the flywheel's own correctness check: run the oracle AS the agent over
 * these tasks and every one must score exactly 1.0. If it ever does not, the generator and the
 * verifier have drifted apart, and every synthetic label is suspect.
 */
export function toTaskSpecs(questions: readonly SyntheticQuestion[], result: AnalysisResult): TaskSpec[] {
  return questions.map((question) => ({
    id: question.id,
    question: question.question,
    repo: result.repository,
    commitSha: result.commitSha ?? "",
    oracle: { kind: question.kind, ...(question.fileId ? { fileId: question.fileId } : {}) },
    expected: { fileIds: question.expectedFileIds },
  }));
}

/** Counts worth reporting when a generated set is produced. */
export interface SyntheticSummary {
  total: number;
  byKind: Record<string, number>;
  negativeControls: number;
  withHardNegatives: number;
  totalHardNegatives: number;
}

export function summarizeSynthetic(questions: readonly SyntheticQuestion[]): SyntheticSummary {
  const byKind: Record<string, number> = {};
  let negativeControls = 0;
  let withHardNegatives = 0;
  let totalHardNegatives = 0;
  for (const question of questions) {
    byKind[question.kind] = (byKind[question.kind] ?? 0) + 1;
    if (question.negativeControl) negativeControls += 1;
    if (question.hardNegativeFileIds.length > 0) withHardNegatives += 1;
    totalHardNegatives += question.hardNegativeFileIds.length;
  }
  return { total: questions.length, byKind, negativeControls, withHardNegatives, totalHardNegatives };
}
