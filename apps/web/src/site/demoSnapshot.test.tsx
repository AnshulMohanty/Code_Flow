import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDemoSnapshot, snapshotLabel, type DemoSnapshot } from "../lib/demoSnapshot";
import { DEMO_REPOS, demoFullName, isDemoRepo } from "../lib/demoRepos";
import { mockAnalysisResult } from "../test/fixture";

/**
 * THE SNAPSHOT IS REAL DATA SHOWN AS WHAT IT IS — the line this feature lives or dies on.
 *
 * The deleted "Use Mock Data Instead" button put invented module names and metrics into every view,
 * indistinguishable from a live run. A pre-computed snapshot is only different if two things hold,
 * and both are asserted here: it cannot be loaded unless it carries a pinned commit and a real
 * graph, and it cannot be RENDERED without its provenance beside it.
 *
 * The App-level tests mock the loader to null so the "nothing measured yet" invariant stays pinned
 * independently — see App.test.tsx. This file is the other half: what happens when there IS one.
 */

/** A snapshot whose `result` is the shared fixture — the point being the WRAPPER, not the analysis. */
function snapshot(overrides: Partial<DemoSnapshot["provenance"]> = {}): DemoSnapshot {
  return {
    provenance: {
      repoFullName: "acme/demo-repo",
      commitSha: "a".repeat(40),
      generatedAt: "2026-09-15T10:00:00.000Z",
      analyzerVersion: "1.1.0",
      producedBy: "codeflow-local (offline, deterministic, no provider key)",
      limitations: ["No AI summary: produced offline with no key."],
      ...overrides,
    },
    result: mockAnalysisResult("acme/demo-repo"),
  };
}

describe("parseDemoSnapshot — a snapshot that cannot be trusted is not loaded", () => {
  it("accepts a well-formed one", () => {
    expect(parseDemoSnapshot(snapshot())).not.toBeNull();
  });

  it("REFUSES one with no pinned commit — its citations could not resolve", () => {
    // A citation that does not resolve is worse than no citation: it looks verifiable.
    const bad = snapshot();
    (bad.provenance as { commitSha: string }).commitSha = "";
    expect(parseDemoSnapshot(bad)).toBeNull();
  });

  it("REFUSES one with no graph — a demo that draws nothing demonstrates nothing", () => {
    const bad = snapshot();
    (bad.result as { graph?: unknown }).graph = { nodes: [], edges: [] };
    expect(parseDemoSnapshot(bad)).toBeNull();
  });

  it("REFUSES one with no provenance at all, rather than rendering it unlabelled", () => {
    expect(parseDemoSnapshot({ result: mockAnalysisResult("x/y") })).toBeNull();
    expect(parseDemoSnapshot(null)).toBeNull();
    expect(parseDemoSnapshot("not an object")).toBeNull();
  });

  it("REFUSES one whose limitations are missing — the field is how a local run states what it lacks", () => {
    const bad = snapshot();
    delete (bad.provenance as Partial<DemoSnapshot["provenance"]>).limitations;
    expect(parseDemoSnapshot(bad)).toBeNull();
  });
});

describe("snapshotLabel names the repository, the commit and the date", () => {
  it("says PRE-COMPUTED and NOT A LIVE RUN in the label itself", () => {
    const label = snapshotLabel(snapshot().provenance);
    expect(label).toMatch(/Pre-computed/i);
    expect(label).toMatch(/not a live run/i);
    expect(label).toContain("acme/demo-repo");
    expect(label).toContain("2026-09-15");
    expect(label).toContain("aaaaaaa");
  });
});

