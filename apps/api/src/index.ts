import { createApp } from "./app.js";
import { resolveEmbeddedWorker } from "./config/embeddedWorker.js";
import { apiPortResolution, env } from "./config/env.js";
import { connectMongo, isMongoConnected } from "./db/connectMongo.js";
import { warmUpApi } from "./health/warmup.js";
import { createRedisRateLimitStore } from "./middleware/rateLimit.js";
import { getSharedRedis, isSharedRedisEnabled } from "./queues/redisClient.js";
import { getQaRetrievalStores, isQaConfigured, warmQaDependencies } from "./services/ragQaService.js";

/**
 * API composition root. V3-P0 wires the PRODUCTION rate-limit store here: Guard 4's limit
 * was per-process (an in-memory map), so it neither held across API replicas nor survived a
 * restart. With Redis it does both. No Redis configured (or unreachable) ⇒ the in-memory
 * store is used and the degradation is LOGGED, not hidden.
 *
 * V3-FINAL adds the WARM-UP registration (P5 DoD 1e). `/health` has reported `warmedUp` since
 * V3-P5, but this process registered no warm-up tasks, so the field was structurally always false —
 * see ./health/warmup.ts. Registration lives here, at the composition root, and NOT in `createApp`:
 * the app is constructed dozens of times by the suite, and warming a process-global singleton from
 * a factory would make the health assertions depend on test order.
 */
try {
  await connectMongo();

  const redis = await getSharedRedis();
  if (!redis && isSharedRedisEnabled()) {
    console.warn(
      "[codeflow] Rate limit: Redis unavailable — falling back to a PER-PROCESS store. " +
        "The per-IP limit will not hold across replicas or restarts.",
    );
  }
  const app = createApp({
    rateLimit: redis ? { store: createRedisRateLimitStore(redis) } : {},
  });

  // Warm BEFORE listening, so the first request never pays the Postgres schema round trip or a
  // per-store Redis connect. Awaited rather than fired-and-forgotten: readiness that races the
  // first request is not readiness.
  const warm = await warmUpApi({
    mongoConnected: isMongoConnected,
    sharedRedis: getSharedRedis,
    redisConfigured: isSharedRedisEnabled,
    qaConfigured: () => isQaConfigured(),
    warmQa: () => warmQaDependencies(),
  });

  // --- EMBEDDED WORKER (free-tier single-service mode) ------------------------
  // Started AFTER warm-up so the tree-sitter grammars and the retrieval schema are already paid for
  // when the first job arrives, and BEFORE listen so the queue is being drained by the time the
  // service is routable. The import is DYNAMIC: with the flag off the worker's module graph — BullMQ,
  // the cloner, the whole analyzer chain — is never loaded, so a normal API deployment pays nothing
  // for this path, not a dependency and not a millisecond of cold start.
  const embedded = resolveEmbeddedWorker(process.env);
  for (const note of embedded.notes) console.log(`[codeflow] ${note}`);
  if (embedded.embedded) {
    const { startAnalysisWorker } = await import("@codeflow/worker");
    await startAnalysisWorker({
      // This process already connected; a second connect on the same mongoose singleton would
      // replace the connection every route above is using.
      mongoAlreadyConnected: true,
      // The same store objects the Q&A path reads. Without this, a deployment with no Postgres has
      // the worker writing an index into one in-memory store and the API querying another.
      retrieval: await getQaRetrievalStores(),
      concurrency: embedded.concurrency,
      // The API already serves /health on the one port the platform routes to.
      healthServer: false,
      // The host owns the process lifecycle; two SIGTERM handlers racing to exit is not a shutdown.
      handleSignals: false,
    });
  }

  // A managed host routes to the port it assigned; binding elsewhere is reported as unhealthy
  // with no useful error, so say which variable chose this one.
  for (const warning of apiPortResolution.warnings) console.warn(`[port] ${warning}`);

  // 0.0.0.0 explicitly: a container that binds the loopback interface is unreachable from the
  // platform proxy, and the default is host-dependent.
  app.listen(env.apiPort, "0.0.0.0", () => {
    console.log(
      `codeflow-api listening on 0.0.0.0:${env.apiPort} (port from ${apiPortResolution.source}) ` +
        `(rate limit: ${redis ? "redis" : "in-memory"}, budget: ${redis ? "redis (shared)" : "in-memory"}, ` +
        `warmedUp: ${warm.warmedUp})`,
    );
  });
} catch {
  process.exit(1);
}
