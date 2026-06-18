import type { BlastRadiusResult, DependencyGraph, TraversalOptions } from "./types.js";
import { findCircularDependencies } from "./cycles.js";
import { findNode } from "./selectors.js";
import { getDirectDependents, getTransitiveDependents } from "./traversal.js";

export function getBlastRadius(graph: DependencyGraph, fileIdOrPath: string, options: TraversalOptions = {}): BlastRadiusResult {
  const selected = findNode(graph, fileIdOrPath);
  if (!selected) {
    return {
      selectedFile: fileIdOrPath,
      directDependents: [],
      transitiveDependents: [],
      affectedCount: 0,
      maxDepth: 0,
      riskReasons: ["Selected file was not found in the dependency graph."],
      confidence: 0,
    };
  }

  const directDependents = getDirectDependents(graph, selected.id);
  const transitive = getTransitiveDependents(graph, selected.id, options);
  const transitiveDependents = transitive.map((result) => result.node);
  const incoming = graph.incoming.get(selected.id) ?? [];
  const confidenceValues = transitive.map((result) => result.via?.confidence ?? 0).concat(incoming.map((edge) => edge.confidence));
  const confidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : 1;
  const maxDepth = transitive.reduce((max, result) => Math.max(max, result.depth), 0);
  const riskReasons = buildRiskReasons(graph, selected.id, transitive.length, incoming.length, confidence);

  return {
    selectedFile: selected.path,
    directDependents,
    transitiveDependents,
    affectedCount: transitiveDependents.length,
    maxDepth,
    riskReasons,
    confidence,
  };
}

function buildRiskReasons(
  graph: DependencyGraph,
  selectedId: string,
  transitiveCount: number,
  incomingCount: number,
  confidence: number,
) {
  const reasons: string[] = [];
  const selectedPath = graph.nodeById.get(selectedId)?.path ?? selectedId;
  if (transitiveCount > 10) reasons.push("File has more than 10 transitive dependents.");
  if (incomingCount > 5) reasons.push("File has high incoming dependency count.");
  if (confidence < 0.7) reasons.push("File has low-confidence dependency edges.");
  if (findCircularDependencies(graph).some((cycle) => cycle.includes(selectedPath))) {
    reasons.push("File is part of a circular dependency.");
  }
  return reasons;
}
