import { estimateTokens } from "@codeflow/analyzers";
import type { ContextBreakdown } from "./contracts.js";

/**
 * PER-PILLAR CONTEXT METERING (V3-P3 task 3).
 *
 * WHY BY PILLAR AND NOT AS ONE NUMBER. A total tells you the prompt got bigger; it cannot tell you
 * which of several unrelated bugs did it. A prompt that doubled because MEMORY grew is a
 * memory-bounds bug. Because TOOL descriptions grew, a routing bug. Because RETRIEVAL returned
 * more, working as intended. Because the TRANSCRIPT grew, an agent that is looping. The four have
 * different fixes, and only a breakdown distinguishes them.
 *
 * ESTIMATED, AND HONEST ABOUT IT. This uses `estimateTokens` — the shared ~4-chars/token heuristic
 * — not a tokenizer, for the reason V3-P0 documented when it refused to bundle one: this codebase
 * talks to Anthropic, Gemini and Voyage, whose vocabularies differ, so any single local tokenizer
 * is precisely wrong for at least two of the three. The provider's own `usage` is authoritative for
 * COST and is recorded separately on every turn trace (`AgentTurnTrace.usage`). What this is for is
 * ATTRIBUTION — which pillar is responsible — and for that a consistent estimate across pillars is
 * exactly as useful as an exact count, because the comparison is between pillars measured the same
 * way.
 *
 * So the two numbers on a trace answer two different questions, and neither is a worse version of
 * the other: `usage` says what the turn cost, `context` says where the input went.
 */

/** The pieces of one prompt, before assembly. */
export interface ContextParts {
  /** System prompt + the action-format instructions. */
  instructions: string;
  /** Retrieved code — chunk text in the transcript's observations. */
  retrieval: string;
  /** Session memory: prior turns, resolved entities. */
  memory: string;
  /** The tool descriptions actually offered this step. */
  tools: string;
  /** The agent's own reasoning + non-retrieval observations so far. */
  transcript: string;
  /** The user's question. */
  question: string;
}

/**
 * Measure each pillar. `total` is the SUM of the pillars, not a separate measurement of the
 * assembled prompt — so the parts always add up and a reader can never be left wondering where a
 * missing few hundred tokens went.
 */
export function meterContext(parts: ContextParts): ContextBreakdown {
  const instructions = estimateTokens(parts.instructions);
  const retrieval = estimateTokens(parts.retrieval);
  const memory = estimateTokens(parts.memory);
  const tools = estimateTokens(parts.tools);
  const transcript = estimateTokens(parts.transcript);
  const question = estimateTokens(parts.question);
  return {
    instructions,
    retrieval,
    memory,
    tools,
    transcript,
    question,
    total: instructions + retrieval + memory + tools + transcript + question,
  };
}

/** Sum breakdowns across turns — the number a cost review wants for a whole question. */
export function sumContext(breakdowns: readonly ContextBreakdown[]): ContextBreakdown {
  const zero: ContextBreakdown = {
    instructions: 0,
    retrieval: 0,
    memory: 0,
    tools: 0,
    transcript: 0,
    question: 0,
    total: 0,
  };
  return breakdowns.reduce<ContextBreakdown>(
    (acc, entry) => ({
      instructions: acc.instructions + entry.instructions,
      retrieval: acc.retrieval + entry.retrieval,
      memory: acc.memory + entry.memory,
      tools: acc.tools + entry.tools,
      transcript: acc.transcript + entry.transcript,
      question: acc.question + entry.question,
      total: acc.total + entry.total,
    }),
    zero,
  );
}

/** The pillar accounting for the largest share, and that share. What a cost review reads first. */
export function dominantPillar(breakdown: ContextBreakdown): { pillar: keyof Omit<ContextBreakdown, "total">; share: number } {
  const pillars: Array<keyof Omit<ContextBreakdown, "total">> = [
    "instructions",
    "retrieval",
    "memory",
    "tools",
    "transcript",
    "question",
  ];
  let best: keyof Omit<ContextBreakdown, "total"> = "instructions";
  let bestValue = -1;
  for (const pillar of pillars) {
    // Strict `>` plus a fixed pillar order makes ties resolve the same way every run.
    if (breakdown[pillar] > bestValue) {
      bestValue = breakdown[pillar];
      best = pillar;
    }
  }
  return { pillar: best, share: breakdown.total === 0 ? 0 : bestValue / breakdown.total };
}
