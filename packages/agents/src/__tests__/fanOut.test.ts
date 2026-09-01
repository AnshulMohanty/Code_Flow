import { describe, expect, it } from "vitest";
import type { AnalysisResult, BudgetHandle, RepoCluster } from "@codeflow/shared-types";
import {
  complexityOf,
  createGroundingScorer,
  emptyBlackboard,
  mapWithConcurrency,
  planRouting,
  post,
  runFanOut,
  selectForSupervisor,
  summarizeBlackboard,
  SPECIALIST_IDS,
} from "../index.js";
import type { BlackboardEntry, SpecialistFinding } from "../orchestrator/contracts.js";
import { buildSupervisorPrompt, deriveSupervisedSynthesis, fallbackSynthesis } from "../orchestrator/supervisor.js";
import { buildSpecialistTask, groundFindings, parseSpecialistOutput } from "../orchestrator/specialists.js";
import { fixtureResult } from "./fixtures.js";
import { scriptedChat } from "./fixtures.js";

// V3-P4. The brief named four risks; the tests below are organised around them, because each one is
// a distinct, serious failure: an orchestrator whose context grows with worker count (the documented
// failure at 4+ workers), a fan-out that is parallel in name only, an N-times bill paid repo-wide,
// and an agent mutating a deterministic slice.

// ── A repository with several communities, built so complexity genuinely varies ──────

function node(id: string) {
  return { id, path: id, name: id.split("/").pop()!, layer: "source", language: "TypeScript", lines: 20, symbolCount: 2 };
}

