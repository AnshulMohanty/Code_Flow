// @codeflow/eval — scores the pipeline's AI output (synthesis + RAG retrieval) against
// authored ground truth. The thing that proves the AI catches the RIGHT files, not just
// well-formed JSON. Hermetic + deterministic; the real scored run + dataset authoring +
// threshold tuning are P7 data tasks. Builds only the retrieval PRIMITIVE the eval needs
// (cosine top-k) — the Q&A answer/cite path is P18.

export {
  EVAL_SCHEMA_VERSION,
  TEMPLATE_DATASET,
  assertDatasetShape,
  type EvalDataset,
  type RagEvalQuestion,
} from "./dataset.js";
// Retrieval is the ONE production primitive (hoisted to @codeflow/analyzers in P18) — re-exported
// here so existing eval consumers keep working and eval measures the SAME retrieval as production.
export { cosineSimilarity, retrieve } from "@codeflow/analyzers";
export {
  scoreSynthesis,
  scoreQuestion,
  aggregateRag,
  type SynthesisScores,
  type RagScores,
  type PerQuestionResult,
} from "./score.js";
export { EVAL_THRESHOLDS, type EvalThresholds } from "./thresholds.js";
export {
  runEval,
  assertHomogeneity,
  type EvalReport,
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
