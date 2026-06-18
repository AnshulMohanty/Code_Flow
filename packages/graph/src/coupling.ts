import type { CouplingThresholds, DependencyGraph, HighCouplingFile } from "./types.js";
import { getBlastRadius } from "./blastRadius.js";
import { computeCentrality } from "./centrality.js";

const DEFAULT_THRESHOLDS: Required<CouplingThresholds> = {
  incoming: 5,
  outgoing: 8,
  totalDegree: 10,
  blastRadius: 10,
};

export function detectHighCouplingFiles(
  graph: DependencyGraph,
  thresholds: CouplingThresholds = {},
): HighCouplingFile[] {
  const resolved = { ...DEFAULT_THRESHOLDS, ...thresholds };
  return computeCentrality(graph)
    .map((score) => {
      const reasons: string[] = [];
      const blastRadius = getBlastRadius(graph, score.id);
      if (score.inDegree >= resolved.incoming) reasons.push(`incoming dependency count ${score.inDegree}`);
      if (score.outDegree >= resolved.outgoing) reasons.push(`outgoing dependency count ${score.outDegree}`);
      if (score.totalDegree >= resolved.totalDegree) reasons.push(`total degree ${score.totalDegree}`);
      if (blastRadius.affectedCount >= resolved.blastRadius) reasons.push(`blast radius ${blastRadius.affectedCount}`);
      return { ...score, reasons };
    })
    .filter((file) => file.reasons.length > 0);
}

export function detectIsolatedFiles(graph: DependencyGraph) {
  return graph.nodes.filter((node) => {
    const incoming = graph.incoming.get(node.id)?.length ?? 0;
    const outgoing = graph.outgoing.get(node.id)?.length ?? 0;
    return incoming === 0 && outgoing === 0;
  });
}
