import type { AnalysisResult } from "@codeflow/shared-types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { createAnalysisJob, getJob, getResult } from "./lib/apiClient";
import { useAppStore } from "./store/appStore";

vi.mock("./lib/apiClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/apiClient")>();
  return {
    ...actual,
    createAnalysisJob: vi.fn(),
    getJob: vi.fn(),
    getResult: vi.fn(),
    normalizeApiError: vi.fn(() =>
      "Could not reach CodeFlow API at http://localhost:4000. Start apps/api or use mock local mode.",
    ),
  };
});

const mockCreateAnalysisJob = vi.mocked(createAnalysisJob);
const mockGetJob = vi.mocked(getJob);
const mockGetResult = vi.mocked(getResult);

describe("CodeFlow web shell", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  beforeEach(() => {
    useAppStore.setState({
      analysisMode: "public_hosted",
      selectedFileId: null,
      analysisLoaded: false,
      mockAnalysis: null,
      currentJobId: null,
      jobProgress: null,
      apiError: null,
      isAnalyzing: false,
      analysisSource: "mock",
    });
  });

  it("renders the app shell", () => {
    render(<App />);

    expect(screen.getByText("Understand any codebase, fast")).toBeInTheDocument();
    expect(screen.getByLabelText(/GitHub repository/i)).toBeInTheDocument();
  });

  it("loads public API mock analysis", async () => {
    mockCreateAnalysisJob.mockResolvedValue({
      jobId: "job-123",
      status: "queued",
      message: "created",
    });
    mockGetJob.mockResolvedValue({
      id: "job-123",
      status: "completed",
      progress: 1,
      currentStep: "Mock analysis completed",
      parsedFiles: 2,
      totalFiles: 2,
      createdAt: "2026-05-05T00:00:00.000Z",
      updatedAt: "2026-05-05T00:00:01.000Z",
    });
    mockGetResult.mockResolvedValue(createApiResult());

    render(<App />);

    fireEvent.change(screen.getByLabelText(/GitHub repository/i), {
      target: { value: "https://github.com/facebook/react" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Analyze Public Repo/i }));

    expect(mockCreateAnalysisJob).toHaveBeenCalledWith({
      mode: "public_hosted",
      repoUrl: "https://github.com/facebook/react",
    });
    // The dashboard opens on Start Here, headed by the repository name.
    expect(await screen.findByRole("heading", { name: "facebook/react" })).toBeInTheDocument();
    expect(screen.getByText("Where do I begin?")).toBeInTheDocument();
  });

  it("renders API error fallback when public API is unavailable", async () => {
    mockCreateAnalysisJob.mockRejectedValue(new TypeError("Failed to fetch"));

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Analyze Public Repo/i }));

    expect(await screen.findByText(/Could not reach CodeFlow API at http:\/\/localhost:4000/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Use Mock Data Instead/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Use Mock Data Instead/i }));

    // The mock dashboard opens on Start Here.
    expect(screen.getByText("Where do I begin?")).toBeInTheDocument();
  });
});

function createApiResult(): AnalysisResult {
  return {
    id: "job-123",
    repository: {
      provider: "github",
      owner: "facebook",
      name: "react",
      url: "https://github.com/facebook/react",
    },
    mode: "public_hosted",
    summary: {
      repository: {
        provider: "github",
        owner: "facebook",
        name: "react",
      },
      mode: "public_hosted",
      files: 2,
      functions: 3,
      connections: 1,
      healthScore: 82,
      healthGrade: "B",
      languages: ["TypeScript", "Markdown"],
      securityIssues: 1,
      architectureViolations: 1,
      circularDependencies: 0,
    },
    files: [
      {
        id: "file-web",
        path: "apps/web/src/App.tsx",
        name: "App.tsx",
        layer: "ui",
        language: "TypeScript",
        lines: 24,
      },
      {
        id: "file-docs",
        path: "README.md",
        name: "README.md",
        layer: "docs",
        language: "Markdown",
        lines: 12,
      },
    ],
    symbols: [
      {
        id: "symbol-app",
        name: "App",
        kind: "function",
        fileId: "file-web",
        line: 1,
        exported: true,
      },
    ],
    dependencies: [
      {
        id: "edge-docs",
        source: "file-web",
        target: "file-docs",
        kind: "unknown",
        weight: 1,
      },
    ],
    issues: [
      {
        id: "issue-security",
        severity: "medium",
        category: "security",
        title: "Mock security finding",
        message: "Mock issue",
        fileId: "file-web",
      },
    ],
    metrics: {
      perFile: [],
      keyFiles: [],
      hotspots: [],
      cycles: [],
      summary: { fileCount: 2, edgeCount: 1, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 },
    },
    warnings: ["Mock API result loaded."],
    createdAt: "2026-05-05T00:00:00.000Z",
  };
}