function clusteredResult(options: { clusters: number; filesPerCluster?: number; couplingFor?: (id: number) => number } = { clusters: 3 }): AnalysisResult {
  const perCluster = options.filesPerCluster ?? 3;
  const files: string[] = [];
  const clusters: RepoCluster[] = [];
  for (let c = 0; c < options.clusters; c++) {
    const members = Array.from({ length: perCluster }, (_, i) => `src/c${c}/f${i}.ts`);
    files.push(...members);
    const external = options.couplingFor ? options.couplingFor(c) : 0;
    clusters.push({ id: c, files: members, size: members.length, internalWeight: 10, externalWeight: external });
  }
  const nodes = files.map(node);
  const base = fixtureResult();
  return {
    ...base,
    files: nodes,
    graph: {
      nodes,
      edges: [],
      resolution: { resolved: 0, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
      cpgEdges: [],
      routes: [],
      cpg: { treeSitterFiles: nodes.length, fallbackFiles: 0, enriched: true },
    },
    inventory: { symbols: [], entryPoints: [], symbolCount: 0, loc: {} },
    entryPoints: [{ fileId: files[0], reason: "index" }],
    metrics: {
      perFile: [],
      keyFiles: files.slice(0, 3),
      hotspots: [],
      cycles: [],
      summary: { fileCount: nodes.length, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 },
      clusters: {
        algorithm: "louvain",
        seed: 42,
        resolution: 1,
        modularity: 0.4,
        count: clusters.length,
        assignments: clusters.flatMap((cluster) => cluster.files.map((fileId) => ({ fileId, cluster: cluster.id }))),
        clusters,
      },
    },
  };
}

/** A specialist reply citing the first file of each community it is given. */
function findingFor(prompt: string, importance = "medium"): string {
  const match = prompt.match(/## Files in this group \(the ONLY fileIds you may cite\)\n {2}(\S+)/);
  const fileId = match?.[1] ?? "src/c0/f0.ts";
  return JSON.stringify({
    findings: [
      { headline: `something about ${fileId}`, detail: "d".repeat(60), importance, fileIds: [fileId] },
    ],
  });
}

function supervisorReply(fileId: string): string {
  return JSON.stringify({
    summary: "A small repository.",
    readingOrder: [{ fileId, order: 1, reason: "start here" }],
  });
}

/** A chat client that answers specialists with findings and the supervisor with a reading order. */
function fanOutChat(options: { supervisorFile?: string; supervisorReply?: string } = {}) {
  return scriptedChat([
    (prompt) => {
      if (prompt.includes("Specialist findings")) {
        return options.supervisorReply ?? supervisorReply(options.supervisorFile ?? "src/c0/f0.ts");
      }
      return findingFor(prompt);
    },
  ]);
}

describe("RISK (b): orchestrator context does NOT grow with worker count", () => {
  it("the supervisor's prompt has the SAME ceiling for 3 communities and for 60", async () => {
    // The documented failure at 4+ workers, avoided structurally rather than hopefully: every
    // finding is individually bounded and the supervisor reads at most SUPERVISOR_MAX_FINDINGS of
    // them, so its input is a function of the CAP and of nothing else.
    const small = clusteredResult({ clusters: 3 });
    const large = clusteredResult({ clusters: 60 });

    const smallRun = await runFanOut({ result: small, chatClient: fanOutChat(), maxCommunities: 3 });
    const largeRun = await runFanOut({ result: large, chatClient: fanOutChat(), maxCommunities: 60 });

    // 60 communities x 5 specialists = 300 findings vs 15 — and the same supervisor prompt size.
    expect(largeRun.blackboard.findings.length).toBeGreaterThan(smallRun.blackboard.findings.length * 5);
    expect(largeRun.supervisorContext.total).toBeLessThanOrEqual(smallRun.supervisorContext.total * 1.35);
  });

  it("selectForSupervisor caps the findings it hands over", () => {
    let board = emptyBlackboard();
    for (let cluster = 0; cluster < 40; cluster++) {
      board = post(board, entry(cluster, "architecture", [finding(cluster, "architecture", "high")]));
    }
    expect(board.findings).toHaveLength(40);
    expect(selectForSupervisor(board, 12)).toHaveLength(12);
  });

  it("selects ROUND-ROBIN across communities, so one loud community cannot eat the cap", () => {
    // A plain importance sort would let one pathological community consume the whole cap, and the
    // supervisor would then synthesise one corner of the repository while believing it had seen the
    // whole blackboard. Breadth first, depth second.
    let board = emptyBlackboard();
    for (const specialist of SPECIALIST_IDS) {
      board = post(board, entry(0, specialist, [finding(0, specialist, "high")]));
    }
    board = post(board, entry(1, "architecture", [finding(1, "architecture", "high")]));
    board = post(board, entry(2, "architecture", [finding(2, "architecture", "high")]));

    const selected = selectForSupervisor(board, 3);
    expect(new Set(selected.map((entry) => entry.cluster))).toEqual(new Set([0, 1, 2]));
  });

  it("still prefers HIGH importance within the round-robin", () => {
    let board = emptyBlackboard();
    board = post(board, entry(0, "architecture", [finding(0, "architecture", "low")]));
    board = post(board, entry(1, "architecture", [finding(1, "architecture", "high")]));
    expect(selectForSupervisor(board, 2)[0].importance).toBe("high");
  });

  it("is deterministic and handles the degenerate caps", () => {
    let board = emptyBlackboard();
    board = post(board, entry(0, "architecture", [finding(0, "architecture", "high")]));
    expect(selectForSupervisor(board, 5)).toEqual(selectForSupervisor(board, 5));
    expect(selectForSupervisor(board, 0)).toEqual([]);
    expect(selectForSupervisor(emptyBlackboard(), 5)).toEqual([]);
  });

  it("keeps the FULL finding list for the report, bounding only the prompt", () => {
    // Losing the record would trade one problem for a worse one.
    let board = emptyBlackboard();
    for (let cluster = 0; cluster < 30; cluster++) {
      board = post(board, entry(cluster, "security", [finding(cluster, "security", "medium")]));
    }
    expect(board.findings).toHaveLength(30);
    expect(summarizeBlackboard(board).findings).toBe(30);
  });
});

describe("RISK: fan-out must be GENUINELY parallel", () => {
  it("observes several specialist calls in flight at once", async () => {
    // A counter, not a stopwatch: a wall-clock comparison is flaky on a loaded machine and can pass
    // by accident, whereas peak concurrency 5 means five calls were genuinely simultaneous.
    const result = clusteredResult({ clusters: 3 });
    const run = await runFanOut({ result, chatClient: slowChat(15), maxConcurrency: 5 });
    expect(run.peakConcurrency).toBe(5);
  });

  it("respects the concurrency cap", async () => {
    // Provider rate limits and peak memory are real, so the cap is not decoration.
    const result = clusteredResult({ clusters: 4 });
    const run = await runFanOut({ result, chatClient: slowChat(5), maxConcurrency: 2 });
    expect(run.peakConcurrency).toBeLessThanOrEqual(2);
    expect(run.peakConcurrency).toBe(2);
  });

  it("is faster than sequential in wall-clock (the number a reader wants)", async () => {
    // Reported with a generous margin because it IS timing-dependent; the concurrency counter above
    // is what actually gates.
    const result = clusteredResult({ clusters: 2 });
    const delay = 20;
    const jobs = 2 * SPECIALIST_IDS.length;

    const parallelStart = Date.now();
    await runFanOut({ result, chatClient: slowChat(delay), maxConcurrency: 5 });
    const parallelMs = Date.now() - parallelStart;

    const serialStart = Date.now();
    await runFanOut({ result, chatClient: slowChat(delay), maxConcurrency: 1 });
    const serialMs = Date.now() - serialStart;

    expect(serialMs).toBeGreaterThan(jobs * delay * 0.5);
    expect(parallelMs).toBeLessThan(serialMs);
  });

  it("mapWithConcurrency uses a worker POOL, not fixed batches", async () => {
    // Batching would idle the whole pool waiting for one slow call per batch, which on a provider
    // with variable latency throws away most of the saving.
    //
    // Proven with a HELD PROMISE rather than with sleeps. A first draft used `setTimeout(30)` for
    // the slow item against five `setTimeout(1)` fast ones and was flaky: Windows clamps short
    // timers, so five "1ms" waits can exceed 30ms and the slow item finishes first. Gating on an
    // explicitly-resolved promise removes timing from the assertion entirely.
    let releaseSlow!: () => void;
    const slowHeld = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const finished: number[] = [];
    let inFlight = 0;
    let peak = 0;

    const running = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (item === 0) await slowHeld;
      finished.push(item);
      inFlight -= 1;
    });

    // Drain the microtask queue: with the slow item held, a POOL lets the second worker take every
    // remaining item, whereas a batching implementation would be stuck at [1] waiting for [0].
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(finished).toEqual([1, 2, 3, 4, 5]);

    releaseSlow();
    await running;
    expect(finished).toEqual([1, 2, 3, 4, 5, 0]);
    expect(peak).toBe(2);
  });

  it("never exceeds the item count in runners", async () => {
    let calls = 0;
    await mapWithConcurrency([1], 10, async () => {
      calls += 1;
    });
    expect(calls).toBe(1);
    await mapWithConcurrency([], 10, async () => {
      calls += 1;
    });
    expect(calls).toBe(1);
  });
});

