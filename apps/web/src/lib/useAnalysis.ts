import type { AnalysisResult, ProgressEvent } from "@codeflow/shared-types";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  askRepo,
  createAnalysisJob,
  getJob,
  getResult,
  normalizeApiError,
  streamJobEvents,
  type ApiJobProgress,
  type AskResponse,
} from "./apiClient";

/**
 * THE ANALYSIS DRIVER — one hook, used by both surfaces.
 *
 * It owns the whole real lifecycle: enqueue → stream per-stage progress over SSE → fall back to
 * polling if the stream is unavailable → read the terminal result. Both the marketing page's embedded
 * card and the workbench render from the SAME state, because they are two views of one run and
 * duplicating the driver would let them disagree about what is happening.
 *
 * THERE IS NO MOCK PATH. The previous shell had a "Use Mock Data Instead" button that loaded
 * fabricated module names and metrics into every dashboard view — which is a direct violation of the
 * one invariant this product is built on. It is gone, and nothing replaces it: a failed analysis
 * shows the failure.
 *
 * PROGRESS EVENTS ARE MERGED, NOT REPLACED. A late-arriving event for a stage that already reported
 * is ignored rather than overwriting it, so a reconnect that replays the buffer cannot make a
 * finished stage look unfinished.
 */

export type AnalysisPhase = "idle" | "starting" | "running" | "ready" | "failed";

export interface AnalysisState {
  phase: AnalysisPhase;
  jobId: string | null;
  /** Per-stage events seen so far, keyed by stage. Feeds the live pipeline rows. */
  events: Map<string, ProgressEvent>;
  progress: ApiJobProgress | null;
  result: AnalysisResult | null;
  error: string | null;
  /** What the user typed, so the workbench can show it while resolving. */
  target: string | null;
}

export interface AskState {
  question: string | null;
  answer: AskResponse | null;
  busy: boolean;
  error: string | null;
}

/** Narrows the 202 "still pending" body away from a real result. */
function isPending(value: AnalysisResult | { status: "pending"; message: string }): value is { status: "pending"; message: string } {
  return "status" in value && value.status === "pending";
}

const IDLE: AnalysisState = {
  phase: "idle",
  jobId: null,
  events: new Map(),
  progress: null,
  result: null,
  error: null,
  target: null,
};

export function useAnalysis() {
  const [state, setState] = useState<AnalysisState>(IDLE);
  const [ask, setAsk] = useState<AskState>({ question: null, answer: null, busy: false, error: null });

  const sourceRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);
  const activeJobRef = useRef<string | null>(null);
  const settledRef = useRef(false);

  const teardown = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  // Torn down on unmount: an EventSource that outlives its component keeps a connection open and
  // keeps calling setState on something that is gone.
  useEffect(() => teardown, [teardown]);

  const finalize = useCallback(
    async (jobId: string, known?: ApiJobProgress) => {
      if (settledRef.current || activeJobRef.current !== jobId) return;
      try {
        const progress = known ?? (await getJob(jobId));
        if (activeJobRef.current !== jobId) return;
        settledRef.current = true;
        teardown();

        if (progress.status === "failed") {
          setState((current) => ({
            ...current,
            phase: "failed",
            progress,
            error: progress.message ?? "The analysis failed.",
          }));
          return;
        }

        const fetched = await getResult(jobId);
        if (activeJobRef.current !== jobId) return;
        if (isPending(fetched)) {
          // A completed job whose result is still pending is a real inconsistency, not a retry
          // opportunity — surface it rather than spinning.
          setState((current) => ({ ...current, phase: "failed", progress, error: fetched.message }));
          return;
        }
        setState((current) => ({ ...current, phase: "ready", progress, result: fetched, error: null }));
      } catch (error) {
        settledRef.current = true;
        teardown();
        setState((current) => ({ ...current, phase: "failed", error: normalizeApiError(error) }));
      }
    },
    [teardown],
  );

  const startPolling = useCallback(
    (jobId: string) => {
      const tick = async () => {
        try {
          const progress = await getJob(jobId);
          if (activeJobRef.current !== jobId) return;
          setState((current) => ({ ...current, progress }));
          if (progress.status === "completed" || progress.status === "failed") {
            await finalize(jobId, progress);
          }
        } catch (error) {
          teardown();
          setState((current) => ({ ...current, phase: "failed", error: normalizeApiError(error) }));
        }
      };
      void tick();
      pollRef.current = window.setInterval(() => void tick(), 800);
    },
    [finalize, teardown],
  );

  const analyze = useCallback(
    async (input: { owner: string; repo: string }) => {
      teardown();
      settledRef.current = false;
      const target = `${input.owner}/${input.repo}`;
      setState({ ...IDLE, phase: "starting", target, events: new Map() });
      setAsk({ question: null, answer: null, busy: false, error: null });

      try {
        const created = await createAnalysisJob({ mode: "public_hosted", owner: input.owner, repo: input.repo });
        activeJobRef.current = created.jobId;
        setState((current) => ({ ...current, phase: "running", jobId: created.jobId }));

        const source = streamJobEvents(created.jobId, {
          onStageEvent: (event) => {
            if (activeJobRef.current !== created.jobId) return;
            setState((current) => {
              // MERGE, never replace: a replayed event for a stage that already reported must not
              // make a finished stage look unfinished.
              const next = new Map(current.events);
              const existing = next.get(event.stage);
              const terminal = (status: string) => status === "completed" || status === "failed" || status === "skipped";
              if (!existing || !terminal(existing.status) || terminal(event.status)) next.set(event.stage, event);
              return { ...current, events: next };
            });
          },
          onDone: () => void finalize(created.jobId),
          onError: () => {
            if (activeJobRef.current === created.jobId && !settledRef.current) startPolling(created.jobId);
          },
        });
        sourceRef.current = source;
        // No EventSource (jsdom, or a build without it) ⇒ poll. The run still works; only the live
        // per-stage stream is lost, and that is a degradation worth having over a dead screen.
        if (!source) startPolling(created.jobId);
      } catch (error) {
        setState((current) => ({ ...current, phase: "failed", error: normalizeApiError(error) }));
      }
    },
    [finalize, startPolling, teardown],
  );

  const reset = useCallback(() => {
    teardown();
    activeJobRef.current = null;
    settledRef.current = false;
    setState(IDLE);
    setAsk({ question: null, answer: null, busy: false, error: null });
  }, [teardown]);

  const askQuestion = useCallback(
    async (question: string) => {
      const jobId = state.jobId;
      if (!jobId) return;
      setAsk({ question, answer: null, busy: true, error: null });
      try {
        const answer = await askRepo(jobId, question);
        setAsk({ question, answer, busy: false, error: null });
      } catch (error) {
        setAsk({ question, answer: null, busy: false, error: normalizeApiError(error) });
      }
    },
    [state.jobId],
  );

  return { state, ask, analyze, askQuestion, reset };
}
