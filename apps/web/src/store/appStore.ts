import type { AnalysisMode, AnalysisResult, PipelineRunStatus, PipelineStatusReason, ProgressEvent } from "@codeflow/shared-types";
import { create } from "zustand";
import type { ApiJobProgress } from "../lib/apiClient";
import { normalizeAnalysisResult } from "../lib/analysisNormalizer";
import { mockAnalysisResult } from "../lib/mockAnalysis";
import { buildDashboard, type DashboardModel } from "../lib/dashboard";
import { buildGraphModel, type GraphModel } from "../lib/graphModel";
import { applyDoneEvent, applyProgressEvent, initialPipelineState, type PipelineState } from "../lib/pipeline";
import type { WebAnalysis } from "../types/web";

interface AppState {
  analysisMode: AnalysisMode;
  selectedFileId: string | null;
  analysisLoaded: boolean;
  mockAnalysis: WebAnalysis | null;
  dashboard: DashboardModel | null;
  graph: GraphModel | null;
  currentJobId: string | null;
  jobProgress: ApiJobProgress | null;
  pipeline: PipelineState;
  apiError: string | null;
  isAnalyzing: boolean;
  analysisSource: "mock" | "api";
  loadMockAnalysis: (repoInput?: string) => void;
  startAnalysis: (jobId: string) => void;
  setJobProgress: (progress: ApiJobProgress | null) => void;
  applyStageEvent: (event: ProgressEvent) => void;
  setPipelineTerminal: (status: PipelineRunStatus, reason?: PipelineStatusReason) => void;
  setApiError: (message: string | null) => void;
  loadAnalysisResult: (result: AnalysisResult) => void;
  resetAnalysis: () => void;
  selectFile: (fileId: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  analysisMode: "public_hosted",
  selectedFileId: null,
  analysisLoaded: false,
  mockAnalysis: null,
  dashboard: null,
  graph: null,
  currentJobId: null,
  jobProgress: null,
  pipeline: initialPipelineState(),
  apiError: null,
  isAnalyzing: false,
  analysisSource: "mock",
  // Loads a faithful current-shape mock analysis so the dashboard is explorable without a
  // running API/worker (the "Use Mock Data Instead" path).
  loadMockAnalysis: (repoInput) => {
    const result = mockAnalysisResult(repoInput);
    const dashboard = buildDashboard(result);
    set({
      analysisMode: "public_hosted",
      analysisLoaded: true,
      mockAnalysis: normalizeAnalysisResult(result),
      dashboard,
      graph: buildGraphModel(result),
      currentJobId: null,
      jobProgress: null,
      apiError: null,
      isAnalyzing: false,
      analysisSource: "mock",
      selectedFileId: dashboard.fileList[0]?.id ?? null,
    });
  },
  startAnalysis: (jobId) =>
    set({
      currentJobId: jobId,
      jobProgress: null,
      pipeline: initialPipelineState(),
      apiError: null,
      isAnalyzing: true,
      analysisLoaded: false,
      mockAnalysis: null,
      dashboard: null,
      graph: null,
      analysisSource: "api",
      selectedFileId: null,
    }),
  setJobProgress: (progress) => set({ jobProgress: progress }),
  applyStageEvent: (event) => set((state) => ({ pipeline: applyProgressEvent(state.pipeline, event) })),
  setPipelineTerminal: (status, reason) =>
    set((state) => ({ pipeline: applyDoneEvent(state.pipeline, status, reason) })),
  setApiError: (message) => set({ apiError: message, isAnalyzing: false }),
  loadAnalysisResult: (result) => {
    const dashboard = buildDashboard(result);
    set({
      analysisMode: result.mode,
      analysisLoaded: true,
      mockAnalysis: normalizeAnalysisResult(result),
      dashboard,
      graph: buildGraphModel(result),
      apiError: null,
      isAnalyzing: false,
      analysisSource: "api",
      selectedFileId: dashboard.fileList[0]?.id ?? null,
    });
  },
  resetAnalysis: () =>
    set({
      analysisLoaded: false,
      mockAnalysis: null,
      dashboard: null,
      graph: null,
      currentJobId: null,
      jobProgress: null,
      pipeline: initialPipelineState(),
      apiError: null,
      isAnalyzing: false,
      analysisSource: "mock",
      selectedFileId: null,
    }),
  selectFile: (fileId) => set({ selectedFileId: fileId }),
}));
