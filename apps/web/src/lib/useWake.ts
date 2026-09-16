import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./apiClient";

/**
 * WAKE-ON-VISIT — the cold-start fix, and deliberately NOT a scheduled pinger.
 *
 * THE SHAPE OF THE PROBLEM. The frontend is a static site: always on, free, never asleep. The API is
 * a container that a free tier suspends after ~15 minutes idle, and wakes in roughly 30-50 seconds.
 * So the first human to arrive after a quiet period finds a page that paints instantly and a backend
 * that is not there yet.
 *
 * WHY NOT A CRON PING, which is the obvious fix and the wrong one. A request every 10 minutes is
 * ~4,300 requests a month that keep the service running 24/7 — which on Render's free tier burns the
 * ~750 instance-hours the account gets and SUSPENDS the service for the rest of the month. That is
 * strictly worse than sleeping: a sleeping service wakes in 40 seconds, a suspended one does not
 * wake at all. So nothing here runs on a schedule. The wake is triggered by a real visitor, which
 * means a month with no visitors costs no hours.
 *
 * WHAT IT MUST NOT DO, and this is the part that decides the design: it must not gate the UI. The
 * whole point of the static frontend is that the page is useful before the backend answers. So this
 * is fire-and-forget — it returns a STATUS that the chrome reflects, and nothing in the render path
 * awaits it.
 *
 * WHY IT STOPS. Retries exist because the FIRST request during a cold start usually times out — the
 * platform is still starting the container. They stop as soon as /health answers, and they stop
 * after the schedule is exhausted. A poll that ran forever would be the cron pinger this design
 * exists to avoid, just relocated into the browser.
 *
 * WHY /health AND NOT A REAL ENDPOINT: it touches no provider, spends no money, and returns 200
 * while still warming (by design — see apps/api/src/routes/health.ts), which is exactly the signal
 * wanted here. Reaching the process IS the goal; being warm is reported separately.
 */

export type WakeStatus = "waking" | "ready" | "offline";

/**
 * Why a real analysis cannot start yet, or null when it can.
 *
 * Lives beside the wake state rather than in a component because BOTH surfaces gate on it — the
 * marketing hero field and the workbench entry step — and two copies of this sentence would drift
 * the first time either was reworded.
 *
 * The two reasons differ in what they ask of the reader, which is why this returns a string rather
 * than a boolean: "waking" is worth waiting thirty seconds for, and "offline" is not.
 */
export function analyzeBlockedReason(wake: WakeState): string | null {
  if (wake.status === "ready") return null;
  if (wake.status === "waking") {
    return "Warming the analysis engine — this takes about 30 seconds on a cold start. A demo repository below works right now.";
  }
  return "The analysis backend did not answer, so a new repository cannot be analysed. The cached demo repositories below still work.";
}

export interface WakeState {
  status: WakeStatus;
  /** How many requests have been sent. Surfaced so the pill can say "still waking" honestly. */
  attempts: number;
  /** True once /health has answered at least once. The chrome's "is the backend there" fact. */
  reachable: boolean;
}

/**
 * Delays BEFORE each attempt, in ms. Six attempts across ~67 seconds, which covers the 30-50s
 * cold start a free tier takes with margin, and then gives up rather than hammering a service that
 * is genuinely down (or suspended for the month, which no amount of retrying fixes).
 *
 * Exported so the test drives the real schedule instead of a copy of it.
 */
export const WAKE_BACKOFF_MS = [0, 2_000, 5_000, 10_000, 20_000, 30_000] as const;

/** Per-attempt ceiling. A cold container can hold a socket open well past the point the answer is
 *  useful, and an attempt that never settles would stall the schedule behind it. */
export const WAKE_ATTEMPT_TIMEOUT_MS = 8_000;

export interface UseWakeOptions {
  /** Injected in tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Set false to skip entirely (a test that is not about waking). */
  enabled?: boolean;
}

export function useWake(options: UseWakeOptions = {}): WakeState {
  const { baseUrl = API_BASE_URL, enabled = true } = options;
  const [state, setState] = useState<WakeState>({ status: "waking", attempts: 0, reachable: false });
  // Ref, not state: StrictMode double-invokes effects in development, and a second wake schedule
  // would double the requests a cold start receives at exactly the moment it is least able to
  // absorb them.
  const startedRef = useRef(false);

  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;

    let live = true;
    const timers: number[] = [];
    const doFetch = options.fetchImpl ?? globalThis.fetch;

    const attempt = async (index: number): Promise<void> => {
      if (!live) return;
      setState((current) => ({ ...current, attempts: current.attempts + 1 }));

      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeout = controller
        ? window.setTimeout(() => controller.abort(), WAKE_ATTEMPT_TIMEOUT_MS)
        : null;
      try {
        const response = await doFetch(`${baseUrl}/health`, {
          ...(controller ? { signal: controller.signal } : {}),
          // No credentials and no custom headers: a preflight would turn one wake request into two
          // against a service that is, by hypothesis, struggling to answer one.
          cache: "no-store",
        });
        if (!live) return;
        if (response.ok) {
          // ANSWERED. Stop here — every remaining timer is cancelled below. This is what keeps the
          // wake a wake rather than a poll.
          setState((current) => ({ status: "ready", attempts: current.attempts, reachable: true }));
          return;
        }
        // A non-2xx still proves the process is UP and routing, which is what "ready" means for the
        // purpose of enabling the analyze button. It is treated as reachable rather than retried.
        setState((current) => ({ status: "ready", attempts: current.attempts, reachable: true }));
      } catch {
        if (!live) return;
        const next = index + 1;
        if (next >= WAKE_BACKOFF_MS.length) {
          // Exhausted. OFFLINE is an honest terminal state: on a free tier it usually means the
          // monthly instance-hour cap was hit, which retrying cannot fix.
          setState((current) => ({ status: "offline", attempts: current.attempts, reachable: false }));
          return;
        }
        timers.push(window.setTimeout(() => void attempt(next), WAKE_BACKOFF_MS[next]));
      } finally {
        if (timeout !== null) window.clearTimeout(timeout);
      }
    };

    timers.push(window.setTimeout(() => void attempt(0), WAKE_BACKOFF_MS[0]));

    return () => {
      live = false;
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [baseUrl, enabled, options.fetchImpl]);

  return state;
}
