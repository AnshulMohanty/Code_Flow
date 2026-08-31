import path from "node:path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Queue, Worker } from "bullmq";
import type { AnalysisJobPayload } from "@codeflow/shared-types";
import {
  createEmbeddingClientFromEnv,
  createGeminiClient,
  createLlmClientFromEnv,
  createRedisBudgetHandle,
  maybeRouted,
  warmupRegistry,
} from "@codeflow/analyzers";
import { initTreeSitter } from "@codeflow/parsers";
import { createRetrievalStores, type RetrievalStores } from "@codeflow/retrieval";
import { Redis } from "ioredis";
import { ANALYSIS_QUEUE_NAME, createRedisConnectionOptions, env } from "./services/workerAnalysisService.js";
import { createMongoCacheHandle, createMongoEventLogStore, createMongoWorkerAnalysisService } from "./services/workerAnalysisService.js";
import { runAnalysisJob } from "./processors/pipelineJobProcessor.js";
import { createGitRepoCloner } from "./services/gitRepoCloner.js";
import { createBullmqProgressPublisher } from "./services/progressPublisher.js";
import { readRepoFile } from "./services/repoFileReader.js";
import { readRepoDir } from "./services/repoDirectoryWalker.js";
import { measureRepoSize } from "./services/measureRepoSize.js";
import { cleanupRepoPath } from "./services/publicRepoCloneService.js";
import { resolveScalingConfig } from "./config/scaling.js";
import { startHealthServer } from "./health/healthServer.js";
import { resolveTraceExport } from "./observability/traceExport.js";

// Monorepo has a single root .env; apps run with cwd = their package dir (apps/<app>), so
// resolve the repo-root .env explicitly rather than dotenv's cwd-relative default. Skip under
// the test runner (NODE_ENV=test) so the hermetic suite never picks up a developer's local .env.
if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
}

// Safety net: a single job's stray async error (e.g. a fire-and-forget progress/event-log
// write that rejects) must NOT take down the worker for every other job. Log and keep running;
// BullMQ already marks the offending job failed via the Worker "failed" handler below.
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandledRejection (worker kept alive):", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[worker] uncaughtException (worker kept alive):", error);
});

