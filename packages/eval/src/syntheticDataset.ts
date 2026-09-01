import {
  generateSyntheticQuestions,
  summarizeSynthetic,
  type GenerateSyntheticOptions,
  type SyntheticQuestion,
  type SyntheticSummary,
} from "@codeflow/arena";
import type { AnalysisResult } from "@codeflow/shared-types";
import { EVAL_SCHEMA_VERSION, type EvalDataset, type RagEvalQuestion } from "./dataset.js";

/**
 * Turning the flywheel's output into an eval dataset (V3-P2, task 4).
 *
 * The generator lives in `@codeflow/arena` — that is where the oracle is, and the labels come
 * from the oracle. This module is the adapter: it maps oracle-derived answers onto the eval's
 * `RagEvalQuestion` shape so a generated set can be scored by the SAME harness as the authored
 * golden set, with no second scorer to keep in step.
 *
 * ONE THING IS DELIBERATELY NOT DONE HERE: generated datasets are NOT written into
 * `packages/eval/datasets/`. That directory is the AUTHORED golden set — 18 questions a human
 * read code to produce — and its value is that a human stands behind every one. Mixing
 * thousands of machine-generated questions into it would destroy that guarantee and, worse,
 * would let a retrieval score be dominated by the mechanical half of the eval while the
 * judgement half quietly stopped mattering. A generated set is produced on demand, from a
 * result, and reported as its own number.
 */

/** How a synthetic question's hard negatives are recorded in the dataset. */
export interface SyntheticDatasetExtras {
  /** Per question id: the mined hard negatives + why they are hard. */
  hardNegatives: Record<string, { fileIds: string[]; strategy: string }>;
  summary: SyntheticSummary;
}

export interface SyntheticDatasetResult {
  dataset: EvalDataset;
  questions: SyntheticQuestion[];
  extras: SyntheticDatasetExtras;
}

export interface BuildSyntheticDatasetOptions extends Omit<GenerateSyntheticOptions, "result"> {
  result: AnalysisResult;
  /** The embedding space the dataset will be graded in — must match the index it is scored
   *  against, or the homogeneity guard (correctly) refuses to score it. */
  embeddingModel: string;
  embeddingDim: number;
}

/**
 * Build a runnable `EvalDataset` from a result's graph. Deterministic; no model, no network.
 *
 * `synthesis.expectedEntryPoints` is filled from the oracle's `entry-points` answer, which is
 * the same fact the synthesis eval grades against — so a generated dataset exercises both
 * halves of `runEval` rather than only the retrieval half.
 */
export function buildSyntheticDataset(options: BuildSyntheticDatasetOptions): SyntheticDatasetResult {
  const { result, embeddingModel, embeddingDim, ...generateOptions } = options;
  const questions = generateSyntheticQuestions({ result, ...generateOptions });

  const hardNegatives: SyntheticDatasetExtras["hardNegatives"] = {};
  const evalQuestions: RagEvalQuestion[] = questions.map((question) => {
    hardNegatives[question.id] = {
      fileIds: question.hardNegativeFileIds,
      strategy: question.hardNegativeStrategy,
    };
    return {
      id: question.id,
      question: question.question,
      // An EMPTY list is legal and meaningful in this schema: it marks a negative control, i.e.
      // a question whose correct behaviour is a refusal. The flywheel produces those with
      // certainty, which is exactly what makes them worth having.
      expectedFiles: question.expectedFileIds,
    };
  });

  const entryPointQuestion = questions.find((question) => question.kind === "entry-points");

  const dataset: EvalDataset = {
    evalSchemaVersion: EVAL_SCHEMA_VERSION,
    provenance: {
      authoredIn: "V3-P2 task 4 (synthetic-data flywheel)",
      method:
        "GENERATED from the code property graph by @codeflow/arena's graph oracle. Every label is " +
        "derived by `truthFor` — the same traversals the product uses — never by a model. Fully " +
        "deterministic: targets ordered by degree descending then fileId, no RNG.",
      measures:
        "Mechanically-verifiable retrieval only (imports-of / who-calls / blast-radius / " +
        "cycle-through / entry-points). Says NOTHING about questions needing judgement, which is " +
        "what the authored golden set is for.",
      whyThisRepo: "Whichever repository was analysed — the point of the flywheel is that any indexed repo works.",
      thresholdStatus:
        "Not comparable to the authored golden set's thresholds: a different question distribution " +
        "measures a different thing. Track it as its own series.",
    },
    repoUrl: repoUrlOf(result),
    // The eval loader requires a full 40-char hex SHA, for the good reason that ground truth is
    // only meaningful pinned to an exact commit. A result with no SHA cannot produce a dataset.
    commitSha: result.commitSha ?? "",
    embeddingModel,
    embeddingDim,
    synthesis: { expectedEntryPoints: entryPointQuestion?.expectedFileIds ?? [] },
    questions: evalQuestions,
  };

  return { dataset, questions, extras: { hardNegatives, summary: summarizeSynthetic(questions) } };
}

/** Best-effort repo URL from the result's `RepositoryRef`, for the dataset's provenance. */
function repoUrlOf(result: AnalysisResult): string {
  const ref = result.repository;
  if (ref.url) return ref.url;
  if (ref.owner) return `https://github.com/${ref.owner}/${ref.name}`;
  return ref.name;
}

/** One-line summary for a CLI or a log. */
export function summarizeSyntheticDataset(built: SyntheticDatasetResult): string {
  const { summary } = built.extras;
  const kinds = Object.entries(summary.byKind)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");
  return (
    `synthetic set — ${summary.total} question(s) [${kinds}], ` +
    `${summary.negativeControls} negative control(s), ` +
    `${summary.totalHardNegatives} hard negative(s) across ${summary.withHardNegatives} question(s)`
  );
}
