import {
  AGENT_MAX_PARSE_RETRIES,
  AGENT_MAX_TOOL_CALLS,
  AGENT_MAX_TOOL_RESULT_CHARS,
  AGENT_MAX_TURNS,
} from "@codeflow/config";
import { BudgetExceededError, estimateTokens, type LlmClient } from "@codeflow/analyzers";
import type { RagAnswerCitation } from "@codeflow/analyzers";
import type { RetrievedChunk } from "@codeflow/retrieval";
import type { AnalysisResult, BudgetHandle } from "@codeflow/shared-types";
import { emptySession, type ResolvedEntity, type SessionMemory } from "@codeflow/memory";
import {
  type AgentAnswer,
  type AgentStopReason,
  type AgentTool,
  type AgentTrace,
  type AgentTurnTrace,
  type ToolContext,
  type ToolResult,
} from "./contracts.js";
import { meterContext, sumContext } from "./contextMeter.js";
import { parseAgentAction } from "./parseAction.js";
import { curateTools, emptyUsageState, recordToolOutcome, type ToolUsageState } from "./toolRouter.js";

/**
 * THE BOUNDED MULTI-TURN Q&A AGENT (V3-P3 task 1).
 *
 * Replaces the single-shot retrieve-then-answer path for `/api/result/:id/ask`. What it buys: a
 * question like "what breaks if I change the auth service?" now gets an EXACT answer from the
 * graph instead of whatever the retriever found text about, and a follow-up ("what about its
 * callers?") resolves against the previous turn.
 *
 * THE TWO RISKS THE BRIEF NAMED, and how each is handled in code rather than in a prompt:
 *
 * 1. UNBOUNDED COST/LATENCY. `AGENT_MAX_TURNS` and `AGENT_MAX_TOOL_CALLS` are hard caps. When the
 *    tool budget runs out the agent is not cut off mid-thought — it gets one FINAL turn with the
 *    tools removed and an explicit instruction to answer from what it has, because a truncated
 *    loop that returns nothing has spent the whole budget for no answer. Every observation is
 *    truncated to `AGENT_MAX_TOOL_RESULT_CHARS`, with the truncation stated in the text so the
 *    model knows it saw a prefix. The daily `BudgetHandle` is checked before EVERY turn, and
 *    exhaustion mid-loop returns the best honest answer rather than throwing away the turns
 *    already paid for.
 *
 * 2. REGRESSING HONEST-NO-ANSWER. Three independent guards, none of which the model can talk past:
 *    - the similarity floor lives inside `search_code` and has no model-settable argument;
 *    - GROUNDING is enforced after the fact: citations must resolve to chunks actually retrieved
 *      this session or to real graph nodes, and ungrounded ones are dropped and counted;
 *    - `answered: true` with NO grounded evidence is downgraded to a refusal. That last one is the
 *      important one: it means a model that ignores every empty tool result and answers from
 *      pre-training cannot produce an answered response, because the check is on evidence rather
 *      than on the model's own claim.
 */

export interface AskAgentDeps {
  /** The question being asked this turn. */
  question: string;
  /** The frozen analysis being asked about. */
  result: AnalysisResult;
  chatClient: LlmClient;
  tools: readonly AgentTool[];
  /** Prior conversation. Omit for a fresh session. */
  memory?: SessionMemory;
  /** Daily spend ceiling, checked before every turn. */
  budget?: BudgetHandle;
  maxTurns?: number;
  maxToolCalls?: number;
  maxToolsPerStep?: number;
  maxToolResultChars?: number;
  /** Max output tokens per turn. */
  maxTokens?: number;
}

