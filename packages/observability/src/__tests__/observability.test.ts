import { describe, expect, it } from "vitest";
import type { TokenUsage } from "@codeflow/shared-types";
import {
  addUsage,
  buildInteractionGraph,
  computeCost,
  createRecordingTracer,
  renderTrace,
} from "../tracer.js";
import { createVersionedBlackboard, renderBlackboardHistory } from "../versionedBlackboard.js";
import {
  createHttpTraceExporter,
  createMultiExporter,
  createOtelReplayExporter,
  exportersFromEnv,
  pricingFromEnv,
  toExportPayload,
  type OtelSpanLike,
} from "../exporters.js";
import { createNoopTracer } from "../noop.js";
import type { PricingTable, TraceExporter } from "../contracts.js";

// V3-P5 task 2. The properties that matter are the honesty ones: a cost report that says $0 when it
// means "unpriced", a trace that reports a duration from an unended span, or an exporter that fails
// the run it is observing would each be worse than having no observability at all.

/** A deterministic clock: every read advances by 10ms, so durations are exact and assertable. */
function stepClock(step = 10) {
  let t = 0;
  return () => (t += step);
}

const MEASURED = (input: number, output: number, cacheRead?: number): TokenUsage => ({
  inputTokens: input,
  outputTokens: output,
  ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
  measured: true,
});

const PRICING: PricingTable = {
  "claude-opus": { inputPerMillion: 15, outputPerMillion: 75, cacheReadPerMillion: 1.5 },
  "gemini-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
};

describe("createRecordingTracer — spans", () => {
  it("records a span tree with parents, kinds, attributes and events", () => {
    const tracer = createRecordingTracer({ clock: stepClock() });
    const run = tracer.startSpan("run", "run", { repo: "acme/repo" });
    const stage = run.child("stage:connect", "stage");
    stage.addEvent("parsed", { files: 12 });
    stage.end();
    run.end();

    const report = tracer.report();
    expect(report.spans.map((span) => span.name)).toEqual(["run", "stage:connect"]);
    expect(report.spans[1].parentId).toBe(report.spans[0].id);
    expect(report.spans[0].attributes.repo).toBe("acme/repo");
    expect(report.spans[1].events[0]).toMatchObject({ name: "parsed", attributes: { files: 12 } });
  });

  it("uses DETERMINISTIC ids, so a recorded trace is assertable", () => {
    // A random id would make every trace unassertable, and a test that regexes around ids stops
    // checking structure. These are unique within a trace; the OTel bridge mints real ids at export.
    const tracer = createRecordingTracer({ clock: stepClock() });
    const a = tracer.startSpan("a", "run");
    const b = a.child("b", "stage");
    expect([a.id, b.id]).toEqual(["s1", "s2"]);
  });

  it("defaults an un-set status to `ok` at end, not to `unset`", () => {
    // Leaving it unset would make every successful span look unfinished in a report.
    const tracer = createRecordingTracer({ clock: stepClock() });
    const span = tracer.startSpan("x", "internal");
    span.end();
    expect(tracer.report().spans[0].status).toBe("ok");
  });

  it("end() is IDEMPOTENT — a double end cannot corrupt a duration", () => {
    const tracer = createRecordingTracer({ clock: stepClock() });
    const span = tracer.startSpan("x", "internal");
    span.end();
    const first = tracer.report().spans[0].durationMs;
    span.end();
    expect(tracer.report().spans[0].durationMs).toBe(first);
  });

  it("ACCUMULATES usage across several calls in one span", () => {
    // A retrying stage or a best-of-N specialist makes several provider calls; keeping only the last
    // would under-report the bill by exactly the amount that is interesting.
    const tracer = createRecordingTracer({ clock: stepClock() });
    const span = tracer.startSpan("specialist", "agent", { model: "gemini-flash" });
    span.recordUsage(MEASURED(100, 20));
    span.recordUsage(MEASURED(150, 30));
    span.end();
    expect(tracer.report().spans[0].usage).toEqual({ inputTokens: 250, outputTokens: 50, measured: true });
  });

  it("reports a trace with an UNENDED span as INCOMPLETE", () => {
    // Any duration read from it is a lower bound, and a reader who does not know that quotes it as
    // fact.
    const tracer = createRecordingTracer({ clock: stepClock() });
    const run = tracer.startSpan("run", "run");
    run.child("dangling", "stage"); // never ended
    run.end();
    const report = tracer.report();
    expect(report.complete).toBe(false);
    expect(renderTrace(report)).toMatch(/INCOMPLETE/);
  });

  it("records errors with their message and surfaces them", () => {
    const tracer = createRecordingTracer({ clock: stepClock() });
    const span = tracer.startSpan("stage:rag", "stage");
    span.setStatus("error", "voyage down");
    span.end();
    const report = tracer.report();
    expect(report.errors).toEqual([{ span: "stage:rag", error: "voyage down" }]);
    expect(report.spans[0].status).toBe("error");
  });

  it("orders spans by START time, so a reader follows the run rather than the tree", () => {
    const tracer = createRecordingTracer({ clock: stepClock() });
    const run = tracer.startSpan("run", "run");
    const first = run.child("first", "stage");
    const second = run.child("second", "stage");
    second.end();
    first.end();
    expect(tracer.report().spans.map((span) => span.name)).toEqual(["run", "first", "second"]);
  });

  it("reset clears the trace", () => {
    const tracer = createRecordingTracer({ clock: stepClock() });
    tracer.startSpan("x", "run").end();
    tracer.reset();
    expect(tracer.report().spans).toEqual([]);
  });
});

