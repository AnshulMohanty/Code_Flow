import { describe, expect, it } from "vitest";
import type { WarmupState } from "@codeflow/analyzers";
import { handleHealthRequest, type WorkerHealthState } from "./healthServer.js";
import { describeScaleRule, MAX_CONCURRENCY, resolveScalingConfig } from "../config/scaling.js";

const warm: WarmupState = {
  warmedUp: true,
  warming: false,
  durationMs: 12,
  tasks: [{ name: "tree-sitter-grammars", status: "warm", durationMs: 12, required: true }],
};
const cold: WarmupState = { warmedUp: false, warming: true, tasks: [] };

function stateFor(overrides: Partial<WorkerHealthState> = {}): WorkerHealthState {
  return {
    warmup: () => warm,
    queueDepth: async () => 3,
    activeJobs: () => 1,
    consumerRunning: () => true,
    ...overrides,
  };
}

const parse = (body: string) => JSON.parse(body) as Record<string, unknown>;

describe("worker /health - liveness", () => {
  it("is 200 while the consumer is open", async () => {
    const response = await handleHealthRequest("/health", stateFor());
    expect(response.status).toBe(200);
    expect(parse(response.body).status).toBe("ok");
  });

  it("is 200 while still COLD, because killing a cold worker only restarts the cold start", async () => {
    const response = await handleHealthRequest("/health", stateFor({ warmup: () => cold }));
    expect(response.status).toBe(200);
    // The coldness is still REPORTED: "live but cold" is invisible from outside otherwise.
    expect(parse(response.body).warmedUp).toBe(false);
    expect(parse(response.body).warming).toBe(true);
  });

  it("is 503 once the consumer has closed, because a stopping worker is not capacity", async () => {
    const response = await handleHealthRequest("/health", stateFor({ consumerRunning: () => false }));
    expect(response.status).toBe(503);
    expect(parse(response.body).status).toBe("stopping");
  });
});

describe("worker /ready - readiness, which is a DIFFERENT question", () => {
  it("is 503 until warm-up completes, so a scale-out instance is not counted while loading WASM", async () => {
    const response = await handleHealthRequest("/ready", stateFor({ warmup: () => cold }));
    expect(response.status).toBe(503);
    expect(parse(response.body).ready).toBe(false);
  });

  it("is 200 once warm", async () => {
    const response = await handleHealthRequest("/ready", stateFor());
    expect(response.status).toBe(200);
    expect(parse(response.body).ready).toBe(true);
  });

  it("reports every warm-up task, so a failed OPTIONAL task stays visible", async () => {
    const partial: WarmupState = {
      warmedUp: true,
      warming: false,
      tasks: [
        { name: "tree-sitter-grammars", status: "warm", durationMs: 5, required: true },
        { name: "embedding-provider", status: "failed", durationMs: 1, required: false, error: "no key" },
      ],
    };
    const response = await handleHealthRequest("/ready", stateFor({ warmup: () => partial }));
    expect(response.status).toBe(200);
    const tasks = parse(response.body).tasks as Array<{ name: string; status: string }>;
    expect(tasks.find((task) => task.name === "embedding-provider")?.status).toBe("failed");
  });
});

describe("worker /metrics - what an autoscaler reads", () => {
  it("reports queue depth and active jobs", async () => {
    const response = await handleHealthRequest("/metrics", stateFor());
    expect(response.status).toBe(200);
    expect(parse(response.body).queueDepth).toBe(3);
    expect(parse(response.body).activeJobs).toBe(1);
  });

  it("returns depth NULL, never 0, when the queue cannot be read", async () => {
    // The failure this prevents: reporting 0 for an unreadable queue scales the fleet IN exactly
    // when Redis is broken and the backlog is invisible, which is the worst possible moment.
    const response = await handleHealthRequest("/metrics", stateFor({ queueDepth: async () => null }));
    expect(parse(response.body).queueDepth).toBeNull();
    expect(parse(response.body).queueDepthAvailable).toBe(false);
    expect(String(parse(response.body).reason)).toMatch(/do NOT treat as zero/);
  });

  it("still answers 200 so a scaler holds its last value instead of erroring", async () => {
    const response = await handleHealthRequest("/metrics", stateFor({ queueDepth: async () => null }));
    expect(response.status).toBe(200);
  });
});

describe("unknown paths", () => {
  it("404s rather than reporting healthy by accident", async () => {
    // A probe misconfigured to the WEB app's /healthz must fail loudly on the worker.
    const response = await handleHealthRequest("/healthz", stateFor());
    expect(response.status).toBe(404);
  });
});

describe("resolveScalingConfig", () => {
  it("defaults to the previously hardcoded concurrency, so an unset env changes nothing", () => {
    const config = resolveScalingConfig({});
    expect(config.concurrency).toBe(2);
    expect(config.healthPort).toBe(0);
    expect(config.warnings).toEqual([]);
  });

  it("reads WORKER_CONCURRENCY", () => {
    expect(resolveScalingConfig({ WORKER_CONCURRENCY: "4" }).concurrency).toBe(4);
  });

  it("CLAMPS an over-large concurrency and says so, rather than refusing to boot", () => {
    // A failed boot during a scale-out removes capacity at the moment it is most needed.
    const config = resolveScalingConfig({ WORKER_CONCURRENCY: "99" });
    expect(config.concurrency).toBe(MAX_CONCURRENCY);
    expect(config.warnings.join(" ")).toMatch(/exceeds the per-instance ceiling/);
    expect(config.warnings.join(" ")).toMatch(/Scale OUT/);
  });

  it("falls back on a non-numeric, fractional or negative concurrency", () => {
    expect(resolveScalingConfig({ WORKER_CONCURRENCY: "many" }).concurrency).toBe(2);
    expect(resolveScalingConfig({ WORKER_CONCURRENCY: "-1" }).concurrency).toBe(2);
    expect(resolveScalingConfig({ WORKER_CONCURRENCY: "2.5" }).warnings.length).toBe(1);
  });

  it("keeps the health server OFF for an invalid port instead of guessing one", () => {
    const config = resolveScalingConfig({ WORKER_HEALTH_PORT: "not-a-port" });
    expect(config.healthPort).toBe(0);
    expect(config.warnings.join(" ")).toMatch(/stays OFF/);
  });

  it("targets one job per concurrency slot", () => {
    expect(resolveScalingConfig({ WORKER_CONCURRENCY: "4" }).targetQueueDepth).toBe(4);
  });

  it("renders a scale rule that names the metric AND rules out CPU", () => {
    const rule = describeScaleRule(resolveScalingConfig({ WORKER_CONCURRENCY: "4", WORKER_HEALTH_PORT: "4100" }));
    expect(rule).toMatch(/queue depth/);
    expect(rule).toMatch(/4100/);
    expect(rule).toMatch(/do NOT scale on CPU/);
    // The drain window is part of the rule: under-configuring it silently re-runs whole jobs.
    expect(rule).toMatch(/terminationGracePeriodSeconds: >= 300/);
  });
});
