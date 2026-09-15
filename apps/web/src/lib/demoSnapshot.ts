import type { AnalysisResult } from "@codeflow/shared-types";

/**
 * THE BUNDLED DEMO SNAPSHOT — real analysis output, shipped with the site, labelled as what it is.
 *
 * WHY THIS IS NOT THE "Use Mock Data Instead" BUTTON COMING BACK. That button was deleted because it
 * put INVENTED module names, paths and metrics into every view, indistinguishable from a real run.
 * This is the opposite in the two ways that decide it:
 *
 *   1. THE DATA IS REAL. It is the output of an actual run of this pipeline against a real
 *      repository at a pinned commit, produced offline and deterministically by `codeflow-local`
 *      (see scripts/build-demo-snapshot.mjs). Nothing in it is authored. If the analyser is wrong
 *      about something, the snapshot is wrong in exactly the same way — which is the point.
 *   2. IT SAYS SO, EVERYWHERE IT IS SHOWN. The repository, the commit, the date, how it was produced
 *      and what it is MISSING all travel with it, and the view renders them.
 *
 * WHY IT EXISTS: the frontend is a static site and the backend sleeps. Without this, the first thing
 * a visitor sees is an empty state and a ~40-second wait. With it they see a real dependency map
 * immediately, and the live backend takes over the moment it wakes.
 *
 * IT IS LOADED LAZILY, and that is not an optimisation detail. The snapshot is ~900 KB of JSON;
 * putting it in the entry bundle would make every visitor download a demo most of them will not
 * open, on a page whose whole argument is that it paints instantly. A dynamic import makes Vite emit
 * it as its own chunk, served from the same static CDN — so it is still there in one round trip, and
 * costs nothing to the people who never ask for it.
 *
 * IT IS OPTIONAL BY CONSTRUCTION. A deployment that has not generated one gets `null` and the UI
 * falls back to the honest empty state it had before. That is deliberate: a snapshot comes from a
 * real run, and a build must never be able to satisfy this requirement by inventing one.
 */

export interface DemoSnapshotProvenance {
  /** `owner/repo` of the analysed repository. */
  repoFullName: string;
  /** The exact commit the analysis read. Every citation in the snapshot resolves against THIS. */
  commitSha: string;
  /** ISO date the snapshot was produced. Shown, because a reader deserves to know how stale it is. */
  generatedAt: string;
  /** The analyzer version that produced it — what decides whether it is still comparable to a live run. */
  analyzerVersion: string;
  /** How it was produced, in words. */
  producedBy: string;
  /** What is MISSING relative to a hosted run. Stated rather than left to be noticed. */
  limitations: string[];
}

export interface DemoSnapshot {
  provenance: DemoSnapshotProvenance;
  result: AnalysisResult;
}

/**
 * Validate a candidate snapshot at the boundary.
 *
 * RUNTIME VALIDATION HERE IS THE RULE, NOT AN EXCEPTION: this is JSON loaded from outside the type
 * system, which is exactly where the amended contract invariant puts runtime checks. A malformed
 * snapshot must produce the honest empty state, never a half-rendered view of `undefined`.
 */
export function parseDemoSnapshot(candidate: unknown): DemoSnapshot | null {
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Partial<DemoSnapshot>;
  const provenance = value.provenance;
  const result = value.result;
  if (!provenance || typeof provenance !== "object") return null;
  if (!result || typeof result !== "object") return null;
  if (typeof provenance.repoFullName !== "string" || !provenance.repoFullName) return null;
  // A snapshot with no pinned SHA cannot have working citation links, and a citation that does not
  // resolve is worse than no citation — it looks verifiable.
  if (typeof provenance.commitSha !== "string" || !provenance.commitSha) return null;
  if (typeof provenance.generatedAt !== "string" || !provenance.generatedAt) return null;
  if (typeof provenance.producedBy !== "string" || !provenance.producedBy) return null;
  if (!Array.isArray(provenance.limitations)) return null;
  // The one structural requirement: a demo that draws no graph demonstrates nothing.
  const graph = (result as AnalysisResult).graph;
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return null;
  return { provenance: provenance as DemoSnapshotProvenance, result: result as AnalysisResult };
}

/** The one-line badge every snapshot-backed view renders. */
export function snapshotLabel(provenance: DemoSnapshotProvenance): string {
  const day = provenance.generatedAt.slice(0, 10);
  const sha = provenance.commitSha.slice(0, 7);
  return `Pre-computed ${day} · ${provenance.repoFullName} @ ${sha} · not a live run`;
}

/**
 * Every snapshot this build happens to contain, as lazy loaders.
 *
 * `import.meta.glob` RATHER THAN A DYNAMIC `import()`, and the difference is not stylistic: Vite
 * resolves import specifiers at TRANSFORM time, so `await import("../demo/snapshot.json")` is a hard
 * build error when the file is absent — a `try/catch` around it never runs, because the failure
 * happens before the code does. A glob that matches nothing is simply an empty object, which is
 * exactly the "this build has no snapshot" case the design requires to be supported.
 *
 * Still lazy: `{ eager: false }` is the default, so each match is a function returning a promise and
 * Vite emits it as its own chunk.
 */
const SNAPSHOT_MODULES = import.meta.glob("../demo/snapshot.json") as Record<
  string,
  () => Promise<{ default?: unknown }>
>;

/** Load the bundled snapshot, or null when this build has none. */
export async function loadDemoSnapshot(): Promise<DemoSnapshot | null> {
  const load = SNAPSHOT_MODULES["../demo/snapshot.json"];
  if (!load) return null;
  try {
    const module = await load();
    return parseDemoSnapshot(module.default ?? module);
  } catch {
    // A malformed or unreadable snapshot degrades to the empty state rather than to a broken view.
    return null;
  }
}
