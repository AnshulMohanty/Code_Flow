import type {
  AnalysisResultSlices,
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
import {
  assertEmbeddingSpace,
  deriveEnrichment,
  embedTextFor,
  retrievalNamespace,
  type ChunkTextStore,
  type SymbolSpan,
  type VectorRecord,
  type VectorStore,
} from "@codeflow/retrieval";
import type { EmbeddingClient, EmbeddingResult } from "../embedding/embeddingClient.js";
import { BudgetExceededError } from "../pipeline/errors.js";
import { embedCacheKey, type CachedEmbedding } from "../rag/embedCache.js";
import type { StageSpeculationSource } from "../pipeline/speculation.js";
import { estimateTokens, sumUsage } from "../util/tokens.js";

export interface RagDependencies {
  /** Injectable embedding client — tests mock it (no real API calls). */
  client: EmbeddingClient;
  /**
   * Where the VECTORS go (V3-P2). Injected, never constructed here: the hermetic suite passes
   * `createMemoryVectorStore`, production passes the pgvector adapter, and this stage does not
   * know or care which. Its `space` is checked against `client` before a single write.
   */
  vectorStore: VectorStore;
  /** Where the chunk TEXT goes (V3-P2). Same injection rule as `vectorStore`. */
  textStore: ChunkTextStore;
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
// v2 (V3-P2): plan entries now carry `enrichment`, so a v1 cached plan would produce
// un-enriched chunks on the no-disk retry path — silently worse retrieval, not a crash.
const PLAN_CACHE_VERSION = "v2";

/**
 * The deterministic chunk plan entry: the persisted metadata PLUS the text, which is what
 * gets embedded and then written to the text store. `RagChunk` itself no longer carries
 * `text` (V3-P2), so the plan states the extra field explicitly rather than subtracting one.
 */
type ChunkPlan = RagChunk & { text: string };

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
 * V3-P2 — WHERE THE OUTPUT GOES. The vectors are written to an injected `VectorStore` and
 * the chunk text to an injected `ChunkTextStore`, both keyed by (namespace, chunk id); the
 * `aiRag` slice keeps only metadata + a `store` reference. Writes are ordered TEXT FIRST, then
 * VECTORS, and that order is not arbitrary: the vector store is what a search reads, so if the
 * process dies between the two, the worst case is text nobody can find (harmless, overwritten
 * on retry) rather than searchable hits whose text is missing (a retrieved chunk with no
 * content, which would reach a prompt as a citation of code the model never saw).
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
export function createRagStage(
  deps: RagDependencies,
): PipelineStage<"aiRag"> & StageEmbeddingTarget & StageSpeculationSource {
  const now = deps.now ?? Date.now;
  const maxAttempts = deps.maxAttempts ?? 3;
  const maxChunkTokens = deps.maxChunkTokens ?? MAX_CHUNK_TOKENS;
  const windowLines = deps.windowLines ?? WINDOW_CHUNK_LINES;
  const client = deps.client;

  /** Where a plan lives in the shared cache. One definition, used by both the stage and its
   *  speculation — two string templates would be a silent cache miss waiting to happen. */
  const planKeyFor = (commitSha: string | undefined) => `rag/${PLAN_CACHE_VERSION}/${commitSha ?? "no-sha"}`;

  return {
    id: "rag",
    kind: "ai",
    label: "Indexing for Q&A",
    owns: ["aiRag"],

    /**
     * SPECULATION (V3-P5 task 1, wired V3-FINAL): build the chunk plan early.
     *
     * WHY THIS TASK AND NOT ANOTHER. The plan is a pure disk+CPU pass over every source file —
     * read, split, interval-cover the symbol spans, sweep the gaps. It costs no money and calls no
     * provider, which is exactly the rule speculation must obey. And it becomes computable the
     * moment `connect` lands (it needs graph node ids, structure and inventory), while the stage
     * that needs it runs LAST — after `synthesize` has spent seconds blocked on a chat provider.
     * In sequential mode that entire wait is currently unused; here it pays for the plan.
     *
     * THE VALUE IS BYTE-IDENTICAL, which is what makes it safe on a deterministic-adjacent path:
     * same function, same inputs, and the inputs are the FROZEN prior slices the stage itself will
     * receive. A test runs the pipeline with and without speculation and compares the rag slice.
     *
     * Returns [] rather than a task when it cannot honestly stage one — no working tree (a no-clone
     * AI-only retry, which reads the cache anyway) or a missing slice. Staging something this stage
     * would not claim is the failure mode `hitRate` exists to expose.
     */
    speculations(context) {
      const prior = context.prior as Partial<AnalysisResultSlices> | undefined;
      const graph = prior?.graph;
      const structure = prior?.structure;
      if (!context.repoPath || !graph || !structure) return [];
      const nodeIds = new Set(graph.nodes.map((node) => node.id));
      const inventory = prior?.inventory;
      const repoPath = context.repoPath;
      return [
        {
          key: planKeyFor(context.commitSha),
          label: `rag chunk plan (${structure.files.length} file(s))`,
          async compute(): Promise<CachedChunkPlan> {
            const built = await buildChunkPlan({
              repoPath,
              structure,
              inventory,
              nodeIds,
              readFile: deps.readFile,
              maxChunkTokens,
              windowLines,
            });
            return { chunks: built.chunks, ...(built.droppedChunks ? { droppedChunks: built.droppedChunks } : {}) };
          },
        },
      ];
    },

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
      const planCacheKey = planKeyFor(ctx.commitSha);

      // --- Resolve the chunk plan: speculation → disk → cache → throw ---------
      let plan: ChunkPlan[];
      let droppedChunks: Rag["droppedChunks"];
      let fromCache = false;
      let fromSpeculation = false;

      // CLAIM first. A staged plan is the SAME computation this stage would run next, already done
      // during `synthesize`'s provider wait — so claiming it is not a shortcut, it is collecting work
      // already paid for. `claim` awaits an in-flight speculation rather than racing it, which is
      // what stops the plan from ever being built twice.
      //
      // Grounding is deliberately NOT skipped: the claimed plan is re-filtered against `nodeIds`
      // below exactly like a cached one, because "computed from the same slices" is a strong reason
      // to expect it to hold and not a reason to stop checking.
      const staged = ctx.speculator ? await ctx.speculator.claim<CachedChunkPlan>(planCacheKey) : null;
      if (staged) {
        plan = staged.chunks.filter((chunk) => nodeIds.has(chunk.fileId));
        droppedChunks = staged.droppedChunks;
        fromSpeculation = true;
        // Still WRITTEN to the shared cache here, unchanged from the non-speculative path. The
        // orchestrator's `commit()` also promotes this key, so it is one redundant write per run —
        // paid deliberately, because the alternative is weakening the guarantee this line exists for:
        // the plan must be persisted BEFORE embedding so it survives a mid-embed failure, and
        // `commit()` runs at the END of the run.
        await ctx.cache.set(planCacheKey, staged);
      } else if (ctx.repoPath) {
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
      const { embeddings, usage: embedUsage } = await embedChunks(plan, ctx, client, maxAttempts);

      // GUARD (V3-P2): the store must live in the SAME embedding space as the client that
      // just produced these vectors. Checked here rather than at wiring time because the
      // client is chosen from env at runtime and a mismatch would otherwise surface as
      // plausible-looking but meaningless cosine scores forever after.
      assertEmbeddingSpace(client, deps.vectorStore.space, `vector store ${deps.vectorStore.id}`);

      const ordered = plan
        .map((chunk, i) => ({ chunk, embedding: embeddings[i] }))
        .sort((a, b) =>
          a.chunk.fileId === b.chunk.fileId
            ? a.chunk.startLine - b.chunk.startLine
            : a.chunk.fileId.localeCompare(b.chunk.fileId),
        );

      const namespace = retrievalNamespace({
        repoFullName: repoFullNameOf(input),
        commitSha: ctx.commitSha ?? "no-sha",
        embeddingModel: client.model,
        embeddingDim: client.dimension,
      });

      // Drop first, so the namespace ends up holding EXACTLY this chunk set. Without it a
      // chunking-algorithm change would leave the previous run's chunk ids behind, still
      // searchable, still citing line ranges the current plan says nothing about.
      await deps.vectorStore.drop(namespace);
      await deps.textStore.drop(namespace);

      await deps.textStore.put(
        namespace,
        ordered.map(({ chunk }) => ({ id: chunk.id, text: chunk.text })),
      );
      const records: VectorRecord[] = ordered.map(({ chunk, embedding }) => ({
        id: chunk.id,
        vector: embedding,
        fileId: chunk.fileId,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        ...(chunk.symbolName ? { symbolName: chunk.symbolName } : {}),
      }));
      await deps.vectorStore.upsert(namespace, records);

      // The persisted slice: metadata only. `text` is stripped here — that strip IS the
      // 16MB-BSON fix, so it is done by construction rather than by remembering to omit it.
      const chunks: RagChunk[] = ordered.map(({ chunk }) => {
        const { text: _text, ...metadata } = chunk;
        return metadata;
      });

      const rag: Rag = {
        chunks,
        chunkCount: chunks.length,
        embeddingModel: client.model,
        embeddingDim: client.dimension,
        ...(droppedChunks ? { droppedChunks } : {}),
        store: {
          namespace,
          vectorStoreId: deps.vectorStore.id,
          textStoreId: deps.textStore.id,
        },
      };

      const event: ProgressEvent = {
        jobId: input.jobId,
        stage: "rag",
        stageIndex: 8,
        stageCount: 8,
        kind: "ai",
        status: "completed",
        label: "Indexing for Q&A",
        detail: `Indexed ${chunks.length} chunks (${client.model}, dim ${client.dimension}) into ${
          deps.vectorStore.id
        }${droppedChunks ? `, ${droppedChunks.count} ungrounded dropped` : ""}${
          fromCache ? ", plan reused from cache" : ""
        }${fromSpeculation ? ", plan prefetched during synthesis" : ""}.`,
        progress: 0,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: now() - startedAt,
        preview: {
          chunkCount: chunks.length,
          embeddingModel: client.model,
          droppedChunks: droppedChunks?.count ?? 0,
          planFromCache: fromCache,
          // Distinct from `planFromCache`: a cache hit means an EARLIER RUN produced the plan, while
          // this means THIS run produced it early, during a wait it was going to spend anyway. They
          // are different facts about latency and collapsing them would hide which one happened.
          planFromSpeculation: fromSpeculation,
          vectorStore: deps.vectorStore.id,
          model: client.model,
        },
        // Absent when every chunk came from the embedding cache — see `embedChunks`.
        ...(embedUsage ? { usage: embedUsage } : {}),
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

    const fileSymbols = symbolsByFile.get(file.path) ?? [];
    const planned =
      mode === "source"
        ? planSourceFile(file.path, lines, fileSymbols, args)
        : planWindowFile(file.path, lines, args.windowLines, args.maxChunkTokens);

    // V3-P2 AST ENRICHMENT — a POST-PASS over the planned ranges, deliberately.
    //
    // Running it after planning rather than threading symbol context down through
    // planSourceFile → windowChunks → splitByTokens → makeChunk keeps the interval-cover and
    // gap-sweep code exactly as V3-P1 left it, which is what guarantees the acceptance
    // condition "chunk id unchanged": ids are `fileId#start-end`, the ranges are computed by
    // untouched code, so enrichment cannot move a boundary even by accident.
    //
    // Note `spansFor` passes EVERY symbol in the file, not just the top-level ones the interval
    // cover selected — the nested ones are precisely what makes a scope chain possible.
    const spans = spansFor(fileSymbols, lineCount);
    const enriched = planned.map((chunk) => {
      const enrichment = deriveEnrichment({
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        ...(chunk.symbolName ? { symbolName: chunk.symbolName } : {}),
        symbols: spans,
        lines,
        language: file.language,
      });
      return enrichment ? { ...chunk, enrichment } : chunk;
    });

    // GROUNDING (enforced by code, never trusted): drop chunks whose fileId is not a
    // graph node or whose range falls outside the file.
    for (const chunk of enriched) {
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
 * Every symbol in the file as a resolved `[startLine, endLine]` span, for enrichment.
 *
 * Distinct from the interval-cover spans in `planSourceFile`: that function selects
 * NON-OVERLAPPING top-level spans (a method inside a selected class is subsumed), because it is
 * deciding chunk boundaries. Enrichment wants the opposite — the overlaps are the scope chain.
 * A symbol with no `endLine` is given a zero-width span rather than a guessed one, so it can
 * still supply a signature but can never be claimed to enclose anything.
 */
function spansFor(symbols: InventorySymbol[], lineCount: number): SymbolSpan[] {
  return symbols.map((symbol) => {
    const start = clamp(symbol.line, 1, lineCount);
    const end = symbol.endLine === undefined ? start : clamp(symbol.endLine, start, lineCount);
    return { name: symbol.name, startLine: start, endLine: end, ...(symbol.signature ? { signature: symbol.signature } : {}) };
  });
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
): Promise<{ embeddings: number[][]; usage: TokenUsage | null }> {
  // V3-P2: what gets EMBEDDED is the enriched text (path + scope + signature + docstring,
  // then the raw bytes) — see `embedTextFor`. What gets STORED stays byte-exact for the line
  // range, because that is what a citation resolves to.
  //
  // The cache key hashes the embedded text, so turning enrichment on invalidates every
  // document-side entry exactly once. That is correct rather than unfortunate: the old vectors
  // describe different text, and serving them would mean the index disagreed with itself.
  const embedTexts = plan.map((chunk) => embedTextFor(chunk));
  const embedTokens = embedTexts.map((text) => estimateTokens(text));
  const keys = embedTexts.map((text) => embedCacheKey(client.provider, client.model, client.dimension, "document", text));
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
  // Estimated on the EMBED text (what is actually sent), not the raw chunk text.
  const estimatedTokens = missing.reduce((sum, i) => sum + embedTokens[i], 0);
  if (missing.length > 0 && ctx.budget && !(await ctx.budget.check(estimatedTokens, "embedding"))) {
    throw new BudgetExceededError("Daily LLM budget exhausted; RAG embedding skipped (demo at capacity).");
  }

  const usageParts: TokenUsage[] = [];
  for (const batch of batchIndices(missing, embedTokens)) {
    const texts = batch.map((i) => embedTexts[i]);
    const { vectors, usage } = await embedWithRetry(client, texts, maxAttempts, ctx);
    usageParts.push(usage);
    // CHARGED PER BATCH — FIXED V3-FINAL. The budget used to be recorded once, after the whole loop,
    // so a throw on batch 7 discarded the usage of batches 1-6: real embedding spend that the daily
    // ceiling never saw. The provider charged for them regardless of whether the stage finished.
    if (ctx.budget) await ctx.budget.record(usage, "embedding");
    if (!usage.measured) {
      ctx.logger.warn("RAG: embedding provider reported no usage; budget recorded an ESTIMATE.", {
        provider: client.provider,
      });
    }
    for (let j = 0; j < batch.length; j++) {
      const i = batch[j];
      embeddings[i] = vectors[j];
      const entry: CachedEmbedding = { embedding: vectors[j], model: client.model, dim: client.dimension };
      await ctx.cache.set(keys[i], entry);
    }
  }

  // Summed unconditionally, not only when a budget exists: the budget is one CONSUMER of this
  // number and the trace is another, so computing it inside the budget branch is what made the
  // trace's cost structurally $0.00 whenever the budget was unset.
  const usage = sumUsage(usageParts);

  return {
    embeddings: embeddings.map((value, i) => {
      if (value === null) throw new Error(`RAG: chunk ${plan[i].id} was never embedded.`);
      return value;
    }),
    // Null when nothing was embedded (every chunk came from the embedding cache). Distinct from a
    // zero-token usage: one means "spent nothing", the other means "a provider charged us nothing".
    usage: missing.length > 0 ? usage : null,
  };
}

/** Greedily group miss indices into batches under MAX_BATCH_TEXTS and MAX_BATCH_TOKENS.
 *  Sized by the EMBED-text token estimate — the payload the provider limits are about. */
function batchIndices(indices: number[], tokensPerIndex: number[]): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let tokens = 0;
  for (const i of indices) {
    const t = tokensPerIndex[i];
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

/**
 * `owner/name` for the retrieval namespace, falling back to the bare name when there is no
 * owner (a local or zip repo). Only used as a namespace component, so it needs to be stable
 * and distinguishing, not canonical.
 */
function repoFullNameOf(input: PipelineInput): string {
  const ref = input.repositoryRef;
  return ref.owner ? `${ref.owner}/${ref.name}` : ref.name;
}
