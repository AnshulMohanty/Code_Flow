import type { RepoClusters } from "@codeflow/shared-types";
import type { DependencyGraph } from "./types.js";

/**
 * Community detection (Louvain) over the code property graph. Resolves the long-standing
 * "clusters/modules metric — no clustering algorithm yet" gap.
 *
 * DETERMINISM IS LOAD-BEARING (the SHA-keyed cache and the eval set both depend on it), so
 * this implementation has NO randomness at all:
 *   • The node visit order is a SEEDED permutation of the node ids in sorted order — the
 *     same seed always produces the same order, and the default seed is fixed. (Classic
 *     Louvain shuffles with a real RNG; that would make the partition differ run to run.)
 *   • Ties on modularity gain are broken by the lowest community index, never by iteration
 *     order of a hash map.
 *   • The final communities are RELABELLED canonically — sorted by size descending, then by
 *     their lowest member fileId — so the ids do not depend on any internal ordering.
 * Result: run twice on the same graph, get a byte-identical partition.
 *
 * The graph is projected to UNDIRECTED WEIGHTED for clustering, which is the model
 * modularity is defined on: "A depends on B" and "B depends on A" are the same coupling,
 * and a call edge with `count: 40` should outweigh a single type import.
 */
export interface CommunityOptions {
  /** Seeds the deterministic node-visit permutation. Same seed ⇒ same partition. */
  seed?: number;
  /** Modularity resolution. Higher ⇒ more, smaller communities. Default 1. */
  resolution?: number;
  /** Safety bound on local-moving sweeps per level (a bad graph must not spin forever). */
  maxPassesPerLevel?: number;
}

export const DEFAULT_COMMUNITY_SEED = 1;
export const DEFAULT_COMMUNITY_RESOLUTION = 1;
const DEFAULT_MAX_PASSES = 50;
/** Guards float comparisons; a gain below this is not an improvement. */
const EPSILON = 1e-12;

/** An undirected weighted graph over opaque unit ids (one Louvain level). */
interface WeightedGraph {
  units: string[];
  /** unit -> neighbour -> weight. Symmetric; never contains a self entry. */
  adjacency: Map<string, Map<string, number>>;
  /** unit -> self-loop weight w (contributes 2w to the unit's degree). */
  selfWeight: Map<string, number>;
  /** unit -> weighted degree (sum of incident weights + 2 * self-loop weight). */
  degree: Map<string, number>;
  /** Sum of every unit's degree — i.e. 2m. Zero for an edgeless graph. */
  twoM: number;
}

/**
 * Partition `graph` into communities and report weighted modularity.
 *
 * Isolated nodes each become their own single-file community: dropping them would make the
 * assignment list incomplete, and lumping them together would assert a relationship that
 * the code does not have.
 */
export function detectCommunities(graph: DependencyGraph, options: CommunityOptions = {}): RepoClusters {
  const seed = options.seed ?? DEFAULT_COMMUNITY_SEED;
  const resolution = options.resolution ?? DEFAULT_COMMUNITY_RESOLUTION;
  const maxPasses = options.maxPassesPerLevel ?? DEFAULT_MAX_PASSES;

  const base = projectUndirected(graph);
  // unit id at the current level -> the original node ids it contains.
  let membership = new Map<string, string[]>(base.units.map((unit) => [unit, [unit]]));
  let level = base;
  let levelIndex = 0;

  while (level.twoM > 0) {
    const communityOf = localMoving(level, { seed, resolution, maxPasses });
    const groups = groupByCommunity(level.units, communityOf);
    if (groups.length === level.units.length) break; // nothing merged — converged

    levelIndex += 1;
    const nextMembership = new Map<string, string[]>();
    const unitIdOf = new Map<string, string>();
    groups.forEach((group, index) => {
      const unitId = `L${levelIndex}#${index}`;
      const originals: string[] = [];
      for (const member of group) {
        unitIdOf.set(member, unitId);
        originals.push(...(membership.get(member) ?? [member]));
      }
      nextMembership.set(unitId, originals);
    });

    level = aggregate(level, unitIdOf);
    membership = nextMembership;
  }

  return finalize(base, membership, seed, resolution);
}

// ── Undirected weighted projection ───────────────────────────────────────────────────

function projectUndirected(graph: DependencyGraph): WeightedGraph {
  // Sorted ids: the canonical base order every deterministic step builds on.
  const units = graph.nodes.map((node) => node.id).sort();
  const adjacency = new Map<string, Map<string, number>>(units.map((unit) => [unit, new Map()]));
  const selfWeight = new Map<string, number>(units.map((unit) => [unit, 0]));

  for (const edge of graph.edges) {
    const weight = edge.weight ?? 1;
    if (!(weight > 0)) continue;
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue; // dangling: never invented
    if (edge.from === edge.to) {
      selfWeight.set(edge.from, (selfWeight.get(edge.from) ?? 0) + weight);
      continue;
    }
    addWeight(adjacency, edge.from, edge.to, weight);
    addWeight(adjacency, edge.to, edge.from, weight);
  }

  return withDegrees({ units, adjacency, selfWeight, degree: new Map(), twoM: 0 });
}

