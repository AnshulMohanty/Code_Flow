import type {
  FileRole,
  Inventory,
  InventorySymbol,
  PipelineContext,
  PipelineInput,
  PipelineStage,
  ProgressEvent,
  Rag,
  RagChunk,
  RepoStructure,
  StageEmbeddingTarget,
  StageResult,
  TokenUsage,
} from "@codeflow/shared-types";
import type { EmbeddingClient, EmbeddingResult } from "../embedding/embeddingClient.js";
import { BudgetExceededError } from "../pipeline/errors.js";
import { embedCacheKey, type CachedEmbedding } from "../rag/embedCache.js";
import { estimateTokens, sumUsage } from "../util/tokens.js";

export interface RagDependencies {
  /** Injectable embedding client — tests mock it (no real API calls). */
  client: EmbeddingClient;
  /**
   * Reads repo-relative file CONTENTS (same shape Inventory/Orient use). Resolves null
   * when unreadable. Only called on the DISK path (ctx.repoPath present); on a no-disk
   * AI-only retry the chunk plan is loaded from the chunk-plan cache instead.
   */
  readFile(repoPath: string, relativePath: string): Promise<string | null>;
  /** Max embedding-API attempts per batch (1 initial + retries). Default 3. */
  maxAttempts?: number;
  /** Override the per-chunk token cap (defaults to MAX_CHUNK_TOKENS). For tests. */
  maxChunkTokens?: number;
  /** Override the fixed window size in lines (defaults to WINDOW_CHUNK_LINES). For tests. */
  windowLines?: number;
  /** Injectable clock (ms) for deterministic timing in tests. */
  now?: () => number;
}

// ── Named constants flagged for P4 tuning (validate on a genuinely large repo) ───────
// Roles we chunk. `source` is symbol-aware; `docs` (e.g. README) is window-chunked.
// config/build/asset/test/other are skipped for now. P4: revisit which roles to index.
const SYMBOL_CHUNK_ROLES = new Set<FileRole>(["source"]);
const WINDOW_CHUNK_ROLES = new Set<FileRole>(["docs"]);
// Per-chunk token cap. voyage-code-3's documented context length is 32K tokens
// (https://docs.voyageai.com/docs/embeddings). P4: retrieval granularity likely wants
// SMALLER chunks — measure on a real repo before lowering.
const MAX_CHUNK_TOKENS = 32_000;
// Fixed window (in lines) for docs files + the gap-sweep over uncovered source regions.
// P4-tunable alongside MAX_CHUNK_TOKENS.
const WINDOW_CHUNK_LINES = 60;
// Voyage per-request limits: ≤1000 texts and ≤120K total tokens. We batch under both.
const MAX_BATCH_TEXTS = 128;
const MAX_BATCH_TOKENS = 120_000;
// Chunk-plan cache-key version — manual cache-bust (bump on a chunking-algorithm change).
// The embedding-cache key lives in ../rag/embedCache.ts (shared with the query path).
const PLAN_CACHE_VERSION = "v1";

/** The deterministic chunk plan entry (a RagChunk WITHOUT its vector). */
type ChunkPlan = Omit<RagChunk, "embedding">;

/** What the chunk-plan cache stores (plain serializable; NO vectors). */
interface CachedChunkPlan {
  chunks: ChunkPlan[];
  droppedChunks?: { count: number; fileIds: string[] };
}


/**
 * Stage 8 — RAG (AI; the SECOND AI stage). Builds the Q&A index: chunk → embed → store
 * under `result.ai.rag`. Index-build ONLY — the retrieve/answer/cite query path is a
 * separate runtime path.
 *
 * Chunking is DETERMINISTIC and symbol-aware (driven by inventory.symbols + structure +
 * file contents), so every chunk inherits a real fileId + line range and citations are
 * grounded by construction. A code-enforced grounding pass then drops any chunk whose
 * fileId is not a graph node (recorded in `droppedChunks`); empty-after-grounding throws.
 * Unlike Synthesize there is NO retry on grounding — chunking is deterministic, so
 * re-running cannot change the outcome.
 *
 * Two caches (via ctx.cache, namespaced keys):
 *   1. Embedding cache (content-addressed) — re-embedding unchanged text costs zero API.
 *   2. Chunk-plan cache (SHA-keyed) — enables the no-disk AI-only retry: when ctx.repoPath
 *      is absent (a no-clone retry) the plan is loaded from cache instead of disk.
 *
 * Error contract (AI): a thrown embedding client (retries exhausted) or empty-after-
 * grounding makes the stage THROW → orchestrator records an AI failure → run "partial"
 * with deterministic + synthesis slices intact.
 */
