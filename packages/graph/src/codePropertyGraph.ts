import type { CpgEdge, DependencyEdge, FileNode, RepoDependencyEdge } from "@codeflow/shared-types";
import { buildDependencyGraph } from "./buildGraph.js";
import type { DependencyGraph } from "./types.js";

/**
 * The plain, serializable pieces of Connect's `graph` slice that a live graph is rebuilt
 * from. Mirrors `RepoGraph` without requiring the whole slice, so callers can build the
 * dependency-only graph or the enriched one from the same shape.
 */
export interface CodePropertyGraphInput {
  nodes: FileNode[];
  edges: RepoDependencyEdge[];
  /** V3-P1 call / inheritance edges. Omit (or pass empty) for the dependency-only graph. */
  cpgEdges?: CpgEdge[];
}

/**
 * Build a live graph over the UNION of dependency edges and code-property (call /
 * inheritance) edges. Every existing algorithm — centrality, cycles, blast radius,
 * coupling, traversal, serialization — works on the result unchanged, because they all read
 * `nodes` / `outgoing` / `incoming` and never assume an edge is an import.
 *
 * Two deliberate properties:
 *   • CPG edges carry `weight = count`, so a file that calls 40 symbols in another is more
 *     strongly coupled to it than one that imports a single type. Community detection reads
 *     that weight; the degree metrics do not (see below).
 *   • `edge.type` distinguishes `import`/`require`/… from `call`/`extends`/`implements`, so
 *     a caller can still traverse ONLY dependency edges via `TraversalOptions.includeTypes`.
 *
 * WHY THIS IS A SEPARATE BUILDER: `metrics.perFile.fanIn`/`fanOut` are contractually "files
 * that directly import this one". Analyze keeps using `buildDependencyGraph` over
 * `graph.edges` alone so those numbers keep their documented meaning; anything that WANTS
 * call-weighted structure (community detection) opts in here.
 */
export function buildCodePropertyGraph(input: CodePropertyGraphInput): DependencyGraph {
  const dependencies: DependencyEdge[] = [
    ...input.edges.map(toDependencyEdge),
    ...(input.cpgEdges ?? []).map(toCpgDependencyEdge),
  ];
  return buildDependencyGraph({ files: input.nodes, dependencies });
}

/** Dependency-only live graph (what Analyze rebuilds). Same mapping, no CPG edges. */
export function buildImportGraph(input: CodePropertyGraphInput): DependencyGraph {
  return buildDependencyGraph({ files: input.nodes, dependencies: input.edges.map(toDependencyEdge) });
}

/** RepoDependencyEdge (plain) -> rich DependencyEdge. Edge ids stay deterministic. */
export function toDependencyEdge(edge: RepoDependencyEdge, index: number): DependencyEdge {
  const dependencyType =
    edge.kind === "dynamic" ? "dynamic-import" : edge.kind === "require" ? "require" : "import";
  return {
    id: `${edge.from}->${edge.to}:${dependencyType}:${index + 1}`,
    source: edge.from,
    target: edge.to,
    from: edge.from,
    to: edge.to,
    kind: "import",
    weight: 1,
    dependencyType,
    confidence: 1,
    evidence: edge.specifier,
  };
}

/** CpgEdge (plain) -> rich DependencyEdge carrying the occurrence count as weight. */
export function toCpgDependencyEdge(edge: CpgEdge, index: number): DependencyEdge {
  return {
    id: `${edge.from}->${edge.to}:${edge.kind}:${edge.symbol}:${index + 1}`,
    source: edge.from,
    target: edge.to,
    from: edge.from,
    to: edge.to,
    kind: edge.kind === "call" ? "call" : "unknown",
    weight: edge.count,
    dependencyType: edge.kind,
    confidence: 1,
    evidence: edge.symbol,
    sourceLine: edge.line,
  };
}
