import { AGENT_MAX_TOOLS_PER_STEP } from "@codeflow/config";
import type { AgentTool } from "./contracts.js";

/**
 * PER-STEP TOOL CURATION (V3-P3 task 3).
 *
 * WHAT THIS ACTUALLY SAVES. A tool's `description` is prompt text, paid for on EVERY turn whether
 * the tool is called or not. Six tools with two-line descriptions is a few hundred tokens of fixed
 * overhead per call, multiplied by up to six turns per question, on every question. Omitting the
 * descriptions of tools that cannot plausibly help is therefore the largest single lever on the
 * agent's context budget — larger than trimming memory, which is already bounded.
 *
 * IT IS ALSO A QUALITY LEVER, and that is the less obvious half. A model offered six tools picks
 * worse than one offered three: irrelevant options invite exploratory calls that cost a turn and
 * return nothing. Curation is not only cheaper, it converges faster.
 *
 * THE RULES, deliberately DETERMINISTIC — no model decides which tools a model may see, because
 * that would be a paid call to save a paid call, and it would make the loop's behaviour
 * unreproducible:
 *
 *   1. A tool with NO triggers is general-purpose and always a candidate (`search_code`).
 *   2. A tool whose trigger appears in the question is a candidate.
 *   3. A tool already USED this question stays a candidate — the model may legitimately call it
 *      again with different arguments.
 *   4. A tool that returned EMPTY twice is dropped. Offering it a third time invites a third
 *      empty call, and the model has no memory of the pattern that a counter here has.
 *   5. Whatever survives is capped at `AGENT_MAX_TOOLS_PER_STEP`, ordered so the strongest signal
 *      wins: trigger matches first (by match count), then already-used, then general-purpose.
 *
 * Rule 4 is the one worth arguing about. It can in principle drop a tool that would have
 * succeeded on a third, better-formed call. Accepted knowingly: two empties is strong evidence the
 * tool has nothing for this question, and the cost of being wrong is one lost option out of
 * several, whereas the cost of not having the rule is a loop that burns its whole turn budget
 * re-asking the same empty question.
 */

/** What the router needs to know about how this question has gone so far. */
export interface ToolUsageState {
  /** Tool id -> how many times it was called this question. */
  calls: Record<string, number>;
  /** Tool id -> how many of those returned `empty: true`. */
  empties: Record<string, number>;
}

export function emptyUsageState(): ToolUsageState {
  return { calls: {}, empties: {} };
}

/** Record a call's outcome. Returns a new state (the loop keeps it immutable per turn). */
export function recordToolOutcome(state: ToolUsageState, toolId: string, wasEmpty: boolean): ToolUsageState {
  return {
    calls: { ...state.calls, [toolId]: (state.calls[toolId] ?? 0) + 1 },
    empties: { ...state.empties, [toolId]: (state.empties[toolId] ?? 0) + (wasEmpty ? 1 : 0) },
  };
}

/** How many consecutive-equivalent empties before a tool stops being offered. */
export const TOOL_EMPTY_DROP_THRESHOLD = 2;

export interface CurateToolsOptions {
  question: string;
  tools: readonly AgentTool[];
  usage: ToolUsageState;
  /** Override the per-step cap (tests). */
  maxTools?: number;
}

export interface CuratedTools {
  tools: AgentTool[];
  /** Tool ids omitted this step, and why — so a trace can explain a choice the model never saw. */
  omitted: Array<{ id: string; reason: "no-trigger-match" | "exhausted" | "over-cap" }>;
}

export function curateTools(options: CurateToolsOptions): CuratedTools {
  const maxTools = options.maxTools ?? AGENT_MAX_TOOLS_PER_STEP;
  const haystack = options.question.toLowerCase();
  const omitted: CuratedTools["omitted"] = [];

  interface Scored {
    tool: AgentTool;
    matches: number;
    used: boolean;
    general: boolean;
  }
  const scored: Scored[] = [];

  for (const tool of options.tools) {
    const empties = options.usage.empties[tool.id] ?? 0;
    if (empties >= TOOL_EMPTY_DROP_THRESHOLD) {
      omitted.push({ id: tool.id, reason: "exhausted" });
      continue;
    }
    const general = !tool.triggers || tool.triggers.length === 0;
    const matches = general ? 0 : (tool.triggers ?? []).filter((trigger) => haystack.includes(trigger)).length;
    const used = (options.usage.calls[tool.id] ?? 0) > 0;

    if (!general && matches === 0 && !used) {
      omitted.push({ id: tool.id, reason: "no-trigger-match" });
      continue;
    }
    scored.push({ tool, matches, used, general });
  }

  // Strongest signal first; ties broken on id so the offered set is deterministic.
  scored.sort(
    (a, b) =>
      b.matches - a.matches ||
      Number(b.used) - Number(a.used) ||
      Number(a.general) - Number(b.general) ||
      a.tool.id.localeCompare(b.tool.id),
  );

  const kept = scored.slice(0, maxTools);
  for (const entry of scored.slice(maxTools)) omitted.push({ id: entry.tool.id, reason: "over-cap" });

  return { tools: kept.map((entry) => entry.tool), omitted };
}