export function createRagStage(deps: RagDependencies): PipelineStage<"aiRag"> & StageEmbeddingTarget {
  const now = deps.now ?? Date.now;
  const maxAttempts = deps.maxAttempts ?? 3;
  const maxChunkTokens = deps.maxChunkTokens ?? MAX_CHUNK_TOKENS;
  const windowLines = deps.windowLines ?? WINDOW_CHUNK_LINES;
  const client = deps.client;

  return {
    id: "rag",
    kind: "ai",
    label: "Indexing for Q&A",
    owns: ["aiRag"],
    // Exposes the (model, dim) this stage will produce so the orchestrator can reject a
    // cached rag slice from a different embedding space (index homogeneity).
    embeddingTarget: { model: client.model, dim: client.dimension },
    async run(input: PipelineInput, ctx: PipelineContext): Promise<StageResult<"aiRag">> {
      const startedAt = now();
      const graph = ctx.prior.graph;
      if (!graph) {
        throw new Error("RAG requires the graph slice; Connect must run first.");
      }
      const structure = ctx.prior.structure;
      const inventory = ctx.prior.inventory;
      const nodeIds = new Set(graph.nodes.map((node) => node.id));
      const planCacheKey = `rag/${PLAN_CACHE_VERSION}/${ctx.commitSha ?? "no-sha"}`;

      // --- Resolve the chunk plan: disk → cache → throw -----------------------
      let plan: ChunkPlan[];
      let droppedChunks: Rag["droppedChunks"];
      let fromCache = false;

      if (ctx.repoPath) {
        if (!structure) {
          throw new Error("RAG requires the structure slice; Map-structure must run first.");
        }
        const built = await buildChunkPlan({
          repoPath: ctx.repoPath,
          structure,
          inventory,
          nodeIds,
          readFile: deps.readFile,
          maxChunkTokens,
          windowLines,
        });
        plan = built.chunks;
        droppedChunks = built.droppedChunks;
        // Persist the GROUNDED plan BEFORE embedding so it survives a mid-embed failure
        // and powers a later no-disk AI-only retry. Plain data only (no vectors).
        const cached: CachedChunkPlan = { chunks: plan, ...(droppedChunks ? { droppedChunks } : {}) };
        await ctx.cache.set(planCacheKey, cached);
      } else {
        const cached = await ctx.cache.get<CachedChunkPlan>(planCacheKey);
        if (!cached) {
          // No working tree AND no cached plan — the orchestrator's post-Ingest fallback
          // legitimately clones to recover; here we cannot proceed.
          throw new Error("RAG has no repoPath and no cached chunk plan; cannot build the index.");
        }
        // The cached plan is already grounded; re-check fileId-in-graph defensively
        // (same SHA ⇒ same graph ⇒ no new drops), skip line-range (no disk to measure).
        const grounded = cached.chunks.filter((chunk) => nodeIds.has(chunk.fileId));
        plan = grounded;
        droppedChunks = cached.droppedChunks;
        fromCache = true;
      }

      if (plan.length === 0) {
        // Empty after grounding — no deterministic retry can change this (contrast
        // Synthesize, whose LLM is nondeterministic). Throw → AI failure → "partial".
        throw new Error("RAG produced no grounded chunks; nothing to index.");
      }

      // --- Embed (embedding cache → batch the misses, transient retry) --------
      const embeddings = await embedChunks(plan, ctx, client, maxAttempts);

      const chunks: RagChunk[] = plan
        .map((chunk, i) => ({ ...chunk, embedding: embeddings[i] }))
        .sort((a, b) => (a.fileId === b.fileId ? a.startLine - b.startLine : a.fileId.localeCompare(b.fileId)));

      const rag: Rag = {
        chunks,
        chunkCount: chunks.length,
        embeddingModel: client.model,
        embeddingDim: client.dimension,
        ...(droppedChunks ? { droppedChunks } : {}),
      };

      const event: ProgressEvent = {
        jobId: input.jobId,
        stage: "rag",
        stageIndex: 8,
        stageCount: 8,
        kind: "ai",
        status: "completed",
        label: "Indexing for Q&A",
        detail: `Indexed ${chunks.length} chunks (${client.model}, dim ${client.dimension})${
          droppedChunks ? `, ${droppedChunks.count} ungrounded dropped` : ""
        }${fromCache ? ", plan reused from cache" : ""}.`,
        progress: 0,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: now() - startedAt,
        preview: {
          chunkCount: chunks.length,
          embeddingModel: client.model,
          droppedChunks: droppedChunks?.count ?? 0,
          planFromCache: fromCache,
        },
        emittedAt: new Date(now()).toISOString(),
      };

      return { partial: { aiRag: rag }, event };
    },
  };
}

