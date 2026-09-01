import { describeDiff, diffSnapshots, repoKeyOf, snapshotOf, type RepoMemoryStore } from "@codeflow/memory";
import type { AgentTool, ToolArgs, ToolContext, ToolResult } from "../contracts.js";

/**
 * `what_changed` — cross-SHA diff, from repo memory (V3-P3 task 2).
 *
 * This is the tool that makes repo memory answerable rather than merely stored. Given the current
 * analysis and a previously-snapshotted commit, it reports added/removed files, files whose symbol
 * set changed, added/removed dependencies, and — called out separately because it is the most
 * actionable line a diff can contain — dependency cycles that did not exist before.
 *
 * TWO THINGS IT REFUSES TO DO, both because the alternative is a confidently wrong answer:
 *
 *   1. It never diffs against a commit it has no snapshot for. It says which commits it DOES
 *      know, so the answer is actionable rather than a dead end. Inferring a baseline (say, "the
 *      oldest snapshot") would silently answer a different question than the one asked.
 *   2. It never diffs across repositories. `diffSnapshots` throws on that, and the tool reports
 *      the throw rather than swallowing it.
 *
 * The current commit is snapshotted on the way IN, so asking "what changed?" also makes THIS
 * commit available as a baseline for the next question — which is what makes the memory
 * accumulate rather than needing a separate ingestion step.
 */

export interface WhatChangedToolDeps {
  store: RepoMemoryStore;
  /**
   * The timestamp stamped on a snapshot taken here. Injected, not read from the clock, so the
   * tool stays deterministic in tests — the same reason `snapshotOf` takes it as an argument.
   */
  now?: () => string;
}

export function createWhatChangedTool(deps: WhatChangedToolDeps): AgentTool {
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    id: "what_changed",
    description:
      "what_changed(sinceSha?) — what changed between a previously analysed commit and this one: files added/removed, " +
      "files whose symbols changed, dependencies added/removed, and NEW dependency cycles. " +
      "Omit sinceSha to compare against the most recent other analysed commit.",
    args: ["sinceSha"],
    triggers: ["change", "changed", "changes", "diff", "since", "recently", "new", "added", "removed", "regress"],
    async run(args: ToolArgs, context: ToolContext): Promise<ToolResult> {
      const result = context.result;
      const repoFullName = repoKeyOf(result.repository);
      if (!result.commitSha) {
        return { text: "This analysis is not pinned to a commit, so there is nothing to diff.", empty: true };
      }

      const current = snapshotOf(result, now());
      await deps.store.put(current);

      const known = await deps.store.list(repoFullName);
      const others = known.filter((snapshot) => snapshot.commitSha !== current.commitSha);
      if (others.length === 0) {
        return {
          text:
            `Only one commit of ${repoFullName} has been analysed (${current.commitSha.slice(0, 12)}), ` +
            "so there is nothing to compare it against yet.",
          empty: true,
        };
      }

      const rawSince = args.sinceSha ?? args.since ?? args.sha;
      const requested = typeof rawSince === "string" ? rawSince.trim() : "";

      let baseline = others[0]; // most recent other commit
      if (requested) {
        // Accept a short SHA prefix, because that is what a human types — but only when it
        // matches EXACTLY ONE snapshot. An ambiguous prefix would diff against an arbitrary
        // commit and the answer would look perfectly plausible.
        const matches = others.filter((snapshot) => snapshot.commitSha.startsWith(requested));
        if (matches.length === 0) {
          return {
            text:
              `No snapshot for commit "${requested}". Analysed commits for ${repoFullName}: ` +
              `${others.map((snapshot) => snapshot.commitSha.slice(0, 12)).join(", ")}.`,
            empty: true,
          };
        }
        if (matches.length > 1) {
          return {
            text:
              `"${requested}" matches ${matches.length} analysed commits ` +
              `(${matches.map((snapshot) => snapshot.commitSha.slice(0, 12)).join(", ")}). Use a longer prefix.`,
            empty: true,
          };
        }
        baseline = matches[0];
      }

      let described: string;
      let fileIds: string[];
      try {
        const diff = diffSnapshots(baseline, current);
        described = describeDiff(diff);
        // Only files that EXIST in the current analysis are offered as citable: a removed file is
        // part of the answer's prose but is not a node in this graph, so citing it would be a
        // grounding violation.
        const currentFiles = new Set(current.fileIds);
        fileIds = [
          ...new Set([
            ...diff.addedFiles,
            ...diff.changedFiles.map((entry) => entry.fileId),
          ]),
        ]
          .filter((fileId) => currentFiles.has(fileId))
          .sort();
      } catch (error) {
        return { text: "what_changed could not diff those snapshots.", error: error instanceof Error ? error.message : String(error) };
      }

      return { text: described, fileIds, empty: false };
    },
  };
}
