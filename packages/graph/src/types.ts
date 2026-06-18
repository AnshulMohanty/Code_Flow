import type {
  AnalysisResult,
  DependencyEdge,
  FileNode,
  GraphEdge,
  GraphEdgeType,
  GraphNode,
  GraphSummary,
  ParsedFile,
  SerializedDependencyGraph,
} from "@codeflow/shared-types";

export type {
  GraphEdge,
  GraphEdgeType,
  GraphNode,
  GraphSummary,
  SerializedDependencyGraph,
} from "@codeflow/shared-types";

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeById: Map<string, GraphNode>;
  nodeIdByPath: Map<string, string>;
  outgoing: Map<string, GraphEdge[]>;
  incoming: Map<string, GraphEdge[]>;
  warnings: string[];
}

export interface BuildGraphInput {
  files?: FileNode[];
  dependencies?: DependencyEdge[];
  parsedFiles?: ParsedFile[];
}

export type GraphInput = AnalysisResult | ParsedFile[] | BuildGraphInput;

export interface TraversalOptions {
  maxDepth?: number;
  minConfidence?: number;
  includeTypes?: GraphEdgeType[];
}

export interface TraversalResult {
  node: GraphNode;
  via?: GraphEdge;
  depth: number;
}

export interface BlastRadiusResult {
  selectedFile: string;
  directDependents: GraphNode[];
  transitiveDependents: GraphNode[];
  affectedCount: number;
  maxDepth: number;
  riskReasons: string[];
  confidence: number;
}

export interface CentralityScore {
  id: string;
  path: string;
  inDegree: number;
  outDegree: number;
  totalDegree: number;
  dependentCount: number;
  dependencyCount: number;
}

export interface CouplingThresholds {
  incoming?: number;
  outgoing?: number;
  totalDegree?: number;
  blastRadius?: number;
}

export interface HighCouplingFile extends CentralityScore {
  reasons: string[];
}
