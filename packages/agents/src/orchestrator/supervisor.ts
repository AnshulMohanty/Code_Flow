import { SUPERVISOR_MAX_FINDINGS, SUPERVISOR_MAX_READING_STEPS } from "@codeflow/config";
import type { AnalysisResult, ReadingStep, Synthesis } from "@codeflow/shared-types";
import type { ContextBreakdown } from "../contracts.js";
import { meterContext } from "../contextMeter.js";
import { renderFindings, selectForSupervisor } from "./blackboard.js";
import type { Blackboard, SpecialistFinding } from "./contracts.js";

/**
 * THE SUPERVISOR (V3-P4 task 1) — one agent, reading summaries and graph facts, producing the final
 * synthesis and the global grounded reading order.
 *
 * WHY A SUPERVISOR AT ALL, rather than concatenating the specialists' findings. A reading order is a
 * GLOBAL, ordered thing: "read this first, then this" is a claim about the whole repository, and no
 * per-community worker can make it because none of them saw the other communities. Concatenation
 * would produce five per-community lists and leave the actual question — where does a newcomer
 * start — unanswered.
 *
 * WHAT IT SEES, and why that is bounded:
 *   - a BOUNDED selection of the blackboard (`selectForSupervisor`), so its prompt does not grow
 *     with worker count;
 *   - DETERMINISTIC graph facts (entry points, key files, cycle count), which are cheap, exact, and
 *     the same facts the single-shot synthesize prompt used.
 * It never sees a transcript, raw code, or a worker's reasoning.
 *
 * ITS OUTPUT IS GROUNDED THE SAME WAY the single-shot path's was: every reading-order fileId must be
 * a real graph node, ungrounded steps are dropped and counted, and the survivors are renumbered
 * deterministically. That is the invariant this phase must not weaken, so the check is applied to
 * the supervisor's output exactly as `deriveSynthesis` applied it before — and there is a
 * DETERMINISTIC FALLBACK for when the supervisor fails entirely, because a fan-out that spent five
 * specialist calls and then returned nothing would be strictly worse than the single call it
 * replaced.
 */

export const SUPERVISOR_SYSTEM_PROMPT =
  "You are the SUPERVISOR of a code-analysis team. Specialists each analysed one group of related " +
  "files and reported structured findings; you never see their raw work, only their findings.\n" +
  "\n" +
  "Your job: write a short summary of what this repository is, and a GLOBAL reading order telling a " +
  "newcomer which files to read and why, in order. The reading order is a claim about the WHOLE " +
  "repository — no specialist could make it, which is why it is yours.\n" +
  "\n" +
  "Use ONLY the findings and graph facts provided. Never invent a file path: a step naming a file " +
  "that does not exist is DROPPED by code before anyone reads it.\n" +
  "\n" +
  "Reply with a SINGLE JSON object and nothing else:\n" +
  '  {"summary":"a few lines","readingOrder":[{"fileId":"<path>","order":1,"reason":"why"}],' +
  '"keyConcepts":["optional"]}';

export interface SupervisorPromptResult {
  prompt: string;
  context: ContextBreakdown;
  /** Exactly what the supervisor was shown — kept so a synthesis can be traced to its inputs. */
  shown: SpecialistFinding[];
}

/**
 * Build the supervisor's prompt and meter it per pillar.
 *
 * The metering is not decoration here: `context.total` is the number the "orchestrator context does
 * not grow with worker count" claim is made about, so it has to be measured rather than argued.
 */