// ── Chunk planning (deterministic) ───────────────────────────────────────────

interface BuildChunkPlanArgs {
  repoPath: string;
  structure: RepoStructure;
  inventory: Inventory | undefined;
  nodeIds: Set<string>;
  readFile: RagDependencies["readFile"];
  maxChunkTokens: number;
  windowLines: number;
}

/**
 * Build the grounded chunk plan from disk. Source files are chunked symbol-aware (one
 * chunk per top-level symbol span, gaps swept into window chunks); docs files are
 * window-chunked. Each chunk is split to fit the token cap. Grounding (fileId ∈ graph,
 * line range within file) is enforced here; dropped chunks are recorded.
 */
async function buildChunkPlan(args: BuildChunkPlanArgs): Promise<{ chunks: ChunkPlan[]; droppedChunks?: Rag["droppedChunks"] }> {
  const symbolsByFile = groupSymbolsByFile(args.inventory?.symbols ?? []);

  // Stable file order so the overall plan is sorted by (fileId, startLine).
  const files = [...args.structure.files].sort((a, b) => a.path.localeCompare(b.path));

  const kept: ChunkPlan[] = [];
  const droppedFileIds = new Set<string>();
  let droppedCount = 0;

  for (const file of files) {
    const mode = chunkMode(file.role);
    if (!mode) continue;

    const content = await args.readFile(args.repoPath, file.path);
    if (content === null) continue; // unreadable — skip (not a stage failure)

    const lines = content.split("\n");
    const lineCount = lines.length;
    if (lineCount === 0 || (lineCount === 1 && lines[0] === "")) continue; // empty file

    const planned =
      mode === "source"
        ? planSourceFile(file.path, lines, symbolsByFile.get(file.path) ?? [], args)
        : planWindowFile(file.path, lines, args.windowLines, args.maxChunkTokens);

    // GROUNDING (enforced by code, never trusted): drop chunks whose fileId is not a
    // graph node or whose range falls outside the file.
    for (const chunk of planned) {
      const grounded =
        args.nodeIds.has(chunk.fileId) &&
        chunk.startLine >= 1 &&
        chunk.endLine >= chunk.startLine &&
        chunk.endLine <= lineCount;
      if (grounded) {
        kept.push(chunk);
      } else {
        droppedCount += 1;
        droppedFileIds.add(chunk.fileId);
      }
    }
  }

  kept.sort((a, b) => (a.fileId === b.fileId ? a.startLine - b.startLine : a.fileId.localeCompare(b.fileId)));

  return {
    chunks: kept,
    ...(droppedCount > 0 ? { droppedChunks: { count: droppedCount, fileIds: [...droppedFileIds].sort() } } : {}),
  };
}

/** "source" → symbol-aware, "docs" → window-chunked, else not indexed. */
function chunkMode(role: FileRole): "source" | "docs" | null {
  if (SYMBOL_CHUNK_ROLES.has(role)) return "source";
  if (WINDOW_CHUNK_ROLES.has(role)) return "docs";
  return null;
}

function groupSymbolsByFile(symbols: InventorySymbol[]): Map<string, InventorySymbol[]> {
  const map = new Map<string, InventorySymbol[]>();
  for (const symbol of symbols) {
    const bucket = map.get(symbol.filePath);
    if (bucket) bucket.push(symbol);
    else map.set(symbol.filePath, [symbol]);
  }
  return map;
}

interface Span {
  start: number;
  end: number;
  name: string;
}

/**
 * Symbol-aware plan for a source file. Selects non-overlapping TOP-LEVEL symbol spans
 * (a nested method inside a selected class span is subsumed), sweeps the gaps between
 * them — module header, top-level code — into window chunks so nothing is silently
 * dropped, and splits any oversized span/window to fit the token cap. Fully deterministic.
 */