describe("RISK (c): N-times cost only on the routed-hard tail", () => {
  it("pays ONE call per specialist on an easy repository", async () => {
    const result = clusteredResult({ clusters: 2 });
    const run = await runFanOut({ result, chatClient: fanOutChat(), hardThreshold: 0.99 });
    expect(run.specialistCalls).toBe(2 * SPECIALIST_IDS.length);
    expect(run.bestOfNExtraCalls).toBe(0);
    expect(run.routes.every((route) => route.difficulty === "easy")).toBe(true);
  });

  it("pays N times ONLY on the communities routed hard, and reports the extra", async () => {
    const result = clusteredResult({ clusters: 3, filesPerCluster: 20, couplingFor: (id) => (id === 0 ? 40 : 0) });
    const run = await runFanOut({ result, chatClient: fanOutChat(), hardThreshold: 0.5, samples: 3, maxHardCommunities: 1 });

    const hard = run.routes.filter((route) => route.difficulty === "hard");
    expect(hard).toHaveLength(1);
    // 3 communities x 5 specialists = 15 base calls, plus 2 extra samples on the hard one's 5.
    expect(run.bestOfNExtraCalls).toBe(2 * SPECIALIST_IDS.length);
    expect(run.specialistCalls).toBe(15 + run.bestOfNExtraCalls);
  });

  it("CEILINGS how many communities may route hard, whatever the repository looks like", async () => {
    // The ceiling on the N-times bill per run. Without it a pathological repo would route
    // everything hard and multiply the entire cost.
    const result = clusteredResult({ clusters: 6, filesPerCluster: 20, couplingFor: () => 40 });
    const run = await runFanOut({ result, chatClient: fanOutChat(), hardThreshold: 0.3, samples: 3, maxHardCommunities: 2 });
    expect(run.routes.filter((route) => route.difficulty === "hard")).toHaveLength(2);
    // The ones that qualified but missed the ceiling SAY so, rather than looking easy.
    const missed = run.routes.filter((route) => route.difficulty === "easy" && route.complexity >= 0.3);
    expect(missed.length).toBeGreaterThan(0);
    expect(missed[0].reason).toMatch(/ceiling/);
  });

  it("stops sampling as soon as a specialist REFUSES", async () => {
    // Further samples would be paying to talk a specialist out of a correct "nothing here".
    const result = clusteredResult({ clusters: 1, filesPerCluster: 20, couplingFor: () => 40 });
    const chat = scriptedChat([
      (prompt) =>
        prompt.includes("Specialist findings")
          ? supervisorReply("src/c0/f0.ts")
          : JSON.stringify({ refused: true, reason: "nothing in my lens here" }),
    ]);
    const run = await runFanOut({ result, chatClient: chat, hardThreshold: 0.1, samples: 3 });
    expect(run.specialistCalls).toBe(SPECIALIST_IDS.length); // one each, not three
    expect(run.bestOfNExtraCalls).toBe(0);
    expect(run.blackboard.entries.every((entry) => entry.status === "refused")).toBe(true);
  });

  it("keeps the BEST-scoring trajectory and records its score", async () => {
    // The scorer is exact and free — a judge per candidate on top of an N-times bill would make
    // best-of-N unaffordable, and a varying scorer would make the winner unreproducible.
    const result = clusteredResult({ clusters: 1, filesPerCluster: 20, couplingFor: () => 40 });
    let call = 0;
    const chat = scriptedChat([
      (prompt) => {
        if (prompt.includes("Specialist findings")) return supervisorReply("src/c0/f0.ts");
        call += 1;
        // Every third reply cites TWO files (better coverage ⇒ a higher exact score).
        const two = call % 3 === 0;
        return JSON.stringify({
          findings: [
            {
              headline: two ? "broad" : "narrow",
              detail: "d".repeat(60),
              importance: "medium",
              fileIds: two ? ["src/c0/f0.ts", "src/c0/f1.ts"] : ["src/c0/f0.ts"],
            },
          ],
        });
      },
    ]);
    const run = await runFanOut({ result, chatClient: chat, hardThreshold: 0.1, samples: 3 });
    const ok = run.blackboard.entries.filter((entry) => entry.status === "ok");
    expect(ok.length).toBeGreaterThan(0);
    for (const entry of ok) {
      expect(entry.samples).toBe(3);
      expect(entry.bestScore).toBeGreaterThan(0);
    }
    // At least one specialist kept the broader (better-scoring) trajectory.
    expect(run.blackboard.findings.some((f) => f.headline === "broad")).toBe(true);
  });
});

describe("complexityOf + planRouting", () => {
  const result = clusteredResult({ clusters: 1 });

  it("scores a larger, more coupled community higher", () => {
    const small = complexityOf({ id: 0, files: ["a.ts"], size: 1, internalWeight: 10, externalWeight: 0 }, result);
    const big = complexityOf(
      { id: 1, files: Array.from({ length: 20 }, (_, i) => `f${i}.ts`), size: 20, internalWeight: 5, externalWeight: 40 },
      result,
    );
    expect(big.score).toBeGreaterThan(small.score);
  });

  it("scores an EDGELESS community 0 on coupling rather than calling it perfectly cohesive", () => {
    // Dividing by zero and naming the result cohesion would be inventing a signal from missing data.
    const scored = complexityOf({ id: 0, files: ["a.ts"], size: 1, internalWeight: 0, externalWeight: 0 }, result);
    expect(scored.signals.coupling).toBe(0);
  });

  it("clamps every signal, so one outlier cannot dominate", () => {
    const huge = complexityOf(
      { id: 0, files: Array.from({ length: 5000 }, (_, i) => `f${i}.ts`), size: 5000, internalWeight: 1, externalWeight: 1 },
      result,
    );
    expect(huge.signals.size).toBe(1);
    expect(huge.score).toBeLessThanOrEqual(1);
  });

  it("names the DOMINANT signal, so a routing decision can be argued with", () => {
    const coupled = complexityOf({ id: 0, files: ["a.ts"], size: 1, internalWeight: 1, externalWeight: 99 }, result);
    expect(coupled.reason).toMatch(/dominant signal: coupling/);
  });

  it("counts cycles through the community", () => {
    const withCycle = clusteredResult({ clusters: 1 });
    withCycle.metrics!.cycles = [{ files: ["src/c0/f0.ts", "src/c0/f1.ts"] }];
    const scored = complexityOf(withCycle.metrics!.clusters!.clusters[0], withCycle);
    expect(scored.signals.cycles).toBeGreaterThan(0);
  });

  it("orders the plan complexity-descending and REPORTS what it dropped", () => {
    const many = clusteredResult({ clusters: 5, filesPerCluster: 4, couplingFor: (id) => id * 10 });
    const plan = planRouting(many.metrics!.clusters!.clusters, many, { maxCommunities: 2 });
    expect(plan.routes).toHaveLength(2);
    expect(plan.routes[0].complexity).toBeGreaterThanOrEqual(plan.routes[1].complexity);
    expect(plan.skippedClusters).toHaveLength(3);
  });

  it("is deterministic", () => {
    const many = clusteredResult({ clusters: 5, couplingFor: (id) => id * 7 });
    const args = [many.metrics!.clusters!.clusters, many] as const;
    expect(JSON.stringify(planRouting(...args))).toBe(JSON.stringify(planRouting(...args)));
  });
});

