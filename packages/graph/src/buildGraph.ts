import type { AnalysisResult, DependencyEdge, FileNode, GraphEdge, GraphEdgeType, GraphNode, ParsedFile } from "@codeflow/shared-types";
import type { BuildGraphInput, DependencyGraph, GraphInput } from "./types.js";
import { createStableNodeId, labelForPath, normalizePath } from "./normalize.js";

export function buildDependencyGraph(input: GraphInput): DependencyGraph {
  const normalized = normalizeInput(input);
  const warnings: string[] = [];
  const nodes = buildNodes(normalized.files, normalized.parsedFiles);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const nodeIdByPath = new Map(nodes.map((node) => [normalizePath(node.path), node.id]));
  const edges = buildEdges(normalized.dependencies, nodeById, nodeIdByPath, warnings);
  return createGraph(nodes, edges, nodeById, nodeIdByPath, warnings);
}

function normalizeInput(input: GraphInput): Required<Pick<BuildGraphInput, "files" | "dependencies" | "parsedFiles">> {
  if (Array.isArray(input)) {
    return {
      files: [],
      dependencies: input.flatMap((file) => file.dependencies),
      parsedFiles: input,
    };
  }

  if (isAnalysisResult(input)) {
    return {
      files: input.files,
      dependencies: input.dependencies,
      parsedFiles: [],
    };
  }

  return {
    files: input.files ?? [],
    dependencies: input.dependencies ?? input.parsedFiles?.flatMap((file) => file.dependencies) ?? [],
    parsedFiles: input.parsedFiles ?? [],
  };
}

function buildNodes(files: FileNode[], parsedFiles: ParsedFile[]): GraphNode[] {
  if (files.length) {
    return files.map((file) => ({
      id: file.id,
      path: normalizePath(file.path),
      label: file.name || labelForPath(file.path),
      language: file.language,
      loc: file.lines,
      layer: file.layer,
    }));
  }

  return parsedFiles.map((file, index) => ({
    id: createStableNodeId(file.path, index),
    path: normalizePath(file.path),
    label: labelForPath(file.path),
    language: file.language,
    loc: file.loc,
  }));
}

function buildEdges(
  dependencies: DependencyEdge[],
  nodeById: Map<string, GraphNode>,
  nodeIdByPath: Map<string, string>,
  warnings: string[],
) {
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];

  dependencies.forEach((dependency, index) => {
    const from = resolveNodeId(dependency.source, dependency.from, nodeById, nodeIdByPath);
    const to = resolveNodeId(dependency.target, dependency.to, nodeById, nodeIdByPath);
    const evidence = dependency.evidence ?? dependency.to ?? dependency.target;

    if (!from) {
      warnings.push(`Unresolved dependency source: ${dependency.source || dependency.from || "unknown"}`);
      return;
    }
    if (!to) {
      warnings.push(`Unresolved dependency target from ${dependency.source || dependency.from}: ${dependency.target || dependency.to}`);
      return;
    }

    const type = toGraphEdgeType(dependency);
    const dedupeKey = `${from}->${to}:${type}:${dependency.sourceLine ?? ""}:${evidence}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    edges.push({
      id: dependency.id || `edge-${index + 1}`,
      from,
      to,
      type,
      confidence: dependency.confidence ?? 0.6,
      evidence,
      sourceLine: dependency.sourceLine,
    });
  });

  return edges;
}

function createGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  nodeById: Map<string, GraphNode>,
  nodeIdByPath: Map<string, string>,
  warnings: string[],
): DependencyGraph {
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();

  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }

  for (const edge of edges) {
    outgoing.get(edge.from)?.push(edge);
    incoming.get(edge.to)?.push(edge);
  }

  return { nodes, edges, nodeById, nodeIdByPath, outgoing, incoming, warnings };
}

function resolveNodeId(
  primary: string | undefined,
  fallback: string | undefined,
  nodeById: Map<string, GraphNode>,
  nodeIdByPath: Map<string, string>,
) {
  for (const candidate of [primary, fallback]) {
    if (!candidate) continue;
    if (nodeById.has(candidate)) return candidate;
    const byPath = nodeIdByPath.get(normalizePath(candidate));
    if (byPath) return byPath;
  }
  return undefined;
}

function toGraphEdgeType(edge: DependencyEdge): GraphEdgeType {
  if (edge.dependencyType) return edge.dependencyType;
  if (edge.kind === "import") return "import";
  if (edge.kind === "call") return "symbol-reference";
  if (edge.kind === "markdown-link") return "heuristic";
  return "unknown";
}

function isAnalysisResult(input: GraphInput): input is AnalysisResult {
  return !Array.isArray(input) && "summary" in input && "files" in input && "dependencies" in input;
}
