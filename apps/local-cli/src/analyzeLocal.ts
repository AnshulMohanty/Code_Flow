import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  createAnalyzeStage,
  createConnectStage,
  createInventoryStage,
  createMapStructureStage,
  createOrientStage,
  createRagStage,
  runPipeline,
  type WalkEntry,
} from "@codeflow/analyzers";
import {
  createFileChunkTextStore,
  createFileVectorStore,
  createLocalEmbeddingClient,
  createLexicalOverlapReranker,
  hybridSearch,
  LOCAL_EMBEDDING_MODEL,
  type ChunkTextStore,
  type VectorStore,
} from "@codeflow/retrieval";
import type { AnalysisResult, PipelineInput, PipelineStage } from "@codeflow/shared-types";

/**
 * LOCAL-FIRST ANALYSIS (V3-P5 task 4) — on-device, keyless, ZERO CODE EGRESS.
 *
 * WHAT MAKES THE EGRESS CLAIM CHECKABLE RATHER THAN ASSERTED. Every component on this path is
 * in-process:
 *   - parsing is `web-tree-sitter` WASM (already in from V3-P1, and the reason V3-P1 chose WASM over
 *     the native bindings was precisely so it could run here);
 *   - embedding is `createLocalEmbeddingClient` — feature hashing, no provider (see
 *     `localEmbedding.ts` for what that does and does not buy, and why an ONNX MiniLM was rejected);
 *   - the index is `createFileVectorStore` — a JSON file on disk (LanceDB probed and rejected: 656 MB
 *     and it drags `onnxruntime-node` back in);
 *   - retrieval is the SAME `hybridSearch` the hosted path uses.
 * There is no HTTP client, no socket and no provider key anywhere in this module's import graph. That
 * is a property a reader can verify by reading the imports, which is the strongest form the claim can
 * take.
 *
 * THE SYNTHESIZE STAGE IS ABSENT, deliberately. It needs an LLM, and there is no keyless local one —
 * so rather than degrade it into something that looks like a summary and is not, the local run stops
 * at a complete deterministic analysis plus a searchable index. That is genuinely useful (the graph,
 * the metrics, the communities, and Q&A retrieval all work offline) and it is honest about the one
 * thing it cannot do.
 *
 * IT SHARES THE CORE PACKAGES rather than reimplementing them: the same stages, the same graph, the
 * same chunker, the same grounding. So a local analysis and a hosted one cannot disagree about what
 * the code says — the only differences are the embedder and the store, both behind interfaces.
 */

export interface LocalAnalysisOptions {
  /** Repository root to analyse. */
  repoPath: string;
  /** Where the index is written. Defaults to `<repoPath>/.codeflow`. */
  indexDir?: string;
  /** Skip the RAG index build (deterministic analysis only). */
  skipIndex?: boolean;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  onProgress?(message: string): void;
}

export interface LocalAnalysisResult {
  result: AnalysisResult;
  /** Where the index lives, so a subsequent query can find it. */
  indexDir: string;
  namespace: string | null;
  chunkCount: number;
  /** Every stage that ran, with its status — the honest report of what a local run covers. */
  stages: Array<{ stage: string; status: string }>;
  warnings: string[];
}

/** Directories never worth walking. Same spirit as the hosted walker's ignores. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".codeflow",
  "__pycache__",
  ".venv",
  "venv",
]);

/** Read a repo-relative file. Returns null when unreadable — a single bad file is not a failure. */
async function readRepoFile(repoPath: string, relativePath: string): Promise<string | null> {
  try {
    return await readFile(path.join(repoPath, relativePath), "utf8");
  } catch {
    return null;
  }
}

