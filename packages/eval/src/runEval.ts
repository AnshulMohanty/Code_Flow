import type { AnalysisResult, Rag } from "@codeflow/shared-types";
import { assertEmbeddingSpace, type EmbeddingClient, type RagAnswer } from "@codeflow/analyzers";
import { vectorRetrieve, type ChunkTextStore, type RetrievedChunk, type VectorStore } from "@codeflow/retrieval";
import {
  aggregateAnswers,
  scoreAnswer,
  type AggregateAnswerScores,
  type PerAnswerResult,
} from "./answerScore.js";
import {
  calibrateJudge,
  judgeIsGateable,
  type Judge,
  type JudgeConcordance,
  type JudgeLabel,
} from "./judge.js";
import type { EvalDataset } from "./dataset.js";
import {
  aggregateRag,
  scoreQuestion,
  scoreSynthesis,
  type PerQuestionResult,
  type RagScores,
  type ScoredCoords,
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
  /**
   * ANSWER-path scores (V3-P0). Null when no `answer` function was supplied — the retrieval
   * half of the eval still runs without one, so an index-only report stays possible.
   */
  answerScores: AggregateAnswerScores | null;
  perAnswer: PerAnswerResult[];
  /** Mean judge faithfulness, or null when no judge ran. */
  judgeFaithfulness: number | null;
  /** The judge's measured agreement with human labels, or null if never calibrated. */
  judgeConcordance: JudgeConcordance | null;
  /** Whether the judge was permitted to affect pass/fail, and why not when it was not. */
  judgeGate: { gateable: boolean; reasons: string[] };
  thresholds: { passed: boolean; failures: string[] };
  summary: string;
}

/** Produces a grounded answer for a question — the production `answerQuestion` path, or a
 *  deterministic fake in tests. Returns the answer AND the chunks it was built from, because
 *  citation validity must be checked against what the model could legitimately have seen. */
export type AnswerRunner = (question: string) => Promise<{ answer: RagAnswer; retrieved: RetrievedChunk[] }>;

/**
 * The stores holding the index being graded (V3-P2). REQUIRED once a dataset has questions,
 * because the vectors are no longer inside the `AnalysisResult`.
 *
 * Passing the interfaces rather than raw vectors is what keeps the eval honest: it drives
 * `vectorRetrieve` — the same function the production Q&A path calls — so recall@k measures
 * production retrieval and not a re-implementation of it. `hydrateEvalIndex` builds the
 * in-memory pair from a sidecar file; pointing this at a live pgvector store is the deferred
 * integration run.
 */
export interface EvalRetrieval {
  vectorStore: VectorStore;
  textStore: ChunkTextStore;
}

export interface RunEvalOptions {
  /** The stores holding the index (V3-P2). Required when the dataset has questions. */
  retrieval?: EvalRetrieval;
  /** Override the synthesis recall@k (defaults to the threshold's k). */
  synthesisK?: number;
  /** Override the RAG recall@k (defaults to the threshold's k). */
  ragK?: number;
  /** Override thresholds (tests). Defaults to EVAL_THRESHOLDS. */
  thresholds?: EvalThresholds;
  /**
   * Score the ANSWER path too. Omit to run the retrieval-only eval (the pre-V3-P0 behaviour),
   * which is what the hermetic CI check does.
   */
  answer?: AnswerRunner;
  /** Grade faithfulness with a judge. Reported always; GATES only if calibrated (below). */
  judge?: Judge;
  /** Human-labeled examples used to calibrate `judge`. WITHOUT these the judge is advisory
   *  only — an uncalibrated judge never fails a threshold. */
  judgeLabels?: JudgeLabel[];
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
  let answerScores: AggregateAnswerScores | null = null;
  const perAnswer: PerAnswerResult[] = [];
  const judgeScores: number[] = [];
  if (dataset.questions.length > 0) {
    const rag = result.ai?.rag;
    if (!rag) {
      throw new Error("Cannot grade RAG: result.ai.rag is missing (the RAG stage did not run).");
    }
    assertHomogeneity(embeddingClient, dataset, rag);
    const retrieval = options.retrieval;
    if (!retrieval) {
      throw new Error(
        "Cannot grade retrieval: no `retrieval` stores were supplied. Since V3-P2 the vectors " +
          "live outside the AnalysisResult, so the harness needs the VectorStore + ChunkTextStore " +
          "holding this index (see `hydrateEvalIndex` for the sidecar-file path).",
      );
    }

    // Embed every question on the QUERY side (matches the document-side index build).
    const { vectors: queryVectors } = await embeddingClient.embed({
      texts: dataset.questions.map((q) => q.question),
      inputType: "query",
    });

    // Retrieve through the PRODUCTION path, once per question, and keep each ranking so the
    // answer-path fallback below scores against the same top-k rather than re-retrieving.
    const rankings: ScoredCoords[][] = [];
    for (let i = 0; i < dataset.questions.length; i++) {
      const found = await vectorRetrieve({ ragIndex: rag, ...retrieval }, { queryVector: queryVectors[i], k: ragK });
      rankings.push(found.chunks);
    }
    perQuestion = dataset.questions.map((question, i) => scoreQuestion(question, rankings[i], ragK));
    ragScores = aggregateRag(perQuestion, ragK);

    // --- Answer-path scoring (V3-P0) ----------------------------------------
    // Retrieval recall says the right chunks were FOUND. This says the answer built from
    // them was grounded and cited real code — the part a user actually reads.
    if (options.answer) {
      for (const [i, question] of dataset.questions.entries()) {
        const produced = await options.answer(question.question);
        // Fall back to the scored top-k when the runner reports no chunk set, so citation
        // validity is still checked against a real retrieval rather than skipped.
        const retrieved: readonly ScoredCoords[] = produced.retrieved.length ? produced.retrieved : rankings[i];
        perAnswer.push(scoreAnswer(question, produced.answer, retrieved));
        if (options.judge) {
          // The judge needs chunk TEXT, which only the answer runner's own retrieval carries
          // (the fallback ranking is coordinates only). Judging with empty text would score
          // faithfulness against nothing, so an answer with no retrieved chunks is skipped.
          const verdict = await options.judge({
            question: question.question,
            answer: produced.answer.answer ?? "",
            chunks: produced.retrieved,
          });
          judgeScores.push(verdict.faithfulness);
        }
      }
      answerScores = aggregateAnswers(perAnswer);
    }
  }

