import type { AnalysisMode, AnalysisResult, RepositoryRef } from "@codeflow/shared-types";
import { env } from "../config/env.js";
import { isMongoConnected } from "../db/connectMongo.js";
import { AnalysisModel } from "../db/models/AnalysisModel.js";
import { AnalysisOverflowModel } from "../db/models/AnalysisOverflowModel.js";
import {
  describeMissingOverflow,
  measureAnalysis,
  rehydrateAnalysis,
  splitOverflow,
  type OverflowField,
  type OverflowManifest,
} from "./analysisOverflow.js";

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
  /** Present only when heavy fields were externalized (V3-P5, ledger #20). */
  overflow?: OverflowManifest;
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

  return doc ? await withOverflow(fromMongoDocument(doc)) : null;
}

/**
 * Fetch and re-attach externalized fields (V3-P5, ledger #20).
 *
 * ONE EXTRA QUERY ONLY WHEN THERE IS A MANIFEST, which is the point of measuring rather than always
 * externalising: a normal-sized analysis reads exactly as it did before, with no join.
 *
 * A missing or unreachable overflow document does NOT fail the read. It attaches a warning naming
 * the fields instead, because `shared-types` documents absent `cpgEdges` as meaning "the parser
 * could not produce them" — so silently serving the shed document would turn a storage failure into
 * a false statement about the repository.
 */