/** List the immediate children of a repo-relative directory, in the shape Map-structure wants. */
async function readRepoDir(repoPath: string, relativeDir: string): Promise<WalkEntry[]> {
  const absolute = path.join(repoPath, relativeDir);
  // Names only, then `stat` for the kind. `withFileTypes` is the obvious choice and its `Dirent`
  // generic varies across @types/node versions, which would tie this file to one of them for no
  // behavioural gain.
  let names: string[];
  try {
    names = await readdir(absolute);
  } catch {
    return [];
  }
  const out: WalkEntry[] = [];
  for (const name of names) {
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(path.join(absolute, name));
    } catch {
      // Unreadable ⇒ skipped. A single inaccessible entry is not a failure of the analysis, and a
      // symlink to nowhere is the common cause.
      continue;
    }
    if (stats.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      out.push({ name, path: path.posix.join(relativeDir, name), type: "dir", sizeBytes: 0 });
      continue;
    }
    if (!stats.isFile()) continue;
    out.push({ name, path: path.posix.join(relativeDir, name), type: "file", sizeBytes: stats.size });
  }
  // Sorted, so a local analysis is as deterministic as a hosted one — directory order is
  // filesystem-dependent and would otherwise leak into the result.
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The local similarity FLOOR, and it is set from measurement rather than taste.
 *
 * Measured on the acceptance fixture with `codeflow-local-bow`:
 *   - a genuinely on-topic query ("AuthService login hash")            → cosine 0.683
 *   - a completely off-topic one ("kubernetes helm chart ingress ...") → cosine 0.051
 *
 * That 0.051 is not signal, it is HASH-COLLISION NOISE: feature hashing into 256 dimensions means two
 * unrelated token sets still land on a few shared dimensions, so the floor of a bag-of-words embedder
 * is never zero. The first version of this used 0.05, which is the noise level itself — so the refusal
 * silently stopped refusing, and the acceptance test caught it.
 *
 * 0.15 sits ~3x above the measured noise and ~4.5x below a real match. It is intentionally HIGHER than
 * the hosted floor: a lexical embedder has no semantic recall to protect, so a near-miss here is much
 * more likely to be a collision than a paraphrase.
 */
export const LOCAL_MIN_SIMILARITY = 0.15;

/** The two measurements the floor is derived from, exported so the test asserts the RELATIONSHIP
 *  rather than restating the constant — if a future embedder change raises the noise level, the test
 *  fails instead of the refusal quietly weakening. */
export const LOCAL_SIMILARITY_MEASURED = { offTopic: 0.051, onTopic: 0.683 } as const;