describe("the specialist PHASE GATE (task 2)", () => {
  const result = clusteredResult({ clusters: 2 });
  const cluster = result.metrics!.clusters!.clusters[0];

  it("INPUT SAFETY: a specialist sees only its own community's files, bounded and sorted", () => {
    const task = buildSpecialistTask("security", cluster, result, 2);
    expect(task.fileIds).toHaveLength(2);
    expect(task.fileIds).toEqual([...task.fileIds].sort());
    for (const fileId of task.fileIds) expect(cluster.files).toContain(fileId);
  });

  it("SCHEMA: rejects rather than coerces", () => {
    // A headline coerced to "" reaches the supervisor as an empty bullet that looks like a fact; a
    // non-array fileIds coerced to [] silently turns a grounded finding into an ungrounded one.
    expect(parseSpecialistOutput("not json")).toEqual({ error: expect.stringContaining("not valid JSON") });
    expect(parseSpecialistOutput('{"findings":[{"detail":"d","fileIds":[]}]}')).toEqual({
      error: expect.stringContaining("headline"),
    });
    expect(parseSpecialistOutput('{"findings":[{"headline":"h","fileIds":"a.ts"}]}')).toEqual({
      error: expect.stringContaining("fileIds"),
    });
    expect(parseSpecialistOutput('{"summary":"no findings key"}')).toEqual({
      error: expect.stringContaining("no `findings` array"),
    });
  });

  it("SCHEMA: treats an empty findings array as a refusal, so callers need one path", () => {
    expect(parseSpecialistOutput('{"findings":[]}')).toMatchObject({ refused: true, reason: "returned no findings" });
  });

  it("SCHEMA: an absent importance defaults to medium, not high", () => {
    // Defaulting upward would let every finding crowd the supervisor's cap.
    const parsed = parseSpecialistOutput('{"findings":[{"headline":"h","detail":"d","fileIds":["a.ts"]}]}');
    expect("error" in parsed ? null : parsed.findings[0].importance).toBe("medium");
  });

  it("SCHEMA: never throws", () => {
    for (const input of ["", "{", "[]", "null", '{"refused":true}', "```json\n{}\n```"]) {
      expect(() => parseSpecialistOutput(input)).not.toThrow();
    }
  });

  it("GROUNDING: to THIS community's files, which is stricter than 'in the graph'", () => {
    // A specialist on community 0 citing a file from community 1 has wandered outside its evidence,
    // and accepting it would let the fan-out produce overlapping, unattributable claims.
    const task = buildSpecialistTask("architecture", cluster, result);
    const otherCommunityFile = result.metrics!.clusters!.clusters[1].files[0];
    const grounded = groundFindings(
      {
        refused: false,
        findings: [
          { headline: "h", detail: "d", importance: "high", fileIds: [task.fileIds[0], otherCommunityFile, "src/ghost.ts"] },
        ],
      },
      task,
    );
    expect(grounded.findings[0].fileIds).toEqual([task.fileIds[0]]);
    expect(grounded.droppedFileIds).toEqual([otherCommunityFile, "src/ghost.ts"].sort());
  });

  it("GROUNDING: drops a finding left with NO grounded files entirely", () => {
    // An ungrounded claim is not a weaker finding, it is an unattributable one.
    const task = buildSpecialistTask("architecture", cluster, result);
    const grounded = groundFindings(
      { refused: false, findings: [{ headline: "h", detail: "d", importance: "high", fileIds: ["src/ghost.ts"] }] },
      task,
    );
    expect(grounded.findings).toEqual([]);
  });

  it("GROUNDING: bounds detail and caps findings, importance-first", () => {
    const task = buildSpecialistTask("architecture", cluster, result);
    const grounded = groundFindings(
      {
        refused: false,
        findings: [
          { headline: "low", detail: "x".repeat(9_000), importance: "low", fileIds: [task.fileIds[0]] },
          { headline: "high", detail: "d", importance: "high", fileIds: [task.fileIds[0]] },
        ],
      },
      task,
      { maxFindings: 1, maxDetailChars: 50 },
    );
    expect(grounded.findings).toHaveLength(1);
    expect(grounded.findings[0].headline).toBe("high");

    const long = groundFindings(
      { refused: false, findings: [{ headline: "h", detail: "x".repeat(9_000), importance: "low", fileIds: [task.fileIds[0]] }] },
      task,
      { maxDetailChars: 50 },
    );
    expect(long.findings[0].detail).toHaveLength(50);
  });

  it("BUDGET: exhaustion SKIPS the remaining specialists instead of failing the run", async () => {
    // Four lenses are worth more than none.
    let allowed = 3;
    const budget: BudgetHandle = {
      async check() {
        return allowed-- > 0;
      },
      async record() {},
    };
    const result2 = clusteredResult({ clusters: 2 });
    const run = await runFanOut({ result: result2, chatClient: fanOutChat(), budget });
    const skipped = run.blackboard.entries.filter((entry) => entry.status === "skipped-budget");
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0].reason).toMatch(/budget/);
    // The run still produced a synthesis, from the lenses that did run.
    expect(run.synthesis.readingOrder.length).toBeGreaterThan(0);
    expect(run.warnings.join(" ")).toMatch(/supervisor step was skipped/);
  });

  it("REFUSAL is a first-class outcome with a reason, not a failure", async () => {
    const result2 = clusteredResult({ clusters: 1 });
    const chat = scriptedChat([
      (prompt) =>
        prompt.includes("Specialist findings")
          ? supervisorReply("src/c0/f0.ts")
          : JSON.stringify({ refused: true, reason: "no trust boundary in these files" }),
    ]);
    const run = await runFanOut({ result: result2, chatClient: chat });
    expect(run.blackboard.entries.every((entry) => entry.status === "refused")).toBe(true);
    expect(run.blackboard.entries[0].reason).toBe("no trust boundary in these files");
    // Refusals still produce an answer, because the supervisor and the graph facts remain.
    expect(run.synthesis.readingOrder.length).toBeGreaterThan(0);
  });

  it("a FAILED specialist is a recorded entry, not a failed run", async () => {
    const result2 = clusteredResult({ clusters: 1 });
    const chat = scriptedChat([
      (prompt) => (prompt.includes("Specialist findings") ? supervisorReply("src/c0/f0.ts") : "total nonsense"),
    ]);
    const run = await runFanOut({ result: result2, chatClient: chat });
    expect(run.blackboard.entries.every((entry) => entry.status === "failed")).toBe(true);
    expect(run.synthesis.readingOrder.length).toBeGreaterThan(0);
  });
});

