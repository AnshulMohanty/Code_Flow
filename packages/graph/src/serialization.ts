import type { DependencyGraph } from "./types.js";
import { computeCentrality } from "./centrality.js";
import { detectHighCouplingFiles, detectIsolatedFiles } from "./coupling.js";
import { findCircularDependencies } from "./cycles.js";

export function createGraphSummary(graph: DependencyGraph) {
  const centrality = computeCentrality(graph);
  const totalDegree = centrality.reduce((sum, score) => sum + score.totalDegree, 0);
  const nodeCount = graph.nodes.length;
  return {
    nodeCount,
    edgeCount: graph.edges.length,
    circularDependencyCount: findCircularDependencies(graph).length,
    highCouplingCount: detectHighCouplingFiles(graph).length,
    isolatedFileCount: detectIsolatedFiles(graph).length,
    averageDegree: nodeCount ? totalDegree / nodeCount : 0,
    topCentralFiles: centrality.slice(0, 5).map(({ id, path, totalDegree, inDegree, outDegree }) => ({
      id,
      path,
      totalDegree,
      inDegree,
      outDegree,
    })),
  };
}

export interface SerializeGraphOptions {
  /** Cap on nodes emitted for rendering. Keeps the highest-degree nodes. */
  maxNodes?: number;
  /** Cap on links emitted for rendering (after node filtering). */
  maxLinks?: number;
}

/**
 * Serialize a graph for the UI.
 *
 * IMPORTANT: `summary` is ALWAYS computed from the full graph — centrality, cycles,
 * coupling, and counts reflect untruncated data. The `maxNodes`/`maxLinks` options
 * only limit what is *rendered*; they never feed back into the computed metrics.
 */
export function serializeGraphForUI(graph: DependencyGraph, options: SerializeGraphOptions = {}) {
  const summary = createGraphSummary(graph);

  let nodes = graph.nodes;
  let edges = graph.edges;

  if (options.maxNodes && nodes.length > options.maxNodes) {
    // Keep the most-connected nodes so the rendered subgraph stays meaningful.
    const keep = new Set(computeCentrality(graph).slice(0, options.maxNodes).map((score) => score.id));
    nodes = graph.nodes.filter((node) => keep.has(node.id));
    edges = graph.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to));
  }

  if (options.maxLinks && edges.length > options.maxLinks) {
    edges = edges.slice(0, options.maxLinks);
  }

  return {
    nodes: nodes.map((node) => ({ ...node })),
    links: edges.map((edge) => ({ ...edge })),
    summary,
  };
}
