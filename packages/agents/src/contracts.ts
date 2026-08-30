import type { RagAnswerCitation } from "@codeflow/analyzers";
import type { AnalysisResult } from "@codeflow/shared-types";
import type { RetrievedChunk } from "@codeflow/retrieval";
import type { SessionMemory } from "@codeflow/memory";

/**
 * `@codeflow/agents` — the agent layer (V3-P3; extended by V3-P4's orchestrator).
 *
 * WHY PROMPTED TOOL-CALLING AND NOT NATIVE TOOL-CALLING. `LlmClient` is a plain text-completion
 * interface with two adapters (Anthropic Messages, Gemini) that expose tool use quite
 * differently. Adding native tool-calling would mean changing that contract, both adapters and
 * their tests, and writing provider-specific request shaping — before a single agent existed to
 * justify it.
 *
 * So the loop is ReAct over a completion: the model is asked to emit ONE JSON action per turn,
 * the action is parsed and validated, the tool runs, and the observation is appended to a
 * transcript. This works with both providers unchanged, is trivially mockable (the hermetic
 * suite injects a scripted `LlmClient`), and puts the parse at exactly the boundary this repo's
 * contract rule names as needing runtime validation: parsed LLM JSON.
 *
 * The cost, stated: prompted tool-calling is less reliable than native, so
 * `parseAgentAction` has to be forgiving about fences and prose around the JSON, and there is a
 * bounded retry for unparseable output. Native tool-calling is a P5 upgrade that slots in behind
 * the SAME `AgentTool` interface — the tools, the router, the metering and the grounding do not
 * change.
 *
 * TWO HARD BOUNDS, enforced in code and not in the prompt: max turns and max tool calls. An
 * unbounded tool-calling loop is the most expensive failure mode in this codebase, because every
 * turn is a paid call and a model that keeps deciding "one more search" spends indefinitely.
 */

// -- Tools ----------------------------------------------------------------------------

/**
 * What a tool sees. Read-only by construction — an agent must not be able to change the world
 * it is answering about, which is the same rule `@codeflow/arena`'s `Sandbox` enforces.
 */
export interface ToolContext {
  /** The frozen analysis the question is about. */
  readonly result: AnalysisResult;
  /** Session memory, for tools that resolve a reference ("its callers"). */
  readonly memory: SessionMemory;
}

/** A tool's arguments as parsed from the model's JSON — untrusted until the tool validates. */
export type ToolArgs = Record<string, unknown>;

/**
 * What a tool returns.
 *
 * `fileIds` and `chunks` are the GROUNDING CONTRIBUTION: they are the evidence the final answer
 * is allowed to cite. A tool that returns only `text` contributes prose the agent may reason
 * with but cannot cite, which is deliberate — an agent should not be able to manufacture a
 * citation out of a tool's summary sentence.
 */
export interface ToolResult {
  /** Prose for the transcript. Bounded by the caller (see AGENT_MAX_TOOL_RESULT_CHARS). */
  text: string;
  /** Graph-grounded fileIds this tool established as relevant. Citable at file granularity. */
  fileIds?: string[];
  /** Retrieved chunks. Citable at line granularity. */
  chunks?: RetrievedChunk[];
  /** True when the tool ran fine and simply found nothing — distinct from an error, and the
   *  signal the router uses to stop offering a tool that keeps coming up empty. */
  empty?: boolean;
  /** Set when the tool FAILED. The agent is told, and the failure is on the trace. */
  error?: string;
}

/**
 * One tool the agent may call.
 *
 * `description` is not documentation, it is PROMPT TEXT — it is what the model reads to decide
 * whether to call this tool, and it is the fixed per-call cost of having the tool available at
 * all. That is why curating which descriptions appear (see `curateTools`) is the main
 * context-budget lever, and why descriptions are written tight.
 */
export interface AgentTool {
  readonly id: string;
  /** One or two lines: what it answers, and what its arguments are. Goes in the prompt. */
  readonly description: string;
  /** Argument names, for the prompt and for a clear error on a malformed call. */
  readonly args: readonly string[];
  /**
   * Keywords that make this tool RELEVANT to a question. Used by the deterministic router; a
   * tool with none is always considered a candidate.
   */
  readonly triggers?: readonly string[];
  run(args: ToolArgs, context: ToolContext): Promise<ToolResult>;
}

// -- The model's action -----------------------------------------------------------------

/** The model asked to call a tool. */
export interface ToolAction {
  kind: "tool";
  tool: string;
  args: ToolArgs;
  /** The model's stated reason. Kept on the trace — it is the only window into WHY a tool ran. */
  thought?: string;
}

/** The model produced a final answer. */
export interface AnswerAction {
  kind: "answer";
  answer: string;
  /** Whether the model claims to have answered. A `false` here is an honest refusal and is
   *  respected; a `true` still has to survive grounding. */
  answered: boolean;
  /** What it claims to have used: chunk ids and/or fileIds. Grounded by code afterwards. */
  citedChunkIds: string[];
  citedFileIds: string[];
  thought?: string;
}

/** The output could not be parsed as either. */
export interface UnparseableAction {
  kind: "unparseable";
  raw: string;
  reason: string;
}

export type AgentAction = ToolAction | AnswerAction | UnparseableAction;

// -- Trace ------------------------------------------------------------------------------

/**
 * Tokens per CONTEXT PILLAR for one LLM call (V3-P3 task 3).
 *
 * Broken out by pillar rather than reported as one number because the number alone cannot answer
 * the only question worth asking about a context budget: which part grew? A prompt that doubled
 * because memory grew is a memory-bounds bug; one that doubled because tool descriptions grew is
 * a routing bug; one that doubled because retrieval returned more is working as intended.
 */
export interface ContextBreakdown {
  instructions: number;
  retrieval: number;
  memory: number;
  tools: number;
  /** The agent's own transcript so far (thoughts + observations). */
  transcript: number;
  question: number;
  total: number;
}

/** One turn of the loop, as it happened. */
export interface AgentTurnTrace {
  turn: number;
  /** Tool ids whose DESCRIPTIONS were included this turn — what the router decided. */
  offeredTools: string[];
  context: ContextBreakdown;
  /** Provider-reported usage for this turn's call. */
  usage?: { inputTokens: number; outputTokens: number; measured: boolean };
  action: AgentAction["kind"];
  toolCalled?: string;
  toolEmpty?: boolean;
  toolError?: string;
  parseError?: string;
}

/** Why the loop stopped. Every value is a real, distinguishable outcome. */
export type AgentStopReason =
  | "answered"
  | "refused"
  | "turn-limit"
  | "tool-call-limit"
  | "parse-failure"
  | "budget-exhausted";

export interface AgentTrace {
  turns: AgentTurnTrace[];
  toolCalls: number;
  stopReason: AgentStopReason;
  /** Summed context tokens across turns — the number a cost review actually wants. */
  totalContextTokens: number;
  /** Summed provider-reported tokens. */
  totalUsage: { inputTokens: number; outputTokens: number; measured: boolean };
}

/**
 * What the agent returns. Shaped to be a superset of `RagAnswer`, so the API route and the UI
 * keep working unchanged — an agent that forced a new response shape would have made this phase
 * a frontend change as well.
 */
export interface AgentAnswer {
  answer: string;
  citations: RagAnswerCitation[];
  retrievedChunkIds: string[];
  answered: boolean;
  droppedCitations?: { count: number; ids: string[] };
  /** File-level citations that resolved to a graph node but not to a retrieved chunk — a real
   *  grounding level, kept separate from line-level citations rather than faked into one. */
  citedFiles?: string[];
  trace: AgentTrace;
}
