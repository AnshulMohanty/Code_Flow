import type { Issue, RepoGraph, RepoMetrics } from "@codeflow/shared-types";

/**
 * Derive the `issues` slice from Analyze's metrics (V3-P0).
 *
 * `issues` was a PRODUCERLESS slice: the type declared it, the orchestrator round-tripped it
 * through the cache, and `apps/web/src/lib/analysisNormalizer.ts` READ it in four places
 * (security findings, architecture rules, the risk level, per-node risk text) — so the UI was
 * rendering an always-empty list as though it were a finding of "no problems". That is the
 * exact failure mode V3-P0 exists to remove, so `issues` is now PRODUCED rather than dropped.
 *
 * WHAT IS AND IS NOT HERE. Every issue below is a restatement of a number Analyze already
 * computed, with a threshold attached. There is no new measurement, no AI, and deliberately
 * NO `category: "security"` issues: this codebase performs no security analysis whatsoever,
 * and emitting a security finding from structural metrics would be a fabrication. The web's
 * security panel therefore stays legitimately empty, which is the honest answer.
 *
 * Determinism is load-bearing (SHA-keyed cache): issues are sorted by (severity desc, id) and
 * every id is derived from the fileIds it concerns, never from an index or a timestamp.
 */

/** A file whose transitive dependents exceed this SHARE of the repo is a structural hub. */
const BLAST_RADIUS_SHARE = 0.25;
/** ...but only once the repo is big enough for a share to mean anything. */
const MIN_FILES_FOR_SHARE = 8;
/** Degree at or above which a file is reported as highly coupled. */
const HIGH_DEGREE = 20;
/** A cycle of at least this length is reported as high rather than medium severity. */
const LONG_CYCLE = 4;

export interface DeriveIssuesInput {
  metrics?: RepoMetrics;
  graph?: RepoGraph;
}

export function deriveIssues(input: DeriveIssuesInput): Issue[] {
  const metrics = input.metrics;
  if (!metrics) return []; // nothing measured ⇒ nothing to report (never a guess)

  const issues: Issue[] = [];
  const fileCount = metrics.summary.fileCount;

  // 1) Dependency cycles — the classic structural smell, and a hard fact from Analyze.
  for (const cycle of metrics.cycles) {
    if (!cycle.files.length) continue;
    issues.push({
      id: `cycle:${cycle.files.join(">")}`,
      severity: cycle.files.length >= LONG_CYCLE ? "high" : "medium",
      category: "architecture",
      title: `Circular dependency across ${cycle.files.length} file${cycle.files.length === 1 ? "" : "s"}`,
      message: `These files form an import cycle: ${cycle.files.join(" -> ")}. Cycles make the modules impossible to load, test, or reason about independently.`,
      // Attribute to the cycle's lowest fileId so the issue is stably addressable.
      fileId: [...cycle.files].sort()[0],
    });
  }

  // 2) Structural hubs — a file most of the repo transitively depends on. Reported as a
  //    SHARE, and only on a repo large enough for the share to be meaningful.
  if (fileCount >= MIN_FILES_FOR_SHARE) {
    for (const file of metrics.perFile) {
      const share = file.blastRadius / fileCount;
      if (share < BLAST_RADIUS_SHARE) continue;
      issues.push({
        id: `blast-radius:${file.fileId}`,
        severity: share >= 0.5 ? "high" : "medium",
        category: "architecture",
        title: `Change to ${file.fileId} affects ${Math.round(share * 100)}% of the repository`,
        message: `${file.blastRadius} of ${fileCount} files transitively depend on this one, so any change here has repository-wide blast radius.`,
        fileId: file.fileId,
      });
    }
  }

  // 3) High coupling — an absolute degree threshold (a small repo can still have a
  //    20-neighbour file, and that is worth saying regardless of repo size).
  for (const file of metrics.perFile) {
    if (file.centrality < HIGH_DEGREE) continue;
    issues.push({
      id: `coupling:${file.fileId}`,
      severity: "low",
      category: "architecture",
      title: `${file.fileId} is highly coupled (degree ${file.centrality})`,
      message: `This file imports ${file.fanOut} files and is imported by ${file.fanIn}. High-degree files concentrate change risk.`,
      fileId: file.fileId,
    });
  }

  // 4) Isolated files — reported as ONE dependency issue, not N, because a long list of
  //    single-file notices is noise rather than a finding.
  const isolated = metrics.summary.isolatedFileCount;
  if (isolated > 0 && fileCount > 0 && isolated / fileCount >= 0.5) {
    issues.push({
      id: "isolated:majority",
      severity: "low",
      category: "dependency",
      title: `${isolated} of ${fileCount} files have no resolved dependencies`,
      message:
        "Most files are disconnected in the import graph. This usually means the language is not fully supported by the parser, or imports use path aliases the resolver does not follow — treat the graph metrics as a partial view.",
    });
  }

  const rank: Record<Issue["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3 };
  issues.sort((a, b) => rank[a.severity] - rank[b.severity] || a.id.localeCompare(b.id));
  return issues;
}

/** Counts for `AnalysisSummary`. `securityIssues` is always 0 — see the note above: no
 *  security analysis is performed, so any non-zero number here would be invented. */
export function countIssues(issues: Issue[]): { securityIssues: number; architectureViolations: number } {
  return {
    securityIssues: issues.filter((issue) => issue.category === "security").length,
    architectureViolations: issues.filter((issue) => issue.category === "architecture").length,
  };
}
