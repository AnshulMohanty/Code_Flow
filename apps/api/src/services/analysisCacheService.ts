import type { AnalysisMode, AnalysisResult, RepositoryRef } from "@codeflow/shared-types";
import { env } from "../config/env.js";
import { isMongoConnected } from "../db/connectMongo.js";
import { AnalysisModel } from "../db/models/AnalysisModel.js";

export interface AnalysisCacheKey {
  repoFullName: string;
  commitSha: string;
  analyzerVersion?: string;
}

export interface CachedAnalysisRecord {
  id: string;
  repoFullName: string;
  repositoryRef: RepositoryRef;
  commitSha: string;
  branch: string;
  mode: AnalysisMode;
  analyzerVersion: string;
  result: AnalysisResult;
  summary: AnalysisResult["summary"];
  completedAt: string;
  durationMs: number;
  createdAt: string;
}

const inMemoryAnalyses = new Map<string, CachedAnalysisRecord>();
const analysesById = new Map<string, CachedAnalysisRecord>();

export async function findCachedAnalysis(key: AnalysisCacheKey): Promise<CachedAnalysisRecord | null> {
  const analyzerVersion = key.analyzerVersion ?? env.analyzerVersion;
  if (!isMongoConnected()) {
    return inMemoryAnalyses.get(cacheKey({ ...key, analyzerVersion })) ?? null;
  }

  const doc = await AnalysisModel.findOne({
    repoFullName: key.repoFullName,
    commitSha: key.commitSha,
    analyzerVersion,
  }).lean();

  return doc ? fromMongoDocument(doc) : null;
}

export async function saveAnalysis(input: {
  repoFullName: string;
  repositoryRef: RepositoryRef;
  commitSha: string;
  branch: string;
  mode: AnalysisMode;
  result: AnalysisResult;
  durationMs: number;
  analyzerVersion?: string;
}): Promise<CachedAnalysisRecord> {
  const analyzerVersion = input.analyzerVersion ?? env.analyzerVersion;
  const completedAt = new Date();

  if (!isMongoConnected()) {
    const id = `memory-${sanitizeId(cacheKey({ ...input, analyzerVersion }))}`;
    const record: CachedAnalysisRecord = {
      id,
      repoFullName: input.repoFullName,
      repositoryRef: input.repositoryRef,
      commitSha: input.commitSha,
      branch: input.branch,
      mode: input.mode,
      analyzerVersion,
      result: { ...input.result, id },
      summary: input.result.summary,
      completedAt: completedAt.toISOString(),
      durationMs: input.durationMs,
      createdAt: completedAt.toISOString(),
    };
    inMemoryAnalyses.set(cacheKey({ ...input, analyzerVersion }), record);
    analysesById.set(id, record);
    return record;
  }

  const doc = await AnalysisModel.findOneAndUpdate(
    {
      repoFullName: input.repoFullName,
      commitSha: input.commitSha,
      analyzerVersion,
    },
    {
      $setOnInsert: {
        repoFullName: input.repoFullName,
        repositoryRef: input.repositoryRef,
        commitSha: input.commitSha,
        branch: input.branch,
        mode: input.mode,
        analyzerVersion,
        result: input.result,
        summary: input.result.summary,
        completedAt,
        durationMs: input.durationMs,
      },
    },
    { returnDocument: "after", upsert: true },
  ).lean();

  return fromMongoDocument(doc);
}

function sanitizeId(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

export async function getAnalysisById(id: string): Promise<CachedAnalysisRecord | null> {
  if (!isMongoConnected()) {
    return analysesById.get(id) ?? null;
  }

  const doc = await AnalysisModel.findById(id).lean();
  return doc ? fromMongoDocument(doc) : null;
}

export function clearAnalysisCacheForTests() {
  inMemoryAnalyses.clear();
  analysesById.clear();
}

function cacheKey(key: AnalysisCacheKey) {
  return `${key.repoFullName}:${key.commitSha}:${key.analyzerVersion ?? env.analyzerVersion}`;
}

function fromMongoDocument(doc: any): CachedAnalysisRecord {
  const id = String(doc._id);
  return {
    id,
    repoFullName: doc.repoFullName,
    repositoryRef: doc.repositoryRef,
    commitSha: doc.commitSha,
    branch: doc.branch,
    mode: doc.mode,
    analyzerVersion: doc.analyzerVersion,
    result: { ...doc.result, id },
    summary: doc.summary,
    completedAt: new Date(doc.completedAt).toISOString(),
    durationMs: doc.durationMs,
    createdAt: new Date(doc.createdAt).toISOString(),
  };
}
