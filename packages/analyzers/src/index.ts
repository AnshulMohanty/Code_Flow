// @codeflow/analyzers — the staged analysis pipeline (PLAN P1).
//
// This package owns the sequential orchestrator and the individual stages
// (ingest/orient/map-structure/inventory/connect/analyze/synthesize/rag).
export {
  runPipeline,
  type CachedAnalysisLookup,
  type PipelineEmitter,
  type PipelineRunResult,
  type RunPipelineOptions,
} from "./pipeline/orchestrator.js";
export {
  createIngestStage,
  type ClonedRepo,
  type IngestDependencies,
  type RepoCloner,
  type RepoSize,
} from "./stages/ingest.js";
export { deriveSummary, scoreHealth, type HealthVerdict } from "./pipeline/summary.js";
export {
  PipelineReasonError,
  RepoTooLargeError,
  BudgetExceededError,
  statusReasonOf,
} from "./pipeline/errors.js";
export { createInMemoryBudgetHandle } from "./budget/budgetHandle.js";
export { createOrientStage, type OrientDependencies } from "./stages/orient.js";
export {
  createMapStructureStage,
  type MapStructureDependencies,
  type WalkEntry,
} from "./stages/mapStructure.js";
export { createInventoryStage, type InventoryDependencies } from "./stages/inventory.js";
export { createConnectStage, type ConnectDependencies } from "./stages/connect.js";
export { createAnalyzeStage, type AnalyzeDependencies } from "./stages/analyze.js";
export {
  createSynthesizeStage,
  buildSynthesisPrompt,
  deriveSynthesis,
  type SynthesizeDependencies,
} from "./stages/synthesize.js";
export { createRagStage, type RagDependencies } from "./stages/rag.js";
export { cosineSimilarity, retrieve } from "./rag/retrieve.js";
export { embedCacheKey, normalizeEmbedText, type CachedEmbedding } from "./rag/embedCache.js";
export { assertEmbeddingSpace, type EmbeddingSpace, type EmbeddingClientLike } from "./rag/homogeneity.js";
export {
  answerQuestion,
  deriveAnswer,
  type RagAnswer,
  type RagAnswerCitation,
  type AnswerQuestionDeps,
} from "./rag/answer.js";
export {
  createAnthropicClient,
  createGeminiClient,
  type LlmClient,
  type LlmProvider,
  type LlmCompletionRequest,
  type AnthropicClientOptions,
  type GeminiClientOptions,
} from "./llm/llmClient.js";
export {
  createVoyageClient,
  createGeminiEmbeddingClient,
  type EmbeddingClient,
  type EmbeddingProvider,
  type EmbeddingRequest,
  type VoyageClientOptions,
  type GeminiEmbeddingClientOptions,
} from "./embedding/embeddingClient.js";
export {
  resolveChatProvider,
  resolveEmbeddingProvider,
  createLlmClientFromEnv,
  createEmbeddingClientFromEnv,
  type ProviderEnv,
} from "./providers.js";
