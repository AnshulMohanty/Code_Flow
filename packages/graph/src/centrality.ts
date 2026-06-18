import type { CentralityScore, DependencyGraph } from "./types.js";
import { getTransitiveDependencies, getTransitiveDependents } from "./traversal.js";

export function computeCentrality(graph: DependencyGraph): CentralityScore[] {
  return graph.nodes
    .map((node) => {
      const inDegree = graph.incoming.get(node.id)?.length ?? 0;
      const outDegree = graph.outgoing.get(node.id)?.length ?? 0;
      return {
        id: node.id,
        path: node.path,
        inDegree,
        outDegree,
        totalDegree: inDegree + outDegree,
        dependentCount: getTransitiveDependents(graph, node.id).length,
        dependencyCount: getTransitiveDependencies(graph, node.id).length,
      };
    })
    .sort((a, b) => b.totalDegree - a.totalDegree || a.path.localeCompare(b.path));
}
