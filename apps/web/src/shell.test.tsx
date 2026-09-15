import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

/**
 * THE STATIC-SITE CONTRACT: the frontend paints without the backend.
 *
 * WHY THIS IS A TEST AND NOT A NOTE. The deployment shape depends on it. The SPA is a static site —
 * free, always on, never asleep — while the API is a container a free tier suspends after ~15
 * minutes and wakes in 30-50 seconds. So for the first half-minute after a quiet period, "the API is
 * unreachable" is the NORMAL state of a working deployment, not an error case. If anything on the
 * paint path awaited an API response, that normal state would render a blank or frozen page and the
 * whole always-on frontend would buy nothing.
 *
 * The assertions are therefore about the SHELL: nav, hero, the repo field, all three sections, and
 * the workbench chrome — every structural piece a visitor sees before any analysis exists. What the
 * shell must NOT do is claim data it does not have; that is asserted in App.test.tsx and is the
 * reason this file checks for structure and em-dashes rather than for content.
 *
 * `fetch` REJECTS here rather than returning a 500. A rejection is what an unreachable host actually
 * produces, and it is the harsher case: a 500 still resolves the promise, so a component that awaits
 * one still re-renders.
 */

beforeEach(() => {
  window.location.hash = "";
  vi.stubGlobal("EventSource", undefined);
  // Unreachable, the way an unreachable host is unreachable.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("the marketing shell renders with the API unreachable", () => {
  it("paints the nav, the hero and the repo field", () => {
    // Synchronous assertions on purpose: nothing here may be gated behind an await.
    render(<App />);
    expect(screen.getByRole("navigation", { name: /primary/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/See what breaks/i);
    expect(screen.getByLabelText(/GitHub repository/i)).toBeInTheDocument();
  });

  it("paints all three sections, so the page is scrollable and complete", () => {
    render(<App />);
    for (const id of ["resolve", "grounding", "numbers"]) {
      expect(document.getElementById(id)).toBeInTheDocument();
    }
  });

  it("still refuses to invent numbers — four em-dashes, each with a reason", () => {
    // An unreachable API is exactly when a UI is most tempted to fall back to something plausible.
    render(<App />);
    const stats = document.getElementById("numbers")!.querySelectorAll(".stat");
    expect(stats).toHaveLength(4);
    for (const stat of stats) {
      expect(stat.getAttribute("data-measured")).toBe("false");
      expect(stat.querySelector(".stat-value")?.textContent).toBe("—");
    }
  });
});

describe("the workbench shell renders with the API unreachable", () => {
  it("paints its chrome from the hash route alone", () => {
    window.location.hash = "workbench";
    render(<App />);
    expect(screen.getByText(/Step 01 — point at a repo/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/GitHub repository/i)).toBeInTheDocument();
  });
});
