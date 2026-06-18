import type { AnalysisMode, RepositoryRef } from "@codeflow/shared-types";

export interface WebAnalysis {
  repository: RepositoryRef;
  mode: AnalysisMode;
  health: {
    grade: string;
    score: number;
    summary: string;
  };
  risk: {
    level: "low" | "medium" | "high";
    summary: string;
  };
  metrics: {
    files: number;
    languages: string[];
    circularDependencies: number;
    securityIssues: number;
    architectureViolations: number;
  };
  entryPoints: string[];
  graph: {
    nodes: number;
    edges: number;
  };
  files: Array<{
    id: string;
    path: string;
    summary: string;
    imports: string[];
    exports: string[];
    functions: string[];
    risk: string;
    owners: string[];
  }>;
  securityFindings: Array<{
    severity: "low" | "medium" | "high";
    title: string;
    file: string;
  }>;
  architectureRules: Array<{
    name: string;
    status: "pass" | "warning";
    description: string;
  }>;
}
