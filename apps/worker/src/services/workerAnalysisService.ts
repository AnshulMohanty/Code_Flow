import type { AnalysisCacheHandle, AnalysisJobPayload, AnalysisResult, BudgetHandle, EventLogStore, JobStatus, PipelineRunStatus, PipelineStageId, PipelineStatusReason, ProgressMessage } from "@codeflow/shared-types";
import path from "node:path";
import { DAILY_LLM_BUDGET } from "@codeflow/config";
import dotenv from "dotenv";
import mongoose from "mongoose";

// Monorepo has a single root .env; apps run with cwd = their package dir (apps/<app>), so
// resolve the repo-root .env explicitly rather than dotenv's cwd-relative default. Skip under
// the test runner (NODE_ENV=test) so the hermetic suite never picks up a developer's local .env.
if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
}

const { Schema, model, models } = mongoose;

export const ANALYSIS_QUEUE_NAME = "codeflow-analysis";

export const env = {
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/codeflow",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
};

export interface WorkerJobPatch {
  status?: JobStatus;
  progress?: number;
  currentStep?: string;
  parsedFiles?: number;
  totalFiles?: number;
  analysisId?: string;
  cached?: boolean;
  error?: string;
  commitSha?: string;
  runStatus?: PipelineRunStatus;
  runStatusReason?: PipelineStatusReason;
  skippedStages?: PipelineStageId[];
}

export interface SavedWorkerAnalysis {
  analysisId: string;
  result: AnalysisResult;
  cached?: boolean;
}

export interface WorkerAnalysisService {
  updateJob(jobId: string, patch: WorkerJobPatch): Promise<void>;
  findCachedAnalysis(input: { payload: AnalysisJobPayload; commitSha: string }): Promise<SavedWorkerAnalysis | null>;
  saveAnalysis(input: {
    payload: AnalysisJobPayload;
    result: AnalysisResult;
    durationMs: number;
    commitSha?: string;
  }): Promise<SavedWorkerAnalysis>;
}

export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db?: number;
  tls?: Record<string, never>;
  maxRetriesPerRequest?: null;
}

const repoSchema = new Schema(
  {
    provider: { type: String, enum: ["github"], required: true },
    owner: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    fullName: { type: String, required: true, unique: true, index: true },
    defaultBranch: { type: String, required: true, default: "main" },
    visibility: { type: String, enum: ["public", "private", "unknown"], required: true, default: "unknown" },
    cloneUrl: { type: String },
    stars: { type: Number },
    lastAnalyzedAt: { type: Date },
  },
  { strict: true, timestamps: true },
);

const analysisSchema = new Schema(
  {
    repoFullName: { type: String, required: true, index: true },
    repositoryRef: { type: Schema.Types.Mixed, required: true },
    commitSha: { type: String, required: true, index: true },
    branch: { type: String, required: true },
    mode: { type: String, enum: ["public_hosted"], required: true },
    analyzerVersion: { type: String, required: true, index: true },
    result: { type: Schema.Types.Mixed, required: true },
    summary: { type: Schema.Types.Mixed, required: true },
    completedAt: { type: Date, required: true },
    durationMs: { type: Number, required: true },
  },
  { strict: true, timestamps: { createdAt: true, updatedAt: false } },
);

analysisSchema.index(
  { repoFullName: 1, commitSha: 1, analyzerVersion: 1 },
  { unique: true, name: "analysis_cache_key" },
);

const jobSchema = new Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ["queued", "cloning", "parsing", "analyzing", "completed", "failed"], required: true },
    progress: { type: Number, required: true, default: 0 },
    currentStep: { type: String, required: true, default: "Analysis job queued." },
    parsedFiles: { type: Number, required: true, default: 0 },
    totalFiles: { type: Number, required: true, default: 42 },
    repoFullName: { type: String, required: true },
    analysisId: { type: String },
    cached: { type: Boolean, default: false },
    error: { type: String },
    runStatus: { type: String, enum: ["completed", "partial", "failed", "aborted"] },
    runStatusReason: { type: String, enum: ["repo-too-large", "budget-exhausted"] },
    // Stages that produced no output because they were never configured (unconfigured AI
    // providers). Lets the UI render an honest terminal state instead of eternal "pending".
    skippedStages: { type: [String], default: undefined },
    repositoryRef: { type: Schema.Types.Mixed, required: true },
    mode: { type: String, enum: ["public_hosted"], required: true },
    commitSha: { type: String, required: true },
    analyzerVersion: { type: String, required: true },
  },
  { strict: true, timestamps: true },
);