describe("the curated demo allowlist", () => {
  it("covers the three parser families the engine treats differently, plus CodeFlow itself", () => {
    const languages = new Set(DEMO_REPOS.map((demo) => demo.language));
    expect(languages).toContain("JavaScript");
    expect(languages).toContain("Python");
    expect(languages).toContain("TypeScript");
    expect(DEMO_REPOS.map(demoFullName)).toContain("AnshulMohanty/Code_Flow");
  });

  it("gives every entry a fact about the repository rather than a sales line", () => {
    for (const demo of DEMO_REPOS) {
      expect(demo.note.length).toBeGreaterThan(10);
      expect(demo.note).not.toMatch(/blazing|amazing|revolutionary|best-in-class/i);
    }
  });

  it("matches case-insensitively, because a URL bar is not case-sensitive about owners", () => {
    expect(isDemoRepo({ owner: "PSF", repo: "Requests" })).toBe(true);
    expect(isDemoRepo({ owner: "someone", repo: "else" })).toBe(false);
  });

  it("stays in step with the pre-warm script, which keeps its own copy on purpose", async () => {
    // scripts/prewarm-demos.mjs duplicates this list so that warming a deployment does not require
    // building the frontend. Duplication is the trade; this assertion is the other half of it.
    // Resolved from the vitest CWD (apps/web); `import.meta.url` is not a file: URL under jsdom.
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const source = await readFile(resolve(process.cwd(), "../../scripts/prewarm-demos.mjs"), "utf8");
    for (const demo of DEMO_REPOS) {
      expect(source).toContain(`owner: "${demo.owner}", repo: "${demo.repo}"`);
    }
  });
});

describe("MarketingSite renders a snapshot only WITH its provenance", () => {
  // Imported lazily so the mock below is installed before the module graph is built.
  let MarketingSite: typeof import("./MarketingSite").MarketingSite;

  beforeEach(async () => {
    vi.stubGlobal("EventSource", undefined);
    ({ MarketingSite } = await import("./MarketingSite"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderWith(demo: DemoSnapshot | null) {
    render(
      <MarketingSite
        meta={{ status: "loading", facts: null, error: null }}
        wake={{ status: "waking", attempts: 1, reachable: false }}
        demo={demo}
        analysis={{ phase: "idle", jobId: null, events: new Map(), progress: null, result: null, error: null, target: null }}
        ask={{ question: null, answer: null, busy: false, error: null }}
        onAnalyze={() => {}}
        onAsk={() => {}}
        onOpenWorkbench={() => {}}
      />,
    );
  }

  it("shows the banner, the repository, the date and the limitations", async () => {
    renderWith(snapshot());
    await waitFor(() => expect(document.querySelector('[data-snapshot="true"]')).toBeInTheDocument());
    // Scoped to the banner: once the snapshot is rendered the repository name legitimately appears
    // elsewhere on the page too, and an unscoped query would match those as well.
    const banner = document.querySelector('[data-snapshot="true"]') as HTMLElement;
    expect(within(banner).getByText(/Pre-computed demo/i)).toBeInTheDocument();
    // It appears twice inside the banner on purpose — once as the heading and once in the
    // provenance line — so this asserts presence, not uniqueness.
    expect(within(banner).getAllByText(/not a live run/i).length).toBeGreaterThan(0);
    expect(within(banner).getByText(/acme.demo-repo/)).toBeInTheDocument();
    expect(within(banner).getByText(/No AI summary/i)).toBeInTheDocument();
    expect(within(banner).getByText(/codeflow-local/i)).toBeInTheDocument();
  });

  it("links the pinned commit, so any claim on screen can be checked against the source", () => {
    renderWith(snapshot());
    const link = screen.getByRole("link", { name: /view the commit/i });
    expect(link).toHaveAttribute("href", expect.stringContaining("a".repeat(40)));
  });

  it("renders NO banner and keeps the empty state when there is no snapshot", () => {
    renderWith(null);
    expect(document.querySelector('[data-snapshot="true"]')).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing resolved yet/i)).toBeInTheDocument();
  });

  it("offers the demo strip while the backend is still waking", () => {
    // The strip is the thing that works soonest: a cached result needs the API but not the queue and
    // not a provider. Offering it is what turns "come back in a minute" into "look at this meanwhile".
    renderWith(null);
    for (const demo of DEMO_REPOS) {
      expect(screen.getByText(demo.label)).toBeInTheDocument();
    }
  });
});