describe("the supervisor", () => {
  const result = clusteredResult({ clusters: 2 });
  const nodeIds = new Set(result.graph!.nodes.map((node) => node.id));

  it("GROUNDS the reading order, drops and counts, and renumbers", () => {
    // The invariant this phase must not weaken — the same rule the single-shot path applied.
    const synthesis = deriveSupervisedSynthesis(
      JSON.stringify({
        summary: "s",
        readingOrder: [
          { fileId: "src/ghost.ts", order: 1, reason: "invented" },
          { fileId: "src/c0/f1.ts", order: 5, reason: "real" },
          { fileId: "src/c0/f0.ts", order: 9, reason: "real" },
        ],
      }),
      nodeIds,
    );
    expect(synthesis.readingOrder.map((step) => step.fileId)).toEqual(["src/c0/f1.ts", "src/c0/f0.ts"]);
    expect(synthesis.readingOrder.map((step) => step.order)).toEqual([1, 2]);
    expect(synthesis.droppedCitations).toBe(1);
  });

  it("dedupes a repeated file, which is the same advice twice", () => {
    const synthesis = deriveSupervisedSynthesis(
      JSON.stringify({
        summary: "s",
        readingOrder: [
          { fileId: "src/c0/f0.ts", order: 1, reason: "a" },
          { fileId: "src/c0/f0.ts", order: 2, reason: "b" },
        ],
      }),
      nodeIds,
    );
    expect(synthesis.readingOrder).toHaveLength(1);
  });

  it("REJECTS an entirely ungrounded synthesis, same contract as the single-shot path", () => {
    expect(() =>
      deriveSupervisedSynthesis(
        JSON.stringify({ summary: "s", readingOrder: [{ fileId: "src/ghost.ts", order: 1, reason: "r" }] }),
        nodeIds,
      ),
    ).toThrow(/no grounded reading steps/);
  });

  it("validates the schema at the parsed-LLM-JSON boundary", () => {
    expect(() => deriveSupervisedSynthesis("nope", nodeIds)).toThrow(/not valid JSON/);
    expect(() => deriveSupervisedSynthesis(JSON.stringify({ readingOrder: [] }), nodeIds)).toThrow(/summary/);
    expect(() => deriveSupervisedSynthesis(JSON.stringify({ summary: "s" }), nodeIds)).toThrow(/readingOrder/);
    expect(() =>
      deriveSupervisedSynthesis(JSON.stringify({ summary: "s", readingOrder: [{ fileId: "src/c0/f0.ts", order: 1, reason: "r" }], keyConcepts: [1] }), nodeIds),
    ).toThrow(/keyConcepts/);
  });

  it("caps the reading order", () => {
    const synthesis = deriveSupervisedSynthesis(
      JSON.stringify({
        summary: "s",
        readingOrder: result.graph!.nodes.map((node, i) => ({ fileId: node.id, order: i + 1, reason: "r" })),
      }),
      nodeIds,
      2,
    );
    expect(synthesis.readingOrder).toHaveLength(2);
  });

  it("sees findings + deterministic facts, and NEVER a transcript", () => {
    let board = emptyBlackboard();
    board = post(board, entry(0, "architecture", [finding(0, "architecture", "high")]));
    const built = buildSupervisorPrompt(board, result);
    expect(built.prompt).toContain("Deterministic repository facts");
    expect(built.prompt).toContain("entry points:");
    expect(built.prompt).toContain("Specialist findings");
    expect(built.prompt).not.toContain("thought:");
    expect(built.context.total).toBeGreaterThan(0);
  });

  it("says how many findings it was shown OF how many exist", () => {
    // So a reader can tell a complete picture from a capped one.
    let board = emptyBlackboard();
    for (let cluster = 0; cluster < 20; cluster++) {
      board = post(board, entry(cluster, "architecture", [finding(cluster, "architecture", "medium")]));
    }
    const built = buildSupervisorPrompt(board, result, { maxFindings: 4 });
    expect(built.prompt).toContain("(4 of 20,");
    expect(built.shown).toHaveLength(4);
  });
});