function planSourceFile(fileId: string, lines: string[], symbols: InventorySymbol[], args: BuildChunkPlanArgs): ChunkPlan[] {
  const lineCount = lines.length;

  // Derive a [start, end] span for every symbol. When endLine is absent, extend to the
  // next symbol's start (bounded by a window) — keeps no-endLine symbols non-overlapping.
  const sorted = [...symbols].sort(
    (a, b) => a.line - b.line || (b.endLine ?? b.line) - (a.endLine ?? a.line) || a.name.localeCompare(b.name),
  );
  const spans: Span[] = sorted.map((symbol, i) => {
    const start = clamp(symbol.line, 1, lineCount);
    let end: number;
    if (symbol.endLine !== undefined) {
      end = symbol.endLine;
    } else {
      const nextStart = i + 1 < sorted.length ? sorted[i + 1].line : lineCount + 1;
      end = Math.min(nextStart - 1, start + args.windowLines - 1);
    }
    return { start, end: clamp(end, start, lineCount), name: symbol.name };
  });

  // Select non-overlapping spans in start order (classic interval cover).
  const selected: Span[] = [];
  let coveredUntil = 0;
  for (const span of spans) {
    if (span.start > coveredUntil) selected.push(span);
    coveredUntil = Math.max(coveredUntil, span.end);
  }

  // Interleave selected symbol spans with window chunks over the uncovered gaps.
  const chunks: ChunkPlan[] = [];
  let cursor = 1;
  for (const span of selected) {
    if (span.start > cursor) {
      chunks.push(...windowChunks(fileId, lines, cursor, span.start - 1, args.windowLines, args.maxChunkTokens, undefined));
    }
    chunks.push(...splitByTokens(fileId, lines, span.start, span.end, span.name, args.maxChunkTokens));
    cursor = span.end + 1;
  }
  if (cursor <= lineCount) {
    chunks.push(...windowChunks(fileId, lines, cursor, lineCount, args.windowLines, args.maxChunkTokens, undefined));
  }
  return chunks;
}

/** Window-chunk an entire file (docs role). */
function planWindowFile(fileId: string, lines: string[], windowLines: number, maxChunkTokens: number): ChunkPlan[] {
  return windowChunks(fileId, lines, 1, lines.length, windowLines, maxChunkTokens, undefined);
}

/** Fixed-window chunks over [from, to], each further token-split if oversized. */
function windowChunks(
  fileId: string,
  lines: string[],
  from: number,
  to: number,
  windowLines: number,
  maxChunkTokens: number,
  symbolName: string | undefined,
): ChunkPlan[] {
  const out: ChunkPlan[] = [];
  for (let start = from; start <= to; start += windowLines) {
    const end = Math.min(start + windowLines - 1, to);
    out.push(...splitByTokens(fileId, lines, start, end, symbolName, maxChunkTokens));
  }
  return out;
}

/**
 * Emit one chunk for [start, end], or split into contiguous line-range sub-chunks when
 * the text exceeds the token cap. A single line that alone exceeds the cap becomes its
 * own (over-cap) chunk — line granularity is the floor (flagged for P4).
 */
function splitByTokens(
  fileId: string,
  lines: string[],
  start: number,
  end: number,
  symbolName: string | undefined,
  maxChunkTokens: number,
): ChunkPlan[] {
  const whole = makeChunk(fileId, lines, start, end, symbolName);
  if (whole.tokenCount <= maxChunkTokens) return [whole];

  const out: ChunkPlan[] = [];
  let segStart = start;
  let segTokens = 0;
  for (let ln = start; ln <= end; ln++) {
    const lineTokens = estimateTokens(lines[ln - 1] + "\n");
    if (ln > segStart && segTokens + lineTokens > maxChunkTokens) {
      out.push(makeChunk(fileId, lines, segStart, ln - 1, symbolName));
      segStart = ln;
      segTokens = 0;
    }
    segTokens += lineTokens;
  }
  out.push(makeChunk(fileId, lines, segStart, end, symbolName));
  return out;
}

function makeChunk(fileId: string, lines: string[], start: number, end: number, symbolName: string | undefined): ChunkPlan {
  const text = lines.slice(start - 1, end).join("\n");
  return {
    id: `${fileId}#${start}-${end}`,
    fileId,
    startLine: start,
    endLine: end,
    ...(symbolName ? { symbolName } : {}),
    text,
    tokenCount: estimateTokens(text),
  };
}

// ── Embedding (cache → batch misses → transient retry) ───────────────────────

