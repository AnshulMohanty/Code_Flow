import { AGENT_MAX_TOOLS_PER_STEP } from "@codeflow/config";
import type { AgentTool } from "./contracts.js";

/**
 * Per-step tool curation. A tool's description is prompt text paid on every turn, and a model offered
 * fewer, relevant tools picks better, so each step offers only plausible tools — by fixed rules, never
 * a model (that would be a paid call to save a paid call, and unreproducible):
 *
 *   1. A tool with no triggers is general-purpose and always a candidate (`search_code`).
 *   2. A tool whose trigger appears in the question is a candidate.
 *   3. A tool already used for this question stays a candidate.
 *   4. A tool that returned empty twice is dropped (accepted risk: it might have worked a third time;
 *      without the rule a loop can burn its whole turn budget on the same empty call).
 *   5. Survivors are capped at `AGENT_MAX_TOOLS_PER_STEP`: trigger matches first, then used, then general.
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
