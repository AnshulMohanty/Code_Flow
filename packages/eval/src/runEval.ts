import type { AnalysisResult, Rag } from "@codeflow/shared-types";
import { assertEmbeddingSpace, type EmbeddingClient } from "@codeflow/analyzers";
import type { EvalDataset } from "./dataset.js";
import {
  aggregateRag,
  scoreQuestion,
  scoreSynthesis,
  type PerQuestionResult,
  type RagScores,
  type SynthesisScores,
} from "./score.js";
import { EVAL_THRESHOLDS, type EvalThresholds } from "./thresholds.js";

export interface EvalReport {
  evalSchemaVersion: number;
  repoUrl: string;
  commitSha: string;
  embeddingModel: string;
  embeddingDim: number;
  synthesisScores: SynthesisScores;
  /** Null when the dataset has no questions (nothing to retrieve). */
  ragScores: RagScores | null;
  perQuestion: PerQuestionResult[];
  thresholds: { passed: boolean; failures: string[] };
  summary: string;
}

export interface RunEvalOptions {
  /** Override the synthesis recall@k (defaults to the threshold's k). */
  synthesisK?: number;
  /** Override the RAG recall@k (defaults to the threshold's k). */
  ragK?: number;
  /** Override thresholds (tests). Defaults to EVAL_THRESHOLDS. */
  thresholds?: EvalThresholds;
}

/**
 * Score a pipeline `AnalysisResult` against an authored `EvalDataset`. Pure + deterministic
 * given a deterministic embedding client. Builds a plain-serializable `EvalReport`.
 *
 * HOMOGENEITY GUARD (mandatory — same trap as P12): the query embedding MUST use the same
 * model/dim as the index it is scored against. The runner fails loud if the embedding
 * client OR the index disagrees with the dataset's `embeddingModel`/`embeddingDim` — cosine
 * across two embedding spaces is meaningless, so we never silently score garbage.
 *
 * Index-build only consumer: this uses the `retrieve` primitive, NOT an answer/cite path
 * (that is P18).
 */
export async function runEval(
  dataset: EvalDataset,
  result: AnalysisResult,
  embeddingClient: EmbeddingClient,
  options: RunEvalOptions = {},
): Promise<EvalReport> {
  const thresholds = options.thresholds ?? EVAL_THRESHOLDS;
  const synthesisK = options.synthesisK ?? thresholds.readingOrderRecallAtK.k;
  const ragK = options.ragK ?? thresholds.ragRecallAtK.k;

  // --- Synthesis scoring ----------------------------------------------------
  const synthesis = result.ai?.synthesis;
  if (!synthesis) {
    throw new Error("Cannot grade synthesis: result.ai.synthesis is missing (the synthesize stage did not run).");
  }
  const nodeIds = new Set((result.files ?? []).map((file) => file.id));
  const keyFiles = result.metrics?.keyFiles ?? [];
  const synthesisScores = scoreSynthesis(synthesis, keyFiles, nodeIds, dataset.synthesis.expectedEntryPoints, synthesisK);

  // --- RAG retrieval scoring (only if the dataset has questions) -------------
  let ragScores: RagScores | null = null;
  let perQuestion: PerQuestionResult[] = [];
  if (dataset.questions.length > 0) {
    const rag = result.ai?.rag;
    if (!rag) {
      throw new Error("Cannot grade RAG: result.ai.rag is missing (the RAG stage did not run).");
    }
    assertHomogeneity(embeddingClient, dataset, rag);

    // Embed every question on the QUERY side (matches the document-side index build).
    const { vectors: queryVectors } = await embeddingClient.embed({
      texts: dataset.questions.map((q) => q.question),
      inputType: "query",
    });
    perQuestion = dataset.questions.map((question, i) => scoreQuestion(question, rag.chunks, queryVectors[i], ragK));
    ragScores = aggregateRag(perQuestion, ragK);
  }

  const thresholdResult = evaluateThresholds(synthesisScores, ragScores, thresholds);

  return {
    evalSchemaVersion: dataset.evalSchemaVersion,
    repoUrl: dataset.repoUrl,
    commitSha: dataset.commitSha,
    embeddingModel: dataset.embeddingModel,
    embeddingDim: dataset.embeddingDim,
    synthesisScores,
    ragScores,
    perQuestion,
    thresholds: thresholdResult,
    summary: buildSummary(dataset, synthesisScores, ragScores, thresholdResult),
  };
}

/**
 * Fail loud when the query embedding space ≠ the index/dataset space. The client-vs-space check
 * reuses the SHARED `assertEmbeddingSpace` helper (one homogeneity guard for eval + production);
 * the index-vs-dataset check is a space-vs-space comparison kept here.
 */
export function assertHomogeneity(client: EmbeddingClient, dataset: EvalDataset, rag: Rag): void {
  assertEmbeddingSpace(client, dataset, "dataset's space");
  if (rag.embeddingModel !== dataset.embeddingModel || rag.embeddingDim !== dataset.embeddingDim) {
    throw new Error(
      `Index (model ${rag.embeddingModel}, dim ${rag.embeddingDim}) does not match the dataset's space ` +
        `(model ${dataset.embeddingModel}, dim ${dataset.embeddingDim}). Re-index or re-author the dataset.`,
    );
  }
}

function evaluateThresholds(
  synthesisScores: SynthesisScores,
  ragScores: RagScores | null,
  thresholds: EvalThresholds,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  if (synthesisScores.readingOrderRecallAtK < thresholds.readingOrderRecallAtK.min) {
    failures.push(
      `readingOrderRecall@${synthesisScores.k} ${fmt(synthesisScores.readingOrderRecallAtK)} < ${thresholds.readingOrderRecallAtK.min}`,
    );
  }
  if (synthesisScores.droppedCitationsRate > thresholds.maxDroppedCitationsRate) {
    failures.push(`droppedCitationsRate ${fmt(synthesisScores.droppedCitationsRate)} > ${thresholds.maxDroppedCitationsRate}`);
  }
  if (ragScores && ragScores.meanRecallAtK < thresholds.ragRecallAtK.min) {
    failures.push(`ragRecall@${ragScores.k} ${fmt(ragScores.meanRecallAtK)} < ${thresholds.ragRecallAtK.min}`);
  }
  return { passed: failures.length === 0, failures };
}

function buildSummary(
  dataset: EvalDataset,
  synthesisScores: SynthesisScores,
  ragScores: RagScores | null,
  thresholdResult: { passed: boolean; failures: string[] },
): string {
  const ragPart = ragScores
    ? `RAG recall@${ragScores.k} ${fmt(ragScores.meanRecallAtK)}, MRR ${fmt(ragScores.mrr)} over ${ragScores.questionCount}q`
    : "no questions";
  return (
    `${dataset.repoUrl}@${dataset.commitSha.slice(0, 12)} — ` +
    `synthesis recall@${synthesisScores.k} ${fmt(synthesisScores.readingOrderRecallAtK)}, ${ragPart} — ` +
    `${thresholdResult.passed ? "PASS" : `FAIL (${thresholdResult.failures.length})`}`
  );
}

function fmt(value: number): string {
  return value.toFixed(3);
}