async function main() {
  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 5000,
  });
  console.log("CodeFlow worker connected to MongoDB.");

  const service = createMongoWorkerAnalysisService();
  const cloner = createGitRepoCloner();
  const cache = createMongoCacheHandle(); // persistent LLM-output cache (wallet defense)
  // Guard 5 — the global daily LLM-spend ceiling, now on the SAME Redis counter the API's
  // Q&A path uses (V3-P0). It was a Mongo counter here and a per-process one there, so the
  // "global" ceiling was two independent ceilings that could not see each other's spend.
  // Redis is already a hard requirement for this process (BullMQ runs on it), so there is no
  // fallback path to justify: if Redis is down the worker has no jobs to run anyway.
  const budgetRedis = new Redis(createRedisConnectionOptions({ forWorker: true }));
  budgetRedis.on("error", (error: Error) => {
    // An unhandled ioredis 'error' event would kill the process; the handle fails open.
    console.error("[worker] budget Redis error:", error.message);
  });
  const budget = createRedisBudgetHandle(budgetRedis);
  console.log("Guard 5 — daily LLM budget ledger: Redis (shared with the API Q&A path).");
  const eventLog = createMongoEventLogStore(); // SSE replay buffer (#20)

  // AI providers are selected by env (LLM_PROVIDER / EMBEDDING_PROVIDER, else inferred
  // from whichever key is set; both keys + no explicit provider throws a clear error).
  // A single GEMINI_API_KEY can power both synthesis and RAG. Owner's keys, never
  // hardcoded; a stage registers only when its SELECTED provider's key is present.
  const synthesisClient = createLlmClientFromEnv(process.env);
  console.log(
    synthesisClient
      ? `Synthesize (AI) enabled — provider ${synthesisClient.provider}, model ${synthesisClient.model}.`
      : "Synthesize (AI) disabled: no chat provider key configured (deterministic pipeline only).",
  );
  if (synthesisClient) {
    console.log(
      env.fanOutSynthesis
        ? "Synthesize path: bounded agent FAN-OUT over code communities (V3-P4) — 5N+1 provider calls per run."
        : "Synthesize path: single-shot (set FANOUT_SYNTHESIS=true for the V3-P4 agent fan-out).",
    );
  }

  // --- V3-P5 MODEL ROUTING ---------------------------------------------------
  // A cheap tier for the many small specialist calls, the configured model for the calls whose
  // output a user reads. `maybeRouted` returns the single client UNWRAPPED when only one tier
  // exists, so a deployment that sets no FAST_MODEL is byte-identical to before — including its
  // cache keys, which a router would otherwise re-scope and invalidate for nothing.
  const routedSynthesisClient = (() => {
    if (!synthesisClient || !env.fastModel) return synthesisClient;
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      console.warn("[worker] FAST_MODEL is set but GEMINI_API_KEY is not; model routing disabled.");
      return synthesisClient;
    }
    const fast = createGeminiClient({ apiKey: geminiKey, model: env.fastModel });
    const routed = maybeRouted(fast, synthesisClient, {
      onDecision: (decision) => console.log(`[worker] routed ${decision.task} → ${decision.tier} (${decision.model})`),
    });
    if (routed !== synthesisClient) {
      console.log(`Model routing enabled — fast: ${fast.model}, frontier: ${synthesisClient.model}.`);
    }
    return routed;
  })();

  const embeddingClient = createEmbeddingClientFromEnv(process.env);
  console.log(
    embeddingClient
      ? `RAG (AI) enabled — provider ${embeddingClient.provider}, model ${embeddingClient.model} (dim ${embeddingClient.dimension}).`
      : "RAG (AI) disabled: no embedding provider key configured.",
  );

  // V3-P2 — the retrieval stores. Resolved ONCE at boot, in the embedding client's space, so
  // the pgvector table is created at the right dimension and every job writes to the same
  // index. Skipped entirely with no embedding client: there would be no vectors to store.
  let retrieval: RetrievalStores | null = null;
  if (embeddingClient) {
    retrieval = await createRetrievalStores({
      space: { embeddingModel: embeddingClient.model, embeddingDim: embeddingClient.dimension },
      postgresUrl: env.postgresUrl,
    });
    console.log(
      `Retrieval index: ${retrieval.vectorStore.id} + ${retrieval.textStore.id} (mode ${retrieval.mode}).`,
    );
    if (retrieval.degradation) {
      // Honest degradation, not a shrug: an in-memory index is invisible to the API, so the
      // Q&A endpoint will refuse for every analysis this worker builds.
      console.warn(`[worker] RETRIEVAL DEGRADED — ${retrieval.degradation}`);
    }
  }

  // --- V3-P5 COLD-START WARM-UP ---------------------------------------------
  // Registered here, at the composition root, because these are PROCESS-lifetime resources: the
  // tree-sitter WASM grammars are the real cost (a one-time load that whichever job arrives first
  // would otherwise pay), and the retrieval schema is a round trip nobody should pay inside a job.
  // Both are already idempotent, so warming is purely a matter of paying the cost before traffic.
  warmupRegistry.register({
    name: "tree-sitter-grammars",
    async run() {
      await initTreeSitter();
    },
  });
  if (embeddingClient) {
    warmupRegistry.register({
      name: "embedding-provider",
      // Not required for readiness: an unavailable embedding provider degrades the run to
      // deterministic-only, which still serves. Blocking readiness on it would take the whole
      // worker out over an optional stage.
      required: false,
      async run() {
        // Construction only — deliberately NOT a probe request. A warm-up that spent money would
        // be charging the owner for a health check.
        void embeddingClient.model;
      },
    });
  }
  if (retrieval) {
    warmupRegistry.register({
      name: "retrieval-stores",
      required: false,
      async run() {
        // `createRetrievalStores` already ensured the schema at boot; this records that it happened
        // so `/health` can report it rather than inferring it.
        void retrieval.vectorStore.id;
      },
    });
  }
  const warmState = await warmupRegistry.warmUp();
  console.log(
    `Warm-up ${warmState.warmedUp ? "complete" : "INCOMPLETE"} in ${warmState.durationMs ?? 0}ms — ` +
      warmState.tasks.map((task) => `${task.name}=${task.status}(${task.durationMs ?? 0}ms)`).join(" "),
  );
  if (env.parallelStages) {
    console.log("Stage schedule: PARALLEL by dependency readiness (V3-P5). Slices are byte-identical to sequential.");
  }

  // --- V3-P5 TRACE EXPORT ----------------------------------------------------
  // Resolved once, at boot, and handed to every job. The recording tracer has run since V3-P5 but
  // its report reached nothing: `traceExporter` was an accepted dependency nobody ever supplied.
  // Default is the bounded in-memory replay buffer (no network); Langfuse/Helicone activate only
  // from env. See ./observability/traceExport.ts.
  const traceExport = resolveTraceExport(process.env);
  console.log(`[worker] ${traceExport.description}`);

  // --- V3-P5 AUTOSCALE CONFIG ------------------------------------------------
  // Concurrency was hardcoded at 2, which is right for a 1-vCPU box and wrong for a 4-vCPU one.
  // An unset WORKER_CONCURRENCY resolves to the same 2, so an existing deployment is unchanged.
  const scaling = resolveScalingConfig(process.env);
  for (const warning of scaling.warnings) console.warn(`[worker] ${warning}`);
  console.log(`Job concurrency: ${scaling.concurrency} per instance.`);

  // In-flight count, so /metrics reports THIS instance's load rather than only the shared queue.
  let activeJobs = 0;
  let consumerRunning = true;

  const worker = new Worker<AnalysisJobPayload>(
    ANALYSIS_QUEUE_NAME,
    async (job) => {
      console.log(`Processing analysis job ${job.data.jobId}.`);
      activeJobs += 1;
      try {
        await runAnalysisJob(job.data, {
          service,
          cloner,
          publisher: createBullmqProgressPublisher(job),
          readFile: readRepoFile,
          readDir: readRepoDir,
          measureRepoSize,
          cleanupRepo: cleanupRepoPath,
          ...(routedSynthesisClient ? { synthesisClient: routedSynthesisClient } : {}),
          fanOutSynthesis: env.fanOutSynthesis,
          parallelStages: env.parallelStages,
          embeddingClient,
          ...(retrieval ? { vectorStore: retrieval.vectorStore, textStore: retrieval.textStore } : {}),
          cache,
          budget,
          eventLog,
          traceExporter: traceExport.exporter,
          pricing: traceExport.pricing,
        });
        console.log(`Completed analysis job ${job.data.jobId}.`);
      } finally {
        // `finally`, so a FAILED job still decrements. Without it a run of failures would leave
        // /metrics reporting phantom load forever, and an autoscaler reading it would keep an
        // idle instance alive on the strength of jobs that ended minutes ago.
        activeJobs -= 1;
      }
    },
    {
      connection: createRedisConnectionOptions({ forWorker: true }),
      concurrency: scaling.concurrency,
    },
  );

  worker.on("failed", (job, error) => {
    console.error(`Analysis job ${job?.data.jobId ?? "unknown"} failed: ${error.message}`);
  });

  // --- V3-P5 HEALTH + METRICS ------------------------------------------------
  // A separate `Queue` handle purely to READ counts. BullMQ's Worker knows what it is running but
  // not what is waiting, and the waiting count is the whole point of the metric: an autoscaler
  // needs the backlog, which by definition lives outside this process.
  const metricsQueue = scaling.healthPort
    ? new Queue(ANALYSIS_QUEUE_NAME, { connection: createRedisConnectionOptions({ forWorker: true }) })
    : null;
  metricsQueue?.on("error", (error: Error) => {
    // Reported, not fatal. The metrics queue is observability; losing it must not cost capacity.
    console.error(`[worker] metrics queue error: ${error.message}`);
  });
  const healthServer = startHealthServer(scaling, {
    warmup: () => warmupRegistry.state(),
    async queueDepth() {
      if (!metricsQueue) return null;
      try {
        const counts = await metricsQueue.getJobCounts("waiting", "delayed");
        return (counts.waiting ?? 0) + (counts.delayed ?? 0);
      } catch {
        // NULL, never 0 — see healthServer.ts. Reporting zero for an unreadable queue would scale
        // the fleet in exactly when the backlog became invisible.
        return null;
      }
    },
    activeJobs: () => activeJobs,
    consumerRunning: () => consumerRunning,
    // The trace exporter's own counters. Reported so "traces are exported" is an observable fact
    // about this instance rather than a claim in a doc.
    traceExport: () => ({
      remoteConfigured: traceExport.remoteConfigured,
      exporterId: traceExport.exporter.id,
      stats: traceExport.buffer.stats(),
    }),
  });

  const shutdown = async () => {
    console.log("Stopping CodeFlow worker.");
    // Flipped BEFORE the close, so /health reports 503 for the whole drain rather than only after
    // the last job finishes. That is what lets a load balancer or scaler stop counting this
    // instance as capacity while it is still legitimately working through its in-flight jobs.
    consumerRunning = false;
    await worker.close();
    await metricsQueue?.close().catch(() => undefined);
    healthServer?.close();
    await retrieval?.sql?.end().catch(() => undefined);
    await mongoose.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  console.log(`CodeFlow worker listening on BullMQ queue "${ANALYSIS_QUEUE_NAME}".`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown worker startup error.";
  console.error(`CodeFlow worker failed to start: ${message}`);
  process.exit(1);
});
