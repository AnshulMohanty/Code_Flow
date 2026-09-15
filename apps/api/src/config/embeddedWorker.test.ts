import { describe, expect, it } from "vitest";
import { resolveEmbeddedWorker } from "./embeddedWorker.js";

/**
 * THE DECISION, not the wiring.
 *
 * `resolveEmbeddedWorker` is a pure function of an env record precisely so the two parts with a real
 * cost — whether the consumer runs in this process at all, and the concurrency clamp that follows —
 * can be asserted without starting BullMQ, connecting Mongo, or loading the worker's module graph.
 * The wiring itself is four lines in the composition root, which is the right amount of untested
 * code for something whose every input is checked here.
 */

describe("resolveEmbeddedWorker — the split stays the default", () => {
  it("is OFF when the variable is absent, so no existing deployment changes shape", () => {
    const decision = resolveEmbeddedWorker({});
    expect(decision.embedded).toBe(false);
    expect(decision.notes).toEqual([]);
  });

  it("is off, silently, for an explicit false", () => {
    for (const value of ["false", "0", "no", "FALSE"]) {
      const decision = resolveEmbeddedWorker({ RUN_WORKER_IN_PROCESS: value });
      expect(decision.embedded).toBe(false);
      expect(decision.notes).toEqual([]);
    }
  });

  it("is on for the accepted spellings of true", () => {
    for (const value of ["true", "TRUE", "1", "yes"]) {
      expect(resolveEmbeddedWorker({ RUN_WORKER_IN_PROCESS: value }).embedded).toBe(true);
    }
  });

  it("ANNOUNCES an unrecognised value instead of quietly treating it as false", () => {
    // A typo here produces the opposite deployment from the one intended, and the symptom is "jobs
    // queue and nothing happens" — which looks like a Redis problem and is not one.
    const decision = resolveEmbeddedWorker({ RUN_WORKER_IN_PROCESS: "ture" });
    expect(decision.embedded).toBe(false);
    expect(decision.notes.join(" ")).toMatch(/not a recognised boolean/i);
    expect(decision.notes.join(" ")).toMatch(/ture/);
  });
});

describe("embedded mode forces concurrency to 1", () => {
  it("clamps regardless of what WORKER_CONCURRENCY says", () => {
    // In split mode a second concurrent job costs queue throughput. Here it competes with every HTTP
    // request on one event loop, and the API is the thing a human is waiting on.
    const decision = resolveEmbeddedWorker({ RUN_WORKER_IN_PROCESS: "true", WORKER_CONCURRENCY: "8" });
    expect(decision.embedded).toBe(true);
    expect(decision.concurrency).toBe(1);
  });

  it("says that it ignored WORKER_CONCURRENCY, rather than silently overriding an operator", () => {
    const decision = resolveEmbeddedWorker({ RUN_WORKER_IN_PROCESS: "true", WORKER_CONCURRENCY: "4" });
    expect(decision.notes.join(" ")).toMatch(/WORKER_CONCURRENCY=4 is IGNORED/);
  });

  it("does not complain when WORKER_CONCURRENCY already agrees", () => {
    const decision = resolveEmbeddedWorker({ RUN_WORKER_IN_PROCESS: "true", WORKER_CONCURRENCY: "1" });
    expect(decision.notes.join(" ")).not.toMatch(/IGNORED/);
  });

  it("states what embedded mode IS, so an operator sees the choice acknowledged at boot", () => {
    const decision = resolveEmbeddedWorker({ RUN_WORKER_IN_PROCESS: "true" });
    expect(decision.notes.join(" ")).toMatch(/INSIDE this API process/i);
    expect(decision.notes.join(" ")).toMatch(/two-process split is the default/i);
  });
});