export async function analyzeLocal(options: LocalAnalysisOptions): Promise<LocalAnalysisResult> {
  const repoPath = path.resolve(options.repoPath);
  const indexDir = options.indexDir ?? path.join(repoPath, ".codeflow");
  const now = options.now ?? Date.now;
  const report = options.onProgress ?? (() => {});

  const embeddingClient = createLocalEmbeddingClient();
  const space = { embeddingModel: embeddingClient.model, embeddingDim: embeddingClient.dimension };
  const vectorStore: VectorStore = createFileVectorStore({ directory: indexDir, space });
  const textStore: ChunkTextStore = createFileChunkTextStore({ directory: indexDir });

  // A LOCAL INGEST stage, and it deliberately keeps the id `"ingest"`.
  //
  // The hosted Ingest CLONES; a local run already has the working tree, so cloning a directory that
  // is on disk would be slower and a betrayal of the premise. But this IS the ingest step —
  // resolving the working tree rather than fetching it — and keeping the id matters for two concrete
  // reasons: the scheduler treats `ingest` as the ambient dependency every other stage waits on (a
  // different id would let Orient launch before `ctx.repoPath` existed), and the coverage partition
  // and cache logic both key off stage ids.
  const stages: PipelineStage[] = [
    {
      id: "ingest",
      kind: "deterministic",
      label: "Reading the working tree",
      owns: [],
      async run(_input, ctx) {
        ctx.repoPath = repoPath;
        // A synthetic SHA rather than reading git: a local analysis is of the WORKING TREE, which
        // includes uncommitted changes, so reporting a commit hash would be a false claim about
        // what was analysed.
        ctx.commitSha = "local";
        return {
          partial: {},
          event: {
            jobId: input.jobId,
            stage: "ingest",
            stageIndex: 1,
            stageCount: stages.length,
            kind: "deterministic",
            status: "completed",
            label: "Reading the working tree",
            detail: `Using the working tree at ${repoPath} (no clone).`,
            progress: 0,
            startedAt: new Date(now()).toISOString(),
            durationMs: 0,
            emittedAt: new Date(now()).toISOString(),
          },
        };
      },
    },
    createOrientStage({ readFile: readRepoFile, now }),
    createMapStructureStage({ readDir: readRepoDir, readFile: readRepoFile, now }),
    createInventoryStage({ readFile: readRepoFile, now }),
    createConnectStage({ readFile: readRepoFile, now }),
    createAnalyzeStage({ now }),
  ];
  if (!options.skipIndex) {
    stages.push(createRagStage({ client: embeddingClient, vectorStore, textStore, readFile: readRepoFile, now }));
  }

  const input: PipelineInput = {
    jobId: `local-${path.basename(repoPath)}`,
    // `provider: "local"` is load-bearing rather than cosmetic: it flows into the retrieval namespace
    // and into the result, so a local index can never be confused with a hosted one.
    repositoryRef: { provider: "local", name: path.basename(repoPath) },
    mode: "public_hosted",
    analyzerVersion: "local",
  };

  report(`analysing ${repoPath} on-device (parser: web-tree-sitter WASM, embedder: ${LOCAL_EMBEDDING_MODEL})`);

  const { result } = await runPipeline(stages, input, {
    now,
    emit: (event) => report(`  ${event.stage}: ${event.status}${event.detail ? ` — ${event.detail}` : ""}`),
    // Layered scheduling is ON here without an env flag: a local run has no shared cache to
    // invalidate and no second replica to disagree with, and the slices are proven byte-identical
    // either way — so the only thing it changes is how long a developer waits.
    schedule: "layered",
  });

  return {
    result,
    indexDir,
    namespace: result.ai?.rag?.store?.namespace ?? null,
    chunkCount: result.ai?.rag?.chunkCount ?? 0,
    stages: (result.pipeline?.stages ?? []).map((record) => ({ stage: record.stage, status: record.status })),
    warnings: result.warnings,
  };
}

/**
 * Ask a question of a locally-built index. Retrieval only — there is no keyless local LLM, so this
 * returns the GROUNDED CHUNKS rather than prose.
 *
 * That is the honest shape for an offline tool, and arguably the more useful one: a developer with
 * the repository open wants "which lines answer this", and a summary would be a worse version of
 * what their editor already shows them. The similarity-floor refusal is unchanged, so "nothing here
 * is relevant" is still a real answer.
 */
export async function queryLocal(options: {
  result: AnalysisResult;
  indexDir: string;
  question: string;
  k?: number;
  /** Override the floor. Exposed for the eval harness, not for the CLI — a caller who lowers it is
   *  choosing to admit collision noise, and should have to say so. */
  minSimilarity?: number;
}): Promise<{ refused: boolean; topScore: number; chunks: Array<{ id: string; fileId: string; startLine: number; endLine: number; text: string }> }> {
  const embeddingClient = createLocalEmbeddingClient();
  const ragIndex = options.result.ai?.rag;
  if (!ragIndex) return { refused: true, topScore: 0, chunks: [] };

  const space = { embeddingModel: embeddingClient.model, embeddingDim: embeddingClient.dimension };
  const { vectors } = await embeddingClient.embed({ texts: [options.question], inputType: "query" });

  const found = await hybridSearch(
    {
      ragIndex,
      vectorStore: createFileVectorStore({ directory: options.indexDir, space }),
      textStore: createFileChunkTextStore({ directory: options.indexDir }),
      reranker: createLexicalOverlapReranker(),
    },
    { text: options.question, vector: vectors[0], k: options.k ?? 5, minSimilarity: options.minSimilarity ?? LOCAL_MIN_SIMILARITY },
  );

  return {
    refused: found.trace.refused,
    topScore: found.trace.topVectorScore,
    chunks: found.chunks.map((chunk) => ({
      id: chunk.id,
      fileId: chunk.fileId,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      text: chunk.text,
    })),
  };
}