// LLM-output cache (PLAN §6): keyed on (commitSha + assembled-prompt hash), SEPARATE from
// the producedBy result-cache above. This is the wallet defense — re-runs of an AI stage
// with an identical prompt hit this cache instead of the paid API.
const llmCacheSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: Schema.Types.Mixed, required: true },
  },
  { strict: true, timestamps: { createdAt: true, updatedAt: false } },
);

// Global daily LLM budget (Guard 5, the wallet ceiling). One doc per UTC day; a new day
// gets a fresh doc (spent 0) — that IS the reset. Shared across worker instances.
const llmBudgetSchema = new Schema(
  {
    day: { type: String, required: true, unique: true, index: true }, // UTC YYYY-MM-DD
    spent: { type: Number, required: true, default: 0 },
  },
  { strict: true, timestamps: true },
);

// SSE replay buffer (#20): one doc per emitted ProgressMessage; `seq` preserves emit order.
// The API reads this same "jobevents" collection to replay a job from Ingest.
const eventLogSchema = new Schema(
  {
    jobId: { type: String, required: true, index: true },
    seq: { type: Number, required: true },
    message: { type: Schema.Types.Mixed, required: true },
  },
  { strict: true, timestamps: { createdAt: true, updatedAt: false } },
);
eventLogSchema.index({ jobId: 1, seq: 1 }, { unique: true });

const RepoModel = models.Repo || model("Repo", repoSchema, "repos");
const AnalysisModel = models.Analysis || model("Analysis", analysisSchema, "analyses");
const JobModel = models.Job || model("Job", jobSchema, "jobs");
const LlmCacheModel = models.LlmCache || model("LlmCache", llmCacheSchema, "llmcache");
const LlmBudgetModel = models.LlmBudget || model("LlmBudget", llmBudgetSchema, "llmbudget");
const EventLogModel = models.JobEvent || model("JobEvent", eventLogSchema, "jobevents");

/**
 * Mongo-backed `EventLogStore` (#20 replay buffer). The worker appends each emitted
 * ProgressMessage; the API reads the same collection to replay a job from Ingest.
 * Integration-only — exercised against real Mongo, not the hermetic suite.
 */
export function createMongoEventLogStore(): EventLogStore {
  return {
    async append(jobId: string, message: ProgressMessage): Promise<void> {
      // The replay buffer is BEST-EFFORT: the live SSE channel is the source of truth and the
      // API dedupes replay on stageIndex. A logging failure must NEVER crash the worker or fail
      // the job — so this never rejects. seq = (max existing) + 1 with a small retry, which
      // tolerates the read→insert race under worker concurrency and BullMQ job re-delivery (the
      // old `countDocuments` + `create` raced on the same seq and the unique {jobId,seq} index
      // threw E11000, which — fired un-awaited — took down the whole worker process).
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const last = await EventLogModel.findOne({ jobId }).sort({ seq: -1 }).select("seq").lean();
          const seq = last ? (last.seq as number) + 1 : 0;
          await EventLogModel.create({ jobId, seq, message });
          return;
        } catch (error) {
          if (isDuplicateKeyError(error) && attempt < 4) continue; // lost the seq race — recompute
          console.warn(`[eventLog] append failed for job ${jobId} (non-fatal): ${(error as Error).message}`);
          return;
        }
      }
    },
    async read(jobId: string): Promise<ProgressMessage[]> {
      const docs = await EventLogModel.find({ jobId }).sort({ seq: 1 }).lean();
      return docs.map((doc) => doc.message as ProgressMessage);
    },
  };
}

/** True for a MongoDB duplicate-key error (code 11000), however the driver surfaces it. */
function isDuplicateKeyError(error: unknown): boolean {
  const code = (error as { code?: number; errorResponse?: { code?: number } })?.code;
  const nested = (error as { errorResponse?: { code?: number } })?.errorResponse?.code;
  return code === 11000 || nested === 11000;
}

/**
 * Mongo-backed AnalysisCacheHandle for AI-stage completions. Persists across runs so a
 * repo whose analysis is re-triggered (e.g. an AI stage previously failed) re-uses the
 * cached completion instead of re-calling the LLM API.
 */
export function createMongoCacheHandle(): AnalysisCacheHandle {
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const doc = await LlmCacheModel.findOne({ key }).lean();
      return doc ? (doc.value as T) : null;
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      await LlmCacheModel.findOneAndUpdate({ key }, { $set: { key, value } }, { upsert: true });
    },
  };
}

