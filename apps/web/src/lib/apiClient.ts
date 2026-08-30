import type {
  AnalysisMode,
  AnalysisResult,
  DegradationNotice,
  JobStatus,
  PipelineRunStatus,
  PipelineStageId,
  PipelineStatusReason,
  ProgressEvent,
  RunMode,
} from "@codeflow/shared-types";

// API base URL resolution, in priority order:
//   1. window.__CODEFLOW_CONFIG__.apiBaseUrl — RUNTIME-injected by the web container's entrypoint
//      (from $API_BASE_URL), so ONE built image works across environments (not baked at build).
//   2. VITE_API_BASE_URL — dev/build-time fallback.
//   3. localhost default.
declare global {
  interface Window {
    __CODEFLOW_CONFIG__?: { apiBaseUrl?: string };
  }
}
const runtimeApiBaseUrl = typeof window !== "undefined" ? window.__CODEFLOW_CONFIG__?.apiBaseUrl : undefined;
export const API_BASE_URL = runtimeApiBaseUrl || import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

export interface CreateAnalysisJobInput {
  mode: AnalysisMode;
  owner?: string;
  repo?: string;
  branch?: string;
  repoUrl?: string;
}

export interface CreateAnalysisJobResponse {
  jobId: string;
  status: string;
  message: string;
  cached?: boolean;
  analysisId?: string;
}

export interface ApiJobProgress {
  id: string;
  jobId?: string;
  status: JobStatus;
  progress: number;
  percent?: number;
  currentStep: string;
  parsedFiles: number;
  totalFiles: number;
  message?: string;
  /** Terminal pipeline outcome (the #19 fix) — REST answers "what happened" on reconnect. */
  runStatus?: PipelineRunStatus;
  runStatusReason?: PipelineStatusReason;
  /** Stages that never ran because they were not configured (unconfigured AI providers).
   *  Without this the panel cannot tell "still working" from "never going to run". */
  skippedStages?: PipelineStageId[];
  /** V3-P0 honest-degradation signals (see RunMode / DegradationNotice). */
  runMode?: RunMode;
  degradations?: DegradationNotice[];
  createdAt: string;
  updatedAt: string;
}

/** The SSE terminal `done` frame payload. */
export interface JobDoneEvent {
  jobId: string;
  status: PipelineRunStatus;
}

export interface PendingResultResponse {
  status: "pending";
  jobId: string;
  message: string;
}

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface JobEventHandlers {
  /** One authoritative ProgressEvent per stage (the real P1 contract shape). */
  onStageEvent?: (event: ProgressEvent) => void;
  /** Terminal frame carrying the run status (reason comes from REST — see getJob). */
  onDone?: (done: JobDoneEvent) => void;
  onError?: (error: Error) => void;
}

export async function createAnalysisJob(input: CreateAnalysisJobInput): Promise<CreateAnalysisJobResponse> {
  return requestJson<CreateAnalysisJobResponse>("/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

export function getJob(jobId: string): Promise<ApiJobProgress> {
  return requestJson<ApiJobProgress>(`/api/job/${encodeURIComponent(jobId)}`);
}

export function getResult(jobId: string): Promise<AnalysisResult | PendingResultResponse> {
  return requestJson<AnalysisResult | PendingResultResponse>(`/api/result/${encodeURIComponent(jobId)}`);
}

export interface AskCitation {
  fileId: string;
  startLine: number;
  endLine: number;
}

/** The Ask-the-repo response (mirrors the API `RagAnswer` + honest no-index/at-capacity flags). */
export interface AskResponse {
  answer: string;
  answered: boolean;
  citations: AskCitation[];
  retrievedChunkIds: string[];
  droppedCitations?: { count: number; ids: string[] };
  /** No searchable index for this analysis (deterministic-only / partial run). */
  unavailable?: boolean;
  /** Daily AI budget reached. */
  atCapacity?: boolean;
}

/** Ask a grounded question about a completed analysis. Throws ApiClientError (status 429) when
 *  rate-limited so the UI can show "slow down". */
export function askRepo(jobId: string, question: string): Promise<AskResponse> {
  return requestJson<AskResponse>(`/api/result/${encodeURIComponent(jobId)}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
}

export function streamJobEvents(jobId: string, handlers: JobEventHandlers): EventSource | null {
  if (typeof EventSource === "undefined") {
    return null;
  }

  const source = new EventSource(`${API_BASE_URL}/api/job/${encodeURIComponent(jobId)}/events`);

  source.addEventListener("progress", (event) => {
    handlers.onStageEvent?.(JSON.parse((event as MessageEvent).data) as ProgressEvent);
  });

  source.addEventListener("done", (event) => {
    handlers.onDone?.(JSON.parse((event as MessageEvent).data) as JobDoneEvent);
    source.close();
  });

  source.onerror = () => {
    handlers.onError?.(new Error(`Could not reach CodeFlow API at ${API_BASE_URL}.`));
    source.close();
  };

  return source;
}

export function normalizeApiError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.message;
  }

  if (error instanceof TypeError) {
    return `Could not reach CodeFlow API at ${API_BASE_URL}. Start apps/api or use mock local mode.`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "CodeFlow API request failed.";
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, init);
  } catch (error) {
    throw new ApiClientError(
      `Could not reach CodeFlow API at ${API_BASE_URL}. Start apps/api or use mock local mode.`,
      { cause: error },
    );
  }

  const data = (await response.json().catch(() => null)) as T | ApiErrorPayload | null;
  if (!response.ok && response.status !== 202) {
    const message = isApiErrorPayload(data)
      ? data.error.message
      : `CodeFlow API request failed with status ${response.status}.`;
    throw new ApiClientError(message, { status: response.status, payload: data });
  }
  return data as T;
}

function isApiErrorPayload(value: unknown): value is ApiErrorPayload {
  return typeof value === "object" && value !== null && "error" in value;
}

export class ApiClientError extends Error {
  readonly status?: number;
  readonly payload?: unknown;

  constructor(message: string, options: { status?: number; payload?: unknown; cause?: unknown } = {}) {
    super(message);
    this.name = "ApiClientError";
    this.status = options.status;
    this.payload = options.payload;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}
