// @codeflow/agents — the agent layer (V3-P3; V3-P4 adds the orchestrator here).
//
// A BOUNDED multi-turn Q&A agent over graph tools + V3-P2 hybrid retrieval. Prompted
// tool-calling (ReAct over a plain completion), because `LlmClient` has no native tool-calling
// and both providers expose it differently — see contracts.ts for the full reasoning and the P5
// upgrade path. Two hard caps (turns, tool calls) enforced in code, not in the prompt.

export type {
  AgentAction,
  AgentAnswer,
  AgentStopReason,
  AgentTool,
  AgentTrace,
  AgentTurnTrace,
  AnswerAction,
  ContextBreakdown,
  ToolAction,
  ToolArgs,
  ToolContext,
  ToolResult,
  UnparseableAction,
} from "./contracts.js";

// V3-FINAL: the durable projection of the fan-out's per-community findings. Inference, and every
// surface that renders it labels it as such.
export {
  buildDomainLanes,
  LANE_MAX_HEADLINES,
  LANE_MAX_MODULES,
  SPECIALIST_TAGS,
  type DomainLaneInput,
} from "./orchestrator/domainLanes.js";

export { askAgent, entitiesFrom, type AskAgentDeps } from "./askAgent.js";
export { extractJsonObject, parseAgentAction } from "./parseAction.js";

// Task 3: context-budget hygiene — per-step tool curation + per-pillar token metering.
export {
  curateTools,
  emptyUsageState,
  recordToolOutcome,
  TOOL_EMPTY_DROP_THRESHOLD,
  type CurateToolsOptions,
  type CuratedTools,
  type ToolUsageState,
} from "./toolRouter.js";
export {
  dominantPillar,
  meterContext,
  sumContext,
  type ContextParts,
} from "./contextMeter.js";

// Tools.
export {
  createBlastRadiusTool,
  createFindReferencesTool,
  createGetCallersTool,
  createGraphTools,
  createSymbolSearchTool,
  resolveFileArg,
} from "./tools/graphTools.js";
export { createSearchTool, type SearchToolDeps } from "./tools/searchTool.js";
export { createWhatChangedTool, type WhatChangedToolDeps } from "./tools/whatChangedTool.js";

// -- V3-P4: bounded agent fan-out + test-time compute -------------------------
// Fan out specialists over V3-P1's Louvain communities (low-coupling BY CONSTRUCTION, which is why
// the parallelism is earned rather than assumed), collect STRUCTURED SUMMARIES on a shared
// blackboard, and have ONE supervisor synthesise from a BOUNDED selection — so orchestrator context
// does not grow with worker count. Never an open mesh.
export type {
  Blackboard,
  BlackboardEntry,
  CommunityRoute,
  FanOutResult,
  FindingImportance,
  SpecialistFinding,
  SpecialistId,
  SpecialistTask,
} from "./orchestrator/contracts.js";
export { SPECIALIST_IDS } from "./orchestrator/contracts.js";
export {
  emptyBlackboard,
  post,
  renderFindings,
  selectForSupervisor,
  summarizeBlackboard,
  type BlackboardSummary,
} from "./orchestrator/blackboard.js";
export { complexityOf, planRouting, type ComplexitySignals, type RoutingPlan } from "./orchestrator/routing.js";
// V3-P5 task 6 — OFFLINE CONSOLIDATION. Extractive, deterministic, no provider: it compresses the
// findings the fan-out already paid for into a compact queryable repo KB.
export {
  consolidateKnowledge,
  queryKnowledgeBase,
  renderKnowledgeBase,
  KB_MAX_COMMUNITIES,
  KB_MAX_DETAIL_CHARS,
  KB_MAX_FAQ,
  KB_MAX_KEY_FILES,
  KB_MAX_POINTS_PER_COMMUNITY,
  type CommunityDigest,
  type ConsolidateInput,
  type ConsolidatedPoint,
  type KbHit,
  type KbQuestion,
  type RepoFact,
  type RepoKnowledgeBase,
} from "./orchestrator/consolidate.js";
export {
  buildSpecialistPrompt,
  buildSpecialistTask,
  groundFindings,
  importanceRank,
  parseSpecialistOutput,
  SPECIALIST_SPECS,
  SPECIALIST_SYSTEM_PROMPT,
  type ParsedSpecialistOutput,
  type SpecialistSpec,
} from "./orchestrator/specialists.js";
export {
  buildSupervisorPrompt,
  deriveSupervisedSynthesis,
  fallbackSynthesis,
  SUPERVISOR_SYSTEM_PROMPT,
  type SupervisorPromptResult,
} from "./orchestrator/supervisor.js";
export {
  createGroundingScorer,
  mapWithConcurrency,
  runFanOut,
  type FanOutDeps,
} from "./orchestrator/runFanOut.js";
export {
  createFanOutSynthesizeStage,
  type FanOutSynthesizeDependencies,
} from "./orchestrator/synthesizeStage.js";
export {
  createAdaptiveSynthesizeStage,
  type AdaptiveSynthesizeDependencies,
} from "./orchestrator/adaptiveStage.js";
