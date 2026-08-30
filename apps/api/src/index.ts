import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { connectMongo } from "./db/connectMongo.js";
import { createRedisRateLimitStore } from "./middleware/rateLimit.js";
import { getSharedRedis, isSharedRedisEnabled } from "./queues/redisClient.js";

/**
 * API composition root. V3-P0 wires the PRODUCTION rate-limit store here: Guard 4's limit
 * was per-process (an in-memory map), so it neither held across API replicas nor survived a
 * restart. With Redis it does both. No Redis configured (or unreachable) ⇒ the in-memory
 * store is used and the degradation is LOGGED, not hidden.
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

  app.listen(env.apiPort, () => {
    console.log(
      `codeflow-api listening on port ${env.apiPort} ` +
        `(rate limit: ${redis ? "redis" : "in-memory"}, budget: ${redis ? "redis (shared)" : "in-memory"})`,
    );
  });
} catch {
  process.exit(1);
}
