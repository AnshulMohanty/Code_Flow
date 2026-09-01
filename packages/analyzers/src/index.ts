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
// V3-P5 task 1 — latency engineering.
export {
  assertAcyclic,
  computeLayers,
  describeSchedule,
  STAGE_READS,
  type SchedulePlan,
  type StageLayer,
} from "./pipeline/schedule.js";
export {
  createWarmupRegistry,
  warmupRegistry,
  type WarmupOptions,
  type WarmupRegistry,
  type WarmupState,
  type WarmupTask,
  type WarmupTaskState,
  type WarmupTaskStatus,
} from "./pipeline/warmup.js";
export {
  createSpeculator,
  isSpeculationSource,
  type SpeculationStats,
  type SpeculationTask,
  type Speculator,
  type SpeculatorOptions,
  type StageSpeculationSource,
} from "./pipeline/speculation.js";
export {
  createRoutedLlmClient,
  maybeRouted,
  routeTier,
  type ModelRouterOptions,
  type ModelTask,
  type ModelTier,
  type RoutedCompletionRequest,
  type RoutingDecision,
  type RoutingHint,
} from "./llm/modelRouter.js";
export {
  renderLatencyReport,
  summarizeTiers,
  timed,
  type LatencyReport,
  type TierSample,
} from "./bench/latencyTiers.js";
// The bench RUNNER, separate from the tier arithmetic: the latter is pure and unit tested, this one
// has to wait for things. Everything slow is injected, so it measures orchestration and never a
// network (see runLatencyBench.ts).
export { runLatencyBench, type LatencyBenchDeps } from "./bench/runLatencyBench.js";
export { countIssues, deriveIssues, type DeriveIssuesInput } from "./pipeline/issues.js";
export {
  PipelineReasonError,
  RepoTooLargeError,
  BudgetExceededError,
  statusReasonOf,
} from "./pipeline/errors.js";
export {
  createInMemoryBudgetHandle,
  createRedisBudgetHandle,
  tokensOf,
  type BudgetRedisLike,
  type RedisBudgetOptions,
} from "./budget/budgetHandle.js";
// V3-P0: the ONE token-accounting module (replaces three duplicated estimators).
export {
  estimateTokens,
  estimatedUsage,
  measuredUsage,
  sumUsage,
  totalTokens,
  usageNumber,
  TOKEN_ESTIMATE_CHARS_PER_TOKEN,
} from "./util/tokens.js";
// V3-FINAL: the ONE linear completion unwrapper (replaces five copies of a cubic fence regex).
export { stripCodeFence, stripTrailingCodeFence } from "./llm/completionText.js";
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
export { embedCacheKey, normalizeEmbedText, type CachedEmbedding } from "./rag/embedCache.js";
// V3-P2: the retrieval primitive and the homogeneity guard MOVED DOWN to @codeflow/retrieval
// (the stores and MMR need them, and analyzers depends on retrieval, not the reverse). They
// are re-exported here so there is still exactly ONE definition of each and every existing
// import path keeps resolving. `retrieve` is now generic over `{ id, embedding }`, because
// `RagChunk` no longer carries a vector.
export {
  assertEmbeddingSpace,
  assertVectorDimension,
  cosineSimilarity,
  createIdentityReranker,
  createLexicalOverlapReranker,
  hybridSearch,
  retrieve,
  retrievalNamespace,
  vectorRetrieve,
  type Embedded,
  type EmbeddingClientLike,
  type EmbeddingSpace,
  type HybridSearchTrace,
  type Reranker,
  type RetrievedChunk,
} from "@codeflow/retrieval";
export {
  answerQuestion,
  deriveAnswer,
  type AnswerQuestionDeps,
  type CitableChunk,
  type RagAnswer,
  type RagAnswerCitation,
} from "./rag/answer.js";
export {
  createAnthropicClient,
  createGeminiClient,
  type LlmClient,
  type LlmProvider,
  type LlmCompletionRequest,
  type LlmCompletionResult,
  type AnthropicClientOptions,
  type GeminiClientOptions,
} from "./llm/llmClient.js";
export {
  createVoyageClient,
  createGeminiEmbeddingClient,
  type EmbeddingClient,
  type EmbeddingProvider,
  type EmbeddingRequest,
  type EmbeddingResult,
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
