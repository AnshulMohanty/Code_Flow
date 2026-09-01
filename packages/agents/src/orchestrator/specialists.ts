import {
  SPECIALIST_MAX_DETAIL_CHARS,
  SPECIALIST_MAX_FILES,
  SPECIALIST_MAX_FINDINGS,
} from "@codeflow/config";
import { stripCodeFence } from "@codeflow/analyzers";
import type { AnalysisResult, RepoCluster } from "@codeflow/shared-types";
import type { FindingImportance, SpecialistFinding, SpecialistId, SpecialistTask } from "./contracts.js";

/**
 * THE FIVE SPECIALISTS + their PHASE GATE (V3-P4 tasks 1 and 2).
 *
 * Each specialist is one LENS over one community. The lens matters: five agents asked "analyse this"
 * produce five overlapping paragraphs, whereas five agents asked five different questions produce
 * five complementary findings that a supervisor can actually compose.
 *
 * THE PHASE GATE, four checks per specialist, all enforced in code:
 *
 *   1. INPUT SAFETY — a specialist sees ONLY its community's files, bounded to
 *      `SPECIALIST_MAX_FILES` and sorted. Bounded for cost, yes, but mainly because a specialist
 *      reasoning over 400 files is a specialist reasoning over noise. Scoping to the community is
 *      what makes the fan-out compose: two specialists on two communities cannot both claim the
 *      same file.
 *   2. SCHEMA — the parsed LLM JSON is validated field by field (an untrusted external boundary
 *      under the V3-P0 rule). A malformed finding is REJECTED, not coerced.
 *   3. GROUNDING — every claimed fileId must be in THIS COMMUNITY's file set. That is strictly
 *      stronger than "in the graph": a security specialist looking at community 3 that cites a file
 *      from community 7 has wandered outside its evidence, and accepting it would let the fan-out
 *      produce overlapping, unattributable claims. Violations are dropped and counted.
 *   4. BUDGET — checked by the orchestrator before each specialist call, so exhaustion skips the
 *      remaining specialists instead of failing the run.
 *
 * REFUSAL IS A FIRST-CLASS OUTCOME, not an error. A specialist with nothing to say returns
 * `refused` with a reason and the run completes normally — the brief's "refusal = 200 + reason".
 * Treating "nothing to report" as a failure would push a model toward inventing findings, which is
 * the opposite of what a security lens should do.
 */

export interface SpecialistSpec {
  id: SpecialistId;
  /** The lens, as the model reads it. */
  question: string;
  /** What a good finding looks like for this lens — keeps the five from converging on prose. */
  guidance: string;
}

export const SPECIALIST_SPECS: readonly SpecialistSpec[] = [
  {
    id: "architecture",
    question: "What is this group of files architecturally, and how does it fit the rest of the system?",
    guidance:
      "Name the responsibility, the entry point into this group, and the layer it belongs to. " +
      "A good finding lets a newcomer know what to read first here.",
  },
  {
    id: "data-flow",
    question: "How does data enter, move through, and leave this group of files?",
    guidance: "Trace inputs to outputs. Name where data is transformed and where it is persisted or emitted.",
  },
  {
    id: "security",
    question: "What in this group of files handles trust boundaries, secrets, authentication or untrusted input?",
    guidance:
      "Report only what the code SHOWS. Do not infer a vulnerability from a file name, and do not " +
      "report the absence of something as a finding. Refuse if nothing here touches a trust boundary.",
  },
  {
    id: "api-surface",
    question: "What does this group of files expose to the rest of the system or to the outside world?",
    guidance: "Name exported symbols, HTTP routes and public entry points. Distinguish internal from external.",
  },
  {
    id: "dependency-risk",
    question: "What coupling or dependency risk does this group of files carry?",
    guidance:
      "Report cycles, files everything depends on, and files that reach across many modules. " +
      "Use the dependency facts given; do not guess at coupling.",
  },
];

export const SPECIALIST_SYSTEM_PROMPT =
  "You are ONE specialist analysing ONE group of related files in a repository. You have a single " +
  "lens; another specialist covers each other concern, so stay in yours.\n" +
  "\n" +
  "Report ONLY what the provided facts show. Never infer from a file name. Never report the absence " +
  "of something as a finding. If your lens has nothing to say about these files, refuse — that is a " +
  "correct and useful answer.\n" +
  "\n" +
  "Reply with a SINGLE JSON object and nothing else:\n" +
  '  {"findings":[{"headline":"one line","detail":"a few sentences","importance":"low|medium|high",' +
  '"fileIds":["<path>"]}]}\n' +
  "  or, to refuse:\n" +
  '  {"refused":true,"reason":"why this lens has nothing here"}\n' +
  "\n" +
  "fileIds MUST come from the file list you were given. A fileId from anywhere else is DROPPED.";

