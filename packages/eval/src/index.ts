// @codeflow/eval — scores the pipeline's AI output (synthesis + RAG retrieval) against
// authored ground truth. The thing that proves the AI catches the RIGHT files, not just
// well-formed JSON. Hermetic + deterministic; the real scored run + dataset authoring +
// threshold tuning are P7 data tasks. Builds only the retrieval PRIMITIVE the eval needs
// (cosine top-k) — the Q&A answer/cite path is P18.

export {
  EVAL_SCHEMA_VERSION,
  TEMPLATE_DATASET,
  assertDatasetShape,
  type DatasetProvenance,
  type EvalDataset,
  type RagEvalQuestion,
} from "./dataset.js";
// V3-P0: the authored golden set + its loader (runtime-validated at the file boundary).
export {
  loadGoldenDatasets,
  totalNegativeControls,
  totalQuestions,
  type LoadedDataset,
} from "./datasets.js";
// V3-P0: answer-path scoring + the calibrated judge.
export {
  aggregateAnswers,
  scoreAnswer,
  type AggregateAnswerScores,
  type AnswerScores,
  type PerAnswerResult,
} from "./answerScore.js";
export type { JudgeChunk } from "./judge.js";
export {
  buildJudgePrompt,
  calibrateJudge,
  cohensKappa,
  judgeIsGateable,
  parseJudgeVerdict,
  waldInterval,
  JUDGE_GATE_REQUIREMENTS,
  JUDGE_SYSTEM_PROMPT,
  type Judge,
  type JudgeConcordance,
  type JudgeLabel,
  type JudgeRequest,
  type JudgeVerdict,
} from "./judge.js";
// Retrieval is the ONE production primitive (hoisted to @codeflow/analyzers in P18, moved
// down to @codeflow/retrieval in V3-P2) — re-exported here so existing eval consumers keep
// working and eval measures the SAME retrieval as production.
export { cosineSimilarity, retrieve } from "@codeflow/analyzers";
// V3-P2: the index sidecar. The vectors left the AnalysisResult, so a scored run loads them
// from a companion file and hydrates the in-memory stores the harness retrieves through.
export {
  assertEvalIndexShape,
  hydrateEvalIndex,
  EVAL_INDEX_SCHEMA_VERSION,
  type EvalIndexFile,
  type HydratedEvalIndex,
} from "./evalIndex.js";
export {
  scoreSynthesis,
  scoreQuestion,
  aggregateRag,
  type SynthesisScores,
  type RagScores,
  type PerQuestionResult,
  type ScoredCoords,
} from "./score.js";
export { EVAL_THRESHOLDS, type EvalThresholds } from "./thresholds.js";
export {
  runEval,
  assertHomogeneity,
  type AnswerRunner,
  type EvalReport,
  type EvalRetrieval,
  type RunEvalOptions,
} from "./runEval.js";
// Parser parity (V3-P1): grades the tree-sitter engine against the regex baseline on
// AUTHORED ground truth. Hermetic — no keys, no clone — so unlike `runEval` it gates in CI.
export { PARITY_CORPUS, type ParityCase } from "./parity/corpus.js";
export {
  createRegexRegistry,
  createTreeSitterRegistry,
  metric,
  PARITY_GATES,
  runParserParity,
  type ParityCaseResult,
  type ParityDimension,
  type ParityEngine,
  type ParityEngineSummary,
  type ParityMeasure,
  type ParityMetric,
  type ParityReport,
} from "./parity/parserParity.js";