const SYSTEM_PROMPT =
  "You are a precise code assistant answering questions about ONE repository, using TOOLS.\n" +
  "You must reason ONLY from tool results. Never use outside knowledge about libraries, frameworks " +
  "or what code 'usually' looks like. If the tools do not establish an answer, say so.\n" +
  "\n" +
  "Reply with a SINGLE JSON object and nothing else, in one of these two forms:\n" +
  '  {"action":"tool","tool":"<tool id>","args":{...},"thought":"why"}\n' +
  '  {"action":"answer","answer":"<prose>","answered":true|false,' +
  '"citedChunkIds":["<chunk id>"],"citedFileIds":["<file path>"],"thought":"why"}\n' +
  "\n" +
  "Citation rules, enforced by code — a citation that breaks them is DROPPED:\n" +
  "- citedChunkIds must be chunk ids returned by search_code in THIS conversation.\n" +
  "- citedFileIds must be file paths returned by a tool in THIS conversation.\n" +
  "- If you have no grounded evidence, set answered:false. An answer with no evidence is discarded.";

export async function askAgent(deps: AskAgentDeps): Promise<AgentAnswer> {
  const maxTurns = deps.maxTurns ?? AGENT_MAX_TURNS;
  const maxToolCalls = deps.maxToolCalls ?? AGENT_MAX_TOOL_CALLS;
  const maxToolResultChars = deps.maxToolResultChars ?? AGENT_MAX_TOOL_RESULT_CHARS;

  const question = deps.question;
  const memory = deps.memory ?? emptySession("ephemeral", deps.result.id);
  const toolContext: ToolContext = { result: deps.result, memory };
  const byId = new Map(deps.tools.map((tool) => [tool.id, tool]));

  const nodeIds = new Set((deps.result.graph?.nodes ?? deps.result.files ?? []).map((node) => node.id));
  const memoryBlock = renderMemory(memory);

  // Evidence accumulated across turns. This is what grounding checks against — NOT the model's
  // claims, and not the whole index.
  const seenChunks = new Map<string, RetrievedChunk>();
  const seenFileIds = new Set<string>();
  // Chunk ids from EARLIER turns of this session are legitimate citation targets: a follow-up may
  // reference code the previous turn retrieved, and forcing a re-search to re-earn it would be
  // paying twice for the same evidence.
  const priorChunkIds = new Set(memory.retrievedChunkIds);

  const transcript: string[] = [];
  const retrievalLog: string[] = [];
  const turnTraces: AgentTurnTrace[] = [];
  let usageState: ToolUsageState = emptyUsageState();
  let toolCalls = 0;
  let parseFailures = 0;
  let stopReason: AgentStopReason = "turn-limit";
  let finalAnswer: { answer: string; answered: boolean; citedChunkIds: string[]; citedFileIds: string[] } | null = null;
  const totalUsage = { inputTokens: 0, outputTokens: 0, measured: true };

  for (let turn = 1; turn <= maxTurns; turn++) {
    // The FINAL turn, and any turn after the tool budget is spent, offers no tools and demands an
    // answer. Removing the descriptions is also the cheapest turn of the loop.
    const forceAnswer = turn === maxTurns || toolCalls >= maxToolCalls;
    const curated = forceAnswer
      ? { tools: [], omitted: [] }
      : curateTools({
          question,
          tools: deps.tools,
          usage: usageState,
          ...(deps.maxToolsPerStep !== undefined ? { maxTools: deps.maxToolsPerStep } : {}),
        });

    const toolBlock = forceAnswer
      ? "No tools are available on this turn. Answer from what you already have, or set answered:false."
      : renderTools(curated.tools);
    const transcriptBlock = transcript.join("\n");
    const retrievalBlock = retrievalLog.join("\n");

    const context = meterContext({
      instructions: SYSTEM_PROMPT,
      retrieval: retrievalBlock,
      memory: memoryBlock,
      tools: toolBlock,
      transcript: transcriptBlock,
      question,
    });

    const prompt = [
      memoryBlock ? `## Conversation so far\n${memoryBlock}` : "",
      `## Available tools\n${toolBlock}`,
      retrievalBlock ? `## Code retrieved so far\n${retrievalBlock}` : "",
      transcriptBlock ? `## Your steps so far\n${transcriptBlock}` : "",
      `## Question\n${question}`,
      "Respond with a single JSON object.",
    ]
      .filter(Boolean)
      .join("\n\n");

    // Cache-before-budget stays the ordering rule, and the estimate is pre-flight admission only —
    // the provider's real usage is recorded after the call.
    if (deps.budget && !(await deps.budget.check(estimateTokens(`${SYSTEM_PROMPT}\n${prompt}`), "chat"))) {
      // Budget out mid-loop: keep whatever the earlier turns established rather than discarding
      // paid work. `finalAnswer` stays null, so this becomes an honest refusal with the trace.
      stopReason = "budget-exhausted";
      turnTraces.push({ turn, offeredTools: curated.tools.map((tool) => tool.id), context, action: "unparseable", parseError: "budget exhausted before the call" });
      break;
    }

    let completionText: string;
    let turnUsage: AgentTurnTrace["usage"];
    try {
      const completed = await deps.chatClient.complete({
        cachePrefix: SYSTEM_PROMPT,
        system: SYSTEM_PROMPT,
        prompt,
        temperature: 0,
        ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
      });
      completionText = completed.text;
      turnUsage = {
        inputTokens: completed.usage.inputTokens,
        outputTokens: completed.usage.outputTokens,
        measured: completed.usage.measured,
      };
      totalUsage.inputTokens += completed.usage.inputTokens;
      totalUsage.outputTokens += completed.usage.outputTokens;
      totalUsage.measured = totalUsage.measured && completed.usage.measured;
      if (deps.budget) await deps.budget.record(completed.usage, "chat");
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        stopReason = "budget-exhausted";
        turnTraces.push({ turn, offeredTools: curated.tools.map((tool) => tool.id), context, action: "unparseable", parseError: error.message });
        break;
      }
      throw error;
    }

    const action = parseAgentAction(completionText);
    const trace: AgentTurnTrace = {
      turn,
      offeredTools: curated.tools.map((tool) => tool.id),
      context,
      ...(turnUsage ? { usage: turnUsage } : {}),
      action: action.kind,
    };

    if (action.kind === "unparseable") {
      parseFailures += 1;
      trace.parseError = action.reason;
      turnTraces.push(trace);
      // Told, not silently retried: the model needs to know WHAT was wrong, or it repeats it.
      transcript.push(`(your previous reply could not be parsed: ${action.reason}. Reply with a single JSON object.)`);
      if (parseFailures > AGENT_MAX_PARSE_RETRIES) {
        stopReason = "parse-failure";
        break;
      }
      continue;
    }

    if (action.kind === "answer") {
      trace.action = "answer";
      turnTraces.push(trace);
      finalAnswer = action;
      stopReason = action.answered ? "answered" : "refused";
      break;
    }

    // --- a tool call -------------------------------------------------------
    // The tool budget is a CAP, not a hint. On a forced-answer turn the call is refused rather
    // than executed: without this the loop would keep running tools past `maxToolCalls` (it only
    // stopped OFFERING them), which is the same runaway the cap exists to prevent.
    if (forceAnswer) {
      trace.toolError = "tool calls are exhausted; this turn must answer";
      turnTraces.push(trace);
      transcript.push("(no tools are available now — answer from what you already have, or set answered:false.)");
      continue;
    }

    const tool = byId.get(action.tool);
    if (!tool) {
      trace.toolError = `no such tool "${action.tool}"`;
      turnTraces.push(trace);
      transcript.push(
        `(you called "${action.tool}", which does not exist. Available: ${deps.tools.map((entry) => entry.id).join(", ")}.)`,
      );
      // A hallucinated tool name counts against the tool budget. Otherwise a model that invents
      // names could loop for free until the turn cap, which is the same runaway with extra steps.
      toolCalls += 1;
      continue;
    }

    let outcome: ToolResult;
    try {
      outcome = await tool.run(action.args, toolContext);
    } catch (error) {
      // A throwing tool is a bug, not an answer. It is reported to the model as an error so it can
      // try something else, and it lands on the trace.
      outcome = { text: `${tool.id} failed.`, error: error instanceof Error ? error.message : String(error) };
    }
    toolCalls += 1;
    usageState = recordToolOutcome(usageState, tool.id, outcome.empty === true);

    for (const chunk of outcome.chunks ?? []) seenChunks.set(chunk.id, chunk);
    for (const fileId of outcome.fileIds ?? []) if (nodeIds.has(fileId)) seenFileIds.add(fileId);

    const observation = truncate(outcome.text, maxToolResultChars);
    // Retrieved CODE goes in its own pillar, so the meter can tell "retrieval grew" from "the
    // agent is looping" — the two have different fixes.
    if (outcome.chunks?.length) retrievalLog.push(observation);
    else transcript.push(`${action.thought ? `thought: ${action.thought}\n` : ""}${tool.id} -> ${observation}`);

    trace.toolCalled = tool.id;
    trace.toolEmpty = outcome.empty === true;
    if (outcome.error) trace.toolError = outcome.error;
    turnTraces.push(trace);

    if (toolCalls >= maxToolCalls && turn < maxTurns) {
      transcript.push("(tool budget spent — answer from what you have on the next turn, or set answered:false.)");
    }
  }

  if (stopReason === "turn-limit" && finalAnswer) stopReason = finalAnswer.answered ? "answered" : "refused";
  if (toolCalls >= maxToolCalls && !finalAnswer) stopReason = "tool-call-limit";

  const contextTotals = sumContext(turnTraces.map((entry) => entry.context));
  const trace: AgentTrace = {
    turns: turnTraces,
    toolCalls,
    stopReason,
    totalContextTokens: contextTotals.total,
    totalUsage,
  };

  return ground({
    action: finalAnswer,
    seenChunks,
    seenFileIds,
    priorChunkIds,
    trace,
  });
}