describe("computeCost — a cost report must never say $0 when it means 'unpriced'", () => {
  it("prices a known model from real usage", () => {
    const cost = computeCost([{ usage: MEASURED(1_000_000, 1_000_000), model: "claude-opus" }], PRICING);
    expect(cost.usd).toBeCloseTo(15 + 75);
    expect(cost.measured).toBe(true);
    expect(cost.unpricedModels).toEqual([]);
  });

  it("reports NULL and names the model when a price is unknown", () => {
    // Reporting 0 would read as "this was free" — the single most misleading thing a cost report can
    // say.
    const cost = computeCost([{ usage: MEASURED(1000, 100), model: "some-new-model" }], PRICING);
    expect(cost.usd).toBeNull();
    expect(cost.unpricedModels).toEqual(["some-new-model"]);
    // The token counts are still real and still reported.
    expect(cost.inputTokens).toBe(1000);
  });

  it("names '(unknown model)' when a usage carries no model at all", () => {
    const cost = computeCost([{ usage: MEASURED(10, 10) }], PRICING);
    expect(cost.usd).toBeNull();
    expect(cost.unpricedModels).toEqual(["(unknown model)"]);
  });

  it("does NOT double-bill cache-read tokens as input", () => {
    // Double-counting them would inflate the reported cost of the very optimisation that saved money.
    const withCache = computeCost([{ usage: MEASURED(1_000_000, 0, 1_000_000), model: "claude-opus" }], PRICING);
    // All input was a cache read ⇒ billed at the cache rate only.
    expect(withCache.usd).toBeCloseTo(1.5);
    const withoutCache = computeCost([{ usage: MEASURED(1_000_000, 0), model: "claude-opus" }], PRICING);
    expect(withoutCache.usd).toBeCloseTo(15);
  });

  it("propagates `measured: false` — one estimate makes the TOTAL an estimate", () => {
    const cost = computeCost(
      [
        { usage: MEASURED(100, 10), model: "gemini-flash" },
        { usage: { inputTokens: 50, outputTokens: 5, measured: false }, model: "gemini-flash" },
      ],
      PRICING,
    );
    expect(cost.measured).toBe(false);
    expect(renderTrace({ ...emptyReport(), cost })).toMatch(/contains ESTIMATES/);
  });

  it("handles no entries at all", () => {
    const cost = computeCost([], PRICING);
    expect(cost).toMatchObject({ inputTokens: 0, outputTokens: 0, usd: 0, measured: true, unpricedModels: [] });
  });
});