function addWeight(adjacency: Map<string, Map<string, number>>, from: string, to: string, weight: number): void {
  const row = adjacency.get(from);
  if (!row) return;
  row.set(to, (row.get(to) ?? 0) + weight);
}

function withDegrees(graph: WeightedGraph): WeightedGraph {
  const degree = new Map<string, number>();
  let twoM = 0;
  for (const unit of graph.units) {
    let sum = 2 * (graph.selfWeight.get(unit) ?? 0);
    for (const weight of graph.adjacency.get(unit)?.values() ?? []) sum += weight;
    degree.set(unit, sum);
    twoM += sum;
  }
  return { ...graph, degree, twoM };
}

// ── Phase 1: local moving ────────────────────────────────────────────────────────────

/**
 * Move each unit to the neighbouring community with the best modularity gain, sweeping
 * until nothing moves. Returns unit -> community index.
 */
function localMoving(
  graph: WeightedGraph,
  options: { seed: number; resolution: number; maxPasses: number },
): Map<string, number> {
  const communityOf = new Map<string, number>();
  const communityDegree: number[] = [];
  graph.units.forEach((unit, index) => {
    communityOf.set(unit, index);
    communityDegree[index] = graph.degree.get(unit) ?? 0;
  });

  const order = seededOrder(graph.units, options.seed);

  for (let pass = 0; pass < options.maxPasses; pass += 1) {
    let moved = false;

    for (const unit of order) {
      const unitDegree = graph.degree.get(unit) ?? 0;
      const current = communityOf.get(unit);
      if (current === undefined) continue;

      // Take the unit out of its community before evaluating any insertion.
      communityDegree[current] -= unitDegree;

      // Weight from this unit into each candidate community.
      const weightToCommunity = new Map<number, number>();
      weightToCommunity.set(current, 0); // staying put is always a candidate
      for (const [neighbour, weight] of graph.adjacency.get(unit) ?? []) {
        const neighbourCommunity = communityOf.get(neighbour);
        if (neighbourCommunity === undefined) continue;
        weightToCommunity.set(neighbourCommunity, (weightToCommunity.get(neighbourCommunity) ?? 0) + weight);
      }

      // Gain (up to a constant factor shared by all candidates):
      //   k_i_in - resolution * totalDegree(C) * k_i / 2m
      let bestCommunity = current;
      let bestGain = gainOf(weightToCommunity.get(current) ?? 0, communityDegree[current], unitDegree, options.resolution, graph.twoM);
      // Ascending community index ⇒ ties resolve to the lowest index, deterministically.
      for (const candidate of [...weightToCommunity.keys()].sort((a, b) => a - b)) {
        if (candidate === current) continue;
        const gain = gainOf(weightToCommunity.get(candidate) ?? 0, communityDegree[candidate], unitDegree, options.resolution, graph.twoM);
        if (gain > bestGain + EPSILON) {
          bestGain = gain;
          bestCommunity = candidate;
        }
      }

      communityDegree[bestCommunity] += unitDegree;
      if (bestCommunity !== current) {
        communityOf.set(unit, bestCommunity);
        moved = true;
      }
    }

    if (!moved) break;
  }

  return communityOf;
}

function gainOf(
  weightIntoCommunity: number,
  communityDegree: number,
  unitDegree: number,
  resolution: number,
  twoM: number,
): number {
  if (twoM === 0) return 0;
  return weightIntoCommunity - (resolution * communityDegree * unitDegree) / twoM;
}

/**
 * Group units by community and RELABEL canonically: size descending, then lowest member id.
 * This is what makes community ids independent of visit order and hash iteration.
 */
function groupByCommunity(units: string[], communityOf: Map<string, number>): string[][] {
  const groups = new Map<number, string[]>();
  // `units` is in sorted order, so each group's member list is sorted too.
  for (const unit of units) {
    const community = communityOf.get(unit);
    if (community === undefined) continue;
    const group = groups.get(community);
    if (group) group.push(unit);
    else groups.set(community, [unit]);
  }
  return [...groups.values()].sort(
    (a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""),
  );
}

// ── Phase 2: aggregation ─────────────────────────────────────────────────────────────

/** Collapse each community into one unit, summing edge weights and folding internal edges
 *  into self-loops. Total degree is preserved exactly, which modularity depends on. */
