import express from "express";
import { analyzeRouter } from "./routes/analyze.js";
import { healthRouter } from "./routes/health.js";
import { jobsRouter } from "./routes/jobs.js";
import { resultsRouter } from "./routes/results.js";
import { askRouter } from "./routes/ask.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";
import { createRateLimitMiddleware, type RateLimitOptions } from "./middleware/rateLimit.js";
import { createCorsMiddleware } from "./middleware/cors.js";

export interface CreateAppOptions {
  /** Per-IP rate-limit config (Guard 4). Defaults to an in-memory store + @codeflow/config
   *  limits; prod injects a Redis-backed store shared across instances. Tests inject a small
   *  limit + fresh store. */
  rateLimit?: RateLimitOptions;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();

  // CORS first so cross-origin preflight (OPTIONS) is answered before json parsing / rate limit.
  app.use(createCorsMiddleware());

  app.use(express.json({ limit: "1mb" }));

  // Guard 4 — per-IP rate limit on the SPENDING endpoints (analyze enqueue + ask), sharing one
  // store so a caller's budget is consistent across both. Reads (health/results/jobs) are free.
  const rateLimit = createRateLimitMiddleware(options.rateLimit);

  app.use(healthRouter);
  app.use("/api/analyze", rateLimit);
  app.use(analyzeRouter);
  app.use(jobsRouter);
  app.use(askRouter(rateLimit)); // POST /api/result/:id/ask (rate-limited)
  app.use(resultsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