  // --- Judge calibration --------------------------------------------------
  // A judge is reported no matter what, but may only GATE once its agreement with human
  // labels has been measured. An uncalibrated judge is a confident second opinion, not a
  // measurement, and gating on one would quietly make a model's bias the quality bar.
  const judgeConcordance =
    options.judge && options.judgeLabels?.length
      ? await calibrateJudge(options.judge, options.judgeLabels)
      : null;
  const judgeGate = judgeIsGateable(judgeConcordance);
  const judgeFaithfulness = judgeScores.length
    ? judgeScores.reduce((sum, value) => sum + value, 0) / judgeScores.length
    : null;

  const thresholdResult = evaluateThresholds(synthesisScores, ragScores, answerScores, thresholds, {
    judgeFaithfulness,
    judgeGate,
  });

  return {
    evalSchemaVersion: dataset.evalSchemaVersion,
    repoUrl: dataset.repoUrl,
    commitSha: dataset.commitSha,
    embeddingModel: dataset.embeddingModel,
    embeddingDim: dataset.embeddingDim,
    synthesisScores,
    ragScores,
    perQuestion,
    answerScores,
    perAnswer,
    judgeFaithfulness,
    judgeConcordance,
    judgeGate,
    thresholds: thresholdResult,
    summary: buildSummary(dataset, synthesisScores, ragScores, answerScores, judgeFaithfulness, judgeGate, thresholdResult),
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
  answerScores: AggregateAnswerScores | null,
  thresholds: EvalThresholds,
  judge: { judgeFaithfulness: number | null; judgeGate: { gateable: boolean; reasons: string[] } },
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

  // Answer-path gates (V3-P0). Citation validity is GROUNDING, checked by code — it is the
  // one answer-path number strict enough to gate on without a model in the loop.
  if (answerScores && answerScores.questionCount > 0) {
    if (answerScores.meanCitationValidity < thresholds.minCitationValidity) {
      failures.push(
        `citationValidity ${fmt(answerScores.meanCitationValidity)} < ${thresholds.minCitationValidity}`,
      );
    }
    if (answerScores.unjustifiedRefusals > thresholds.maxUnjustifiedRefusals) {
      failures.push(
        `unjustifiedRefusals ${answerScores.unjustifiedRefusals} > ${thresholds.maxUnjustifiedRefusals}`,
      );
    }
  }

  // Faithfulness gates ONLY with a calibrated judge. Otherwise it is reported and ignored —
  // deliberately, and the report says why (judgeGate.reasons).
  if (judge.judgeFaithfulness !== null && judge.judgeGate.gateable) {
    if (judge.judgeFaithfulness < thresholds.minJudgeFaithfulness) {
      failures.push(`judgeFaithfulness ${fmt(judge.judgeFaithfulness)} < ${thresholds.minJudgeFaithfulness}`);
    }
  }

  return { passed: failures.length === 0, failures };
}

function buildSummary(
  dataset: EvalDataset,
  synthesisScores: SynthesisScores,
  ragScores: RagScores | null,
  answerScores: AggregateAnswerScores | null,
  judgeFaithfulness: number | null,
  judgeGate: { gateable: boolean; reasons: string[] },
  thresholdResult: { passed: boolean; failures: string[] },
): string {
  const ragPart = ragScores
    ? `RAG recall@${ragScores.k} ${fmt(ragScores.meanRecallAtK)}, MRR ${fmt(ragScores.mrr)} over ${ragScores.questionCount}q`
    : "no questions";
  const answerPart = answerScores
    ? `; answers ${fmt(answerScores.answerRate)} answered, citationValidity ${fmt(answerScores.meanCitationValidity)}` +
      `, relevance ${fmt(answerScores.meanCitationRelevance)}` +
      `, refusals ${answerScores.justifiedRefusals} justified / ${answerScores.unjustifiedRefusals} not`
    : "";
  const judgePart =
    judgeFaithfulness === null
      ? ""
      : `; faithfulness ${fmt(judgeFaithfulness)} (${judgeGate.gateable ? "GATING" : `advisory — ${judgeGate.reasons.join(", ")}`})`;
  return (
    `${dataset.repoUrl}@${dataset.commitSha.slice(0, 12)} — ` +
    `synthesis recall@${synthesisScores.k} ${fmt(synthesisScores.readingOrderRecallAtK)}, ${ragPart}${answerPart}${judgePart} — ` +
    `${thresholdResult.passed ? "PASS" : `FAIL (${thresholdResult.failures.length})`}`
  );
}

function fmt(value: number): string {
  return value.toFixed(3);
}
