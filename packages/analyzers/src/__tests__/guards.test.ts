import { describe, expect, it, vi } from "vitest";
import type {
  PipelineContext,
  PipelineInput,
  PipelineStage,
  ProgressEvent,
  RepoStructure,
} from "@codeflow/shared-types";
import { createIngestStage, type RepoCloner } from "../stages/ingest.js";
import { createInventoryStage } from "../stages/inventory.js";
import { runPipeline } from "../pipeline/orchestrator.js";
import { createInMemoryBudgetHandle } from "../budget/budgetHandle.js";
import { createLimiter, withTimeout } from "../util/concurrency.js";

const input: PipelineInput = {
  jobId: "job-1",
  repositoryRef: { provider: "github", owner: "acme", name: "repo" },
  mode: "public_hosted",
  analyzerVersion: "v1",
};

const ev = (stage: PipelineStage["id"]): ProgressEvent => ({
  jobId: "job-1",
  stage,
  stageIndex: 0,
  stageCount: 0,
  kind: "deterministic",
  status: "completed",
  label: stage,
  progress: 0,
  startedAt: "",
  emittedAt: "",
});

function makeClock() {
  let t = 0;
  return () => ++t;
}

// ── Guard 1 — repo-size cap (Ingest) ─────────────────────────────────────────

describe("Guard 1 — repo-size cap (Ingest)", () => {
  const cloner: RepoCloner = { clone: async () => ({ repoPath: "/repo", commitSha: "sha-1" }) };

  it("over MAX_FILES ⇒ run 'failed' + repo-too-large, dependents skipped", async () => {
    const ingest = createIngestStage({
      cloner,
      measureRepoSize: async () => ({ fileCount: 11, totalBytes: 10 }),
      maxFiles: 10,
      maxBytes: 1_000_000,
      now: () => 1,
    });
    const dependent = { run: vi.fn(async () => ({ partial: {}, event: ev("orient") })) };
    const orient = { id: "orient", kind: "deterministic", label: "orient", owns: [], run: dependent.run } as unknown as PipelineStage;

    const { result } = await runPipeline([ingest, orient], input, { now: makeClock() });

    expect(result.pipeline?.status).toBe("failed");
    expect(result.pipeline?.statusReason).toBe("repo-too-large");
    expect(dependent.run).not.toHaveBeenCalled(); // dependents skipped
  });

  it("over MAX_BYTES ⇒ repo-too-large", async () => {
    const ingest = createIngestStage({
      cloner,
      measureRepoSize: async () => ({ fileCount: 1, totalBytes: 999 }),
      maxFiles: 10,
      maxBytes: 500,
      now: () => 1,
    });
    const { result } = await runPipeline([ingest], input, { now: makeClock() });
    expect(result.pipeline?.status).toBe("failed");
    expect(result.pipeline?.statusReason).toBe("repo-too-large");
  });

  it("within cap ⇒ no failure (Ingest completes)", async () => {
    const ingest = createIngestStage({
      cloner,
      measureRepoSize: async () => ({ fileCount: 5, totalBytes: 100 }),
      maxFiles: 10,
      maxBytes: 1_000,
      now: () => 1,
    });
    const { result } = await runPipeline([ingest], input, { now: makeClock() });
    expect(result.pipeline?.status).toBe("completed");
    expect(result.pipeline?.statusReason).toBeUndefined();
  });
});

// ── Guard 2 + 3 — parsing concurrency + per-file timeout (Inventory) ─────────

function structureOf(paths: string[]): RepoStructure {
  return {
    layout: "flat",
    fileCount: paths.length,
    files: paths.map((path) => ({ path, ext: ".ts", role: "source", language: "TypeScript", sizeBytes: 10 })),
  };
}

function inventoryCtx(structure: RepoStructure): PipelineContext {
  return {
    repoPath: "/repo",
    commitSha: "sha-1",
    prior: { structure },
    cache: { async get() { return null; }, async set() {} },
    logger: { info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };
}

describe("Guard 2 — parsing concurrency (Inventory)", () => {
  it("in-flight parses never exceed the configured concurrency", async () => {
    const paths = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`);
    const structure = structureOf(paths);

    let inFlight = 0;
    let maxInFlight = 0;
    const readFile = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5)); // hold the slot so overlap is observable
      inFlight -= 1;
      return "export const x = 1;";
    };

    const stage = createInventoryStage({ readFile, concurrency: 4, now: () => 1 });
    await stage.run(input, inventoryCtx(structure));

    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // actually overlapped (guard is doing work)
  });
});

describe("Guard 3 — per-file parse timeout (Inventory)", () => {
  it("a slow file is recorded unparsed; the run still completes with the rest", async () => {
    const structure = structureOf(["src/fast.ts", "src/slow.ts"]);
    const readFile = async (_repo: string, path: string) => {
      if (path === "src/slow.ts") {
        await new Promise((r) => setTimeout(r, 100)); // exceeds the 20ms timeout
      }
      return "export const ok = 1;";
    };

    const stage = createInventoryStage({ readFile, fileTimeoutMs: 20, concurrency: 4, now: () => 1 });
    const { partial } = await stage.run(input, inventoryCtx(structure));

    expect(partial.inventory!.unparsedFiles).toContain("src/slow.ts");
    expect(partial.inventory!.loc["src/fast.ts"]).toBeGreaterThanOrEqual(1); // fast file parsed
    expect(partial.inventory!.loc["src/slow.ts"]).toBeUndefined();
  });
});

describe("concurrency primitives", () => {
  it("createLimiter bounds active tasks", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let max = 0;
    const task = () =>
      limit(async () => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 8 }, task));
    expect(max).toBeLessThanOrEqual(2);
  });

  it("withTimeout resolves the value or reports timedOut", async () => {
    expect(await withTimeout(Promise.resolve(42), 50)).toEqual({ timedOut: false, value: 42 });
    const slow = new Promise<number>((r) => setTimeout(() => r(1), 100));
    expect(await withTimeout(slow, 10)).toEqual({ timedOut: true });
  });
});

// ── Guard 5 — in-memory budget handle (mechanics + UTC reset) ────────────────

describe("Guard 5 — BudgetHandle (in-memory)", () => {
  it("check passes under the ceiling and fails when an estimate would exceed it", async () => {
    const budget = createInMemoryBudgetHandle(100);
    expect(await budget.check(60)).toBe(true);
    await budget.record(60);
    expect(await budget.check(50)).toBe(false); // 60 + 50 > 100
    expect(await budget.check(40)).toBe(true); // 60 + 40 == 100
  });

  it("resets at the UTC day boundary", async () => {
    let day = Date.UTC(2026, 5, 10, 12, 0, 0); // 2026-06-10
    const budget = createInMemoryBudgetHandle(100, () => day);
    await budget.record(100);
    expect(await budget.check(1)).toBe(false); // exhausted on day 1

    day = Date.UTC(2026, 5, 11, 0, 0, 0); // 2026-06-11 → reset
    expect(await budget.check(100)).toBe(true);
  });
});
