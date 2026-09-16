import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SiteNav } from "./SiteNav";
import type { MetaState } from "../lib/useMeta";
import type { WakeState } from "../lib/useWake";

/**
 * THE PILL, state by state, with the wake result INJECTED.
 *
 * Driven directly rather than through `<App />` because the OFFLINE state is only reachable after the
 * wake's full 67-second backoff — a test that waited for it would spend a minute of wall clock to
 * assert one word. `useWake.test.ts` proves the hook reaches `offline`; this proves what the pill
 * does with it. Between them the path is covered and neither test is slow.
 *
 * The invariant is the one it has always been: the pill may not claim a connection it does not have,
 * and may not report a version it was not given.
 */

const META_READY = {
  status: "ready",
  error: null,
  facts: {
    analyzerVersion: "1.1.0",
    build: "abc1234",
    answerLatency: { p50Ms: 400, p95Ms: 900, sampleCount: 10, scope: "process" },
    indexed: [],
    serverTime: "2026-08-31T13:10:25.000Z",
  },
} as unknown as MetaState;

const META_ERROR: MetaState = { status: "error", facts: null, error: "HTTP 500" };

function wakeState(status: WakeState["status"]): WakeState {
  return { status, attempts: 1, reachable: status === "ready" };
}

function pill(meta: MetaState, wake: WakeState) {
  render(
    <SiteNav
      meta={meta}
      wake={wake}
      activeSection={null}
      onNavigate={() => {}}
      onOpenPalette={() => {}}
      onOpenWorkbench={() => {}}
    />,
  );
  return document.querySelector(".pill")!;
}

describe("the status pill reports the real /health outcome", () => {
  it("WARMING while a wake is in flight — grey, and it says why", () => {
    const element = pill(META_READY, wakeState("waking"));
    expect(element).toHaveTextContent(/WARMING/);
    expect(element.getAttribute("data-live")).toBe("false");
    expect(element.getAttribute("data-wake")).toBe("waking");
    expect(element.getAttribute("title")).toMatch(/30-50 seconds/);
  });

  it("READY, green, once /health has answered", () => {
    const element = pill(META_READY, wakeState("ready"));
    expect(element).toHaveTextContent(/READY/);
    expect(element.getAttribute("data-live")).toBe("true");
    expect(element).toHaveTextContent("v1.1.0");
  });

  it("OFFLINE, grey, when every wake attempt failed — never a green pill talking to nothing", () => {
    // The failure this guards against: a green READY pill on a build reaching nothing is the most
    // misleading thing a status indicator can do.
    const element = pill(META_READY, wakeState("offline"));
    expect(element).toHaveTextContent(/OFFLINE/);
    expect(element.getAttribute("data-live")).toBe("false");
    // And it points at what still works, rather than reading as a dead end.
    expect(element.getAttribute("title")).toMatch(/cached demo repositories still work/i);
  });

  it("shows an em-dash version rather than guessing when meta failed, even while green", () => {
    const element = pill(META_ERROR, wakeState("ready"));
    expect(element).toHaveTextContent(/READY/);
    expect(element).toHaveTextContent("—");
  });

  it("never renders CONNECTING — there is no state that resolves to nothing", () => {
    for (const status of ["waking", "ready", "offline"] as const) {
      const element = pill(META_READY, wakeState(status));
      expect(element.textContent ?? "").not.toMatch(/CONNECTING/);
    }
  });
});
