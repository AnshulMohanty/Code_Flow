import type { DependencyGraph } from "./types.js";
import { normalizePath } from "./normalize.js";

export function findNode(graph: DependencyGraph, fileIdOrPath: string) {
  return graph.nodeById.get(fileIdOrPath) ?? graph.nodeById.get(graph.nodeIdByPath.get(normalizePath(fileIdOrPath)) ?? "");
}

export function getNodeId(graph: DependencyGraph, fileIdOrPath: string) {
  return findNode(graph, fileIdOrPath)?.id;
}

export function uniqueNodes(nodes: Iterable<NonNullable<ReturnType<typeof findNode>>>) {
  const seen = new Set<string>();
  const output: NonNullable<ReturnType<typeof findNode>>[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    output.push(node);
  }
  return output;
}