/**
 * Mongo-backed `BudgetHandle` for the global daily LLM-spend ceiling (Guard 5). Persists
 * across worker instances/restarts; the per-UTC-day document IS the reset boundary. Mirrors
 * the in-memory handle's mechanics (check estimate ≤ remaining; record adds to the day's
 * total). Integration-only — exercised against real Mongo, not the hermetic suite.
 */
export function createMongoBudgetHandle(limitTokens: number = DAILY_LLM_BUDGET): BudgetHandle {
  const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    async check(estimatedTokens: number): Promise<boolean> {
      const doc = await LlmBudgetModel.findOne({ day: utcDay(Date.now()) }).lean();
      const spent = doc ? (doc.spent as number) : 0;
      return spent + estimatedTokens <= limitTokens;
    },
    async record(actualTokens: number): Promise<void> {
      const day = utcDay(Date.now());
      await LlmBudgetModel.findOneAndUpdate(
        { day },
        { $inc: { spent: actualTokens }, $setOnInsert: { day } },
        { upsert: true },
      );
    },
  };
}

export function createMongoWorkerAnalysisService(): WorkerAnalysisService {
  return {
    async updateJob(jobId, patch) {
      const doc = await JobModel.findOneAndUpdate({ jobId }, { $set: patch }, { returnDocument: "after" }).lean();
      if (!doc) {
        throw new Error(`Analysis job not found: ${jobId}`);
      }
    },
    async findCachedAnalysis({ payload, commitSha }) {
      const repoFullName = formatRepoFullName(payload.repositoryRef);
      const doc = await AnalysisModel.findOne({
        repoFullName,
        commitSha,
        analyzerVersion: payload.analyzerVersion,
      }).lean();

      if (!doc) {
        return null;
      }

      return {
        analysisId: String(doc._id),
        result: { ...(doc.result as AnalysisResult), id: String(doc._id) },
        cached: true,
      };
    },
    async saveAnalysis({ payload, result, durationMs, commitSha }) {
      const repoFullName = formatRepoFullName(payload.repositoryRef);
      const actualCommitSha = commitSha ?? payload.commitSha;
      const branch = payload.repositoryRef.branch ?? "main";

      await RepoModel.findOneAndUpdate(
        { fullName: repoFullName },
        {
          $set: {
            provider: "github",
            owner: payload.repositoryRef.owner ?? "unknown",
            name: payload.repositoryRef.name,
            fullName: repoFullName,
            defaultBranch: branch,
            visibility: "public",
            cloneUrl: payload.repositoryRef.url,
            lastAnalyzedAt: new Date(),
          },
        },
        { returnDocument: "after", upsert: true },
      );

      const completedAt = new Date();
      const doc = await AnalysisModel.findOneAndUpdate(
        {
          repoFullName,
          commitSha: actualCommitSha,
          analyzerVersion: payload.analyzerVersion,
        },
        {
          $setOnInsert: {
            repoFullName,
            repositoryRef: payload.repositoryRef,
            commitSha: actualCommitSha,
            branch,
            mode: payload.mode,
            analyzerVersion: payload.analyzerVersion,
            result,
            summary: result.summary,
            completedAt,
            durationMs,
          },
        },
        { returnDocument: "after", upsert: true },
      ).lean();

      return {
        analysisId: String(doc._id),
        result: { ...result, id: String(doc._id) },
      };
    },
  };
}

export function createRedisConnectionOptions(options: { forWorker?: boolean } = {}): RedisConnectionOptions {
  const url = new URL(env.redisUrl);
  const connection: RedisConnectionOptions = {
    host: url.hostname,
    port: Number(url.port || 6379),
  };

  if (url.username) {
    connection.username = decodeURIComponent(url.username);
  }
  if (url.password) {
    connection.password = decodeURIComponent(url.password);
  }
  if (url.pathname && url.pathname !== "/") {
    connection.db = Number(url.pathname.slice(1));
  }
  if (url.protocol === "rediss:") {
    connection.tls = {};
  }
  if (options.forWorker) {
    connection.maxRetriesPerRequest = null;
  }

  return connection;
}

function formatRepoFullName(repositoryRef: AnalysisJobPayload["repositoryRef"]) {
  return `${repositoryRef.owner ?? "unknown"}/${repositoryRef.name}`;
}