export function buildSupervisorPrompt(
  board: Blackboard,
  result: AnalysisResult,
  options: { maxFindings?: number; maxSteps?: number } = {},
): SupervisorPromptResult {
  const shown = selectForSupervisor(board, options.maxFindings ?? SUPERVISOR_MAX_FINDINGS);
  const maxSteps = options.maxSteps ?? SUPERVISOR_MAX_READING_STEPS;

  const entryPoints = (result.entryPoints ?? []).map((entry) => entry.fileId).sort();
  const keyFiles = (result.metrics?.keyFiles ?? []).slice(0, 10);
  const clusters = result.metrics?.clusters;
  const cycleCount = result.metrics?.cycles.length ?? 0;

  const facts = [
    `files: ${result.graph?.nodes.length ?? result.files.length}`,
    `entry points: ${entryPoints.length ? entryPoints.join(", ") : "none detected"}`,
    `most central files: ${keyFiles.length ? keyFiles.join(", ") : "none"}`,
    clusters ? `communities: ${clusters.count} (modularity ${clusters.modularity.toFixed(3)})` : "communities: not computed",
    `dependency cycles: ${cycleCount}`,
  ].join("\n");

  const findingsBlock = renderFindings(shown);

  const prompt = [
    `## Deterministic repository facts\n${facts}`,
    `## Specialist findings (${shown.length} of ${board.findings.length}, selected by importance across communities)\n${findingsBlock}`,
    `## Your task\nWrite the summary and a reading order of at most ${maxSteps} steps. Respond with a single JSON object.`,
  ].join("\n\n");

  const context = meterContext({
    instructions: SUPERVISOR_SYSTEM_PROMPT,
    // A worker's finding IS the supervisor's retrieved evidence, so it is metered as retrieval —
    // which is what makes "did the supervisor's input grow?" answerable from the breakdown.
    retrieval: findingsBlock,
    memory: "",
    tools: "",
    transcript: facts,
    question: `reading order, at most ${maxSteps} steps`,
  });

  return { prompt, context, shown };
}

/**
 * Validate + GROUND the supervisor's output. Runtime validation at the parsed-LLM-JSON boundary.
 *
 * Deliberately mirrors `deriveSynthesis` rather than reusing it: that function is the single-shot
 * path's contract and takes a graph node set, which is exactly right — so this applies the SAME
 * rule (fileId ∈ graph nodes, drop + count, renumber deterministically) with the additional step
 * cap the supervisor is given. Sharing one function would have meant threading a cap through the
 * older path for no reason; sharing the RULE is what matters, and a test asserts both paths ground
 * identically.
 */
export function deriveSupervisedSynthesis(
  raw: string,
  nodeIds: ReadonlySet<string>,
  maxSteps = SUPERVISOR_MAX_READING_STEPS,
): Synthesis {
  const cleaned = stripFences(raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Supervisor output was not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Supervisor output was not a JSON object.");
  }
  const record = parsed as Record<string, unknown>;

  if (typeof record.summary !== "string" || record.summary.trim() === "") {
    throw new Error("Supervisor output is missing a non-empty `summary`.");
  }
  if (!Array.isArray(record.readingOrder)) {
    throw new Error("Supervisor output is missing a `readingOrder` array.");
  }

  const steps: ReadingStep[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const [index, entry] of record.readingOrder.entries()) {
    if (!entry || typeof entry !== "object") throw new Error(`readingOrder[${index}] is not an object.`);
    const step = entry as Record<string, unknown>;
    if (typeof step.fileId !== "string" || step.fileId === "") throw new Error(`readingOrder[${index}].fileId is missing.`);
    if (typeof step.reason !== "string") throw new Error(`readingOrder[${index}].reason is missing.`);
    // GROUNDING: a fileId that is not a graph node is a fabricated path. Dropped and counted.
    if (!nodeIds.has(step.fileId)) {
      dropped += 1;
      continue;
    }
    // A repeated file is not a second step — it is the same advice twice, and it would push a real
    // step out of the capped list.
    if (seen.has(step.fileId)) continue;
    seen.add(step.fileId);
    steps.push({
      fileId: step.fileId,
      order: typeof step.order === "number" ? step.order : index + 1,
      reason: step.reason,
    });
  }

  if (steps.length === 0) {
    // Same contract as the single-shot path: an entirely ungrounded synthesis is rejected so the
    // caller can retry or fall back, rather than shipping a guide that points nowhere.
    throw new Error("Supervisor produced no grounded reading steps.");
  }

  // Renumber deterministically after grounding, so the numbers a user sees are contiguous and the
  // order does not depend on which steps happened to be dropped.
  const ordered = steps
    .sort((a, b) => a.order - b.order || a.fileId.localeCompare(b.fileId))
    .slice(0, Math.max(1, maxSteps))
    .map((step, index) => ({ ...step, order: index + 1 }));

  let keyConcepts: string[] | undefined;
  if (record.keyConcepts !== undefined) {
    if (!Array.isArray(record.keyConcepts) || record.keyConcepts.some((value) => typeof value !== "string")) {
      throw new Error("`keyConcepts` must be an array of strings when present.");
    }
    keyConcepts = record.keyConcepts as string[];
  }

  return {
    summary: record.summary.trim(),
    readingOrder: ordered,
    ...(keyConcepts ? { keyConcepts } : {}),
    ...(dropped > 0 ? { droppedCitations: dropped } : {}),
  };
}

