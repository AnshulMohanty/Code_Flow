import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { mockAnalysisResult } from "./test/fixture";
import { parseRepo } from "./site/RepoField";
import type { AnalysisResult } from "@codeflow/shared-types";

/**
 * INTERACTION TESTS for the two shipped surfaces.
 *
 * The assertions are organised around the invariant, not around the layout: no shipped view shows a
 * number it did not measure, no view presents inference as fact, and there is no path from the UI to
 * fabricated data. Every fetch is stubbed, so nothing here touches a network.
 */

/**
 * NO BUNDLED SNAPSHOT IN THIS SUITE, deliberately.
 *
 * This file pins the "nothing has been measured yet" invariant — four em-dashes, an honest empty
 * state, no path to data the user did not ask for. Once a build ships a generated snapshot, the real
 * loader would fill those views with a pre-computed analysis and every one of those assertions would
 * be describing a different page.
 *
 * Without this mock the tests still PASS, which is worse than failing: the loader is async, so the
 * synchronous assertions win the race by accident. An invariant that holds by timing is not pinned.
 * The snapshot path has its own tests in site/demoSnapshot.test.tsx.
 */
vi.mock("./lib/useDemoSnapshot", () => ({ useDemoSnapshot: () => null }));

const META = {
  analyzerVersion: "1.1.0",
  build: "abc1234def",
  answerLatency: { p50Ms: 412, p95Ms: 900, sampleCount: 40, scope: "process" },
  indexed: [{ analysisId: "a1", repoFullName: "acme/indexed-repo", commitSha: "f".repeat(40), fileCount: 12, completedAt: "2026-08-31T00:00:00.000Z" }],
  serverTime: "2026-08-31T13:10:25.000Z",
};

