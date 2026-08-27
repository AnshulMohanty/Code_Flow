import { randomUUID } from "node:crypto";
import type { AnalysisMode, JobProgress, JobStatus, PipelineRunStatus, PipelineStageId, PipelineStatusReason, RepositoryRef } from "@codeflow/shared-types";
import { ApiError } from "../middleware/errorHandler.js";
import { isMongoConnected } from "../db/connectMongo.js";
import { JobModel } from "../db/models/JobModel.js";

export interface AnalysisJobRecord {
  id: string;
  jobId: string;
  repositoryRef: RepositoryRef;
  repoFullName: string;
  mode: AnalysisMode;
  status: JobStatus;
  progress: number;
  currentStep: string;
  parsedFiles: number;
  totalFiles: number;
  commitSha: string;
  analyzerVersion: string;
  analysisId?: string;
  cached: boolean;
  error?: string;
  runStatus?: PipelineRunStatus;
  runStatusReason?: PipelineStatusReason;
  /** Stages the worker reported as never-configured (unconfigured AI providers). */
  skippedStages?: PipelineStageId[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateAnalysisJobInput {
  repositoryRef: RepositoryRef;
  repoFullName: string;
  mode: AnalysisMode;
  commitSha: string;
  analyzerVersion: string;
  analysisId?: string;
  cached?: boolean;
  status?: JobStatus;
  progress?: number;
  currentStep?: string;
  parsedFiles?: number;
  totalFiles?: number;
  runStatus?: PipelineRunStatus;
  runStatusReason?: PipelineStatusReason;
  skippedStages?: PipelineStageId[];
}

const inMemoryJobs = new Map<string, AnalysisJobRecord>();

export async function createAnalysisJob(input: CreateAnalysisJobInput): Promise<AnalysisJobRecord> {
  const now = new Date().toISOString();
  const status = input.status ?? "queued";
  const progress = input.progress ?? (status === "completed" ? 1 : 0);
  const job: AnalysisJobRecord = {
    id: randomUUID(),
    jobId: randomUUID(),
    repositoryRef: input.repositoryRef,
    repoFullName: input.repoFullName,
    mode: input.mode,
    status,
    progress,
    currentStep: input.currentStep ?? (status === "completed" ? "Analysis completed." : "Analysis job queued."),
    // File counts are only known once the worker has walked the tree; 0 until then rather
    // than a fabricated placeholder.
    parsedFiles: input.parsedFiles ?? 0,
    totalFiles: input.totalFiles ?? 0,
    commitSha: input.commitSha,
    analyzerVersion: input.analyzerVersion,
    analysisId: input.analysisId,
    cached: input.cached ?? false,
    runStatus: input.runStatus,
    runStatusReason: input.runStatusReason,
    skippedStages: input.skippedStages,
    createdAt: now,
    updatedAt: now,
  };

  if (!isMongoConnected()) {
    inMemoryJobs.set(job.jobId, job);
    return job;
  }

  const doc = await JobModel.create({
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    currentStep: job.currentStep,
    parsedFiles: job.parsedFiles,
    totalFiles: job.totalFiles,
    repoFullName: job.repoFullName,
    analysisId: job.analysisId,
    cached: job.cached,
    runStatus: job.runStatus,
    runStatusReason: job.runStatusReason,
    skippedStages: job.skippedStages,
    repositoryRef: job.repositoryRef,
    mode: job.mode,
    commitSha: job.commitSha,
    analyzerVersion: job.analyzerVersion,
  });

  return fromMongoDocument(doc.toObject());
}

export async function updateAnalysisJob(
  jobId: string,
  patch: Partial<
    Pick<
      AnalysisJobRecord,
      | "status"
      | "progress"
      | "currentStep"
      | "parsedFiles"
      | "totalFiles"
      | "analysisId"
      | "cached"
      | "error"
      | "runStatus"
      | "runStatusReason"
      | "skippedStages"
    >
  >,
): Promise<AnalysisJobRecord> {
  if (!isMongoConnected()) {
    const job = await getAnalysisJob(jobId);
    const updated = {
      ...job,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    inMemoryJobs.set(jobId, updated);
    return updated;
  }

  const doc = await JobModel.findOneAndUpdate({ jobId }, { $set: patch }, { returnDocument: "after" }).lean();
  if (!doc) {
    throw new ApiError(404, "NOT_FOUND", `Analysis job not found: ${jobId}`, { id: jobId });
  }
  return fromMongoDocument(doc);
}

export async function getAnalysisJob(jobId: string): Promise<AnalysisJobRecord> {
  if (!isMongoConnected()) {
    const job = inMemoryJobs.get(jobId);
    if (!job) {
      throw new ApiError(404, "NOT_FOUND", `Analysis job not found: ${jobId}`, { id: jobId });
    }
    return job;
  }

  const doc = await JobModel.findOne({ jobId }).lean();
  if (!doc) {
    throw new ApiError(404, "NOT_FOUND", `Analysis job not found: ${jobId}`, { id: jobId });
  }
  return fromMongoDocument(doc);
}

export async function getAnalysisJobProgress(jobId: string): Promise<JobProgress & {
  id: string;
  progress: number;
  currentStep: string;
  parsedFiles: number;
  totalFiles: number;
  createdAt: string;
}> {
  const job = await getAnalysisJob(jobId);
  return {
    id: job.jobId,
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    percent: Math.round(job.progress * 100),
    currentStep: job.currentStep,
    parsedFiles: job.parsedFiles,
    totalFiles: job.totalFiles,
    message: job.error ?? job.currentStep,
    analysisId: job.analysisId,
    cached: job.cached,
    error: job.error,
    // #19 — terminal pipeline outcome on REST (SSE is for live watching only).
    ...(job.runStatus ? { runStatus: job.runStatus } : {}),
    ...(job.runStatusReason ? { runStatusReason: job.runStatusReason } : {}),
    // Never-configured stages, so the UI can settle those rows instead of spinning.
    ...(job.skippedStages?.length ? { skippedStages: job.skippedStages } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function clearAnalysisJobsForTests() {
  inMemoryJobs.clear();
}

function fromMongoDocument(doc: any): AnalysisJobRecord {
  return {
    id: String(doc._id),
    jobId: doc.jobId,
    repositoryRef: doc.repositoryRef,
    repoFullName: doc.repoFullName,
    mode: doc.mode,
    status: doc.status,
    progress: doc.progress,
    currentStep: doc.currentStep,
    parsedFiles: doc.parsedFiles,
    totalFiles: doc.totalFiles,
    commitSha: doc.commitSha,
    analyzerVersion: doc.analyzerVersion,
    analysisId: doc.analysisId,
    cached: Boolean(doc.cached),
    error: doc.error,
    runStatus: doc.runStatus,
    runStatusReason: doc.runStatusReason,
    skippedStages: doc.skippedStages,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}