/**
 * Build one specialist's task: the community's files, bounded and sorted.
 *
 * Sorted before truncating, so which files a specialist sees is deterministic — a set that varied
 * run to run would make the whole fan-out unreproducible even though no model is involved in the
 * choice.
 */
export function buildSpecialistTask(
  specialist: SpecialistId,
  cluster: RepoCluster,
  result: AnalysisResult,
  maxFiles = SPECIALIST_MAX_FILES,
): SpecialistTask {
  return {
    specialist,
    cluster,
    result,
    fileIds: [...cluster.files].sort().slice(0, Math.max(1, maxFiles)),
  };
}

/**
 * The DETERMINISTIC facts a specialist is given about its community.
 *
 * Facts, not code: the graph already knows the imports, the calls, the cycles, the symbols and the
 * routes, and handing those over is both cheaper and more reliable than handing over file contents
 * for the model to re-derive. It is also what keeps the specialist's claims checkable — every
 * fileId it can legitimately cite appears in this block.
 */
export function buildSpecialistPrompt(task: SpecialistTask): string {
  const spec = SPECIALIST_SPECS.find((entry) => entry.id === task.specialist);
  const members = new Set(task.fileIds);
  const graph = task.result.graph;

  const internalEdges = (graph?.edges ?? [])
    .filter((edge) => members.has(edge.from) && members.has(edge.to))
    .map((edge) => `${edge.from} -> ${edge.to}`)
    .sort();
  const inboundEdges = (graph?.edges ?? [])
    .filter((edge) => !members.has(edge.from) && members.has(edge.to))
    .map((edge) => `${edge.from} -> ${edge.to}`)
    .sort();
  const outboundEdges = (graph?.edges ?? [])
    .filter((edge) => members.has(edge.from) && !members.has(edge.to))
    .map((edge) => `${edge.from} -> ${edge.to}`)
    .sort();
  const calls = (graph?.cpgEdges ?? [])
    .filter((edge) => members.has(edge.from) || members.has(edge.to))
    .map((edge) => `${edge.from} ${edge.kind} ${edge.to} (${edge.symbol}, x${edge.count})`)
    .sort();
  const routes = (graph?.routes ?? [])
    .filter((route) => members.has(route.fileId))
    .map((route) => `${route.method} ${route.path} (${route.fileId})`)
    .sort();
  const symbols = (task.result.inventory?.symbols ?? [])
    .filter((symbol) => members.has(symbol.filePath))
    .map((symbol) => `${symbol.name} (${symbol.kind}${symbol.exported ? ", exported" : ""}) in ${symbol.filePath}`)
    .sort();
  const cycles = (task.result.metrics?.cycles ?? [])
    .filter((cycle) => cycle.files.some((file) => members.has(file)))
    .map((cycle) => cycle.files.join(" -> "))
    .sort();

  const section = (label: string, items: readonly string[], limit = 40): string => {
    if (items.length === 0) return `${label}: none`;
    const shown = items.slice(0, limit);
    const suffix = items.length > shown.length ? `\n  (+${items.length - shown.length} more of ${items.length})` : "";
    return `${label}:\n  ${shown.join("\n  ")}${suffix}`;
  };

  return [
    `## Your lens\n${spec?.question ?? task.specialist}\n${spec?.guidance ?? ""}`,
    `## Files in this group (the ONLY fileIds you may cite)\n  ${task.fileIds.join("\n  ")}`,
    `## Dependency facts\n${section("within the group", internalEdges)}\n${section("into the group", inboundEdges)}\n${section("out of the group", outboundEdges)}`,
    section("## Calls and inheritance", calls),
    section("## HTTP routes", routes),
    section("## Declared symbols", symbols),
    section("## Dependency cycles touching this group", cycles),
    "Respond with a single JSON object.",
  ].join("\n\n");
}

export interface ParsedSpecialistOutput {
  refused: boolean;
  reason?: string;
  findings: Array<{ headline: string; detail: string; importance: FindingImportance; fileIds: string[] }>;
}

