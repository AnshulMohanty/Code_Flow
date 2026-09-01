import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWarmupRegistry, warmupRegistry, type WarmupRegistry } from "@codeflow/analyzers";
import { createApp } from "../app.js";
import { registerApiWarmupTasks, warmUpApi, type ApiWarmupDeps } from "./warmup.js";

/**
 * THE REGRESSION THESE TESTS EXIST FOR (P5 DoD 1e).
 *
 * `/health.warmedUp` was structurally always FALSE in the API: the route read the shared registry
 * and the process registered nothing into it, so `required.length > 0` could never hold. The old
 * suite asserted `false` and therefore passed forever while describing a broken endpoint.
 *
 * So the assertions below are specifically: the API registers REAL tasks, warming them flips the
 * flag to TRUE, and the flag goes back to false only for a genuine reason (a required dependency
 * that failed). Hermetic — every dependency is injected; nothing connects to Mongo, Redis or
 * Postgres, and no provider client is constructed.
 */

const silent = { info: () => {}, warn: () => {} };

function deps(overrides: Partial<ApiWarmupDeps> = {}): ApiWarmupDeps {
  return {
    mongoConnected: () => true,
    sharedRedis: async () => ({ id: "fake-redis" }),
    redisConfigured: () => true,
    qaConfigured: () => false,
    warmQa: async () => ({}),
    logger: silent,
    ...overrides,
  };
}

describe("registerApiWarmupTasks — what the API actually warms", () => {
  let registry: WarmupRegistry;
  beforeEach(() => {
    registry = createWarmupRegistry({ now: (() => { let t = 0; return () => (t += 5); })() });
  });

  it("registers a REQUIRED mongo task — without one, `warmedUp` can never be true", () => {
    const names = registerApiWarmupTasks(deps({ registry }));
    expect(names).toContain("mongo-connection");
    const state = registry.state();
    expect(state.tasks.filter((task) => task.required).map((task) => task.name)).toEqual(["mongo-connection"]);
  });

  it("registers shared-redis as NOT required, because every Redis consumer degrades honestly", () => {
    registerApiWarmupTasks(deps({ registry }));
    const redisTask = registry.state().tasks.find((task) => task.name === "shared-redis");
    expect(redisTask?.required).toBe(false);
  });

  it("registers qa-dependencies ONLY when a chat+embedding provider is configured", () => {
    const without = registerApiWarmupTasks(deps({ registry, qaConfigured: () => false }));
    expect(without).not.toContain("qa-dependencies");

    const fresh = createWarmupRegistry();
    const with_ = registerApiWarmupTasks(deps({ registry: fresh, qaConfigured: () => true }));
    expect(with_).toContain("qa-dependencies");
  });

  it("does not depend on a provider key for readiness — a keyless deployment is still READY", async () => {
    const state = await warmUpApi(deps({ registry, qaConfigured: () => false }));
    expect(state.warmedUp).toBe(true);
  });
});

describe("warmUpApi — the flag now moves", () => {
  let registry: WarmupRegistry;
  beforeEach(() => {
    registry = createWarmupRegistry();
  });

  it("reports warmedUp TRUE once the required task is warm (the state V3-P5 could not reach)", async () => {
    const state = await warmUpApi(deps({ registry }));
    expect(state.warmedUp).toBe(true);
    expect(state.tasks.map((task) => task.status)).not.toContain("pending");
  });

  it("reports warmedUp FALSE for a REAL reason — Mongo down", async () => {
    const state = await warmUpApi(deps({ registry, mongoConnected: () => false }));
    expect(state.warmedUp).toBe(false);
    const mongo = state.tasks.find((task) => task.name === "mongo-connection");
    expect(mongo?.status).toBe("failed");
    // Named, so an operator does not have to guess which dependency is the problem.
    expect(mongo?.error).toContain("Mongo is not connected");
  });

  it("stays READY when a configured Redis is unreachable, and still names the failure", async () => {
    const state = await warmUpApi(deps({ registry, sharedRedis: async () => null, redisConfigured: () => true }));
    // Not required ⇒ readiness holds. Losing a whole replica over a shared cache would cost more.
    expect(state.warmedUp).toBe(true);
    const redisTask = state.tasks.find((task) => task.name === "shared-redis");
    expect(redisTask?.status).toBe("failed");
    expect(redisTask?.error).toContain("configured but unavailable");
  });

  it("treats an UNCONFIGURED Redis as fine, not as a failure", async () => {
    const state = await warmUpApi(deps({ registry, sharedRedis: async () => null, redisConfigured: () => false }));
    expect(state.tasks.find((task) => task.name === "shared-redis")?.status).toBe("warm");
  });

  it("records a Q&A warm-up failure without taking readiness down", async () => {
    const state = await warmUpApi(
      deps({
        registry,
        qaConfigured: () => true,
        warmQa: async () => {
          throw new Error("postgres unreachable");
        },
      }),
    );
    expect(state.warmedUp).toBe(true);
    expect(state.tasks.find((task) => task.name === "qa-dependencies")?.error).toContain("postgres unreachable");
  });

  it("is idempotent: warming twice does not re-run a warm task", async () => {
    let mongoChecks = 0;
    const d = deps({
      registry,
      mongoConnected: () => {
        mongoChecks += 1;
        return true;
      },
    });
    await warmUpApi(d);
    await registry.warmUp();
    expect(mongoChecks).toBe(1);
  });
});

describe("GET /health after the REAL registration", () => {
  afterEach(() => {
    // The process-wide registry is a singleton; leaving it warm would leak into app.test.ts.
    warmupRegistry.reset();
  });

  it("reports warmedUp TRUE and names every task — end to end through the live route", async () => {
    const app = createApp();
    // Uses the PROCESS-WIDE registry, which is the one the route reads. That is the whole point:
    // an assertion against an injected registry would not prove the endpoint changed.
    await warmUpApi(deps({ qaConfigured: () => true, warmQa: async () => ({ retrieval: "pgvector:test" }) }));

    const response = await request(app).get("/health").expect(200);
    expect(response.body.warmedUp).toBe(true);
    expect(response.body.warming).toBe(false);
    expect(response.body.warmup.tasks.map((task: { name: string }) => task.name).sort()).toEqual([
      "mongo-connection",
      "qa-dependencies",
      "shared-redis",
    ]);
    expect(response.body.warmup.tasks.every((task: { status: string }) => task.status === "warm")).toBe(true);
    // Liveness is unchanged by readiness — the documented split.
    expect(response.body.status).toBe("ok");
  });

  it("reports warmedUp FALSE with a NAMED failing task when Mongo is down", async () => {
    const app = createApp();
    await warmUpApi(deps({ mongoConnected: () => false }));

    const response = await request(app).get("/health").expect(200);
    expect(response.body.warmedUp).toBe(false);
    // Still 200 + "ok": a cold or degraded process is alive, and a liveness probe must not kill it.
    expect(response.body.status).toBe("ok");
    const mongo = response.body.warmup.tasks.find((task: { name: string }) => task.name === "mongo-connection");
    expect(mongo.status).toBe("failed");
    expect(mongo.error).toContain("Mongo is not connected");
  });
});
