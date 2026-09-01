import { SUPERVISOR_MAX_FINDINGS } from "@codeflow/config";
import type { Blackboard, BlackboardEntry, SpecialistFinding } from "./contracts.js";
import { importanceRank } from "./specialists.js";

/**
 * THE SHARED BLACKBOARD (V3-P4 task 1) — and the one mechanism that makes the fan-out scale.
 *
 * THE DOCUMENTED FAILURE this exists to prevent: orchestrator context growing with worker count. It
 * is the reason naive multi-agent systems fall over at 4+ workers — every worker's output is
 * concatenated into the supervisor's prompt, so cost and latency grow linearly with parallelism and
 * the supervisor's attention degrades exactly when there is most to attend to.
 *
 * The fix is structural, not hopeful. Workers write STRUCTURED, individually BOUNDED findings (never
 * transcripts, never raw code). The supervisor then reads `selectForSupervisor`, which returns at
 * most `SUPERVISOR_MAX_FINDINGS` of them. So the supervisor's input has a CEILING that is a function
 * of the cap and of nothing else: 5 workers and 500 workers produce the same-size supervisor prompt
 * once the cap is reached. That is asserted by a test comparing a 3-community run against a
 * 60-community one.
 *
 * The full `findings` list is kept for the report and the trace — the bound applies to the PROMPT,
 * not to what is recorded. Losing the record would be trading one problem for a worse one.
 */

export function emptyBlackboard(): Blackboard {
  return { entries: [], findings: [] };
}

/** Append one worker's outcome. Pure; returns a new blackboard. */
export function post(board: Blackboard, entry: BlackboardEntry): Blackboard {
  return {
    entries: [...board.entries, entry],
    findings: [...board.findings, ...entry.findings],
  };
}

/**
 * Select what the supervisor sees: at most `max` findings, chosen DETERMINISTICALLY.
 *
 * The ordering is importance descending, then a ROUND-ROBIN across communities, then cluster id and
 * specialist. The round-robin is the part worth explaining: a plain importance sort would let one
 * pathological community with five `high` findings consume the entire cap, and the supervisor would
 * then write a synthesis of one corner of the repository while believing it had seen the whole
 * blackboard. Interleaving by community guarantees breadth first and depth second, so the cap
 * degrades coverage gracefully instead of catastrophically.
 */
export function selectForSupervisor(board: Blackboard, max = SUPERVISOR_MAX_FINDINGS): SpecialistFinding[] {
  if (max <= 0) return [];

  // Group by community, each group ordered by importance then a stable tie-break.
  const byCluster = new Map<number, SpecialistFinding[]>();
  for (const finding of board.findings) {
    const bucket = byCluster.get(finding.cluster) ?? [];
    bucket.push(finding);
    byCluster.set(finding.cluster, bucket);
  }
  for (const bucket of byCluster.values()) {
    bucket.sort(
      (a, b) =>
        importanceRank(b.importance) - importanceRank(a.importance) ||
        a.specialist.localeCompare(b.specialist) ||
        a.headline.localeCompare(b.headline),
    );
  }

  const clusters = [...byCluster.keys()].sort((a, b) => a - b);
  const selected: SpecialistFinding[] = [];
  let round = 0;
  // Round-robin: one finding per community per pass, until the cap or the findings run out.
  while (selected.length < max) {
    let addedThisRound = false;
    for (const cluster of clusters) {
      if (selected.length >= max) break;
      const bucket = byCluster.get(cluster);
      const candidate = bucket?.[round];
      if (!candidate) continue;
      selected.push(candidate);
      addedThisRound = true;
    }
    if (!addedThisRound) break;
    round += 1;
  }

  // Presented importance-first so the supervisor reads the strongest signals at the top of its
  // prompt, where a truncating tokenizer would keep them.
  return selected.sort(
    (a, b) =>
      importanceRank(b.importance) - importanceRank(a.importance) ||
      a.cluster - b.cluster ||
      a.specialist.localeCompare(b.specialist) ||
      a.headline.localeCompare(b.headline),
  );
}

/** Counts worth reporting about a completed fan-out. */
export interface BlackboardSummary {
  entries: number;
  ok: number;
  refused: number;
  failed: number;
  skippedBudget: number;
  findings: number;
  clusters: number;
  droppedFileIds: number;
  /** Communities that produced no finding at all — a coverage gap worth seeing. */
  silentClusters: number[];
}

export function summarizeBlackboard(board: Blackboard): BlackboardSummary {
  const clusters = new Set(board.entries.map((entry) => entry.cluster));
  const withFindings = new Set(board.findings.map((finding) => finding.cluster));
  return {
    entries: board.entries.length,
    ok: board.entries.filter((entry) => entry.status === "ok").length,
    refused: board.entries.filter((entry) => entry.status === "refused").length,
    failed: board.entries.filter((entry) => entry.status === "failed").length,
    skippedBudget: board.entries.filter((entry) => entry.status === "skipped-budget").length,
    findings: board.findings.length,
    clusters: clusters.size,
    droppedFileIds: board.entries.reduce((sum, entry) => sum + entry.droppedFileIds.length, 0),
    silentClusters: [...clusters].filter((cluster) => !withFindings.has(cluster)).sort((a, b) => a - b),
  };
}

/** Render the selected findings for the supervisor's prompt. Bounded by construction — every field
 *  was bounded when it was posted, and the count is bounded by `selectForSupervisor`. */
export function renderFindings(findings: readonly SpecialistFinding[]): string {
  if (findings.length === 0) return "(no specialist findings)";
  return findings
    .map(
      (finding) =>
        `- [${finding.importance}] (${finding.specialist}, community ${finding.cluster}) ${finding.headline}\n` +
        `  ${finding.detail}\n  files: ${finding.fileIds.join(", ")}`,
    )
    .join("\n");
}