describe("addUsage", () => {
  it("sums, and `measured: false` WINS", () => {
    // A total containing one estimate is an estimate.
    expect(addUsage(MEASURED(10, 1), { inputTokens: 5, outputTokens: 2, measured: false })).toEqual({
      inputTokens: 15,
      outputTokens: 3,
      measured: false,
    });
  });

  it("only carries cacheReadTokens when at least one side had it", () => {
    expect(addUsage(MEASURED(1, 1), MEASURED(1, 1))).not.toHaveProperty("cacheReadTokens");
    expect(addUsage(MEASURED(1, 1, 5), MEASURED(1, 1))).toMatchObject({ cacheReadTokens: 5 });
  });
});

describe("the interaction graph — DERIVED from the span tree", () => {
  it("collapses repeated spans by NAME, which is what makes a fan-out readable", () => {
    // A flat list of 300 fan-out spans is unreadable; "supervisor ← specialist:security ×60" is a
    // shape a human can hold.
    const tracer = createRecordingTracer({ clock: stepClock() });
    const run = tracer.startSpan("run", "run");
    const supervisor = run.child("supervisor", "agent");
    for (let i = 0; i < 60; i++) {
      const specialist = run.child("specialist:security", "agent", { model: "gemini-flash" });
      specialist.recordUsage(MEASURED(100, 10));
      specialist.end();
    }
    supervisor.end();
    run.end();

    const graph = tracer.report().interactions;
    const node = graph.nodes.find((entry) => entry.name === "specialist:security");
    expect(node?.calls).toBe(60);
    expect(node?.usage).toEqual({ inputTokens: 6000, outputTokens: 600, measured: true });
    const edge = graph.edges.find((entry) => entry.to === "specialist:security");
    expect(edge).toMatchObject({ from: "run", count: 60 });
  });

  it("counts errors per node", () => {
    const tracer = createRecordingTracer({ clock: stepClock() });
    const run = tracer.startSpan("run", "run");
    const bad = run.child("tool:search", "tool");
    bad.setStatus("error", "boom");
    bad.end();
    const good = run.child("tool:search", "tool");
    good.end();
    run.end();
    expect(tracer.report().interactions.nodes.find((node) => node.name === "tool:search")).toMatchObject({
      calls: 2,
      errors: 1,
    });
  });

  it("is sorted, so a report is deterministic and diffable between runs", () => {
    const tracer = createRecordingTracer({ clock: stepClock() });
    const run = tracer.startSpan("run", "run");
    for (const name of ["zeta", "alpha", "mid"]) run.child(name, "stage").end();
    run.end();
    const graph = buildInteractionGraph(tracer.report().spans);
    expect(graph.nodes.map((node) => node.name)).toEqual(["alpha", "mid", "run", "zeta"]);
  });

  it("ignores an edge whose parent is not in the trace", () => {
    expect(
      buildInteractionGraph([
        { id: "s1", parentId: "missing", name: "orphan", kind: "stage", startMs: 0, status: "ok", attributes: {}, events: [] },
      ]).edges,
    ).toEqual([]);
  });
});

