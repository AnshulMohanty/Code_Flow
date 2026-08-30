import { REPO_MAX_SNAPSHOTS } from "@codeflow/config";
import type { AnalysisResult } from "@codeflow/shared-types";
import { repoKeyOf, type RepoDiff, type RepoMemoryStore, type RepoSnapshot } from "./contracts.js";

/**
 * Repository memory (V3-P3): "what changed between these two commits?"
 *
 * The whole feature rests on keeping something SMALL per commit. Storing `AnalysisResult`s per
 * SHA would turn a memory layer into a second database (and re-introduce, per commit, exactly the
 * document-size problem V3-P2 just solved). A snapshot is fileIds, edges as `from>to` strings,
 * symbol names per file, and cycle keys — sorted, so two snapshots of the same tree are
 * byte-identical and their diff is empty BY CONSTRUCTION rather than by luck.
 *
 * `snapshotOf` reads no clock: `capturedAt` is supplied. A clock read inside a pure derivation
 * makes it untestable and non-reproducible, which is the same reason V3-P1's size guard is a byte
 * ceiling rather than a timeout.
 */

/** Derive a snapshot from an analysis result. Pure and deterministic. */
export function snapshotOf(result: AnalysisResult, capturedAt: string): RepoSnapshot {
  const fileIds = [...new Set((result.graph?.nodes ?? result.files ?? []).map((node) => node.id))].sort();

  const edges = [...new Set((result.graph?.edges ?? []).map((edge) => `${edge.from}>${edge.to}`))].sort();

  const symbolsByFile: Record<string, string[]> = {};
  for (const symbol of result.inventory?.symbols ?? []) {
    const bucket = (symbolsByFile[symbol.filePath] ??= []);
    bucket.push(symbol.name);
  }
  for (const key of Object.keys(symbolsByFile)) {
    // Deduped AND sorted: a file declaring an overloaded name twice must not read as a change
    // when the declaration order shifts.
    symbolsByFile[key] = [...new Set(symbolsByFile[key])].sort();
  }

  // A cycle is a SET of files, so the key is its sorted members — otherwise the same cycle
  // reported from a different starting node would look like a new one.
  const cycles = [...new Set((result.metrics?.cycles ?? []).map((cycle) => [...cycle.files].sort().join("|")))].sort();

  return {
    repoFullName: repoKeyOf(result.repository),
    commitSha: result.commitSha ?? "",
    fileIds,
    edges,
    symbolsByFile,
    cycles,
    capturedAt,
  };
}

/**
 * Diff two snapshots. Pure, deterministic, sorted output.
 *
 * `changedFiles` compares SYMBOL SETS for files present in both. That is the closest thing to
 * "this file changed" available without hashing contents, and for the question this answers —
 * "what changed, and should I care?" — it is more useful than a byte diff: a reformatting commit
 * produces no entry, and a renamed export produces one.
 *
 * `newCycles` is called out separately because it is the single most actionable line a diff can
 * contain: a dependency cycle that did not exist last commit is a regression somebody introduced.
 */
export function diffSnapshots(before: RepoSnapshot, after: RepoSnapshot): RepoDiff {
  if (before.repoFullName !== after.repoFullName) {
    throw new Error(
      `Cannot diff snapshots from two different repositories (${before.repoFullName} vs ${after.repoFullName}).`,
    );
  }

  const beforeFiles = new Set(before.fileIds);
  const afterFiles = new Set(after.fileIds);
  const addedFiles = after.fileIds.filter((id) => !beforeFiles.has(id));
  const removedFiles = before.fileIds.filter((id) => !afterFiles.has(id));

  const changedFiles: RepoDiff["changedFiles"] = [];
  for (const fileId of after.fileIds) {
    if (!beforeFiles.has(fileId)) continue; // added, not changed
    const was = new Set(before.symbolsByFile[fileId] ?? []);
    const now = new Set(after.symbolsByFile[fileId] ?? []);
    const addedSymbols = [...now].filter((name) => !was.has(name)).sort();
    const removedSymbols = [...was].filter((name) => !now.has(name)).sort();
    if (addedSymbols.length || removedSymbols.length) changedFiles.push({ fileId, addedSymbols, removedSymbols });
  }

  const beforeEdges = new Set(before.edges);
  const afterEdges = new Set(after.edges);
  const addedEdges = after.edges.filter((edge) => !beforeEdges.has(edge));
  const removedEdges = before.edges.filter((edge) => !afterEdges.has(edge));

  const beforeCycles = new Set(before.cycles);
  const afterCycles = new Set(after.cycles);
  const newCycles = after.cycles.filter((cycle) => !beforeCycles.has(cycle));
  const resolvedCycles = before.cycles.filter((cycle) => !afterCycles.has(cycle));

  return {
    repoFullName: after.repoFullName,
    fromSha: before.commitSha,
    toSha: after.commitSha,
    addedFiles,
    removedFiles,
    changedFiles,
    addedEdges,
    removedEdges,
    newCycles,
    resolvedCycles,
    identical:
      addedFiles.length === 0 &&
      removedFiles.length === 0 &&
      changedFiles.length === 0 &&
      addedEdges.length === 0 &&
      removedEdges.length === 0 &&
      newCycles.length === 0 &&
      resolvedCycles.length === 0,
  };
}

