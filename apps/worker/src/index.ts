import path from "node:path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Worker } from "bullmq";
import type { AnalysisJobPayload } from "@codeflow/shared-types";
import { createEmbeddingClientFromEnv, createLlmClientFromEnv } from "@codeflow/analyzers";
import { ANALYSIS_QUEUE_NAME, createRedisConnectionOptions, env } from "./services/workerAnalysisService.js";
import { createMongoBudgetHandle, createMongoCacheHandle, createMongoEventLogStore, createMongoWorkerAnalysisService } from "./services/workerAnalysisService.js";
import { runAnalysisJob } from "./processors/pipelineJobProcessor.js";
import { createGitRepoCloner } from "./services/gitRepoCloner.js";
import { createBullmqProgressPublisher } from "./services/progressPublisher.js";
import { readRepoFile } from "./services/repoFileReader.js";
import { readRepoDir } from "./services/repoDirectoryWalker.js";
import { measureRepoSize } from "./services/measureRepoSize.js";
import { cleanupRepoPath } from "./services/publicRepoCloneService.js";

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
  const budget = createMongoBudgetHandle(); // Guard 5 — global daily LLM-spend ceiling
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

  const embeddingClient = createEmbeddingClientFromEnv(process.env);
  console.log(
    embeddingClient
      ? `RAG (AI) enabled — provider ${embeddingClient.provider}, model ${embeddingClient.model} (dim ${embeddingClient.dimension}).`
      : "RAG (AI) disabled: no embedding provider key configured.",
  );

  const worker = new Worker<AnalysisJobPayload>(
    ANALYSIS_QUEUE_NAME,
    async (job) => {
      console.log(`Processing analysis job ${job.data.jobId}.`);
      await runAnalysisJob(job.data, {
        service,
        cloner,
        publisher: createBullmqProgressPublisher(job),
        readFile: readRepoFile,
        readDir: readRepoDir,
        measureRepoSize,
        cleanupRepo: cleanupRepoPath,
        synthesisClient,
        embeddingClient,
        cache,
        budget,
        eventLog,
      });
      console.log(`Completed analysis job ${job.data.jobId}.`);
    },
    {
      connection: createRedisConnectionOptions({ forWorker: true }),
      concurrency: 2,
    },
  );

  worker.on("failed", (job, error) => {
    console.error(`Analysis job ${job?.data.jobId ?? "unknown"} failed: ${error.message}`);
  });

  const shutdown = async () => {
    console.log("Stopping CodeFlow worker.");
    await worker.close();
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