// -- Grounding ------------------------------------------------------------------------

interface GroundArgs {
  action: { answer: string; answered: boolean; citedChunkIds: string[]; citedFileIds: string[] } | null;
  seenChunks: Map<string, RetrievedChunk>;
  seenFileIds: Set<string>;
  priorChunkIds: Set<string>;
  trace: AgentTrace;
}

const NO_ANSWER =
  "I couldn't establish an answer from this repository's code. Try rephrasing, or ask about a specific file.";

/**
 * Enforce grounding on the model's claims. The whole point: the model proposes, code decides.
 *
 * A chunk citation must resolve to a chunk retrieved in THIS session (this question's tool calls,
 * or an earlier turn's). A file citation must be a fileId a tool actually returned. Anything else
 * is dropped and counted — a fabricated reference is not a near miss.
 *
 * And the last guard: `answered: true` with NO grounded evidence is DOWNGRADED to a refusal. That
 * is what makes the honest-no-answer property survive an agent, because it does not depend on the
 * model respecting an instruction — it depends on the evidence existing.
 */
function ground(args: GroundArgs): AgentAnswer {
  const retrievedChunkIds = [...args.seenChunks.keys()].sort();

  if (!args.action) {
    return { answer: NO_ANSWER, citations: [], retrievedChunkIds, answered: false, trace: args.trace };
  }

  const citations: RagAnswerCitation[] = [];
  const dropped: string[] = [];
  const seenCoords = new Set<string>();
  for (const id of args.action.citedChunkIds) {
    const chunk = args.seenChunks.get(id);
    if (!chunk) {
      // Dropped either way, but for two different reasons worth distinguishing in a review: an id
      // this session never retrieved is FABRICATED, while an id from an EARLIER turn is legitimate
      // yet has no coordinates in hand now, so it cannot become a line-range citation. Neither is
      // guessed at; both are counted.
      dropped.push(args.priorChunkIds.has(id) ? `${id} (earlier turn; coordinates not reloaded)` : id);
      continue;
    }
    const key = `${chunk.fileId}#${chunk.startLine}-${chunk.endLine}`;
    if (seenCoords.has(key)) continue;
    seenCoords.add(key);
    citations.push({ fileId: chunk.fileId, startLine: chunk.startLine, endLine: chunk.endLine });
  }

  const citedFiles: string[] = [];
  for (const fileId of args.action.citedFileIds) {
    if (args.seenFileIds.has(fileId)) {
      if (!citedFiles.includes(fileId)) citedFiles.push(fileId);
    } else {
      dropped.push(fileId);
    }
  }
  citedFiles.sort();

  const hasEvidence = citations.length > 0 || citedFiles.length > 0;
  const answered = args.action.answered && args.action.answer !== "" && hasEvidence;

  return {
    answer: answered ? args.action.answer : args.action.answer || NO_ANSWER,
    citations,
    retrievedChunkIds,
    answered,
    ...(dropped.length ? { droppedCitations: { count: dropped.length, ids: [...new Set(dropped)] } } : {}),
    ...(citedFiles.length ? { citedFiles } : {}),
    trace: {
      ...args.trace,
      // An answer the model claimed but grounding rejected is a REFUSAL, and the stop reason must
      // say so — otherwise a trace would report "answered" for a response that says it could not.
      stopReason: args.trace.stopReason === "answered" && !answered ? "refused" : args.trace.stopReason,
    },
  };
}

