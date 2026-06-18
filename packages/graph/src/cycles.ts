import type { DependencyGraph } from "./types.js";

export function findCircularDependencies(graph: DependencyGraph) {
  const cycles = new Map<string, string[]>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const inStack = new Set<string>();

  function visit(nodeId: string) {
    visited.add(nodeId);
    stack.push(nodeId);
    inStack.add(nodeId);

    for (const edge of graph.outgoing.get(nodeId) ?? []) {
      if (!visited.has(edge.to)) {
        visit(edge.to);
        continue;
      }

      if (inStack.has(edge.to)) {
        const startIndex = stack.indexOf(edge.to);
        const cycleIds = stack.slice(startIndex);
        const normalized = normalizeCycle(cycleIds);
        cycles.set(normalized.join("->"), normalized.map((id) => graph.nodeById.get(id)?.path ?? id));
      }
    }

    stack.pop();
    inStack.delete(nodeId);
  }

  for (const node of graph.nodes) {
    if (!visited.has(node.id)) visit(node.id);
  }

  return [...cycles.values()];
}

function normalizeCycle(ids: string[]) {
  if (!ids.length) return ids;
  const rotations = ids.map((_, index) => [...ids.slice(index), ...ids.slice(0, index)]);
  rotations.sort((a, b) => a.join("\0").localeCompare(b.join("\0")));
  return rotations[0];
}