/**
 * The DETERMINISTIC FALLBACK synthesis, from graph facts and the blackboard alone — no model.
 *
 * It exists because a fan-out that spent five specialist calls and then returned nothing would be
 * strictly worse than the single call it replaced. When the supervisor fails (unparseable output,
 * budget exhausted, provider down), the specialists' work is still real: their findings are grounded
 * fileIds with importance attached, and the graph still knows the entry points and the central files.
 * That is enough for a genuinely useful reading order.
 *
 * It is honest about what it is: the summary says so, so nobody mistakes it for a model's synthesis.
 * Fully deterministic, which also makes it the natural thing to test the grounding contract against.
 */
export function fallbackSynthesis(board: Blackboard, result: AnalysisResult, maxSteps = SUPERVISOR_MAX_READING_STEPS): Synthesis {
  const nodeIds = new Set((result.graph?.nodes ?? result.files).map((node) => node.id));

  const ranked: Array<{ fileId: string; reason: string; rank: number }> = [];
  const push = (fileId: string, reason: string, rank: number) => {
    if (!nodeIds.has(fileId) || ranked.some((entry) => entry.fileId === fileId)) return;
    ranked.push({ fileId, reason, rank });
  };

  // Entry points first — where execution starts is where a newcomer starts.
  for (const entry of result.entryPoints ?? []) push(entry.fileId, `Entry point (${entry.reason}).`, 0);
  // Then files the specialists actually flagged, importance-first: real findings beat centrality.
  const byImportance = [...board.findings].sort(
    (a, b) => rank(b.importance) - rank(a.importance) || a.cluster - b.cluster || a.headline.localeCompare(b.headline),
  );
  for (const finding of byImportance) {
    for (const fileId of finding.fileIds) push(fileId, `${finding.specialist}: ${finding.headline}`, 1);
  }
  // Then centrality, to fill out the list when the specialists were quiet.
  for (const fileId of result.metrics?.keyFiles ?? []) push(fileId, "One of the most connected files.", 2);

  const readingOrder = ranked
    .sort((a, b) => a.rank - b.rank || a.fileId.localeCompare(b.fileId))
    .slice(0, Math.max(1, maxSteps))
    .map((entry, index) => ({ fileId: entry.fileId, order: index + 1, reason: entry.reason }));

  const clusters = result.metrics?.clusters;
  return {
    summary:
      `Assembled from ${board.findings.length} specialist finding(s) across ` +
      `${clusters?.count ?? 0} code communities WITHOUT a supervisor synthesis (the supervisor step did ` +
      "not complete). The reading order below is derived from entry points, specialist findings and " +
      "dependency centrality — all deterministic facts.",
    readingOrder,
    ...(clusters ? { keyConcepts: [`${clusters.count} code communities (modularity ${clusters.modularity.toFixed(2)})`] } : {}),
  };
}

function rank(importance: SpecialistFinding["importance"]): number {
  return importance === "high" ? 3 : importance === "medium" ? 2 : 1;
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced ? fenced[1] : text;
}
