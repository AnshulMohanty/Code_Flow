import {
  BEST_OF_N,
  FANOUT_MAX_COMMUNITIES,
  HARD_COMMUNITY_COMPLEXITY,
  MAX_HARD_COMMUNITIES,
} from "@codeflow/config";
import type { AnalysisResult, RepoCluster } from "@codeflow/shared-types";
import type { CommunityRoute } from "./contracts.js";

/**
 * ROUTING BY COMMUNITY COMPLEXITY (V3-P4 task 3).
 *
 * WHY ROUTE AT ALL. Best-of-N costs N times as much. Paying that everywhere would be paying it
 * mostly on communities where one sample was already right — a single-file utility cluster does not
 * get a better architecture summary from three attempts. The value of test-time compute is
 * concentrated where a single attempt is actually likely to be wrong, so the whole design rests on
 * identifying those cheaply and correctly.
 *
 * THE SCORE IS DETERMINISTIC AND FREE — no model, no RNG. Four signals, each normalised to 0..1 and
 * averaged with stated weights:
 *
 *   size          — more files is more to get wrong.
 *   coupling      — external/(internal+external) edge weight. A community that leaks is a community
 *                   whose behaviour is not local, so a summary of it in isolation is likelier wrong.
 *   cycles        — a cycle through the community means there is no clean reading order to find.
 *   symbol density — symbols per file. A cluster of dense files hides more per line.
 *
 * Weights are stated defaults with no calibration against this repo's own eval, and they are flagged
 * for P5 — the honest position is that the SHAPE is defensible (all four are real difficulty signals)
 * while the exact numbers are a guess.
 *
 * TWO CEILINGS, both because an unbounded router is an unbounded bill:
 *   - `MAX_HARD_COMMUNITIES` caps how many communities may route hard, so the N-times cost has a
 *     hard maximum per run regardless of how complex the repository is.
 *   - `FANOUT_MAX_COMMUNITIES` caps how many are analysed at all — and the ones dropped are the
 *     LEAST complex, with the omission REPORTED, because a silent cap reads as "covered everything".
 */

export interface ComplexitySignals {
  size: number;
  coupling: number;
  cycles: number;
  symbolDensity: number;
}

/** Stated weights. Flagged for P5 calibration; the shape is defensible, the numbers are a guess. */
const WEIGHTS: ComplexitySignals = { size: 0.3, coupling: 0.3, cycles: 0.25, symbolDensity: 0.15 };

/** Community size treated as "fully large". Above it the size signal saturates at 1. */
const SIZE_SATURATION = 20;
/** Symbols per file treated as "fully dense". */
const DENSITY_SATURATION = 12;

/**
 * Score one community 0..1. Pure and deterministic.
 *
 * Every signal is CLAMPED to 0..1 before weighting, so no single one can dominate through an
 * outlier — a 500-file community and a 20-file one both score 1 on size, which is intended: past a
 * point "large" is just large, and letting size run away would make the other three signals
 * decorative.
 */
export function complexityOf(cluster: RepoCluster, result: AnalysisResult): { score: number; signals: ComplexitySignals; reason: string } {
  const members = new Set(cluster.files);

  const size = clamp01(cluster.size / SIZE_SATURATION);

  const totalWeight = cluster.internalWeight + cluster.externalWeight;
  // A community with no edges at all is not "perfectly cohesive", it is uninformative — scored 0
  // rather than 1, because dividing by zero and calling the result cohesion would be inventing a
  // signal from an absence of data.
  const coupling = totalWeight === 0 ? 0 : clamp01(cluster.externalWeight / totalWeight);

  const cyclesThrough = (result.metrics?.cycles ?? []).filter((cycle) => cycle.files.some((file) => members.has(file))).length;
  const cycles = clamp01(cyclesThrough / 2);

  const symbolCount = (result.inventory?.symbols ?? []).filter((symbol) => members.has(symbol.filePath)).length;
  const symbolDensity = cluster.size === 0 ? 0 : clamp01(symbolCount / cluster.size / DENSITY_SATURATION);

  const signals: ComplexitySignals = { size, coupling, cycles, symbolDensity };
  const score = clamp01(
    signals.size * WEIGHTS.size +
      signals.coupling * WEIGHTS.coupling +
      signals.cycles * WEIGHTS.cycles +
      signals.symbolDensity * WEIGHTS.symbolDensity,
  );

  // The reason names the DOMINANT contributor, so a routing decision can be argued with rather
  // than merely accepted.
  const contributions: Array<[keyof ComplexitySignals, number]> = [
    ["size", signals.size * WEIGHTS.size],
    ["coupling", signals.coupling * WEIGHTS.coupling],
    ["cycles", signals.cycles * WEIGHTS.cycles],
    ["symbolDensity", signals.symbolDensity * WEIGHTS.symbolDensity],
  ];
  contributions.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const reason =
    `${cluster.size} file(s), coupling ${coupling.toFixed(2)}, ${cyclesThrough} cycle(s), ` +
    `${symbolCount} symbol(s); dominant signal: ${contributions[0][0]}`;

  return { score, signals, reason };
}

export interface RoutingPlan {
  /** Communities to analyse, most complex FIRST — so the interesting work starts immediately. */
  routes: CommunityRoute[];
  /** Communities dropped by `FANOUT_MAX_COMMUNITIES`, sorted. REPORTED, never silent. */
  skippedClusters: number[];
}

/**
 * Decide which communities to analyse and which get best-of-N. Pure and deterministic.
 *
 * Ordering is complexity descending, then cluster id — so the plan is reproducible and the hard
 * work is not left to a tail that a concurrency cap might starve.
 */
export function planRouting(
  clusters: readonly RepoCluster[],
  result: AnalysisResult,
  options: { maxCommunities?: number; maxHard?: number; hardThreshold?: number; samples?: number } = {},
): RoutingPlan {
  const maxCommunities = options.maxCommunities ?? FANOUT_MAX_COMMUNITIES;
  const maxHard = options.maxHard ?? MAX_HARD_COMMUNITIES;
  const hardThreshold = options.hardThreshold ?? HARD_COMMUNITY_COMPLEXITY;
  const samples = options.samples ?? BEST_OF_N;

  const scored = clusters
    .map((cluster) => ({ cluster, ...complexityOf(cluster, result) }))
    .sort((a, b) => b.score - a.score || a.cluster.id - b.cluster.id);

  const selected = scored.slice(0, Math.max(0, maxCommunities));
  const skippedClusters = scored
    .slice(Math.max(0, maxCommunities))
    .map((entry) => entry.cluster.id)
    .sort((a, b) => a - b);

  let hardBudget = maxHard;
  const routes: CommunityRoute[] = selected.map((entry) => {
    // Hard only while the ceiling allows. Because `selected` is complexity-descending, the budget
    // is spent on the hardest communities rather than on whichever came first by id.
    const isHard = entry.score >= hardThreshold && hardBudget > 0;
    if (isHard) hardBudget -= 1;
    return {
      cluster: entry.cluster.id,
      complexity: entry.score,
      difficulty: isHard ? "hard" : "easy",
      samples: isHard ? Math.max(1, samples) : 1,
      reason:
        entry.score >= hardThreshold && !isHard
          ? `${entry.reason} — above the hard threshold but the best-of-N ceiling (${maxHard}) was already spent`
          : entry.reason,
    };
  });

  return { routes, skippedClusters };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