/**
 * Render a diff as the prose an agent (or a human) actually wants, bounded.
 *
 * Bounded because this text goes into a prompt: a 900-file rename would otherwise become a
 * 900-line context pillar. Truncation states the count it truncated FROM, so a reader knows they
 * saw a prefix rather than believing they saw everything.
 */
export function describeDiff(diff: RepoDiff, maxPerSection = 10): string {
  if (diff.identical) {
    return `No structural change between ${short(diff.fromSha)} and ${short(diff.toSha)} (same files, symbols, dependencies and cycles).`;
  }
  const lines: string[] = [`Changes from ${short(diff.fromSha)} to ${short(diff.toSha)}:`];
  const section = (label: string, items: string[]) => {
    if (items.length === 0) return;
    const shown = items.slice(0, maxPerSection);
    const suffix = items.length > shown.length ? ` (+${items.length - shown.length} more of ${items.length})` : "";
    lines.push(`- ${label}: ${shown.join(", ")}${suffix}`);
  };

  section("added files", diff.addedFiles);
  section("removed files", diff.removedFiles);
  section(
    "files whose symbols changed",
    diff.changedFiles.map(
      (entry) =>
        `${entry.fileId}` +
        (entry.addedSymbols.length ? ` (+${entry.addedSymbols.join("/")})` : "") +
        (entry.removedSymbols.length ? ` (-${entry.removedSymbols.join("/")})` : ""),
    ),
  );
  section("new dependencies", diff.addedEdges);
  section("removed dependencies", diff.removedEdges);
  // Listed last but flagged hardest: a cycle that did not exist last commit is a regression.
  if (diff.newCycles.length) lines.push(`- NEW dependency cycles: ${diff.newCycles.slice(0, maxPerSection).join(" ; ")}`);
  section("resolved cycles", diff.resolvedCycles);
  return lines.join("\n");
}

function short(sha: string): string {
  return sha ? sha.slice(0, 12) : "(unpinned)";
}

/**
 * The in-memory repo-snapshot store — hermetic default.
 *
 * Bounded to `REPO_MAX_SNAPSHOTS` per repository, most recent kept. Re-putting the same SHA
 * OVERWRITES rather than appending: re-analysing a commit produces the same snapshot, and a
 * duplicate would waste a slot and make `list()` misleading about how many commits are known.
 */
export function createMemoryRepoStore(): RepoMemoryStore {
  // repoFullName -> snapshots, most recent LAST internally (cheap append), reversed on read.
  const byRepo = new Map<string, RepoSnapshot[]>();

  return {
    id: "memory-repo-store",

    async put(snapshot: RepoSnapshot): Promise<void> {
      const existing = byRepo.get(snapshot.repoFullName) ?? [];
      const withoutSame = existing.filter((entry) => entry.commitSha !== snapshot.commitSha);
      withoutSame.push(structuredClone(snapshot));
      byRepo.set(snapshot.repoFullName, withoutSame.slice(-REPO_MAX_SNAPSHOTS));
    },

    async list(repoFullName: string): Promise<RepoSnapshot[]> {
      return [...(byRepo.get(repoFullName) ?? [])].reverse().map((entry) => structuredClone(entry));
    },

    async get(repoFullName: string, commitSha: string): Promise<RepoSnapshot | null> {
      const found = (byRepo.get(repoFullName) ?? []).find((entry) => entry.commitSha === commitSha);
      return found ? structuredClone(found) : null;
    },

    async clear(repoFullName: string): Promise<void> {
      byRepo.delete(repoFullName);
    },
  };
}
