import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { aiAvailability } from "../lib/aiMode";
import type { MetaState } from "../lib/useMeta";
import { ModeSwitch } from "./ModeSwitch";
import { mockAnalysisResult } from "../test/fixture";

/**
 * THE TWO MODES, end to end: what the server says is possible, what the visitor picks, and the
 * `withAi` the request actually carries. The request body is the contract with the backend, so it is
 * read off the stubbed fetch rather than off component state.
 */

vi.mock("../lib/useDemoSnapshot", () => ({ useDemoSnapshot: () => null }));

const BASE_META = {
  analyzerVersion: "1.4.0",
  build: null,
  answerLatency: { p50Ms: null, p95Ms: null, sampleCount: 0, scope: "process" },
  indexed: [],
  serverTime: "2026-11-25T10:00:00.000Z",
};

function metaWith(ai: unknown, limits: unknown = { dailyAiAnalysesPerIp: 3, dailyQuestionsPerIp: 20 }) {
  return { ...BASE_META, ...(ai === undefined ? {} : { ai }), ...(limits === undefined ? {} : { limits }) };
}

const AI_ON = { enabled: true, provider: "openai", chatModel: "gpt-4.1-mini", embeddingModel: "text-embedding-3-small" };
const AI_OFF = { enabled: false, provider: null, chatModel: null, embeddingModel: null, configError: "set OPENAI_API_KEY" };

/** Routes /health, /api/meta and /api/analyze; records every analyze body. */
function stub(meta: unknown, analyzeResponse?: { status: number; body: unknown }) {
  const analyzeBodies: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) return new Response("{}", { status: 200 });
    if (url.includes("/api/meta")) return new Response(JSON.stringify(meta), { status: 200 });
    if (url.includes("/api/analyze")) {
      analyzeBodies.push(JSON.parse(String(init?.body ?? "{}")));
      const response = analyzeResponse ?? { status: 202, body: { jobId: "job-1", status: "queued", message: "queued" } };
      return new Response(JSON.stringify(response.body), { status: response.status });
    }
    // Everything after enqueue (polling) is irrelevant to these tests; keep it pending.
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return analyzeBodies;
}

async function analyze(value: string) {
  const button = await waitFor(() => screen.getByRole("button", { name: /^Analyze$/ }));
  fireEvent.change(screen.getByLabelText(/GitHub repository/i), { target: { value } });
  fireEvent.click(button);
}

beforeEach(() => {
  window.location.hash = "";
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("the mode switch sends withAi", () => {
  it("defaults to Map + AI when the server has AI, and sends withAi: true", async () => {
    const bodies = stub(metaWith(AI_ON));
    render(<App />);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Map \+ AI/i })).toBeChecked());
    await analyze("acme/repo");
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ owner: "acme", repo: "repo", withAi: true });
  });

  it("sends withAi: false after the visitor picks Map only", async () => {
    const bodies = stub(metaWith(AI_ON));
    render(<App />);
    const mapOnly = await waitFor(() => screen.getByRole("radio", { name: /Map only/i }));
    fireEvent.click(mapOnly);
    expect(mapOnly).toBeChecked();
    await analyze("acme/repo");
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ withAi: false });
  });

  it("omits withAi entirely for an OLDER server that does not report modes — and offers no switch", async () => {
    // A switch the server cannot honour would be a control that does nothing.
    const bodies = stub(metaWith(undefined, undefined));
    render(<App />);
    await waitFor(() => expect(screen.queryByRole("radio")).not.toBeInTheDocument());
    await analyze("acme/repo");
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).not.toHaveProperty("withAi");
  });

  it("shows the chosen mode in the nav badge, with the server's chat model", async () => {
    stub(metaWith(AI_ON));
    render(<App />);
    await waitFor(() => expect(document.querySelector(".nav .mode-badge")).toHaveTextContent("AI · gpt-4.1-mini"));
    fireEvent.click(screen.getByRole("radio", { name: /Map only/i }));
    expect(document.querySelector(".nav .mode-badge")).toHaveTextContent("Map only");
  });
});