// -- Prompt rendering -----------------------------------------------------------------

function renderTools(tools: readonly AgentTool[]): string {
  if (tools.length === 0) return "(none)";
  return tools.map((tool) => `- ${tool.description}`).join("\n");
}

/**
 * Render session memory for the prompt.
 *
 * Prior turns AND resolved entities, because they do different jobs: the turns tell the model what
 * has already been tried (including what was refused), and the entity list is what a pronoun in
 * the current question resolves against. Bounded upstream by the memory store, so nothing is
 * trimmed here — trimming in two places is how the two disagree.
 */
function renderMemory(memory: SessionMemory): string {
  if (memory.turns.length === 0 && memory.resolvedEntities.length === 0) return "";
  const lines: string[] = [];
  for (const turn of memory.turns) {
    lines.push(`Q${turn.turn}: ${turn.question}`);
    lines.push(`A${turn.turn}${turn.answered ? "" : " (could not answer)"}: ${turn.answer}`);
    if (turn.citations.length) {
      lines.push(`   cited: ${turn.citations.map((citation) => citation.fileId).join(", ")}`);
    }
  }
  if (memory.resolvedEntities.length) {
    lines.push(
      `Recently discussed (most recent first): ${memory.resolvedEntities
        .map((entity) => `${entity.value}${entity.kind === "symbol" && entity.fileId ? ` in ${entity.fileId}` : ""}`)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // States what it truncated FROM, so the model knows it saw a prefix rather than believing it saw
  // everything — the same rule the diff and list renderers follow.
  return `${text.slice(0, maxChars)}\n(truncated from ${text.length} characters)`;
}

/**
 * Entities to remember from a completed exchange, for the next turn's pronoun resolution.
 *
 * File entities come from what was actually CITED (grounded), in citation order; symbol entities
 * from symbol-aligned chunks. Deriving them from grounded output rather than from the question text
 * means "it" resolves to something that demonstrably exists in the repository.
 */
export function entitiesFrom(answer: AgentAnswer, chunks: readonly RetrievedChunk[]): Array<Omit<ResolvedEntity, "turn">> {
  const out: Array<Omit<ResolvedEntity, "turn">> = [];
  const seen = new Set<string>();
  const push = (entity: Omit<ResolvedEntity, "turn">) => {
    const key = `${entity.kind}:${entity.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entity);
  };

  for (const citation of answer.citations) push({ kind: "file", value: citation.fileId });
  for (const fileId of answer.citedFiles ?? []) push({ kind: "file", value: fileId });
  for (const chunk of chunks) {
    if (chunk.symbolName) push({ kind: "symbol", value: chunk.symbolName, fileId: chunk.fileId });
  }
  return out;
}