async function embedChunks(
  plan: ChunkPlan[],
  ctx: PipelineContext,
  client: EmbeddingClient,
  maxAttempts: number,
): Promise<number[][]> {
  // Document-side embedding-cache keys (shared helper): scoped by provider/model/dim AND
  // input_type, so a chunk and a query with identical text never collide.
  const keys = plan.map((chunk) => embedCacheKey(client.provider, client.model, client.dimension, "document", chunk.text));
  const embeddings: (number[] | null)[] = new Array(plan.length).fill(null);

  // 1) Embedding cache READ (wallet defense) — an unchanged repo costs ZERO API.
  for (let i = 0; i < plan.length; i++) {
    const hit = await ctx.cache.get<CachedEmbedding>(keys[i]);
    if (hit && Array.isArray(hit.embedding)) embeddings[i] = hit.embedding;
  }

  // 2) Batch the misses under Voyage's per-request limits, embed with transient retry,
  //    and write each result back to the cache.
  const missing = embeddings.map((value, i) => (value === null ? i : -1)).filter((i) => i >= 0);

  // Guard 5 — CACHE-BEFORE-BUDGET: only the MISSING chunks need a paid call (a full cache
  // hit ⇒ missing.length === 0 ⇒ budget untouched, free). Pre-check the daily budget with
  // a deterministic estimate (summed chunk tokenCount); if exhausted, degrade gracefully
  // (throw budget-exhausted ⇒ orchestrator "partial") WITHOUT calling the provider.
  const estimatedTokens = missing.reduce((sum, i) => sum + plan[i].tokenCount, 0);
  if (missing.length > 0 && ctx.budget && !(await ctx.budget.check(estimatedTokens, "embedding"))) {
    throw new BudgetExceededError("Daily LLM budget exhausted; RAG embedding skipped (demo at capacity).");
  }

  const usageParts: TokenUsage[] = [];
  for (const batch of batchIndices(missing, plan)) {
    const texts = batch.map((i) => plan[i].text);
    const { vectors, usage } = await embedWithRetry(client, texts, maxAttempts, ctx);
    usageParts.push(usage);
    for (let j = 0; j < batch.length; j++) {
      const i = batch[j];
      embeddings[i] = vectors[j];
      const entry: CachedEmbedding = { embedding: vectors[j], model: client.model, dim: client.dimension };
      await ctx.cache.set(keys[i], entry);
    }
  }

  // Record the provider's REAL usage after successful embedding — not the estimate above
  // (which exists only to admit the call). `measured: false` means a provider reported no
  // usage (today: Gemini's batch-embed endpoint), and that is logged rather than hidden.
  if (missing.length > 0 && ctx.budget) {
    const usage = sumUsage(usageParts);
    await ctx.budget.record(usage, "embedding");
    if (!usage.measured) {
      ctx.logger.warn("RAG: embedding provider reported no usage; budget recorded an ESTIMATE.", {
        provider: client.provider,
      });
    }
  }

  return embeddings.map((value, i) => {
    if (value === null) throw new Error(`RAG: chunk ${plan[i].id} was never embedded.`);
    return value;
  });
}

/** Greedily group miss indices into batches under MAX_BATCH_TEXTS and MAX_BATCH_TOKENS. */
function batchIndices(indices: number[], plan: ChunkPlan[]): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let tokens = 0;
  for (const i of indices) {
    const t = plan[i].tokenCount;
    if (current.length > 0 && (current.length >= MAX_BATCH_TEXTS || tokens + t > MAX_BATCH_TOKENS)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(i);
    tokens += t;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Transient retry on embedding-API failure (mirrors Synthesize's call retry). */
async function embedWithRetry(
  client: EmbeddingClient,
  texts: string[],
  maxAttempts: number,
  ctx: PipelineContext,
): Promise<EmbeddingResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await client.embed({ texts, inputType: "document" });
    } catch (error) {
      lastError = error;
      ctx.logger.warn("RAG embedding call failed; retrying if attempts remain.", {
        attempt,
        batchSize: texts.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw new Error(
    `RAG embedding failed after ${maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Estimate tokens for a piece of text. Voyage's tokenizer is not bundled, so this is a
 * documented heuristic (~4 chars/token) used only to drive chunk splitting + batching —
 * NOT billed. Deterministic (byte-stable) so the embedding cache key stays stable.
 * Flagged for P4 tuning against measured Voyage token counts.
 */


function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