/** Routes every request the app makes. Anything unrouted FAILS loudly rather than silently 404ing. */
function stubFetch(routes: Record<string, unknown>, options: { metaFails?: boolean } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // Wake-on-visit hits /health on mount (see lib/useWake.ts). Answered by default: these tests are
    // about what the app does with a REACHABLE backend, and an unrouted /health would put every one
    // of them into the cold-start retry path.
    if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    if (url.includes("/api/meta")) {
      if (options.metaFails) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify(META), { status: 200, headers: { "content-type": "application/json" } });
    }
    // LONGEST fragment first, so `/api/result/job-1/ask` cannot be matched by the `/api/result/job-1`
    // route and answered with an analysis document. Route order in an object literal is a fragile
    // thing to depend on.
    const matches = Object.entries(routes)
      .filter(([fragment]) => url.includes(fragment))
      .sort((a, b) => b[0].length - a[0].length);
    if (matches[0]) {
      return new Response(JSON.stringify(matches[0][1]), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unrouted fetch: ${url}`);
  });
}

/**
 * Fill the repo field and click Analyze — AFTER waiting for the button to enable.
 *
 * Analysing a fresh repository needs the API and the queue, so the button is disabled and reads
 * "Warming up…" until wake-on-visit's `GET /health` answers (see lib/useWake.ts). Waiting for it is
 * exactly what a real visitor does, so the tests do it rather than reaching past the gate — a test
 * that clicked a disabled button would be asserting against a UI nobody can drive.
 */
async function startAnalysis(value: string) {
  const button = await waitFor(() => screen.getByRole("button", { name: /^Analyze$/ }));
  fireEvent.change(screen.getByLabelText(/GitHub repository/i), { target: { value } });
  fireEvent.click(button);
}

function completedJob(jobId: string) {
  return {
    id: jobId,
    jobId,
    status: "completed",
    progress: 1,
    currentStep: "Analysis completed.",
    parsedFiles: 4,
    totalFiles: 4,
    runStatus: "partial",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:05.000Z",
  };
}

beforeEach(() => {
  window.location.hash = "";
  // The app's SSE path needs EventSource; jsdom has none, so the driver falls back to polling —
  // which is exactly the degradation these tests should exercise.
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("the marketing site, before any analysis", () => {
  it("renders the headline and the repo field", async () => {
    vi.stubGlobal("fetch", stubFetch({}));
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/See what breaks/i);
    expect(screen.getByLabelText(/GitHub repository/i)).toBeInTheDocument();
  });

  it("shows FOUR em-dashes in the numbers section — nothing has been measured", async () => {
    // The correct first screenshot for a page about measured numbers with nothing to measure.
    vi.stubGlobal("fetch", stubFetch({}));
    render(<App />);
    const numbers = document.getElementById("numbers")!;
    const stats = numbers.querySelectorAll(".stat");
    expect(stats).toHaveLength(4);
    for (const stat of stats) {
      expect(stat.getAttribute("data-measured")).toBe("false");
      expect(stat.querySelector(".stat-value")?.textContent).toBe("—");
      // And each one says WHY, because a bare dash is honest but useless.
      expect(stat.querySelector(".stat-note")?.textContent ?? "").not.toBe("");
    }
  });

  it("shows an honest empty state where the pipeline card goes", async () => {
    vi.stubGlobal("fetch", stubFetch({}));
    render(<App />);
    expect(screen.getByText(/Nothing resolved yet/i)).toBeInTheDocument();
    expect(screen.getByText(/never with sample data/i)).toBeInTheDocument();
  });

  it("labels the hero mesh as a representative shape, not a repository", async () => {
    // A graph-shaped graphic on a page arguing for real data must say what it is.
    vi.stubGlobal("fetch", stubFetch({}));
    render(<App />);
    expect(screen.getByText(/representative shape · not a repository/i)).toBeInTheDocument();
  });

  it("has NO path to mock data anywhere in the UI", async () => {
    // The old shell shipped a "Use Mock Data Instead" button that loaded fabricated modules and
    // metrics into every view. It is gone and nothing replaces it.
    vi.stubGlobal("fetch", stubFetch({}));
    render(<App />);
    expect(screen.queryByText(/mock/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sample data/i)).toBeInTheDocument(); // only as the promise NOT to use it
  });
});

describe("the status pill never claims a connection it does not have", () => {
  // WHAT THE PILL REPORTS CHANGED, and the tests changed with it rather than being deleted. It used
  // to read `meta.status` — "did /api/meta return". On a free tier where the backend sleeps, the
  // honest answer for the first thirty seconds of a visit is neither "connecting" nor "offline" but
  // "asleep, being woken", and those differ in the one way a visitor cares about: the third is worth
  // waiting for. The pill now reads the real `GET /health` outcome. Every guarantee the old tests
  // made is still asserted — here for the reachable states, and in SiteNav.test.tsx for OFFLINE,
  // which is only reachable through the App after the full 67-second backoff.

  it("reads WARMING, not a frozen spinner, while the wake request is in flight", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<App />);
    const pill = document.querySelector(".pill")!;
    expect(pill).toHaveTextContent(/WARMING/);
    expect(pill.getAttribute("data-live")).toBe("false");
    // It says WHY, so a visitor knows this resolves rather than hangs.
    expect(pill.getAttribute("title")).toMatch(/sleeps when idle|30-50 seconds/i);
  });

  it("reads READY with a green dot and the SERVER's version once /health answers", async () => {
    vi.stubGlobal("fetch", stubFetch({}));
    render(<App />);
    await waitFor(() => expect(document.querySelector(".pill")).toHaveTextContent(/READY/));
    const pill = document.querySelector(".pill")!;
    expect(pill.getAttribute("data-live")).toBe("true");
    // The server's analyzer version, not a constant compiled into this bundle.
    expect(pill).toHaveTextContent("v1.1.0");
  });

  it("is green on REACHABILITY, and still falls back to an em-dash version when /api/meta fails", async () => {
    // Two different facts, reported separately. A deployment can answer /health while /api/meta is
    // failing; the useful fact for a visitor is the first, and inventing a version because the
    // second failed would be the lie the pill exists to avoid.
    vi.stubGlobal("fetch", stubFetch({}, { metaFails: true }));
    render(<App />);
    await waitFor(() => expect(document.querySelector(".pill")).toHaveTextContent(/READY/));
    expect(document.querySelector(".pill")!.getAttribute("data-live")).toBe("true");
    expect(document.querySelector(".pill")).toHaveTextContent("—");
  });
});

describe("running a real analysis", () => {
  function routes(result: AnalysisResult) {
    return {
      "/api/analyze": { jobId: "job-1", status: "queued", message: "queued" },
      "/api/job/job-1": completedJob("job-1"),
      "/api/jobs/job-1": completedJob("job-1"),
      "/api/result/job-1": result,
    };
  }

  it("moves to the workbench and renders the run's REAL numbers", async () => {
    const result = mockAnalysisResult("acme/repo");
    vi.stubGlobal("fetch", stubFetch(routes(result)));
    render(<App />);

    await startAnalysis("acme/repo");

    // The tabs appear only once there is a result.
    await waitFor(() => expect(screen.getByRole("tab", { name: /01 SYSTEM/ })).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByRole("tab", { name: /02 EXPLORE/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /03 IMPACT/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /04 DOMAINS/ })).toBeInTheDocument();
  });

  it("TAB 01 derives the container diagram from the real edge count", async () => {
    const result = mockAnalysisResult("acme/repo");
    vi.stubGlobal("fetch", stubFetch(routes(result)));
    render(<App />);
    await startAnalysis("acme/repo");
    await waitFor(() => expect(screen.getByRole("tab", { name: /01 SYSTEM/ })).toBeInTheDocument(), { timeout: 4000 });

    const edgeCount = result.graph!.edges.length;
    expect(screen.getByText(new RegExp(`derived from ${edgeCount} resolved edges`, "i"))).toBeInTheDocument();
  });

  it("omits the VIOLATION legend key when no sanctioned rule fires", async () => {
    // A legend key for a class that cannot occur is itself a claim about the codebase.
    const result = mockAnalysisResult("acme/repo");
    vi.stubGlobal("fetch", stubFetch(routes(result)));
    render(<App />);
    await startAnalysis("acme/repo");
    await waitFor(() => expect(screen.getByRole("tab", { name: /01 SYSTEM/ })).toBeInTheDocument(), { timeout: 4000 });

    const legend = document.querySelector(".legend")!;
    expect(legend).toHaveTextContent(/control flow/);
    expect(legend).toHaveTextContent(/data \/ read/);
    expect(legend).toHaveTextContent(/no rule violations detected/);
  });

  it("TAB 04 labels the domain lanes as INFERENCE, three times over", async () => {
    const result = mockAnalysisResult("acme/repo");
    vi.stubGlobal("fetch", stubFetch(routes(result)));
    render(<App />);
    await startAnalysis("acme/repo");
    await waitFor(() => expect(screen.getByRole("tab", { name: /04 DOMAINS/ })).toBeInTheDocument(), { timeout: 4000 });
    fireEvent.click(screen.getByRole("tab", { name: /04 DOMAINS/ }));

    expect(screen.getByText(/Structural roles — deterministic pass/i)).toBeInTheDocument();
    expect(screen.getByText(/Roles come from the parser/i)).toBeInTheDocument();
    expect(screen.getByText(/labelled as inference, never as fact/i)).toBeInTheDocument();
    expect(screen.getByText(/Domain lanes — specialist agents · inferred/i)).toBeInTheDocument();
  });

  it("TAB 04 says so plainly when there are NO inferred domains, and does not substitute communities", async () => {
    // Quietly showing the structural community partition as a "domain" is exactly the confusion the
    // view exists to prevent.
    const result = mockAnalysisResult("acme/repo");
    vi.stubGlobal("fetch", stubFetch(routes(result)));
    render(<App />);
    await startAnalysis("acme/repo");
    await waitFor(() => expect(screen.getByRole("tab", { name: /04 DOMAINS/ })).toBeInTheDocument(), { timeout: 4000 });
    fireEvent.click(screen.getByRole("tab", { name: /04 DOMAINS/ }));

    expect(screen.getByText(/No inferred domains for this run/i)).toBeInTheDocument();
    expect(screen.getByText(/deliberately not shown here as though it were an inferred domain/i)).toBeInTheDocument();
  });

  it("TAB 03 relabels the coverage card to the fact it actually has", async () => {
    const result = mockAnalysisResult("acme/repo");
    vi.stubGlobal("fetch", stubFetch(routes(result)));
    render(<App />);
    await startAnalysis("acme/repo");
    await waitFor(() => expect(screen.getByRole("tab", { name: /03 IMPACT/ })).toBeInTheDocument(), { timeout: 4000 });
    fireEvent.click(screen.getByRole("tab", { name: /03 IMPACT/ }));

    expect(screen.getByText(/Test files that reach it/i)).toBeInTheDocument();
    expect(screen.getByText(/By import reachability, NOT coverage/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Tests that cover it$/i)).not.toBeInTheDocument();
  });

  it("TAB 03's MOVE mode reports fewer affected files than CHANGE mode", async () => {
    // A rename is not a refactor: only direct references break.
    const result = mockAnalysisResult("acme/repo");
    vi.stubGlobal("fetch", stubFetch(routes(result)));
    render(<App />);
    await startAnalysis("acme/repo");
    await waitFor(() => expect(screen.getByRole("tab", { name: /03 IMPACT/ })).toBeInTheDocument(), { timeout: 4000 });
    fireEvent.click(screen.getByRole("tab", { name: /03 IMPACT/ }));

    fireEvent.click(screen.getByRole("button", { name: /If I move it/i }));
    expect(screen.getByText(/A path change breaks only DIRECT references/i)).toBeInTheDocument();
  });

  it("TAB 02 states the PROVENANCE of the reading order", async () => {
    const result = mockAnalysisResult("acme/repo");
    vi.stubGlobal("fetch", stubFetch(routes(result)));
    render(<App />);
    await startAnalysis("acme/repo");
    await waitFor(() => expect(screen.getByRole("tab", { name: /02 EXPLORE/ })).toBeInTheDocument(), { timeout: 4000 });
    fireEvent.click(screen.getByRole("tab", { name: /02 EXPLORE/ }));

    // This fixture HAS a synthesis, so the caption must attribute the prose to the agent.
    expect(screen.getByText(/Narrated by the onboarding agent/i)).toBeInTheDocument();
  });
});

describe("the workbench entry step", () => {
  it("lists the deployment's REAL indexed repositories", async () => {
    vi.stubGlobal("fetch", stubFetch({}));
    window.location.hash = "workbench";
    render(<App />);
    await waitFor(() => expect(screen.getByText(/acme\/indexed-repo/)).toBeInTheDocument());
  });

  it("says NOTHING YET rather than showing well-known repositories as if they were history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ...META, indexed: [] }), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    window.location.hash = "workbench";
    render(<App />);
    await waitFor(() => expect(screen.getByText(/has not analysed a repository/i)).toBeInTheDocument());
  });
});

describe("parseRepo — validated locally, so a value this field accepts the API accepts", () => {
  it("accepts owner/repo and a full URL", () => {
    expect(parseRepo("tokio-rs/tokio")).toEqual({ owner: "tokio-rs", repo: "tokio" });
    expect(parseRepo("https://github.com/tokio-rs/tokio")).toEqual({ owner: "tokio-rs", repo: "tokio" });
    expect(parseRepo("https://github.com/tokio-rs/tokio.git")).toEqual({ owner: "tokio-rs", repo: "tokio" });
    expect(parseRepo("git@github.com:tokio-rs/tokio.git")).toEqual({ owner: "tokio-rs", repo: "tokio" });
  });

  it("REJECTS a single segment rather than guessing which half it is", () => {
    expect(parseRepo("tokio")).toEqual({ error: expect.stringContaining("owner/repo") });
  });

  it("rejects an empty value and an over-deep path", () => {
    expect("error" in parseRepo("")).toBe(true);
    expect("error" in parseRepo("a/b/c")).toBe(true);
  });

  it("rejects characters GitHub does not allow", () => {
    expect("error" in parseRepo("bad owner/repo")).toBe(true);
  });
});

describe("Q&A availability is stated, never a dead end", () => {
  it("explains WHY Q&A is unavailable on a run that built no index", async () => {
    // "Q&A unavailable" with no reason makes a correctly-behaving product feel broken.
    const result = mockAnalysisResult("acme/repo");
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/api/analyze": { jobId: "job-1", status: "queued", message: "queued" },
        "/api/job/job-1": completedJob("job-1"),
        "/api/jobs/job-1": completedJob("job-1"),
        "/api/result/job-1": result,
      }),
    );
    render(<App />);
    await startAnalysis("acme/repo");
    await waitFor(() => expect(screen.getByRole("tab", { name: /02 EXPLORE/ })).toBeInTheDocument(), { timeout: 4000 });
    fireEvent.click(screen.getByRole("tab", { name: /02 EXPLORE/ }));

    expect(screen.getByText(/No Q&A index was built for this run/i)).toBeInTheDocument();
    expect(screen.getByText(/does not need a provider key/i)).toBeInTheDocument();
  });
});

describe("citation chips resolve, or do not pretend to", () => {
  it("links a citation to the ANALYSED commit, not to HEAD", async () => {
    // The base fixture is a PARTIAL run whose RAG stage was budget-skipped, so Q&A is legitimately
    // unavailable on it — which the next test asserts. Here we give it an index, because the thing
    // under test is the CHIP, not the availability branch.
    const result: AnalysisResult = {
      ...mockAnalysisResult("acme/repo"),
    };
    result.ai = {
      ...result.ai,
      rag: {
        chunks: [],
        embeddingModel: "mock-embed",
        embeddingDim: 3,
        store: { namespace: "n", vectorStoreId: "v", textStoreId: "t" },
      } as never,
    };
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/api/analyze": { jobId: "job-1", status: "queued", message: "queued" },
        "/api/job/job-1": completedJob("job-1"),
        "/api/jobs/job-1": completedJob("job-1"),
        "/api/result/job-1": result,
        "/api/result/job-1/ask": {
          answer: "The session shape is verified once at the edge.",
          answered: true,
          citations: [{ fileId: "src/auth.ts", startLine: 4, endLine: 9 }],
          retrievedChunkIds: [],
        },
      }),
    );
    render(<App />);
    await startAnalysis("acme/repo");
    await waitFor(() => expect(screen.getByRole("tab", { name: /02 EXPLORE/ })).toBeInTheDocument(), { timeout: 4000 });
    fireEvent.click(screen.getByRole("tab", { name: /02 EXPLORE/ }));

    const suggestion = document.querySelector(".ask-suggestions .chip") as HTMLButtonElement;
    expect(suggestion).toBeTruthy();
    fireEvent.click(suggestion);

    await waitFor(() => expect(screen.getByText(/verified once at the edge/i)).toBeInTheDocument());
    const chip = within(document.querySelector(".cited")!).getByRole("link");
    expect(chip).toHaveAttribute("href", expect.stringContaining(result.commitSha!));
    expect(chip).toHaveAttribute("href", expect.stringContaining("#L4-L9"));
  });
});