describe("when the server says AI is off", () => {
  it("disables the AI option, says why in plain words, and sends withAi: false", async () => {
    const bodies = stub(metaWith(AI_OFF));
    render(<App />);
    const ai = await waitFor(() => screen.getByRole("radio", { name: /Map \+ AI/i }));
    await waitFor(() => expect(ai).toBeDisabled());
    expect(screen.getByRole("radio", { name: /Map only/i })).toBeChecked();
    expect(screen.getByText(/AI is off on this server/i)).toBeInTheDocument();
    // The operator's configError (an env var name) is never shown.
    expect(screen.queryByText(/OPENAI_API_KEY/)).not.toBeInTheDocument();
    await analyze("acme/repo");
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ withAi: false });
  });
});

describe("the daily AI cap", () => {
  it("turns a DAILY_LIMIT 429 into plain copy with a one-click way to Map only", async () => {
    stub(metaWith(AI_ON), {
      status: 429,
      body: { error: { code: "DAILY_LIMIT", message: "You have used today's 3 AI analyses.", details: { limit: 3 } } },
    });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Map \+ AI/i })).toBeChecked());
    await analyze("acme/repo");
    // The analyze call moves the visitor to the workbench, which states the limit there.
    const alert = await waitFor(() => screen.getAllByRole("alert").find((el) => /Daily limit reached/.test(el.textContent ?? ""))!);
    expect(alert).toHaveTextContent(/Map only is free and still works/i);
    fireEvent.click(screen.getAllByRole("button", { name: /Use Map only/i })[0]);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Map only/i })).toBeChecked());
  });
});

describe("result banners are in plain words", () => {
  it("a map-only result says so in the workbench — and never prints the worker's operator text", async () => {
    const result = {
      ...mockAnalysisResult("acme/repo"),
      runMode: "deterministic-only" as const,
      degradations: [
        { reason: "map-only" as const, detail: "AI stages not requested (withAi=false)." },
        { reason: "ai-unavailable" as const, detail: "Provider 402 — top up or set ANTHROPIC_API_KEY." },
      ],
      warnings: ["Synthesis skipped: set ANTHROPIC_API_KEY or GEMINI_API_KEY."],
    };
    const job = {
      id: "job-1",
      jobId: "job-1",
      status: "completed",
      progress: 1,
      currentStep: "done",
      parsedFiles: 4,
      totalFiles: 4,
      createdAt: "2026-11-25T00:00:00.000Z",
      updatedAt: "2026-11-25T00:00:05.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/health")) return new Response("{}", { status: 200 });
        if (url.includes("/api/meta")) return new Response(JSON.stringify(metaWith(AI_ON)), { status: 200 });
        if (url.includes("/api/analyze")) return new Response(JSON.stringify({ jobId: "job-1", status: "queued", message: "q" }), { status: 202 });
        if (url.includes("/api/job/job-1")) return new Response(JSON.stringify(job), { status: 200 });
        if (url.includes("/api/result/job-1")) return new Response(JSON.stringify(result), { status: 200 });
        throw new Error(`unrouted ${url}`);
      }),
    );
    render(<App />);
    await analyze("acme/repo");
    await waitFor(() => expect(screen.getByRole("tab", { name: /01 SYSTEM/ })).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByText("Map only — no AI was used. Switch to Map + AI to add the guide and Q&A.")).toBeInTheDocument();
    expect(
      screen.getByText("AI is unavailable right now (limit or credit reached). The map is complete."),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ANTHROPIC_API_KEY|GEMINI_API_KEY|withAi=false/);
  });
});

describe("ModeSwitch — a native radio group", () => {
  function meta(ai: unknown): MetaState {
    return { status: "ready", error: null, facts: metaWith(ai) as never };
  }

  it("is one radio group with two options, keyboard-reachable by construction", () => {
    const onChange = vi.fn();
    render(<ModeSwitch choice="map-ai" availability={aiAvailability(meta(AI_ON))} onChange={onChange} />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    // Same `name` ⇒ the browser treats them as one group: one tab stop, arrow keys move.
    expect(radios[0].getAttribute("name")).toBe(radios[1].getAttribute("name"));
    expect(screen.getByRole("group", { name: /Analysis mode/i })).toBeInTheDocument();
    fireEvent.click(radios[0]);
    expect(onChange).toHaveBeenCalledWith("map-only");
  });

  it("labels the options with what they cost", () => {
    render(<ModeSwitch choice="map-ai" availability={aiAvailability(meta(AI_ON))} onChange={() => {}} />);
    expect(screen.getByText("free")).toBeInTheDocument();
    expect(screen.getByText(/uses credits · 3\/day/)).toBeInTheDocument();
  });
});
