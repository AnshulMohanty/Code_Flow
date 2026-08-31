import { warmupRegistry, type WarmupRegistry, type WarmupState } from "@codeflow/analyzers";

/**
 * THE API'S WARM-UP TASKS (V3-FINAL — closing P5 DoD 1e).
 *
 * THE BUG THIS FIXES, stated plainly: `/health` reported `warmedUp` by reading the shared
 * `warmupRegistry`, and the API process registered NOTHING into it. `snapshot()` computes
 * `warmedUp: required.length > 0 && required.every(warm)` — correctly, because "nothing to do" and
 * "ready" are different claims — so with zero registered tasks the field was **structurally always
 * false**. Not "false because cold": false because it could never be anything else. A readiness
 * probe wired to it would have held traffic back from a perfectly ready API forever, and the test
 * suite pinned the false value as though it were the specification.
 *
 * WHY THIS IS A SEPARATE, INJECTED MODULE rather than three lines in `index.ts`. `index.ts` has a
 * top-level await, connects Mongo and binds a port, so nothing in it is reachable from a test — and
 * registering warm-up there would have produced exactly the same situation in a new place: real
 * behaviour with no test able to see it. Here the dependencies are injected, so the hermetic suite
 * drives the real registration and asserts what `/health` then reports.
 *
 * WHY REGISTRATION IS NOT IN `createApp()`. Tests build the app dozens of times; registering there
 * would make every one of them warm a process-global singleton, and the health assertions would
 * depend on test order. The composition root registers; `createApp` stays pure.
 *
 * BOOT-TIME READINESS, not live health. Warm-up latches: once a task is `warm` it stays warm, so
 * `warmedUp` answers "did this process come up ready", which is the question an orchestrator asks
 * before sending traffic. Whether Mongo is up RIGHT NOW is a different question with its own
 * answer — `persistenceDegradation()`, computed at read time — and conflating them would make one
 * of the two lie.
 */

export interface ApiWarmupDeps {
  /**
   * Is Mongo connected? REQUIRED for readiness: `index.ts` refuses to boot without it, so a
   * process reporting ready while unconnected would be reporting an impossible state. (A LATER loss
   * of Mongo is a degradation, not un-readiness — see the module note.)
   */
  mongoConnected(): boolean;
  /** Resolve the shared Redis handle, or null when unavailable/unconfigured. */
  sharedRedis(): Promise<unknown | null>;
  /** True when a shared Redis was CONFIGURED — so "absent" can be told from "misconfigured". */
  redisConfigured(): boolean;
  /** True when both a chat and an embedding provider are configured (the Q&A path can run). */
  qaConfigured(): boolean;
  /** Pre-resolve the lazily-built Q&A dependencies. Returns a descriptor per dependency. */
  warmQa(): Promise<Record<string, string>>;
  /** Test seam: the registry to register into. Defaults to the process-wide one. */
  registry?: WarmupRegistry;
  logger?: { info(message: string): void; warn(message: string): void };
}

/**
 * Register the API's warm-up tasks. Returns the registered names, in registration order, so a
 * caller (and a test) can assert WHAT was registered rather than only that something was.
 */
export function registerApiWarmupTasks(deps: ApiWarmupDeps): string[] {
  const registry = deps.registry ?? warmupRegistry;
  const logger = deps.logger ?? console;
  const registered: string[] = [];

  // The readiness anchor. The only REQUIRED task, because it is the only dependency whose absence
  // means the API cannot serve its core read paths from durable storage.
  registry.register({
    name: "mongo-connection",
    required: true,
    async run() {
      if (!deps.mongoConnected()) {
        throw new Error("Mongo is not connected; the API cannot serve durable reads.");
      }
    },
  });
  registered.push("mongo-connection");

  // NOT required: every consumer of Redis here degrades honestly to a per-process fallback, and
  // holding a whole replica out of rotation over a shared cache would cost more than it protects.
  registry.register({
    name: "shared-redis",
    required: false,
    async run() {
      const redis = await deps.sharedRedis();
      if (!redis && deps.redisConfigured()) {
        // FAILED rather than skipped, so `/health` names it. A configured-but-unreachable Redis is
        // a misconfiguration worth seeing; an unconfigured one is a deployment choice.
        throw new Error("Redis is configured but unavailable; rate limit, budget and memory are per-process.");
      }
    },
  });
  registered.push("shared-redis");

  // The expensive one — Postgres schema + the store handles the first /ask would otherwise pay for
  // inside the request. Registered only when the Q&A path can actually run: a task that exists to
  // report "skipped" on every keyless deployment is noise, and `warmedUp` must not depend on a
  // provider key the owner deliberately did not set.
  if (deps.qaConfigured()) {
    registry.register({
      name: "qa-dependencies",
      required: false,
      async run() {
        const descriptors = await deps.warmQa();
        logger.info(
          `[codeflow] Q&A warm: ${Object.entries(descriptors)
            .map(([name, value]) => `${name}=${value}`)
            .join(" · ")}`,
        );
      },
    });
    registered.push("qa-dependencies");
  } else {
    logger.info("[codeflow] Q&A warm-up skipped: no chat+embedding provider configured (deterministic reads unaffected).");
  }

  return registered;
}

/** Register, then warm. What `index.ts` calls; separated so a test can drive either half. */
export async function warmUpApi(deps: ApiWarmupDeps): Promise<WarmupState> {
  registerApiWarmupTasks(deps);
  const registry = deps.registry ?? warmupRegistry;
  const state = await registry.warmUp();
  const logger = deps.logger ?? console;
  const line =
    `Warm-up ${state.warmedUp ? "complete" : "INCOMPLETE"} in ${state.durationMs ?? 0}ms — ` +
    state.tasks.map((task) => `${task.name}=${task.status}(${task.durationMs ?? 0}ms)`).join(" ");
  if (state.warmedUp) logger.info(line);
  else logger.warn(line);
  return state;
}