function aggregate(graph: WeightedGraph, unitIdOf: Map<string, string>): WeightedGraph {
  const units = [...new Set(graph.units.map((unit) => unitIdOf.get(unit) ?? unit))].sort();
  const adjacency = new Map<string, Map<string, number>>(units.map((unit) => [unit, new Map()]));
  const selfWeight = new Map<string, number>(units.map((unit) => [unit, 0]));

  // Existing self-loops carry over unchanged.
  for (const unit of graph.units) {
    const target = unitIdOf.get(unit) ?? unit;
    const existing = graph.selfWeight.get(unit) ?? 0;
    if (existing) selfWeight.set(target, (selfWeight.get(target) ?? 0) + existing);
  }

  // Internal pairs are visited twice (once per direction), so halve them at the end.
  const internalDouble = new Map<string, number>();
  for (const unit of graph.units) {
    const source = unitIdOf.get(unit) ?? unit;
    for (const [neighbour, weight] of graph.adjacency.get(unit) ?? []) {
      const target = unitIdOf.get(neighbour) ?? neighbour;
      if (source === target) internalDouble.set(source, (internalDouble.get(source) ?? 0) + weight);
      else addWeight(adjacency, source, target, weight);
    }
  }
  for (const [unit, doubled] of internalDouble) {
    selfWeight.set(unit, (selfWeight.get(unit) ?? 0) + doubled / 2);
  }

  return withDegrees({ units, adjacency, selfWeight, degree: new Map(), twoM: 0 });
}

// ── Reporting ────────────────────────────────────────────────────────────────────────

/** Build the reported partition, with modularity measured on the ORIGINAL graph. */
function finalize(
  base: WeightedGraph,
  membership: Map<string, string[]>,
  seed: number,
  resolution: number,
): RepoClusters {
  // Canonical order: size desc, then lowest member fileId.
  const groups = [...membership.values()]
    .map((files) => [...files].sort())
    .filter((files) => files.length > 0)
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));

  const communityIndexOf = new Map<string, number>();
  groups.forEach((files, index) => {
    for (const file of files) communityIndexOf.set(file, index);
  });

  const clusters = groups.map((files, index) => {
    let internalWeight = 0;
    let externalWeight = 0;
    const members = new Set(files);
    for (const file of files) {
      internalWeight += base.selfWeight.get(file) ?? 0;
      for (const [neighbour, weight] of base.adjacency.get(file) ?? []) {
        if (members.has(neighbour)) internalWeight += weight / 2; // each internal pair seen twice
        else externalWeight += weight;
      }
    }
    return {
      id: index,
      files,
      size: files.length,
      // Rounded to shed float dust so the stored slice is byte-stable across runs.
      internalWeight: round(internalWeight),
      externalWeight: round(externalWeight),
    };
  });

  const assignments = [...communityIndexOf.entries()]
    .map(([fileId, cluster]) => ({ fileId, cluster }))
    .sort((a, b) => a.fileId.localeCompare(b.fileId));

  return {
    algorithm: "louvain",
    seed,
    resolution,
    modularity: round(modularityOf(base, communityIndexOf)),
    count: clusters.length,
    assignments,
    clusters,
  };
}

/**
 * STANDARD weighted modularity (Newman–Girvan):
 *   Q = Σ_c [ in_c / 2m − (tot_c / 2m)^2 ]
 * where `in_c` counts each internal pair twice (plus twice each self-loop) and `tot_c` is
 * the summed weighted degree of the community's members. Zero for an edgeless graph.
 *
 * Reported WITHOUT the resolution factor on purpose: `resolution` steers how finely the
 * search partitions, but the reported number has to stay the standard, comparable Q (range
 * roughly [-0.5, 1); > ~0.3 is meaningful structure). A resolution-scaled score would not
 * be comparable across runs with different settings, which is the main thing you want to
 * compare.
 */
export function modularityOf(graph: WeightedGraph, communityIndexOf: Map<string, number>): number {
  if (graph.twoM === 0) return 0;
  const internal = new Map<number, number>();
  const total = new Map<number, number>();

  for (const unit of graph.units) {
    const community = communityIndexOf.get(unit);
    if (community === undefined) continue;
    total.set(community, (total.get(community) ?? 0) + (graph.degree.get(unit) ?? 0));
    internal.set(community, (internal.get(community) ?? 0) + 2 * (graph.selfWeight.get(unit) ?? 0));
    for (const [neighbour, weight] of graph.adjacency.get(unit) ?? []) {
      if (communityIndexOf.get(neighbour) === community) {
        internal.set(community, (internal.get(community) ?? 0) + weight);
      }
    }
  }

  let modularity = 0;
  for (const [community, totalDegree] of total) {
    const inside = internal.get(community) ?? 0;
    const fraction = totalDegree / graph.twoM;
    modularity += inside / graph.twoM - fraction * fraction;
  }
  return modularity;
}

/** 10 decimal places: enough precision to compare partitions, few enough that float dust
 *  cannot make two identical runs differ in the stored JSON. */
function round(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}

/**
 * A deterministic permutation of `ids`. Louvain's quality depends on visiting nodes in a
 * varied order, but a real RNG would break run-to-run reproducibility — so this is a
 * seeded xorshift32 Fisher–Yates over the SORTED ids. Same seed ⇒ same order, always.
 */
export function seededOrder(ids: string[], seed: number): string[] {
  const order = [...ids].sort();
  let state = (seed | 0) || 1;
  const next = () => {
    state ^= state << 13;
    state |= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return state >>> 0;
  };
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = next() % (i + 1);
    const swap = order[i];
    order[i] = order[j];
    order[j] = swap;
  }
  return order;
}
