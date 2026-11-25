import type { AnalysisMode } from "@codeflow/shared-types";

export type ApiErrorCode = "INVALID_REQUEST" | "NOT_FOUND" | "INTERNAL_ERROR" | "QUEUE_UNAVAILABLE" | "RATE_LIMITED" | "DAILY_LIMIT";

export interface ErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface AnalyzeRequestBody {
  mode?: AnalysisMode | string;
  owner?: string;
  repo?: string;
  repoUrl?: string;
  branch?: string;
  commitSha?: string;
  /** false = "map only" (no AI stages, nothing spent). Absent = AI when the server has a key. */
  withAi?: boolean;
}