describe("ACCEPTANCE — a complete trace with per-pillar tokens AND cost for a whole run", () => {
  it("produces one", () => {
    // The task-2 acceptance criterion, exercised end to end on a realistic run shape.
    const tracer = createRecordingTracer({ traceId: "run-42", clock: stepClock(5), pricing: PRICING });

    const run = tracer.startSpan("run", "run", { repo: "acme/repo", sha: "a".repeat(40) });

    // Deterministic stages: no provider, so no usage — and that absence is itself information.
    for (const stage of ["ingest", "orient", "map-structure", "inventory", "connect", "analyze"]) {
      run.child(`stage:${stage}`, "stage").end();
    }

    // The AI stages, with REAL provider usage attributed per span.
    const ragSpan = run.child("stage:rag", "stage", { model: "gemini-flash" });
    ragSpan.child("retrieval:embed", "retrieval").end();
    ragSpan.recordUsage(MEASURED(40_000, 0));
    ragSpan.end();

    const synth = run.child("stage:synthesize", "stage");
    const supervisor = synth.child("supervisor", "agent", { model: "claude-opus" });
    supervisor.recordUsage(MEASURED(8_000, 1_200, 6_000));
    supervisor.end();
    for (let i = 0; i < 3; i++) {
      const specialist = synth.child("specialist:architecture", "agent", { model: "gemini-flash" });
      specialist.recordUsage(MEASURED(2_000, 300));
      specialist.end();
    }
    synth.end();
    run.end();

    const report = tracer.report();

    // COMPLETE: every span ended.
    expect(report.complete).toBe(true);
    expect(report.durationMs).toBeGreaterThan(0);

    // Per-pillar tokens AND dollars, broken out by span kind.
    expect(report.costByKind.stage?.inputTokens).toBe(40_000);
    expect(report.costByKind.agent?.inputTokens).toBe(8_000 + 3 * 2_000);
    expect(report.costByKind.agent?.outputTokens).toBe(1_200 + 3 * 300);
    expect(report.cost.usd).not.toBeNull();
    expect(report.cost.measured).toBe(true);
    expect(report.cost.cacheReadTokens).toBe(6_000);

    // The interaction graph shows the fan-out shape.
    const specialistNode = report.interactions.nodes.find((node) => node.name === "specialist:architecture");
    expect(specialistNode?.calls).toBe(3);
    expect(report.interactions.edges.some((edge) => edge.from === "stage:synthesize" && edge.to === "supervisor")).toBe(true);

    // And it renders as something a human reads.
    const rendered = renderTrace(report);
    expect(rendered).toContain("run-42");
    expect(rendered).toMatch(/cost: \$0\.\d+/);
    expect(rendered).toContain("specialist:architecture");
  });
});

describe("createVersionedBlackboard — replay", () => {
  it("records who wrote what, why, and in order", () => {
    const board = createVersionedBlackboard<{ findings: number }>({ clock: stepClock() });
    expect(board.currentVersion()).toBe(0);
    expect(board.current()).toBeNull();

    board.write({ findings: 1 }, "specialist:security", "first finding");
    board.write({ findings: 2 }, "specialist:architecture", "second finding");

    const report = board.report();
    expect(report.versions.map((version) => version.writer)).toEqual([
      "specialist:security",
      "specialist:architecture",
    ]);
    expect(report.versions[0].reason).toBe("first finding");
    expect(board.currentVersion()).toBe(2);
    expect(board.current()).toEqual({ findings: 2 });
  });

  it("APPEND-ONLY: a writer cannot mutate history through the object it passed in", () => {
    // Without the clone, the log would hold a reference the writer keeps mutating, and "the state at
    // version 1" would silently become "the state now".
    const board = createVersionedBlackboard<{ items: string[] }>({ clock: stepClock() });
    const state = { items: ["a"] };
    board.write(state, "w", "r");
    state.items.push("injected");
    expect(board.at(1)).toEqual({ items: ["a"] });
  });

  it("hands out COPIES on read, so a reader cannot corrupt the log either", () => {
    const board = createVersionedBlackboard<{ items: string[] }>({ clock: stepClock() });
    board.write({ items: ["a"] }, "w", "r");
    const handed = board.read("reader").state;
    handed?.items.push("injected");
    expect(board.at(1)).toEqual({ items: ["a"] });
  });

  it("records READS against the version they saw — what makes a decision explainable", () => {
    // The question is always "what had been written by the time X read it".
    const board = createVersionedBlackboard<{ findings: number }>({ clock: stepClock() });
    board.write({ findings: 1 }, "specialist", "one");
    const first = board.read("supervisor", "took 1 of 1");
    board.write({ findings: 2 }, "specialist", "two");
    const second = board.read("supervisor", "took 2 of 2");

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(board.report().reads.map((entry) => entry.version)).toEqual([1, 2]);
  });

  it("replays the exact state a given version held", () => {
    const board = createVersionedBlackboard<{ findings: number }>({ clock: stepClock() });
    board.write({ findings: 1 }, "w", "r");
    board.write({ findings: 5 }, "w", "r");
    expect(board.at(1)).toEqual({ findings: 1 });
    expect(board.at(2)).toEqual({ findings: 5 });
    expect(board.at(99)).toBeNull();
  });

  it("BOUNDS the log and REPORTS the trim, so a replay that cannot reach back says so", () => {
    // A version log that grows without limit is a memory leak in a long-lived worker; a silent trim
    // would let a replay start mid-run while looking complete.
    const board = createVersionedBlackboard<{ n: number }>({ maxVersions: 3, clock: stepClock() });
    for (let i = 1; i <= 6; i++) board.write({ n: i }, "w", `write ${i}`);
    const report = board.report();
    expect(report.versions.map((version) => version.version)).toEqual([4, 5, 6]);
    expect(report.trimmedBefore).toBe(4);
    expect(report.totalWrites).toBe(6);
    expect(board.at(1)).toBeNull();
    expect(renderBlackboardHistory(report)).toMatch(/versions before 4 were TRIMMED/);
  });

  it("interleaves reads with writes in the rendered history", () => {
    const board = createVersionedBlackboard<{ n: number }>({ clock: stepClock() });
    board.write({ n: 1 }, "specialist", "found something");
    board.read("supervisor", "bounded selection");
    const rendered = renderBlackboardHistory(board.report());
    expect(rendered).toMatch(/v1 @\d+ms by specialist: found something/);
    expect(rendered).toMatch(/↳ read by supervisor \(bounded selection\)/);
  });
});

