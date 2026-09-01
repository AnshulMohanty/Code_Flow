import { useEffect, useState } from "react";
import { API_BASE_URL } from "./apiClient";
import type { MetaFacts } from "./siteModel";

/**
 * `/api/meta` — the server's own facts, fetched once.
 *
 * THREE STATES, and they must stay distinguishable in the chrome:
 *   loading   the pill is grey and says CONNECTING. Not green: green means the API answered.
 *   ready     real version, real build, real measured p50.
 *   error     grey pill saying OFFLINE, and every meta-sourced figure renders as an em-dash.
 *
 * That third state matters more than it looks. Without it the nav would show a green READY pill for
 * a build talking to nothing, which is the most misleading thing a status indicator can do.
 *
 * NOT retried on a timer. A failed meta fetch costs the chrome its version string and nothing else —
 * the analysis views work entirely from the result — and a background poll against a dead API is
 * noise in a console for no benefit. The user's next navigation refetches.
 */

export type MetaState =
  | { status: "loading"; facts: null; error: null }
  | { status: "ready"; facts: MetaFacts; error: null }
  | { status: "error"; facts: null; error: string };

export function useMeta(): MetaState {
  const [state, setState] = useState<MetaState>({ status: "loading", facts: null, error: null });

  useEffect(() => {
    let live = true;
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/meta`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const facts = (await response.json()) as MetaFacts;
        if (live) setState({ status: "ready", facts, error: null });
      } catch (error) {
        if (!live || controller.signal.aborted) return;
        setState({
          status: "error",
          facts: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      live = false;
      controller.abort();
    };
  }, []);

  return state;
}

/** UTC `HH:MM:SSZ` — the form the design's status pill uses. */
export function utcClock(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}

/**
 * A ticking UTC clock for the status pill.
 *
 * Seeded from the SERVER's time when it is known, then advanced locally — so the pill shows the
 * server's clock rather than the viewer's, which is the useful one for a status readout, without a
 * request per second to keep it honest. Drift is bounded by the page's lifetime and is stated here
 * rather than pretended away.
 */
export function useUtcClock(serverTime: string | null): string {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!serverTime) return;
    const parsed = new Date(serverTime);
    if (!Number.isNaN(parsed.getTime())) setNow(parsed);
  }, [serverTime]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow((current) => new Date(current.getTime() + 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return utcClock(now);
}
