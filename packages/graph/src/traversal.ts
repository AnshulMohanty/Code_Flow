import type { DependencyGraph, TraversalOptions, TraversalResult } from "./types.js";
import { findNode, getNodeId } from "./selectors.js";

export function getDirectDependencies(graph: DependencyGraph, fileIdOrPath: string) {
  const nodeId = getNodeId(graph, fileIdOrPath);
  if (!nodeId) return [];
  return (graph.outgoing.get(nodeId) ?? []).map((edge) => findNode(graph, edge.to)).filter(isDefined);
}

export function getDirectDependents(graph: DependencyGraph, fileIdOrPath: string) {
  const nodeId = getNodeId(graph, fileIdOrPath);
  if (!nodeId) return [];
  return (graph.incoming.get(nodeId) ?? []).map((edge) => findNode(graph, edge.from)).filter(isDefined);
}

export function getTransitiveDependencies(graph: DependencyGraph, fileIdOrPath: string, options: TraversalOptions = {}) {
  return traverse(graph, fileIdOrPath, "outgoing", options);
}

export function getTransitiveDependents(graph: DependencyGraph, fileIdOrPath: string, options: TraversalOptions = {}) {
  return traverse(graph, fileIdOrPath, "incoming", options);
}

function traverse(
  graph: DependencyGraph,
  fileIdOrPath: string,
  direction: "outgoing" | "incoming",
  options: TraversalOptions,
): TraversalResult[] {
  const startId = getNodeId(graph, fileIdOrPath);
  if (!startId) return [];

  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const seen = new Map<string, TraversalResult>();
  const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: startId, depth: 0 }];

  while (queue.length) {
    const current = queue.shift();
    if (!current || current.depth >= maxDepth) continue;

    const edges = graph[direction].get(current.nodeId) ?? [];
    for (const edge of edges) {
      if (!edgeAllowed(edge, options)) continue;
      const nextId = direction === "outgoing" ? edge.to : edge.from;
      if (nextId === startId) continue;
      const nextNode = findNode(graph, nextId);
      if (!nextNode) continue;

      const depth = current.depth + 1;
      const previous = seen.get(nextId);
      if (!previous || depth < previous.depth) {
        seen.set(nextId, { node: nextNode, via: edge, depth });
        queue.push({ nodeId: nextId, depth });
      }
    }
  }

  return [...seen.values()].sort((a, b) => a.depth - b.depth || a.node.path.localeCompare(b.node.path));
}

function edgeAllowed(edge: { confidence: number; type: string }, options: TraversalOptions) {
  if (options.minConfidence !== undefined && edge.confidence < options.minConfidence) return false;
  if (options.includeTypes?.length && !options.includeTypes.includes(edge.type as never)) return false;
  return true;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
