import { execFile } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createDirectoryFactsStore } from "./factsCache.js";
import { factsStoreStats, setFactsStore, type FactsStore } from "@codeflow/parsers";
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
 * Local analysis: on-device, keyless, no code leaves the machine. Parsing is tree-sitter WASM, embedding
 * is `createLocalEmbeddingClient` (feature hashing), the index is a JSON file (`createFileVectorStore`),
 * retrieval is the same `hybridSearch` as hosted — the same stages and grounding, so a local and a
 * hosted analysis cannot disagree about the code.
 *
 * "No egress", precisely: `@codeflow/analyzers`' barrel makes two fetch-capable modules REACHABLE, but
 * nothing here constructs a provider client, and the published bundle contains no `fetch` call and no
 * provider hostname (Rollup drops them). `__tests__/zeroEgress.test.ts` asserts both, with the exact list
 * of reachable modules. Synthesize is absent on purpose: there is no keyless local LLM, and a fake
 * summary would be worse than none.
 */

export interface LocalAnalysisOptions {
  /** Repository root to analyse. */
  repoPath: string;
  /** Where the index is written. Defaults to `<repoPath>/.codeflow`. */
  indexDir?: string;
  /** Skip the RAG index build (deterministic analysis only). */
  skipIndex?: boolean;
  /**
   * Per-file parse cache (incremental analysis). Default: a directory store at `<indexDir>/cache`, so
   * a re-run parses only changed files. `false` disables it; a store can be passed to share one
   * across analyses in one process (`impact` analyses head and base).
   */
  factsCache?: FactsStore | false;
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

/**
 * Directories never listed: this tool's own index, plus heavy trees Map-structure hard-ignores
 * anyway. Ambiguous names (`build`, `out`, `coverage`) are NOT here — Map-structure decides those
 * by content (a Go package named `coverage` is source), and a second list would overrule it.
 */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next", ".turbo", ".codeflow", "__pycache__", ".venv", "venv"]);

/**
 * Read a repo-relative file. Returns null when unreadable — a single bad file is not a failure — and
 * when it resolves OUTSIDE the repository: the GitHub Action runs this on a pull request's code, and
 * a committed `README.md -> /proc/self/environ` must not be read into the analysis.
 */
async function readRepoFile(repoPath: string, relativePath: string): Promise<string | null> {
  try {
    const [root, real] = await Promise.all([realpath(repoPath), realpath(path.join(repoPath, relativePath))]);
    if (real !== root && !real.startsWith(root + path.sep)) return null;
    return await readFile(real, "utf8");
  } catch {
    return null;
  }
}

/** The files git tracks in `repoPath`, or null when it is not a git checkout (or git is missing). */
function gitTrackedFiles(repoPath: string): Promise<ReadonlySet<string> | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repoPath, "ls-files", "-z"], { maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : new Set(stdout.split("\u0000").filter(Boolean)));
    });
  });
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
 * 0.15 sits ~3x above the measured noise and ~4.5x below a real match. It is not comparable with the
 * hosted floor (`RAG_MIN_SIMILARITY`, 0.2): that one is a cosine between a real model's embeddings,
 * this one between 256-dimension hashed bags of words, so each is set against its own noise level.
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
    createMapStructureStage({ readDir: readRepoDir, readFile: readRepoFile, trackedFiles: gitTrackedFiles, now }),
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

  setFactsStore(
    options.factsCache === false ? null : (options.factsCache ?? createDirectoryFactsStore(path.join(indexDir, "cache"))),
  );
  let pipeline: Awaited<ReturnType<typeof runPipeline>>;
  try {
    pipeline = await runPipeline(stages, input, {
    now,
    emit: (event) => report(`  ${event.stage}: ${event.status}${event.detail ? ` — ${event.detail}` : ""}`),
    // Layered scheduling is ON here without an env flag: a local run has no shared cache to
    // invalidate and no second replica to disagree with, and the slices are proven byte-identical
    // either way — so the only thing it changes is how long a developer waits.
    schedule: "layered",
    });
  } finally {
    const { hits, misses } = factsStoreStats();
    if (hits + misses > 0) report(`  parse cache: ${hits} file(s) reused, ${misses} parsed`);
    setFactsStore(null);
  }
  const { result } = pipeline;

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