/**
 * SCHEMA validation for a specialist's output — real runtime validation at the parsed-LLM-JSON
 * boundary, not a cast.
 *
 * Rejects rather than coerces. A finding with no headline coerced to `""` would reach the supervisor
 * as an empty bullet that looks like a fact; a non-array `fileIds` coerced to `[]` would silently
 * turn a grounded finding into an ungrounded one. Both are worse than a rejected turn.
 *
 * Never throws — a malformed output is a legitimate outcome the orchestrator records as `failed`.
 */
export function parseSpecialistOutput(raw: string): ParsedSpecialistOutput | { error: string } {
  const cleaned = stripCodeFence(raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { error: "specialist output was not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "specialist output was not a JSON object" };
  }
  const record = parsed as Record<string, unknown>;

  if (record.refused === true) {
    const reason = typeof record.reason === "string" && record.reason.trim() ? record.reason.trim() : "no reason given";
    return { refused: true, reason, findings: [] };
  }

  if (!Array.isArray(record.findings)) {
    return { error: "specialist output has no `findings` array (and did not refuse)" };
  }
  // An EMPTY findings array is a refusal in all but name, and treating it as one keeps the two
  // paths from diverging — a caller should not have to check both.
  if (record.findings.length === 0) {
    return { refused: true, reason: "returned no findings", findings: [] };
  }

  const findings: ParsedSpecialistOutput["findings"] = [];
  for (const [index, entry] of record.findings.entries()) {
    if (!entry || typeof entry !== "object") return { error: `findings[${index}] is not an object` };
    const finding = entry as Record<string, unknown>;
    const headline = typeof finding.headline === "string" ? finding.headline.trim() : "";
    if (!headline) return { error: `findings[${index}] has no non-empty \`headline\`` };
    const detail = typeof finding.detail === "string" ? finding.detail.trim() : "";
    const importance = normalizeImportance(finding.importance);
    if (!Array.isArray(finding.fileIds)) return { error: `findings[${index}] has no \`fileIds\` array` };
    const fileIds = finding.fileIds.filter((value): value is string => typeof value === "string" && value.trim() !== "");
    findings.push({ headline, detail, importance, fileIds: [...new Set(fileIds.map((id) => id.trim()))] });
  }
  return { refused: false, findings };
}

/** Unknown/absent importance becomes "medium" rather than "high": a model that omits the field has
 *  not claimed urgency, and defaulting upward would let every finding crowd the supervisor's cap. */
function normalizeImportance(value: unknown): FindingImportance {
  if (value === "high" || value === "medium" || value === "low") return value;
  return "medium";
}

/**
 * GROUNDING + bounding, applied to a parsed output. Returns the findings the blackboard will accept
 * and the fileIds that were dropped.
 *
 * A finding left with NO grounded fileIds is dropped entirely: an ungrounded claim is not a weaker
 * finding, it is an unattributable one, and letting it through would put a sentence in front of a
 * user with nothing behind it.
 */
export function groundFindings(
  parsed: ParsedSpecialistOutput,
  task: SpecialistTask,
  options: { maxFindings?: number; maxDetailChars?: number } = {},
): { findings: SpecialistFinding[]; droppedFileIds: string[] } {
  const allowed = new Set(task.fileIds);
  const maxFindings = options.maxFindings ?? SPECIALIST_MAX_FINDINGS;
  const maxDetail = options.maxDetailChars ?? SPECIALIST_MAX_DETAIL_CHARS;

  const droppedFileIds: string[] = [];
  const findings: SpecialistFinding[] = [];

  for (const candidate of parsed.findings) {
    const grounded = candidate.fileIds.filter((fileId) => allowed.has(fileId));
    for (const fileId of candidate.fileIds) if (!allowed.has(fileId)) droppedFileIds.push(fileId);
    if (grounded.length === 0) continue;
    findings.push({
      specialist: task.specialist,
      cluster: task.cluster.id,
      headline: truncate(candidate.headline, 160),
      detail: truncate(candidate.detail, maxDetail),
      importance: candidate.importance,
      fileIds: [...new Set(grounded)].sort(),
    });
  }

  // Importance-first, then a stable tie-break, then the cap — so which findings survive is
  // deterministic and the most important ones do.
  findings.sort((a, b) => importanceRank(b.importance) - importanceRank(a.importance) || a.headline.localeCompare(b.headline));

  return { findings: findings.slice(0, Math.max(0, maxFindings)), droppedFileIds: [...new Set(droppedFileIds)].sort() };
}

export function importanceRank(importance: FindingImportance): number {
  return importance === "high" ? 3 : importance === "medium" ? 2 : 1;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

