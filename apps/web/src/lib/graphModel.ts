import type { AnalysisResult, FileMetrics, FileNode, RepoDependencyEdge } from "@codeflow/shared-types";

// The full, grounded graph read-model for the 2D viz. Derived from graph.nodes + graph.edges +
// metrics (NO new analysis). Externals are tallied-not-nodes (per Connect) — we never invent
// nodes; unresolved imports are surfaced as an honest count, not faked edges. The model is the
// FULL graph; render caps (graphView) are render-only and never mutate it.

export interface GraphModelNode {
  id: string; // fileId === repo-relative POSIX path
  path: string;
  name: string;
  role: string;
  centrality: number;
  loc: number;
  inCycle: boolean;
  /** Visual size hint (driven by centrality). */
  size: number;
}

export interface GraphModelLink {
  source: string;
  target: string;
  kind: RepoDependencyEdge["kind"];
  /** True when this directed edge sits between two files of a common dependency cycle. */
  inCycle: boolean;
}

export interface GraphModel {
  nodes: GraphModelNode[];
  links: GraphModelLink[];
  /** Full counts (=== nodes/links length) — the viz reports "N of M" against nodeCount. */
  nodeCount: number;
  linkCount: number;
  /** Recorded-not-edges per Connect: surfaced as honest counts, never faked links. */
  unresolvedCount: number;
  externalCount: number;
}

export function buildGraphModel(result: AnalysisResult): GraphModel {
  const fileNodes: FileNode[] = result.graph?.nodes ?? result.files ?? [];
  const edges: RepoDependencyEdge[] = result.graph?.edges ?? [];
  const nodeIds = new Set(fileNodes.map((n) => n.id));

  const roleByPath = new Map<string, string>((result.structure?.files ?? []).map((f) => [f.path, f.role]));
  const locByPath = result.inventory?.loc ?? {};
  const metricsById = new Map<string, FileMetrics>((result.metrics?.perFile ?? []).map((m) => [m.fileId, m]));

  // Cycle membership (from metrics.cycles): a node set per cycle.
  const cycleSets = (result.metrics?.cycles ?? []).map((c) => new Set(c.files));
  const inAnyCycle = (id: string) => cycleSets.some((set) => set.has(id));
  const edgeInCycle = (from: string, to: string) => cycleSets.some((set) => set.has(from) && set.has(to));

  const nodes: GraphModelNode[] = fileNodes.map((node) => {
    const centrality = metricsById.get(node.id)?.centrality ?? 0;
    return {
      id: node.id,
      path: node.path,
      name: node.name,
      role: roleByPath.get(node.path) ?? node.layer ?? "other",
      centrality,
      loc: locByPath[node.path] ?? node.lines ?? 0,
      inCycle: inAnyCycle(node.id),
      size: 2 + Math.sqrt(centrality) * 1.5,
    };
  });

  // Grounding: keep only edges whose BOTH endpoints resolve to a real node (no dangling).
  const links: GraphModelLink[] = edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .map((edge) => ({ source: edge.from, target: edge.to, kind: edge.kind, inCycle: edgeInCycle(edge.from, edge.to) }));

  return {
    nodes,
    links,
    nodeCount: nodes.length,
    linkCount: links.length,
    unresolvedCount: result.graph?.resolution.unresolved ?? 0,
    externalCount: result.graph?.resolution.external ?? 0,
  };
}
