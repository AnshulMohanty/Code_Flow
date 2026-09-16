import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { resetQaBudgetForTests, retrievalHealth, retrievalHealthOf } from "../services/ragQaService.js";
import { NO_POSTGRES_DEGRADATION } from "@codeflow/retrieval";

/**
 * LEDGER #32 — the retrieval backend was invisible from `/health`.
 *
 * It was announced at boot in the LOGS and nowhere else, so from outside the process "the API is up"
 * and "the API can answer anything the worker indexed" were the same observation. That pair is
 * exactly the one a deploy check has to separate, because the failure mode is silent by
 * construction: an API on a per-process index returns 200 on every endpoint and refuses every
 * question.
 *
 * Hermetic: no store is resolved, no provider client is called, no socket is opened. The mapping is
 * a pure function and the env-derived states take an injected env record.
 */

afterEach(() => {
  // The snapshot is process-global (one retrieval index per process), so a test that leaves one
  // behind would decide the next test's answer.
  resetQaBudgetForTests();
});

describe("GET /health reports which retrieval index this process is talking to", () => {
  it("always includes a retrieval mode — the field is not conditional on being healthy", async () => {
    const response = await request(createApp()).get("/health").expect(200);
    expect(response.body.retrieval).toBeDefined();
    expect(["postgres", "memory", "not-configured", "pending"]).toContain(response.body.retrieval.mode);
  });

  it("does not 500 or hang when retrieval was never resolved", async () => {
    // The endpoint reads a SNAPSHOT rather than awaiting `createRetrievalStores`. A /health that can
    // block on the dependency it reports on turns one outage into two.
    const response = await request(createApp()).get("/health").expect(200);
    expect(response.body.status).toBe("ok");
  });

  it("reports not-configured, with the reason, when no embedding provider is set", async () => {
    // The hermetic suite runs with NODE_ENV=test, so `config/env.ts` skips dotenv and no provider
    // key is present. That is the state this assertion describes.
    const response = await request(createApp()).get("/health").expect(200);
    expect(response.body.retrieval.mode).toBe("not-configured");
    expect(response.body.retrieval.degradation).toMatch(/no embedding provider/i);
  });
});

describe("retrievalHealth — the four states are four, not two", () => {
  it("not-configured when no embedding key exists: no index CAN exist, and none is expected", () => {
    const health = retrievalHealth({});
    expect(health.mode).toBe("not-configured");
    expect(health.degradation).toMatch(/deterministic analysis paths are unaffected/i);
  });

  it("pending when a provider IS configured but the store has not resolved yet", () => {
    // Distinct from not-configured on purpose: "we have no Postgres" and "we have not looked yet"
    // are different facts, and collapsing them would make one of them a lie.
    expect(retrievalHealth({ GEMINI_API_KEY: "test-key" }).mode).toBe("pending");
  });

  it("reports an AMBIGUOUS provider config rather than throwing it at a liveness probe", () => {
    // Two keys with no explicit choice throws at client construction. /health must not 500 on it:
    // a probe would read that as a dead process while every deterministic read still works.
    const health = retrievalHealth({ GEMINI_API_KEY: "a", VOYAGE_API_KEY: "b" });
    expect(health.mode).toBe("not-configured");
    expect(health.degradation).toMatch(/ambiguously/i);
  });
});

describe("retrievalHealthOf — the mapping from a resolved store", () => {
  it("a shared postgres index reports postgres and NO degradation", () => {
    expect(retrievalHealthOf({ mode: "postgres" })).toEqual({ mode: "postgres" });
  });

  it("carries the degradation string through verbatim, so the endpoint says WHY", () => {
    // Verbatim matters: the string names the variable and the fix (see NO_POSTGRES_DEGRADATION).
    // Summarising it at the boundary would leave an operator with an alarm and no next step.
    expect(retrievalHealthOf({ mode: "memory", degradation: NO_POSTGRES_DEGRADATION })).toEqual({
      mode: "memory",
      degradation: NO_POSTGRES_DEGRADATION,
    });
  });

  it("omits the key entirely when there is nothing wrong, rather than emitting an empty string", () => {
    expect(retrievalHealthOf({ mode: "memory" })).toEqual({ mode: "memory" });
  });
});