describe("the deterministic fallback", () => {
  const result = clusteredResult({ clusters: 2 });

  it("produces a grounded reading order with NO model", () => {
    // A fan-out that spent five specialist calls and then returned nothing would be strictly worse
    // than the single call it replaced.
    let board = emptyBlackboard();
    board = post(board, entry(0, "security", [finding(0, "security", "high")]));
    const synthesis = fallbackSynthesis(board, result);
    expect(synthesis.readingOrder.length).toBeGreaterThan(0);
    const nodeIds = new Set(result.graph!.nodes.map((node) => node.id));
    for (const step of synthesis.readingOrder) expect(nodeIds.has(step.fileId)).toBe(true);
  });

  it("is HONEST about being a fallback, so nobody mistakes it for a synthesis", () => {
    expect(fallbackSynthesis(emptyBlackboard(), result).summary).toMatch(/WITHOUT a supervisor synthesis/);
  });

  it("puts entry points first, then specialist findings, then centrality", () => {
    let board = emptyBlackboard();
    board = post(board, entry(1, "security", [{ ...finding(1, "security", "high"), fileIds: ["src/c1/f0.ts"] }]));
    const synthesis = fallbackSynthesis(board, result);
    expect(synthesis.readingOrder[0].fileId).toBe(result.entryPoints![0].fileId);
    expect(synthesis.readingOrder.map((step) => step.fileId)).toContain("src/c1/f0.ts");
  });

  it("is used when the supervisor fails, and the failure is REPORTED", async () => {
    const result2 = clusteredResult({ clusters: 1 });
    const chat = scriptedChat([(prompt) => (prompt.includes("Specialist findings") ? "unparseable" : findingFor(prompt))]);
    const run = await runFanOut({ result: result2, chatClient: chat });
    expect(run.supervised).toBe(false);
    expect(run.warnings.join(" ")).toMatch(/supervisor step failed/);
    expect(run.synthesis.readingOrder.length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    let board = emptyBlackboard();
    board = post(board, entry(0, "security", [finding(0, "security", "high")]));
    expect(JSON.stringify(fallbackSynthesis(board, result))).toBe(JSON.stringify(fallbackSynthesis(board, result)));
  });
});

describe("RISK (d): agents never mutate a deterministic slice", () => {
  it("a fan-out leaves the graph, metrics and communities byte-identical", async () => {
    // Agents are AI LEAVES. The spine is computed before any agent runs and is read-only to all of
    // them, so this is a property of the design — asserted rather than assumed.
    const result = clusteredResult({ clusters: 3 });
    const before = JSON.stringify({ graph: result.graph, metrics: result.metrics, files: result.files });
    await runFanOut({ result, chatClient: fanOutChat() });
    expect(JSON.stringify({ graph: result.graph, metrics: result.metrics, files: result.files })).toBe(before);
  });

  it("the ROUTING is deterministic even though the specialists are not", async () => {
    const result = clusteredResult({ clusters: 4, couplingFor: (id) => id * 9 });
    const a = await runFanOut({ result, chatClient: fanOutChat() });
    const b = await runFanOut({ result, chatClient: fanOutChat() });
    expect(JSON.stringify(a.routes)).toBe(JSON.stringify(b.routes));
    expect(a.skippedClusters).toEqual(b.skippedClusters);
  });

  it("the blackboard is ordered deterministically despite concurrent writes", async () => {
    // Otherwise entry ORDER would depend on scheduling and the run would stop being reproducible
    // for a reason unrelated to the models.
    const result = clusteredResult({ clusters: 3 });
    const a = await runFanOut({ result, chatClient: fanOutChat(), maxConcurrency: 5 });
    const b = await runFanOut({ result, chatClient: fanOutChat(), maxConcurrency: 5 });
    const key = (run: typeof a) => run.blackboard.entries.map((entry) => `${entry.cluster}:${entry.specialist}`).join("|");
    expect(key(a)).toBe(key(b));
  });
});

describe("runFanOut — edges", () => {
  it("falls back honestly when there are NO communities", async () => {
    const result = clusteredResult({ clusters: 1 });
    result.metrics!.clusters = undefined;
    const run = await runFanOut({ result, chatClient: fanOutChat() });
    expect(run.specialistCalls).toBe(0);
    expect(run.supervised).toBe(false);
    expect(run.warnings.join(" ")).toMatch(/nothing to fan out over/);
    expect(run.synthesis.readingOrder.length).toBeGreaterThan(0);
  });

  it("REPORTS the communities it did not analyse", async () => {
    // A silent cap reads as "covered everything".
    const result = clusteredResult({ clusters: 5 });
    const run = await runFanOut({ result, chatClient: fanOutChat(), maxCommunities: 2 });
    expect(run.skippedClusters).toHaveLength(3);
    expect(run.warnings.join(" ")).toMatch(/3 of 5 communities were not analysed/);
  });

  it("summarizeBlackboard names communities that produced nothing", () => {
    let board = emptyBlackboard();
    board = post(board, entry(0, "architecture", [finding(0, "architecture", "high")]));
    board = post(board, { ...entry(1, "architecture", []), status: "refused", reason: "none" });
    expect(summarizeBlackboard(board).silentClusters).toEqual([1]);
  });
});

describe("createGroundingScorer", () => {
  const result = clusteredResult({ clusters: 1, filesPerCluster: 4 });
  const task = buildSpecialistTask("architecture", result.metrics!.clusters!.clusters[0], result);
  const score = createGroundingScorer();

  it("scores 0 for no findings", () => {
    expect(score([], task)).toBe(0);
  });

  it("rewards GROUNDING most heavily", () => {
    const grounded = score([{ ...finding(0, "architecture", "high"), fileIds: [task.fileIds[0]] }], task);
    const ungrounded = score([{ ...finding(0, "architecture", "high"), fileIds: ["src/ghost.ts"] }], task);
    expect(grounded).toBeGreaterThan(ungrounded);
  });

  it("rewards broader COVERAGE of the community", () => {
    const narrow = score([{ ...finding(0, "architecture", "high"), fileIds: [task.fileIds[0]] }], task);
    const broad = score([{ ...finding(0, "architecture", "high"), fileIds: task.fileIds }], task);
    expect(broad).toBeGreaterThan(narrow);
  });

  it("caps SUBSTANCE rather than rewarding length linearly — length is not insight", () => {
    const short = score([{ ...finding(0, "architecture", "high"), detail: "x".repeat(50), fileIds: task.fileIds }], task);
    const long = score([{ ...finding(0, "architecture", "high"), detail: "x".repeat(5_000), fileIds: task.fileIds }], task);
    expect(long).toBe(short);
  });

  it("is deterministic and free (no model, no I/O)", () => {
    const findings = [{ ...finding(0, "architecture", "high"), fileIds: task.fileIds }];
    expect(score(findings, task)).toBe(score(findings, task));
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

function finding(cluster: number, specialist: SpecialistFinding["specialist"], importance: SpecialistFinding["importance"]): SpecialistFinding {
  return {
    specialist,
    cluster,
    headline: `${specialist} finding in ${cluster}`,
    detail: "d".repeat(60),
    importance,
    fileIds: [`src/c${cluster}/f0.ts`],
  };
}

function entry(cluster: number, specialist: SpecialistFinding["specialist"], findings: SpecialistFinding[]): BlackboardEntry {
  return { specialist, cluster, status: "ok", findings, droppedFileIds: [], samples: 1 };
}

/** A chat client with a real (small) delay, for the concurrency probe. */
function slowChat(ms: number) {
  return scriptedChat([
    async (prompt: string) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return prompt.includes("Specialist findings") ? supervisorReply("src/c0/f0.ts") : findingFor(prompt);
    },
  ]);
}

// ── V3-P5 task 6: the fan-out consolidates its own findings before they are lost ──────

describe("consolidated knowledge base (V3-P5 task 6)", () => {
  it("is produced by every fan-out run, because the BLACKBOARD is never persisted", () => {
    // The findings exist only for the duration of the run: the supervisor reads a bounded selection
    // and the rest is paid for and discarded. Inside the run is the only point at which all of them
    // are still in hand.
    return runFanOut({ result: clusteredResult({ clusters: 3 }), chatClient: fanOutChat(), capturedAt: "2026-03-01T00:00:00.000Z" }).then(
      (run) => {
        expect(run.knowledgeBase).toBeDefined();
        expect(run.knowledgeBase.capturedAt).toBe("2026-03-01T00:00:00.000Z");
        expect(run.knowledgeBase.reduction.findingsIn).toBe(run.blackboard.findings.length);
      },
    );
  });

  it("is still produced with NO communities, from deterministic graph facts alone", async () => {
    // Otherwise "no communities" would be indistinguishable from "consolidation failed".
    const single = clusteredResult({ clusters: 0 });
    const run = await runFanOut({ result: single, chatClient: fanOutChat(), capturedAt: "2026-03-01T00:00:00.000Z" });
    expect(run.knowledgeBase).toBeDefined();
    expect(run.knowledgeBase.communities).toEqual([]);
    // The FAQ still answers something, because the graph facts do not need an agent.
    expect(run.knowledgeBase.faq.length).toBeGreaterThan(0);
  });

  it("uses a FIXED sentinel timestamp when none is supplied, keeping a run reproducible", async () => {
    // `new Date()` here would silently make every KB differ, which is the property the whole
    // extractive design exists to preserve.
    const run = await runFanOut({ result: clusteredResult({ clusters: 2 }), chatClient: fanOutChat() });
    expect(run.knowledgeBase.capturedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("is COMPACT relative to the blackboard it came from", async () => {
    const run = await runFanOut({ result: clusteredResult({ clusters: 4 }), chatClient: fanOutChat(), capturedAt: "2026-03-01T00:00:00.000Z" });
    const blackboardBytes = Buffer.byteLength(JSON.stringify(run.blackboard), "utf8");
    // Not a fixed ratio — that would depend on the fixture. The claim is that consolidation reduces,
    // and the KB carries its own measurement so the claim is checkable rather than asserted.
    expect(run.knowledgeBase.reduction.jsonBytes).toBeLessThan(blackboardBytes);
  });
});

// ── V3-P5 task 2e: the VERSIONED BLACKBOARD, on the live fan-out path (wired V3-FINAL) ──
//
// `createVersionedBlackboard` shipped in V3-P5 with a full test suite and ZERO production call
// sites: the fan-out kept folding an unversioned immutable value, so "what did the supervisor
// actually see?" stayed unanswerable in production while being answerable in a unit test. These
// assertions are specifically about the LIVE path — that a real `runFanOut` produces a version log,
// that the supervisor's read is recorded against a version that still exists, and that replaying
// that version returns the board the supervisor was shown rather than the fuller final one.

describe("versioned blackboard — replay on the LIVE fan-out path", () => {
  it("produces a version log from a real run, not an empty one", async () => {
    const run = await runFanOut({ result: clusteredResult({ clusters: 2 }), chatClient: fanOutChat() });
    // 2 communities x 5 specialists = 10 posted entries, plus the opening empty state.
    expect(run.blackboardHistory.totalWrites).toBe(11);
    expect(run.blackboardHistory.versions[0].writer).toBe("orchestrator");
    expect(run.blackboardHistory.versions[0].state.findings).toEqual([]);
  });

  it("names the WRITER of every version as the specialist and community that posted it", async () => {
    const run = await runFanOut({ result: clusteredResult({ clusters: 2 }), chatClient: fanOutChat() });
    const writers = run.blackboardHistory.versions.slice(1).map((version) => version.writer);
    // A version log whose writer was "the orchestrator" throughout would be a log nobody can use to
    // attribute a claim.
    expect(writers).toContain("architecture@c0");
    expect(writers).toContain("architecture@c1");
    expect(new Set(writers).size).toBe(10);
  });

  it("records the SUPERVISOR's read, with what it was shown", async () => {
    const run = await runFanOut({ result: clusteredResult({ clusters: 3 }), chatClient: fanOutChat() });
    const read = run.blackboardHistory.reads.find((entry) => entry.reader === "supervisor");
    expect(read).toBeDefined();
    // The note is the whole point: "shown 12 of 15" is the fact a replay needs, and it does not
    // exist anywhere else once the run ends.
    expect(read?.note).toMatch(/^shown \d+ of \d+ finding\(s\), \d+ prompt token\(s\)$/);
    expect(read?.version).toBe(run.blackboardHistory.totalWrites);
  });

  it("REPLAYS the exact board the supervisor read — not the fuller final one", async () => {
    const run = await runFanOut({ result: clusteredResult({ clusters: 2 }), chatClient: fanOutChat() });
    const read = run.blackboardHistory.reads.find((entry) => entry.reader === "supervisor");
    const atRead = run.blackboardHistory.versions.find((version) => version.version === read?.version);
    expect(atRead).toBeDefined();
    // At the read, the board is complete — so the interesting proof is that an EARLIER version is
    // genuinely smaller, i.e. the log holds real intermediate states rather than N copies of the end.
    const midway = run.blackboardHistory.versions[5];
    expect(midway.state.entries.length).toBeLessThan(atRead!.state.entries.length);
    expect(atRead!.state.entries.length).toBe(run.blackboard.entries.length);
  });

  it("holds INTERMEDIATE states, so the board's growth is reconstructable entry by entry", async () => {
    const run = await runFanOut({ result: clusteredResult({ clusters: 2 }), chatClient: fanOutChat() });
    const sizes = run.blackboardHistory.versions.map((version) => version.state.entries.length);
    expect(sizes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("each version is an INDEPENDENT snapshot, not a reference to one growing array", async () => {
    // The failure this rules out: folding into a shared mutable board and pushing the SAME object
    // reference into every version. The log would then hold N views of the final state, every
    // intermediate version would be a lie, and it would look correct in a size assertion.
    const run = await runFanOut({ result: clusteredResult({ clusters: 1 }), chatClient: fanOutChat() });
    const [, second, third] = run.blackboardHistory.versions;
    expect(second.state.entries).not.toBe(third.state.entries);
    const thirdSizeBefore = third.state.entries.length;
    second.state.entries.push(entry(99, "architecture", []));
    expect(third.state.entries.length).toBe(thirdSizeBefore);
  });

  it("is NEVER trimmed on a full-size fan-out — the bound is derived, not guessed", async () => {
    // maxVersions = clusters x specialists + 2, so the production ceiling (FANOUT_MAX_COMMUNITIES)
    // cannot reach it. A trim would mean a replay silently starting mid-run.
    const run = await runFanOut({ result: clusteredResult({ clusters: 12 }), chatClient: fanOutChat(), maxCommunities: 12 });
    expect(run.blackboardHistory.trimmedBefore).toBe(1);
    expect(run.blackboardHistory.versions).toHaveLength(run.blackboardHistory.totalWrites);
    expect(run.warnings.filter((warning) => warning.includes("trimmed"))).toEqual([]);
  });

  it("is REPRODUCIBLE: the same input yields a byte-identical history", async () => {
    // The default clock is a constant, deliberately — a wall-clock stamp would make two runs of the
    // same input differ, and a history you cannot diff is not one you can use to compare runs.
    const a = await runFanOut({ result: clusteredResult({ clusters: 2 }), chatClient: fanOutChat() });
    const b = await runFanOut({ result: clusteredResult({ clusters: 2 }), chatClient: fanOutChat() });
    expect(JSON.stringify(a.blackboardHistory)).toBe(JSON.stringify(b.blackboardHistory));
  });

  it("records a read even on the NO-COMMUNITIES fallback, so a synthesis is never unattributed", async () => {
    const noClusters = clusteredResult({ clusters: 1 });
    const run = await runFanOut({
      result: { ...noClusters, metrics: { ...noClusters.metrics!, clusters: undefined } },
      chatClient: fanOutChat(),
    });
    expect(run.blackboardHistory.totalWrites).toBe(1);
    expect(run.blackboardHistory.reads.map((read) => read.reader)).toEqual(["fallback-synthesis"]);
  });

  it("records a REFUSAL as its own version with the reason, not as a silent gap", async () => {
    const refusing = scriptedChat([
      (prompt) =>
        prompt.includes("Specialist findings")
          ? supervisorReply("src/c0/f0.ts")
          : JSON.stringify({ refused: true, reason: "nothing security-relevant here" }),
    ]);
    const run = await runFanOut({ result: clusteredResult({ clusters: 1 }), chatClient: refusing });
    const reasons = run.blackboardHistory.versions.slice(1).map((version) => version.reason);
    expect(reasons.every((reason) => reason.startsWith("refused:"))).toBe(true);
    expect(reasons[0]).toContain("nothing security-relevant here");
  });

  it("keeps `blackboard` and the log's HEAD in agreement — there is no second truth", async () => {
    const run = await runFanOut({ result: clusteredResult({ clusters: 3 }), chatClient: fanOutChat() });
    const head = run.blackboardHistory.versions.at(-1)!.state;
    expect(JSON.stringify(head)).toBe(JSON.stringify(run.blackboard));
  });
});