describe("exporters — must never fail the run they observe", () => {
  function report() {
    const tracer = createRecordingTracer({ traceId: "t", clock: stepClock(), pricing: PRICING });
    const run = tracer.startSpan("run", "run", { model: "gemini-flash" });
    run.recordUsage(MEASURED(100, 10));
    run.addEvent("started");
    run.end();
    return tracer.report();
  }

  it("POSTs a flat, self-describing payload", async () => {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const exporter = createHttpTraceExporter({
      endpoint: "https://example.test/ingest",
      authorization: "Bearer k",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    });
    await exporter.export(report());
    expect(exporter.id).toBe("http:example.test");
    expect(calls[0].headers.authorization).toBe("Bearer k");
    expect(calls[0].body).toMatchObject({ traceId: "t", complete: true });
  });

  it("SWALLOWS a network failure and reports it, rather than throwing into the run", async () => {
    const errors: unknown[] = [];
    const exporter = createHttpTraceExporter({
      endpoint: "https://example.test/ingest",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      onError: (error) => errors.push(error),
    });
    await expect(exporter.export(report())).resolves.toBeUndefined();
    expect(String(errors[0])).toMatch(/ECONNREFUSED/);
  });

  it("reports a non-2xx as an error without throwing", async () => {
    const errors: unknown[] = [];
    const exporter = createHttpTraceExporter({
      endpoint: "https://example.test/ingest",
      fetchImpl: (async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch,
      onError: (error) => errors.push(error),
    });
    await exporter.export(report());
    expect(String(errors[0])).toMatch(/HTTP 503/);
  });

  it("reports missing fetch rather than crashing", async () => {
    const errors: unknown[] = [];
    const exporter = createHttpTraceExporter({
      endpoint: "https://example.test/ingest",
      fetchImpl: undefined as unknown as typeof fetch,
      onError: (error) => errors.push(error),
    });
    // Force the no-fetch branch by removing the global for this call.
    const original = globalThis.fetch;
    // @ts-expect-error — deliberately removing it to exercise the guard.
    delete globalThis.fetch;
    try {
      await exporter.export(report());
    } finally {
      globalThis.fetch = original;
    }
    expect(String(errors[0])).toMatch(/no fetch implementation/);
  });

  it("replays a trace into an INJECTED OTel tracer, parents before children", async () => {
    // Replay rather than live instrumentation keeps the hot path dependency-free and guarantees the
    // exported trace is the one the tests assert on. A child replayed first would be reparented to
    // nothing by most backends.
    const started: string[] = [];
    const ended: string[] = [];
    const tracer = createRecordingTracer({ clock: stepClock(), pricing: PRICING });
    const run = tracer.startSpan("run", "run", { model: "gemini-flash" });
    run.recordUsage(MEASURED(100, 10));
    const child = run.child("stage:connect", "stage");
    child.setStatus("error", "nope");
    child.end();
    run.end();

    const exporter = createOtelReplayExporter({
      epochMs: 1_000_000,
      tracer: {
        startSpan(name: string): OtelSpanLike {
          started.push(name);
          return {
            setAttribute: () => undefined,
            addEvent: () => undefined,
            setStatus: () => undefined,
            end: () => {
              ended.push(name);
            },
          };
        },
      },
    });
    await exporter.export(tracer.report());
    expect(started).toEqual(["run", "stage:connect"]);
    expect(ended).toEqual(["run", "stage:connect"]);
  });

  it("carries usage AND the `measured` flag into OTel attributes", async () => {
    // A cost attribute that dropped the honesty flag would let an estimate be queried as measured.
    const attributes: Record<string, unknown> = {};
    const tracer = createRecordingTracer({ clock: stepClock() });
    const run = tracer.startSpan("run", "run", { model: "gemini-flash" });
    run.recordUsage({ inputTokens: 10, outputTokens: 2, measured: false });
    run.end();
    await createOtelReplayExporter({
      tracer: {
        startSpan(_name, options) {
          Object.assign(attributes, options?.attributes ?? {});
          return { setAttribute: () => undefined, addEvent: () => undefined, setStatus: () => undefined, end: () => undefined };
        },
      },
    }).export(tracer.report());
    expect(attributes["codeflow.tokens.input"]).toBe(10);
    expect(attributes["codeflow.tokens.measured"]).toBe(false);
    expect(attributes["codeflow.kind"]).toBe("run");
  });

  it("an OTel bridge failure is reported, not thrown", async () => {
    const errors: unknown[] = [];
    await createOtelReplayExporter({
      tracer: {
        startSpan(): OtelSpanLike {
          throw new Error("provider not initialised");
        },
      },
      onError: (error) => errors.push(error),
    }).export(report());
    expect(String(errors[0])).toMatch(/not initialised/);
  });

  it("a multi-exporter does not let one failure stop another", async () => {
    // Otherwise adding a second exporter would be a liability.
    const seen: string[] = [];
    const failing: TraceExporter = {
      id: "bad",
      async export() {
        throw new Error("nope");
      },
    };
    const working: TraceExporter = {
      id: "good",
      async export() {
        seen.push("good");
      },
    };
    const multi = createMultiExporter([failing, working]);
    await expect(multi.export(report())).resolves.toBeUndefined();
    expect(seen).toEqual(["good"]);
    expect(multi.id).toBe("multi:bad+good");
  });

  it("exportersFromEnv returns NULL when nothing is configured — which is what 'off in tests' means", async () => {
    // A no-op exporter object would make "observability is on" indistinguishable from
    // "observability is configured".
    expect(exportersFromEnv({})).toBeNull();
    expect(exportersFromEnv({ LANGFUSE_HOST: "https://x" })).toBeNull(); // partial config ⇒ still off
  });

  it("builds a Langfuse exporter from a COMPLETE config, with basic auth", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const exporter = exportersFromEnv(
      { LANGFUSE_HOST: "https://cloud.langfuse.test/", LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" },
      {
        fetchImpl: (async (url: string, init: RequestInit) => {
          calls.push({ url, headers: init.headers as Record<string, string> });
          return { ok: true, status: 200 } as Response;
        }) as unknown as typeof fetch,
      },
    );
    expect(exporter).not.toBeNull();
    await exporter?.export(report());
    expect(calls[0].url).toBe("https://cloud.langfuse.test/api/public/ingestion");
    expect(calls[0].headers.authorization).toMatch(/^Basic /);
  });

  it("builds a Helicone exporter from just its key, and combines both when both are set", () => {
    expect(exportersFromEnv({ HELICONE_API_KEY: "hk" })?.id).toBe("http:api.helicone.ai");
    const both = exportersFromEnv({
      HELICONE_API_KEY: "hk",
      LANGFUSE_HOST: "https://l.test",
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
    });
    expect(both?.id).toMatch(/^multi:/);
  });

  it("toExportPayload omits empty optionals rather than sending nulls", () => {
    const payload = toExportPayload(report());
    const span = (payload.spans as Array<Record<string, unknown>>)[0];
    expect(span).not.toHaveProperty("error");
    expect(span).toHaveProperty("usage");
  });
});

describe("createNoopTracer", () => {
  it("records nothing and never throws", () => {
    // For a call site that must always hold a tracer — threading `tracer?` through a deep chain
    // means every level re-implements the same optional check and one of them gets it wrong.
    const tracer = createNoopTracer();
    const span = tracer.startSpan("x", "run", { a: 1 });
    span.setAttribute("b", 2);
    span.setAttributes({ c: 3 });
    span.addEvent("e");
    span.recordUsage(MEASURED(1, 1));
    span.setStatus("error", "ignored");
    span.child("y", "stage").end();
    span.end();
    expect(tracer.id).toBe("noop-tracer");
  });
});

/** A minimal report shell, for tests that only exercise the renderer's cost line. */
function emptyReport() {
  return {
    traceId: "t",
    spans: [],
    durationMs: 0,
    cost: computeCost([], {}),
    costByKind: {},
    interactions: { nodes: [], edges: [] },
    errors: [],
    complete: true,
  };
}

describe("pricingFromEnv — visibly incomplete beats confidently wrong", () => {
  it("returns an EMPTY table when nothing is configured, so costs report as UNPRICED", () => {
    // Not a default price table: prices change per account and region, and a stale constant reports
    // a confident wrong number where an empty table reports `usd: null` and names the models.
    expect(pricingFromEnv({})).toEqual({});
    expect(pricingFromEnv({ LLM_PRICING: "   " })).toEqual({});
  });

  it("parses a configured table", () => {
    const table = pricingFromEnv({
      LLM_PRICING: JSON.stringify({
        "claude-x": { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
      }),
    });
    expect(table["claude-x"]).toEqual({ inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 });
  });

  it("reports malformed JSON and applies NO prices, rather than a partial table", () => {
    const errors: unknown[] = [];
    expect(pricingFromEnv({ LLM_PRICING: "{not json" }, { onError: (error) => errors.push(error) })).toEqual({});
    expect(String(errors[0])).toMatch(/not valid JSON/);
  });

  it("rejects a non-object blob", () => {
    const errors: unknown[] = [];
    expect(pricingFromEnv({ LLM_PRICING: "[1,2]" }, { onError: (error) => errors.push(error) })).toEqual({});
    expect(String(errors[0])).toMatch(/must be a JSON object/);
  });

  it("SKIPS a model with a non-numeric price instead of charging it zero", () => {
    // Defaulting to 0 would make an unreadable price look free; skipping keeps the model in
    // `unpricedModels`, where a reader can see the gap.
    const errors: unknown[] = [];
    const table = pricingFromEnv(
      { LLM_PRICING: JSON.stringify({ good: { inputPerMillion: 1, outputPerMillion: 2 }, bad: { inputPerMillion: "3" } }) },
      { onError: (error) => errors.push(error) },
    );
    expect(Object.keys(table)).toEqual(["good"]);
    expect(String(errors[0])).toMatch(/"bad"/);
  });

  it("an unpriced model makes usd NULL, not 0 — and names itself", () => {
    // The distinction the whole design turns on: null means "we do not know", zero means "free".
    const cost = computeCost([{ usage: { inputTokens: 1000, outputTokens: 100, measured: true }, model: "unknown-x" }], {});
    expect(cost.usd).toBeNull();
    expect(cost.unpricedModels).toEqual(["unknown-x"]);
    expect(cost.inputTokens).toBe(1000); // tokens are measured either way
  });
});