async function withOverflow(record: CachedAnalysisRecord): Promise<CachedAnalysisRecord> {
  const manifest = record.overflow;
  if (!manifest || manifest.fields.length === 0) return record;

  let payload: Record<string, unknown> | null = null;
  try {
    const doc = await AnalysisOverflowModel.findOne({
      repoFullName: record.repoFullName,
      commitSha: record.commitSha,
      analyzerVersion: record.analyzerVersion,
    }).lean();
    payload = (doc?.payload as Record<string, unknown> | undefined) ?? null;
  } catch (error) {
    // Reported, not thrown: the rest of this analysis is still worth serving.
    console.warn(
      `[codeflow] overflow read failed for ${record.repoFullName}@${record.commitSha}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const { result, missing } = rehydrateAnalysis(record.result, manifest, payload);
  if (missing.length) {
    const warning = describeMissingOverflow(missing);
    console.warn(`[codeflow] ${warning}`);
    // Surfaced through the EXISTING honest-degradation channel rather than a new one: `warnings`
    // is already rendered to the user, so an incomplete analysis says so where they will see it.
    result.warnings = [...(result.warnings ?? []), warning];
  }
  return { ...record, result };
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

  // V3-P5 (ledger #20): measure, and externalize the heavy optional fields only if this document
  // would otherwise approach Mongo's 16MB ceiling. A normal analysis takes the original path
  // exactly — same document, no second collection, no manifest.
  const split = splitOverflow(input.result);

  if (split.stillTooLarge) {
    // Fail LOUDLY with the measurement. Mongo would reject this too, but with a driver error that
    // names no field; this names the sizes and the three largest remaining slices, which is the
    // difference between a diagnosable limit and a mystery.
    const measured = measureAnalysis(input.result);
    throw new Error(
      `Cannot store the analysis of ${input.repoFullName}@${input.commitSha}: ${split.stillTooLarge} ` +
        `(externalizable fields: ${measured.fields.map((entry) => `${entry.field}=${entry.count}`).join(", ")})`,
    );
  }

  if (split.manifest) {
    console.log(
      `[codeflow] analysis ${input.repoFullName}@${input.commitSha} externalized ` +
        `${split.manifest.fields.join(", ")} (${split.manifest.originalJsonBytes} -> ` +
        `${split.manifest.storedJsonBytes} JSON bytes).`,
    );
    // The overflow document is written FIRST, deliberately. If this write fails the analysis is
    // never stored, so the pair cannot end up with an analysis whose manifest points at nothing —
    // a state that would read as "incomplete" forever. The reverse order could produce it.
    await AnalysisOverflowModel.findOneAndUpdate(
      { repoFullName: input.repoFullName, commitSha: input.commitSha, analyzerVersion },
      { $set: { payload: split.payload, createdAt: completedAt } },
      { upsert: true },
    );
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
        result: split.stored,
        summary: input.result.summary,
        completedAt,
        durationMs: input.durationMs,
        ...(split.manifest ? { overflow: split.manifest } : {}),
      },
    },
    { returnDocument: "after", upsert: true },
  ).lean();

  // The record returned to the CALLER carries the complete result, not the shed one: this is the
  // response to the request that just produced the analysis, and handing back a stripped document
  // would make the analysis look incomplete to the one user guaranteed to be watching.
  return { ...fromMongoDocument(doc), result: { ...input.result, id: String((doc as { _id: unknown })._id) } };
}

function sanitizeId(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

export async function getAnalysisById(id: string): Promise<CachedAnalysisRecord | null> {
  if (!isMongoConnected()) {
    return analysesById.get(id) ?? null;
  }

  const doc = await AnalysisModel.findById(id).lean();
  return doc ? await withOverflow(fromMongoDocument(doc)) : null;
}

/**
 * Repositories this deployment has ACTUALLY analysed, newest first (V3-FINAL).
 *
 * For the workbench's "indexed:" recents row. A hardcoded list there would be the prototype's sample
 * repositories shipped as though they were the user's own history, which is the single most
 * convincing way to lie in a UI. So: real records, newest first, bounded, and an EMPTY list when
 * this deployment has analysed nothing — which the component renders as an honest empty state.
 *
 * Reads the same two paths every other function here does, so it is correct with or without Mongo.
 */
export interface IndexedAnalysis {
  analysisId: string;
  repoFullName: string;
  commitSha: string;
  /** Files in the analysed graph — enough for the row to be informative without a second fetch. */
  fileCount: number;
  completedAt: string;
}

export async function listIndexedAnalyses(limit: number): Promise<IndexedAnalysis[]> {
  const bounded = Math.max(0, Math.min(limit, 50));
  if (bounded === 0) return [];

  if (!isMongoConnected()) {
    return [...analysesById.values()]
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
      .slice(0, bounded)
      .map(toIndexed);
  }

  // Projected, not hydrated: the recents row needs five fields, and pulling whole analysis documents
  // (plus their overflow) to render a list would be a heavy read for a convenience feature.
  const docs = await AnalysisModel.find({}, { repoFullName: 1, commitSha: 1, summary: 1, completedAt: 1 })
    .sort({ completedAt: -1 })
    .limit(bounded)
    .lean();
  return docs.map((doc) => {
    const record = doc as unknown as {
      _id: unknown;
      repoFullName?: string;
      commitSha?: string;
      summary?: { files?: number };
      completedAt?: string | Date;
    };
    return {
      analysisId: String(record._id),
      repoFullName: record.repoFullName ?? "unknown",
      commitSha: record.commitSha ?? "",
      fileCount: record.summary?.files ?? 0,
      completedAt: toIso(record.completedAt),
    };
  });
}

function toIndexed(record: CachedAnalysisRecord): IndexedAnalysis {
  return {
    analysisId: record.id,
    repoFullName: record.repoFullName,
    commitSha: record.commitSha,
    fileCount: record.result.summary?.files ?? 0,
    completedAt: record.completedAt,
  };
}

function toIso(value: string | Date | undefined): string {
  if (!value) return new Date(0).toISOString();
  return typeof value === "string" ? value : value.toISOString();
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
    ...(doc.overflow
      ? {
          overflow: {
            fields: (doc.overflow.fields ?? []) as OverflowField[],
            originalJsonBytes: doc.overflow.originalJsonBytes ?? 0,
            storedJsonBytes: doc.overflow.storedJsonBytes ?? 0,
          },
        }
      : {}),
  };
}
