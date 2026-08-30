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
