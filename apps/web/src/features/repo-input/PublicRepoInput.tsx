import type { AnalysisResult } from "@codeflow/shared-types";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/ui/Button";
import {
  API_BASE_URL,
  createAnalysisJob,
  getJob,
  getResult,
  normalizeApiError,
  streamJobEvents,
  type ApiJobProgress,
  type CreateAnalysisJobInput,
} from "../../lib/apiClient";
import { useAppStore } from "../../store/appStore";

export function PublicRepoInput() {
  const [repo, setRepo] = useState("octocat/hello-world");
  const loadMockAnalysis = useAppStore((state) => state.loadMockAnalysis);
  const startAnalysis = useAppStore((state) => state.startAnalysis);
  const setJobProgress = useAppStore((state) => state.setJobProgress);
  const applyStageEvent = useAppStore((state) => state.applyStageEvent);
  const setPipelineTerminal = useAppStore((state) => state.setPipelineTerminal);
  const setApiError = useAppStore((state) => state.setApiError);
  const loadAnalysisResult = useAppStore((state) => state.loadAnalysisResult);
  const isAnalyzing = useAppStore((state) => state.isAnalyzing);
  const apiError = useAppStore((state) => state.apiError);
  const intervalRef = useRef<number | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const activeJobRef = useRef<string | null>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    return () => {
      teardown();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    teardown();
    settledRef.current = false;
    setApiError(null);

    try {
      const created = await createAnalysisJob(toAnalyzeRequest(repo));
      activeJobRef.current = created.jobId;
      startAnalysis(created.jobId);

      // Live channel: stream per-stage ProgressEvents into the pipeline panel. The terminal
      // `done` triggers a final REST read (which carries runStatus + runStatusReason). If
      // EventSource is unavailable (tests/SSR) or the stream errors, fall back to polling.
      const source = streamJobEvents(created.jobId, {
        onStageEvent: (stageEvent) => {
          if (activeJobRef.current === created.jobId) applyStageEvent(stageEvent);
        },
        onDone: () => {
          void finalize(created.jobId);
        },
        onError: () => {
          if (activeJobRef.current === created.jobId && !settledRef.current) startPolling(created.jobId);
        },
      });
      sseRef.current = source;
      if (!source) startPolling(created.jobId);
    } catch (error) {
      setApiError(normalizeApiError(error));
    }
  }

  return (
    <div className="repo-form">
      <form className="repo-form" onSubmit={handleSubmit}>
        <label htmlFor="public-repo">GitHub repository</label>
        <div className="input-row">
          <input
            id="public-repo"
            onChange={(event) => setRepo(event.target.value)}
            placeholder="https://github.com/owner/repo or owner/repo"
            type="text"
            value={repo}
          />
          <Button disabled={isAnalyzing} type="submit" variant="primary">
            {isAnalyzing ? "Analyzing..." : "Analyze Public Repo"}
          </Button>
        </div>
      </form>
      {apiError ? (
        <div className="api-error-inline">
          <p>{apiError.includes(API_BASE_URL) ? apiError : `${apiError} Start apps/api or use mock local mode.`}</p>
          <Button onClick={() => loadMockAnalysis(repo)} type="button" variant="secondary">
            Use Mock Data Instead
          </Button>
        </div>
      ) : null}
    </div>
  );

  function startPolling(jobId: string) {
    void pollJob(jobId).catch((error: unknown) => {
      teardown();
      setApiError(normalizeApiError(error));
    });
    intervalRef.current = window.setInterval(() => {
      void pollJob(jobId).catch((error: unknown) => {
        teardown();
        setApiError(normalizeApiError(error));
      });
    }, 700);
  }

  async function pollJob(jobId: string) {
    const progress = await getJob(jobId);
    if (activeJobRef.current !== jobId) return;
    setJobProgress(progress);
    if (progress.status === "completed" || progress.status === "failed") {
      stopPolling();
      await finalize(jobId, progress);
    }
  }

  /** Resolve the terminal outcome once: record the honest run status/reason, then load the
   *  result (completed/partial) or surface the failure. */
  async function finalize(jobId: string, known?: ApiJobProgress) {
    if (settledRef.current || activeJobRef.current !== jobId) return;
    const progress = known ?? (await getJob(jobId));
    if (activeJobRef.current !== jobId) return;
    settledRef.current = true;
    stopPolling();
    setJobProgress(progress);
    setPipelineTerminal(progress.runStatus ?? (progress.status === "failed" ? "failed" : "completed"), progress.runStatusReason);

    if (progress.status === "failed") {
      setApiError("CodeFlow analysis failed.");
      return;
    }
    const result = await getResult(jobId);
    if (isPendingResult(result)) {
      setApiError(result.message);
      return;
    }
    loadAnalysisResult(result);
  }

  function stopPolling() {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }

  function teardown() {
    stopPolling();
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
  }
}

function toAnalyzeRequest(value: string): CreateAnalysisJobInput {
  const trimmed = value.trim();
  if (trimmed.startsWith("https://github.com/")) {
    return { mode: "public_hosted", repoUrl: trimmed };
  }

  const [owner, repo] = trimmed.replace(/\.git$/, "").split("/");
  if (!owner || !repo) {
    throw new Error("Enter a public GitHub repository as owner/repo or https://github.com/owner/repo.");
  }

  return { mode: "public_hosted", owner, repo };
}

function isPendingResult(result: AnalysisResult | { status: "pending" }): result is { status: "pending" } {
  return "status" in result && result.status === "pending";
}
