import type { AnalysisResult, DomainLane } from "@codeflow/shared-types";
import type { RepoKnowledgeBase } from "./consolidate.js";
import type { SpecialistId } from "./contracts.js";

/**
 * DOMAIN LANES (V3-FINAL) — the fan-out's per-community findings, projected into something a UI can
 * render and a document can hold.
 *
 * THE GAP THIS CLOSES. V3-P4 paid for 5N specialist calls; the supervisor read a bounded twelve
 * findings and V3-P5 consolidated the rest into a knowledge base — INSIDE the run, because that is
 * the only moment they are all in hand. Then the run ended and the KB went with it. Five lenses'
 * worth of analysis was bought and thrown away, and no surface could show a user what the
 * specialists found, because nothing durable carried it.
 *
 * WHY A PROJECTION AND NOT THE WHOLE KB. Ledger #20 tracks the analysis document's growth, and the
 * KB holds merged detail (up to 400 chars per point, 5 points per community, 12 communities) plus a
 * generated FAQ. That is the part that would grow. A lane keeps the identity, the modules, the
 * counts and the HEADLINES — the shape a reader needs to decide where to look — and drops the prose
 * they would have to read anyway. `reduction.jsonBytes` on the KB says what was dropped.
 *
 * INFERENCE, LABELLED. Every field here except `moduleIds` and `entryProbable` came from a model.
 * `moduleIds` are re-grounded against `graph.nodes` on the way in: a lane citing a file the graph
 * does not contain would be the same failure the three grounding passes exist to prevent, one layer
 * later, and a durable artefact is exactly where that must not happen.
 *
 * THE TITLE IS DERIVED, NOT WRITTEN. It is built from the community's own module paths — a shared
 * directory when there is one, otherwise the most central module's name. A model-written title would
 * be a second thing to ground and would read as a fact ("Authentication & identity") while being a
 * guess. The design's own lane titles come from the prototype's hardwired sample data; a real repo
 * gets a title made of its real paths.
 */

/** Modules listed per lane. Bounded because this rides the analysis document. */
export const LANE_MAX_MODULES = 12;
/** Headlines kept per lane. */
export const LANE_MAX_HEADLINES = 3;

/** The agent tag shown beside a lane. One per specialist, so a reader knows WHICH lens spoke. */
export const SPECIALIST_TAGS: Record<SpecialistId, string> = {
  architecture: "arch-shape",
  "data-flow": "data-path",
  security: "auth-surface",
  "api-surface": "contract-map",
  "dependency-risk": "dep-risk",
};

export interface DomainLaneInput {
  knowledgeBase: RepoKnowledgeBase;
  result: AnalysisResult;
  /** True when this module is entry-probable. Injected, because that is a GRAPH derivation and this
   *  file is about projecting agent output — mixing the two would make the lane's provenance murky. */
  isEntryProbable(fileId: string): boolean;
}

export function buildDomainLanes(input: DomainLaneInput): DomainLane[] {
  const nodeIds = new Set((input.result.graph?.nodes ?? input.result.files).map((node) => node.id));

  return input.knowledgeBase.communities
    .map((digest): DomainLane | null => {
      // RE-GROUNDED. The KB grounded these when it was built, but this is a durable artefact and a
      // stale module id in it would outlive the run that produced it.
      const moduleIds = [...new Set(digest.points.flatMap((point) => point.fileIds).concat(digest.keyFiles))]
        .filter((fileId) => nodeIds.has(fileId))
        .sort()
        .slice(0, LANE_MAX_MODULES);

      // A lane with no grounded module is not a lane. Dropping it is honest; rendering an empty one
      // would claim a domain was detected when nothing about it survived grounding.
      if (moduleIds.length === 0) return null;

      const headlines = digest.points
        .slice(0, LANE_MAX_HEADLINES)
        .map((point) => point.headline)
        .filter((headline) => headline.trim().length > 0);

      return {
        cluster: digest.cluster,
        title: deriveTitle(moduleIds),
        agentTag: dominantTag(digest.points, digest.specialists),
        specialists: [...digest.specialists].sort(),
        moduleIds,
        entryProbable: moduleIds.filter((fileId) => input.isEntryProbable(fileId)).length,
        headlines,
        corroborated: digest.points.filter((point) => point.corroboratedBy.length > 1).length,
      };
    })
    .filter((lane): lane is DomainLane => lane !== null)
    .sort((a, b) => b.moduleIds.length - a.moduleIds.length || a.cluster - b.cluster);
}

/**
 * A title made of the community's real paths.
 *
 * The deepest directory EVERY module shares, when there is one — that is the name the codebase
 * already gave this group, and it beats anything a model would invent. When they share nothing, the
 * first module's own directory-and-name, so the title still points at something real.
 */
function deriveTitle(moduleIds: readonly string[]): string {
  const common = commonDirectory(moduleIds);
  if (common) return common;
  const first = moduleIds[0];
  const parts = first.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : first;
}

function commonDirectory(moduleIds: readonly string[]): string | null {
  if (moduleIds.length === 0) return null;
  const split = moduleIds.map((fileId) => fileId.split("/").slice(0, -1));
  let depth = 0;
  outer: for (;;) {
    const segment = split[0][depth];
    if (segment === undefined) break;
    for (const parts of split) if (parts[depth] !== segment) break outer;
    depth += 1;
  }
  return depth === 0 ? null : split[0].slice(0, depth).join("/");
}

/**
 * The lens that contributed most to this community.
 *
 * By finding count, then by importance, then alphabetically — a fully deterministic tie-break, so
 * two runs over the same blackboard name the same lens. Falls back to the first reporting specialist
 * when no point carries attribution, and to `"unattributed"` when nothing does, because a tag that
 * silently defaulted to `architecture` would attribute a security finding to the wrong lens.
 */
function dominantTag(
  points: ReadonlyArray<{ corroboratedBy: readonly string[]; importance: string }>,
  specialists: readonly SpecialistId[],
): string {
  const tally = new Map<string, number>();
  for (const point of points) {
    for (const specialist of point.corroboratedBy) {
      tally.set(specialist, (tally.get(specialist) ?? 0) + 1);
    }
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const winner = (ranked[0]?.[0] ?? specialists[0]) as SpecialistId | undefined;
  if (!winner) return "unattributed";
  return SPECIALIST_TAGS[winner] ?? winner;
}
