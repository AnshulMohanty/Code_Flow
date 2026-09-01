# CODEFLOW — CONTEXT-RECOVERY SNAPSHOT

Generated 2026-08-27 against working tree `d:\Code_Flow`, branch `fresh-main` @ `799b6ff`.
Ground truth only. "ABSENT" = verified not to exist.

---

## 1. GIT REALITY vs GITHUB

**Branch:** `fresh-main` → tracks `origin/main`
**`git status --short`:** *(empty — clean tree)*
**Untracked files:** none in tracked dirs; gitignored-but-present: `.env`, `temp/` (10 log files), `tmp/`, `node_modules/`, `codeflow.zip`, per-package `dist/`
**Stashes:** none (`git stash list` empty)
**Tracked file count:** 280

```
git log --oneline -15
799b6ff Initial commit — CodeFlow: AI-powered codebase analyzer (paste a repo, get an 8-stage analysis + grounded Q&A)
```
That is the **entire** history of this branch — one squashed commit.

**Divergence from origin/main:** 0 ahead / 0 behind. **No unpushed commits.**

**Three remotes configured:**
| remote | url |
|---|---|
| `origin` | github.com/AnshulMohanty/Code_Flow.git |
| `git-the-point` | github.com/AnshulMohanty/GitThePoint.git |
| `upstream` | github.com/braedonsaunders/codeflow |

**Other local branches (not merged into `fresh-main`):**
```
codeflow-cleanup                     6765f1f  (no upstream)  docs: professional README + one-command Docker run
codeflow-mern-phase-6-mongo-cache    3aa1839  [git-the-point/...: ahead 1]  chore: checkpoint Phase 6-10 work
main                                 8cb11ee  [upstream/main: behind 12]   Restore CodeFlow Card section in README
remotes/upstream/main                51ab970  fix: disambiguate duplicate function calls
```
`fresh-main` shares **no** ancestry with `main`/`upstream/main` — it is a fresh-root history. The 12-commit "behind upstream" on `main` is a different lineage (the pre-MERN single-file app).

**.gitignore entries that exist locally and matter:**
- `.env` — **present**, 2953 bytes. Key names set: `API_PORT MONGO_URI REDIS_URL ANALYZER_VERSION NODE_ENV CODEFLOW_TMP_DIR CODEFLOW_KEEP_TMP CODEFLOW_MAX_FILES LLM_PROVIDER EMBEDDING_PROVIDER GEMINI_API_KEY VOYAGE_API_KEY SYNTHESIS_MODEL GEMINI_MODEL VOYAGE_MODEL GEMINI_EMBEDDING_MODEL GEMINI_EMBEDDING_DIM API_BASE_URL VITE_API_BASE_URL WEB_PORT`. `ANTHROPIC_API_KEY=` is **blank**.
- `codeflow.env` (the Docker `--env-file` QUICKSTART requires) — **ABSENT**.
- `temp/` — 10 stale smoke/dev logs from earlier phases.
- No local model configs, no credentials JSON.

---

## 2. MONOREPO MAP

pnpm workspace (`apps/*`, `packages/*`), pnpm@9.15.4, Node ≥20, TS path aliases in `tsconfig.base.json`.

### apps/ (LOC per tracked source file)

```
apps/api/                                      @codeflow/api — Express REST + SSE
   14  src/index.ts                (entry: connectMongo → createApp → listen)
   42  src/app.ts
   21  src/config/env.ts
   28  src/db/connectMongo.ts
   31  src/db/models/AnalysisModel.ts
   34  src/db/models/JobModel.ts
   21  src/db/models/PRReportModel.ts     ← never imported
   25  src/db/models/RepoModel.ts
   20  src/db/models/ShareModel.ts        ← never imported
   50  src/middleware/cors.ts
   52  src/middleware/errorHandler.ts
   11  src/middleware/notFound.ts
   67  src/middleware/rateLimit.ts
   63  src/queues/analysisQueue.ts
   71  src/queues/eventLogStore.ts
   51  src/queues/progressChannel.ts
   43  src/queues/queueConnection.ts
  101  src/routes/analyze.ts
   69  src/routes/ask.ts
   12  src/routes/health.ts
  122  src/routes/jobs.ts
   56  src/routes/results.ts
  143  src/services/analysisCacheService.ts
  198  src/services/analysisJobService.ts
   72  src/services/ragQaService.ts
   70  src/services/repositoryService.ts
   20  src/types/api.ts
    7  src/utils/asyncHandler.ts
  102  src/utils/repoRef.ts
  577  src/app.test.ts
   29  Dockerfile

apps/worker/                                   @codeflow/worker — BullMQ pipeline runner
  111  src/index.ts                (entry: mongoose.connect → new Worker)
  203  src/processors/pipelineJobProcessor.ts
   26  src/services/gitRepoCloner.ts
   38  src/services/measureRepoSize.ts
   21  src/services/progressPublisher.ts
  334  src/services/publicRepoCloneService.ts
   33  src/services/repoDirectoryWalker.ts
   18  src/services/repoFileReader.ts
  353  src/services/workerAnalysisService.ts   ← Mongo schemas for all 6 collections, duplicated here
  137  src/processors/pipelineJobProcessor.test.ts
  113  src/services/publicRepoCloneService.test.ts
   25  Dockerfile

apps/web/                                      @codeflow/web — Vite + React 18 SPA
   10  src/main.tsx                (entry)
    5  src/App.tsx
   40  src/app/AppShell.tsx
   10  src/app/routes.tsx                       ← TODO: not wired to any router
   10  src/components/ui/Badge.tsx
   14  src/components/ui/Button.tsx
   10  src/components/ui/Card.tsx
   13  src/components/ui/EmptyState.tsx
   13  src/components/ui/ErrorState.tsx
   12  src/components/ui/LoadingState.tsx
   32  src/components/ui/Tabs.tsx
  218  src/features/analysis/PipelinePanel.tsx
  147  src/features/dashboard/AskRepo.tsx
   78  src/features/dashboard/DashboardShell.tsx
  137  src/features/dashboard/FileDrilldown.tsx
   17  src/features/dashboard/MetricCard.tsx
   69  src/features/dashboard/StartHere.tsx
   92  src/features/dashboard/StructureMap.tsx
  212  src/features/graph/DependencyGraph.tsx
   10  src/features/graph/GraphLegend.tsx        ← "placeholder" label, static
   12  src/features/graph/GraphToolbar.tsx       ← TODO: no real controls
   10  src/features/onboarding/OnboardingPanel.tsx
  176  src/features/repo-input/PublicRepoInput.tsx
   12  src/features/repo-input/RepoInput.tsx
  125  src/lib/analysisNormalizer.ts
  209  src/lib/apiClient.ts
  232  src/lib/dashboard.ts
    3  src/lib/formatters.ts
   80  src/lib/graphModel.ts
   86  src/lib/graphView.ts
  190  src/lib/mockAnalysis.ts                  ← hand-authored fake AnalysisResult (UI demo path)
   84  src/lib/pipeline.ts
  115  src/store/appStore.ts (zustand)
 1262  src/styles.css
   47  src/types/web.ts
    4  public/config.js                         ← runtime API-URL injection point
   (11 test files, 856 LOC)
   25  Dockerfile · 16 docker/nginx.conf · 11 docker/40-codeflow-config.sh

apps/local-cli/     5 LOC  src/index.ts   — console.log placeholder. STUB.
apps/card-action/   7 LOC  src/index.ts   — returns {status:"placeholder"}. STUB.
```

### packages/

```
packages/analyzers/                  @codeflow/analyzers — THE pipeline (the core)
   76  src/index.ts (barrel)
  584  src/pipeline/orchestrator.ts
   42  src/pipeline/errors.ts
  114  src/stages/ingest.ts
  281  src/stages/orient.ts
  342  src/stages/mapStructure.ts
  395  src/stages/inventory.ts
  282  src/stages/connect.ts
  153  src/stages/analyze.ts
  334  src/stages/synthesize.ts
  523  src/stages/rag.ts
  149  src/llm/llmClient.ts
  195  src/embedding/embeddingClient.ts
  117  src/providers.ts
  183  src/rag/answer.ts
   35  src/rag/retrieve.ts
   35  src/rag/embedCache.ts
   28  src/rag/homogeneity.ts
   42  src/budget/budgetHandle.ts
   62  src/util/concurrency.ts
   (14 test files, 3323 LOC)

packages/shared-types/     929  src/index.ts   — every contract type; + 182 LOC contract test
packages/graph/            ~570 src/*.ts       — graph algorithms (API below)
packages/parsers/          ~590 src/**/*.ts    — JS/TS/JSX/TSX/Python + generic parsers
packages/config/            50  src/constants.ts + 7 src/index.ts  — all guardrail constants
packages/eval/             ~410 src/*.ts       — AI scoring harness (§5)
packages/exports/            4  src/index.ts   — `export {}`. EMPTY.
```

### Public API (signatures only)

**`@codeflow/shared-types`** — 78 exported types, no runtime values. Key ones:
`AnalysisResult`, `AnalysisResultSlices`, `AnalysisSliceKey`, `PipelineStage<K>`, `PipelineStageId`, `PipelineContext`, `PipelineInput`, `StageResult<K>`, `ProgressEvent`, `ProgressMessage`, `PipelineRunSummary`, `PipelineRunStatus`, `PipelineStatusReason`, `AnalysisCacheHandle`, `BudgetHandle`, `EventLogStore`, `ProgressPublisher`, `ProgressSubscriber`, `RepoGraph`, `RepoMetrics`, `Inventory`, `RepoStructure`, `RepoOrientation`, `Synthesis`, `Rag`, `RagChunk`, `AiAnalysis`, `AnalysisJobPayload`, `JobProgress`, `ParsedFile`.

**`@codeflow/config`** — values only:
```ts
DEFAULT_API_PORT=4000  DEFAULT_WEB_PORT=5173  DEFAULT_LOCAL_API_PORT=3001
MAX_FILES=25_000  MAX_BYTES=512*1024*1024  PARSE_CONCURRENCY=8  FILE_TIMEOUT_MS=5_000
RATE_WINDOW_MS=60_000  RATE_MAX=30  DAILY_LLM_BUDGET=5_000_000
GRAPH_BACKBONE_NODES=80  GRAPH_FOCUS_HOPS=1  GRAPH_PERF_WARN_NODES=600
RAG_TOP_K=6  RAG_MIN_SIMILARITY=0.2
```
Every value carries a `PLACEHOLDER — tune in P7` comment.

**`@codeflow/graph`**
```ts
buildDependencyGraph(input: GraphInput): DependencyGraph
getDirectDependencies(graph, fileIdOrPath)
getDirectDependents(graph, fileIdOrPath)
getTransitiveDependencies(graph, fileIdOrPath, options?: TraversalOptions)
getTransitiveDependents(graph, fileIdOrPath, options?: TraversalOptions)
getBlastRadius(graph, fileIdOrPath, options?): BlastRadiusResult
findCircularDependencies(graph)
computeCentrality(graph): CentralityScore[]
detectHighCouplingFiles(...) ; detectIsolatedFiles(graph)
findNode(graph, fileIdOrPath) ; getNodeId(graph, fileIdOrPath) ; normalizePath(value)
createGraphSummary(graph) ; serializeGraphForUI(graph, options?: SerializeGraphOptions)
```

**`@codeflow/parsers`**
```ts
class ParserRegistry ; createParserRegistry(parsers?: ParserAdapter[])
parseRepository(repoRoot: string, options?: ParseRepositoryOptions)
detectLanguage(filePath): LanguageId ; isJavaScriptLike(language)
discoverSourceFiles(...) ; isSupportedSourceFile(p) ; shouldExcludePath(p)
resolveRelativeImport(input): string|undefined ; resolvePythonImport(input): string|undefined
genericParser | javascriptParser | typescriptParser | tsxParser | jsxParser | pythonParser : ParserAdapter
createJavaScriptParser(language, extensions): ParserAdapter
```

**`@codeflow/analyzers`** — the 8 stage factories + orchestrator + AI layer:
```ts
runPipeline(stages: readonly PipelineStage[], input: PipelineInput, options?: RunPipelineOptions): Promise<PipelineRunResult>
createIngestStage(deps: IngestDependencies): PipelineStage<never>
createOrientStage(deps: OrientDependencies): PipelineStage<"orientation">
createMapStructureStage(deps: MapStructureDependencies): PipelineStage<"structure">
createInventoryStage(deps: InventoryDependencies): PipelineStage<"inventory">
createConnectStage(deps: ConnectDependencies): PipelineStage<"graph">
createAnalyzeStage(deps?: AnalyzeDependencies): PipelineStage<"metrics">
createSynthesizeStage(deps: SynthesizeDependencies): PipelineStage<"aiSynthesis">
createRagStage(deps: RagDependencies): PipelineStage<"aiRag"> & StageEmbeddingTarget
buildSynthesisPrompt(ctx: PipelineContext): string
deriveSynthesis(raw: string, nodeIds: Set<string>): Synthesis
answerQuestion(deps: AnswerQuestionDeps): Promise<RagAnswer>
deriveAnswer(raw: string, retrieved: RagChunk[], retrievedChunkIds: string[]): RagAnswer
retrieve(chunks: RagChunk[], queryVector: number[], k: number): RagChunk[]
cosineSimilarity(a: number[], b: number[]): number
embedCacheKey(provider, model, dim, inputType: "document"|"query", text): string
normalizeEmbedText(text): string
assertEmbeddingSpace(client: EmbeddingClientLike, space: EmbeddingSpace, context: string): void
createInMemoryBudgetHandle(limitTokens?: number, now?: () => number): BudgetHandle
createAnthropicClient(o: AnthropicClientOptions): LlmClient
createGeminiClient(o: GeminiClientOptions): LlmClient
createVoyageClient(o: VoyageClientOptions): EmbeddingClient
createGeminiEmbeddingClient(o: GeminiEmbeddingClientOptions): EmbeddingClient
resolveChatProvider(env: ProviderEnv): LlmProvider | null
resolveEmbeddingProvider(env: ProviderEnv): EmbeddingProvider | null
createLlmClientFromEnv(env: ProviderEnv): LlmClient | undefined
createEmbeddingClientFromEnv(env: ProviderEnv): EmbeddingClient | undefined
class PipelineReasonError ; RepoTooLargeError ; BudgetExceededError ; statusReasonOf(error)
```

**`@codeflow/eval`** — see §5.  **`@codeflow/exports`** — `export {}` (nothing).

### Internal dependency graph

```
shared-types  ← (nothing)
config        ← (nothing)
exports       ← (nothing)
graph         → shared-types
parsers       → shared-types
analyzers     → config, graph, parsers, shared-types
eval          → analyzers, shared-types
api           → analyzers, config, shared-types
worker        → analyzers, config, graph, parsers, shared-types
web           → config, shared-types
card-action   → shared-types          (stub)
local-cli     → config                (stub)
```
No cycles. `exports` is a leaf nobody imports.

### legacy/

**One file: `legacy/index.html`, 6845 LOC.** The pre-MERN single-file app: React 18 + ReactDOM + Babel-standalone + d3 + d3-sankey + acorn + jsrsasign + jszip + web-tree-sitter, all from CDN `<script>` tags, with the whole analyzer + UI inline.

**Wiring: DEAD as an app.** Nothing in `apps/`, `packages/`, `docker-compose*.yml`, or `package.json` references it. It is still a **test fixture**:
- `tests/*.mjs` (root, run in CI via `node --test tests/*.mjs`) parse `legacy/index.html` and assert on its inline analyzer functions — `tests/sync-with-html.test.mjs`, `tests/html-inline-script-analysis.smoke.js`, `tests/numeric-fn-name.test.mjs`, `tests/codeflow-golden.test.mjs`.
- `card/lib/analyzer.js:63` comments on the quarantine and tolerates both locations.

Also outside the workspace: **`card/`** (12 files, ~1750 LOC) — a standalone GitHub Action (`card/action.yml`, `card/index.js`, `card/render/*` SVG renderers). Not a pnpm workspace member, not in CI, not referenced by any app. Its intended successor `apps/card-action` is a 7-line stub. Effectively **orphaned but functional-looking**. `card/examples/*.svg` — **10 files, all 0 bytes**.

---

## 3. THE 8-STAGE PIPELINE

Registered in `apps/worker/src/processors/pipelineJobProcessor.ts:117-137`; executed sequentially by `runPipeline` (`packages/analyzers/src/pipeline/orchestrator.ts:73`). Every stage is a factory with injected I/O deps — zero direct fs/network in stage code.

| # | Stage | id / kind | File | In → Out |
|---|---|---|---|---|
| 1 | Ingest | `ingest` / **deterministic** | `packages/analyzers/src/stages/ingest.ts` | `PipelineInput` + `RepoCloner` → **owns nothing**; writes `ctx.repoPath`, `ctx.commitSha`. Enforces Guard 1 post-clone. |
| 2 | Orient | `orient` / **deterministic** | `stages/orient.ts` | `ctx.repoPath` + `readFile` (probes fixed README + manifest paths only, never walks) → `RepoOrientation` slice `orientation` |
| 3 | Map | `map-structure` / **deterministic** | `stages/mapStructure.ts` | `ctx.repoPath` + `readDir` + `readFile` (`.gitignore`) → `RepoStructure` slice `structure` (files, roles, layout) |
| 4 | Inventory | `inventory` / **deterministic** | `stages/inventory.ts` | `ctx.prior.structure` (role==="source") + `readFile` + `ParserRegistry` → `Inventory` slice `inventory` (symbols, entryPoints, loc, projectTypeSignal, unparsedFiles). Guards 2+3 here. |
| 5 | Connect | `connect` / **deterministic** | `stages/connect.ts` | `structure` + `inventory` + `readFile` → `RepoGraph` slice `graph` (nodes+edges+resolution). `fileId === repo-relative POSIX path`. |
| 6 | Analyze | `analyze` / **deterministic** | `stages/analyze.ts` | `ctx.prior.graph` → `RepoMetrics` slice `metrics` (perFile, keyFiles, hotspots, cycles, summary). Rebuilds a live `@codeflow/graph` from the plain slice. |
| 7 | Synthesize | `synthesize` / **AI** | `stages/synthesize.ts` | `orientation`+`structure`+`inventory`+`graph`+`metrics` → LLM → `Synthesis` slice `aiSynthesis` |
| 8 | Index-for-Q&A | `rag` / **AI** | `stages/rag.ts` | `structure`+`inventory`+`graph`+`readFile` → embeddings → `Rag` slice `aiRag` |

**Persistence — there is no per-stage persistence.** All eight slices accumulate in the orchestrator's in-process `slices` object, are assembled once into a single `AnalysisResult`, and written as **one Mongo document**:

- `analyses` collection, field `result` (`Schema.Types.Mixed`), unique index `analysis_cache_key = {repoFullName, commitSha, analyzerVersion}` — `apps/worker/src/services/workerAnalysisService.ts:277`.
- Written only when `status ∈ {completed, partial}` (`pipelineJobProcessor.ts:161`). `failed`/`aborted` runs are **never** persisted.
- Job lifecycle → `jobs` collection.
- Per-stage `ProgressEvent`s → `jobevents` collection (SSE replay buffer) + BullMQ `job.updateProgress` (live channel).
- AI-stage caches (LLM completions, embeddings, chunk plans) → `llmcache` collection, namespaced keys.
- **Redis holds no analysis state** — only the BullMQ queue `codeflow-analysis` and its `QueueEvents` progress channel.

**AI-stage registration is conditional** (`pipelineJobProcessor.ts:129-137`): stage 7 registers only if `createLlmClientFromEnv` returned a client; stage 8 only if `createEmbeddingClientFromEnv` did. With no keys the pipeline is a 6-stage deterministic run and `stageCount` is 6, not 8.

---

## 4. THE AI / CONTEXT LAYER

### 4a. Provider abstraction

Two tiny interfaces; every AI stage takes one by injection, so tests make zero real calls.

```ts
// packages/analyzers/src/llm/llmClient.ts
export interface LlmCompletionRequest {
  system?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}
export type LlmProvider = "anthropic" | "gemini";
export interface LlmClient {
  readonly provider: LlmProvider;
  readonly model: string;
  complete(request: LlmCompletionRequest): Promise<string>;   // RAW text; stage parses
}

// packages/analyzers/src/embedding/embeddingClient.ts
export interface EmbeddingRequest {
  texts: string[];
  inputType: "document" | "query";
}
export type EmbeddingProvider = "voyage" | "gemini";
export interface EmbeddingClient {
  readonly provider: EmbeddingProvider;
  readonly model: string;
  readonly dimension: number;
  embed(request: EmbeddingRequest): Promise<number[][]>;      // 1:1 with texts, in order
}
```

Four adapters, all raw `fetch`, **no vendor SDK anywhere**:
- `createAnthropicClient` → `POST {baseUrl}/v1/messages`, headers `x-api-key` + `anthropic-version: 2023-06-01`, body `{model, max_tokens, temperature, system?, messages:[{role:"user",content:prompt}]}`. Default `max_tokens` 2048.
- `createGeminiClient` → `POST /v1beta/models/{model}:generateContent`, header `x-goog-api-key`, `generationConfig: {temperature, responseMimeType:"application/json", maxOutputTokens?}`, system via `systemInstruction`. Default model `gemini-2.5-flash`.
- `createVoyageClient` → `POST /v1/embeddings`, `Bearer`, `{input, model, input_type, output_dimension}`. Defaults `voyage-code-3` / dim 1024.
- `createGeminiEmbeddingClient` → `POST /v1beta/models/{model}:batchEmbedContents`, re-chunks at 100/request, `taskType: RETRIEVAL_DOCUMENT|RETRIEVAL_QUERY`. Defaults `gemini-embedding-001` / dim 768.

Selection is a pure function of env (`packages/analyzers/src/providers.ts`): explicit `LLM_PROVIDER`/`EMBEDDING_PROVIDER` wins; else inferred from whichever key is present; **both keys + no explicit provider ⇒ throws**; no key ⇒ returns `undefined` ⇒ stage not registered. Default Anthropic model constant is `"claude-opus-4-8"`.

### 4b. Stage 7 (Synthesize) — EXACT prompt assembly

System prompt (`stages/synthesize.ts:36-45`), verbatim:

```ts
const SYSTEM_PROMPT =
  "You are a senior engineer writing an onboarding guide for a newcomer to a codebase. " +
  "You are given DETERMINISTIC facts about the repository (languages, layout, entry points, " +
  "the most central files, dependency cycles, and per-file metrics). Using ONLY these facts, " +
  "produce a short 'what is this and where do I start' guide and a ranked reading order. " +
  "Every reading-order entry MUST cite a fileId taken verbatim from the provided file list — " +
  "never invent a path. Respond with a SINGLE JSON object and nothing else (no markdown, no " +
  "code fences, no commentary). Schema: " +
  '{"summary": string, "readingOrder": [{"fileId": string, "order": number, "reason": string}], "keyConcepts"?: string[]}.';
```

Selection/truncation constants (`synthesize.ts:28-33`):
```ts
const TOP_KEY_FILES = 30;      const TOP_IMPACT = 10;
const TOP_CYCLES = 15;         const MAX_ENTRY_POINTS = 50;
const README_HEAD_CHARS = 1200;
```

User prompt, assembled in this exact order by `buildSynthesisPrompt(ctx)` (`synthesize.ts:255-334`):

```ts
lines.push("## Project");
//   - projectType / languages / frameworks   (from orientation)
//   - layout / fileCount                     (from structure)
//   - graph: N files, N edges, N cycles, N isolated, maxBlastRadius N   (from metrics.summary)
if (orientation?.readme?.text) {
  lines.push("\n## README (head)");
  lines.push(orientation.readme.text.slice(0, README_HEAD_CHARS));      // 1200 chars
}
const entryPoints = inventory?.entryPoints ?? [];
if (entryPoints.length) {
  lines.push("\n## Entry points");
  for (const entry of entryPoints.slice(0, MAX_ENTRY_POINTS))           // 50
    lines.push(`- ${entry.filePath} (${entry.kind}, evidence: ${entry.evidence})`);
}
const keyFiles = (metrics?.keyFiles ?? []).slice(0, TOP_KEY_FILES);     // 30
if (keyFiles.length) {
  lines.push(`\n## Most central files (top ${keyFiles.length}, by degree centrality)`);
  for (const fileId of keyFiles)
    lines.push(`- ${fileId} [${node?.language ?? "?"}, ${node?.lines ?? 0} loc] centrality N, fanIn N, fanOut N, blastRadius N`);
}
const impactful = [...(metrics?.perFile ?? [])]
  .sort((a,b) => b.blastRadius - a.blastRadius || a.fileId.localeCompare(b.fileId))
  .filter(f => f.blastRadius > 0).slice(0, TOP_IMPACT);                 // 10
// → "## Highest-impact files (top N, by blast radius)"
const cycles = (metrics?.cycles ?? []).slice(0, TOP_CYCLES);            // 15
// → "## Dependency cycles (top N)"  each "- a -> b -> c"
lines.push("\n## Task\nWrite the onboarding guide. `readingOrder` fileIds MUST be chosen from the file lists above. Return JSON only.");
return lines.join("\n");
```

**No repo file CONTENT enters the prompt** except the first 1200 chars of the README. Everything else is metadata: paths, languages, LOC counts, four integer metrics per key file, cycle path strings.

Cache-then-budget-then-call, with a provider/model-scoped key:
```ts
const cacheKey = `synthesis/v2/${deps.client.provider}/${deps.client.model}/${ctx.commitSha ?? "no-sha"}/${sha256(prompt)}`;
const cachedCompletion = await ctx.cache.get<string>(cacheKey);   // read BEFORE any LLM call
// ... on miss:
const estimatedTokens = estimateTokens(SYSTEM_PROMPT + "\n" + prompt);
if (ctx.budget && !(await ctx.budget.check(estimatedTokens)))
  throw new BudgetExceededError("Daily LLM budget exhausted; synthesis skipped (demo at capacity).");
```
Then up to `maxAttempts` (default 3) attempts of `complete({system, prompt, temperature: 0, maxTokens: deps.maxTokens})`. The worker passes **no** `maxTokens` → Anthropic falls back to 2048, Gemini sends no `maxOutputTokens` at all.

### 4c. Stage 8 + Q&A query path

**Chunking** (`stages/rag.ts`, fully deterministic, no LLM):
```ts
const SYMBOL_CHUNK_ROLES = new Set<FileRole>(["source"]);   // symbol-aware
const WINDOW_CHUNK_ROLES = new Set<FileRole>(["docs"]);     // fixed window
const MAX_CHUNK_TOKENS = 32_000;      // char/4 estimate, not a real tokenizer
const WINDOW_CHUNK_LINES = 60;
const MAX_BATCH_TEXTS = 128;  const MAX_BATCH_TOKENS = 120_000;
```
`source` files: one chunk per non-overlapping **top-level symbol span** (interval cover over `inventory.symbols`; a symbol with no `endLine` extends to the next symbol's start, bounded by 60 lines), with **gap sweeps** window-chunking every uncovered region so nothing is dropped. `docs`: pure 60-line windows. Any span over the token cap is line-split. Roles `config/build/asset/test/other` are **not indexed at all**. Chunk id is `${fileId}#${startLine}-${endLine}`.

**Embedding model:** whatever `createEmbeddingClientFromEnv` selects — `voyage-code-3`/1024 or `gemini-embedding-001`/768. Recorded on the index as `embeddingModel`/`embeddingDim`.

**Vector store: Mongo, inside the analysis document.** `Rag.chunks[]` each carry `embedding: number[]` plus their full `text`, stored under `result.ai.rag` in the `analyses` doc. **No vector database, no vector index, no ANN.** The 16MB BSON limit is the hard ceiling on index size (acknowledged in a code comment as the reason for the 768-dim Gemini default).

**Retrieval** (`rag/retrieve.ts`) — brute-force cosine over **every** chunk, loaded into the API process:
```ts
export function retrieve(chunks: RagChunk[], queryVector: number[], k: number): RagChunk[] {
  if (k <= 0 || chunks.length === 0) return [];
  const scored = chunks.map((chunk) => ({ chunk, score: cosineSimilarity(queryVector, chunk.embedding) }));
  scored.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
  return scored.slice(0, k).map((entry) => entry.chunk);
}
```
`k = RAG_TOP_K = 6`. **Reranking: ABSENT.** **Hybrid/keyword search: ABSENT.** **MMR/diversity: ABSENT.**

**Final Q&A prompt** (`rag/answer.ts`). System prompt, verbatim:
```ts
const SYSTEM_PROMPT =
  "You are a precise code assistant answering questions about ONE repository. Answer the user's " +
  "question USING ONLY the provided code chunks — do NOT use any outside knowledge, and do NOT " +
  "guess. If the chunks do not contain the answer, set \"answered\" to false and say so. Cite the " +
  "chunk ids you actually used. Respond with a SINGLE JSON object and nothing else: " +
  '{"answer": string, "answered": boolean, "citations": [{"chunkId": string}]}.';
```
User prompt — retrieved chunks first (with **full untruncated text**), question last:
```ts
function buildAnswerPrompt(question: string, retrieved: RagChunk[]): string {
  const lines: string[] = ["## Retrieved code chunks"];
  for (const chunk of retrieved) {
    lines.push(`\n### Chunk ${chunk.id}  (file ${chunk.fileId}, lines ${chunk.startLine}-${chunk.endLine})`);
    lines.push(chunk.text);
  }
  lines.push(`\n## Question\n${question}`);
  lines.push("\nAnswer using ONLY the chunks above. Cite the chunk ids you used. Return JSON only.");
  return lines.join("\n");
}
```
Order of operations in `answerQuestion`: homogeneity assert → embed query (cache-first) → `retrieve(k)` → **similarity floor gate** (`topScore < RAG_MIN_SIMILARITY 0.2` or empty retrieval ⇒ return canned `NO_ANSWER`, **no LLM call**) → answer cache `qa/v1/{provider}/{model}/{sha}/{sha256(question + retrievedChunkIds)}` → budget check → `complete()` → `deriveAnswer` grounding → cache write → budget record.

**Single-turn only.** `AnswerQuestionDeps` has no history field; the web `AskRepo` component holds one `AskState` and replaces it per question. **No multi-turn context.**

### 4d. Token counting / context budget / caching / capping / compaction

| Feature | Status |
|---|---|
| Real tokenizer (tiktoken, Anthropic `count_tokens`, provider usage fields) | **ABSENT** |
| Token estimation | 3 identical private copies of `estimateTokens(text) { return Math.ceil(text.length / 4); }` — `synthesize.ts:243`, `rag.ts:517`, `answer.ts:177` |
| Context-window budget logic (fit-prompt-to-N-tokens) | **ABSENT.** Prompt size is bounded by fixed item counts (top-30/10/15/50, 1200 README chars), never measured against a model's window. The Q&A prompt is unbounded — 6 chunks × up to 32K-estimated-tokens each. |
| Provider prompt caching (`cache_control`, `ephemeral`, `anthropic-beta`) | **ABSENT** (grepped) |
| Application-level completion cache | **PRESENT** — 4 namespaces on one `AnalysisCacheHandle`: `synthesis/v2/…`, `qa/v1/…`, `embed/{provider}/{model}/{dim}/{inputType}/v1/{sha256}`, `rag/v1/{sha}` (chunk plan). Mongo-backed in the worker (`llmcache`); **in-process `Map` in the API** (`ragQaService.ts:createInMemoryCache`) — Q&A answer + query-embedding caches die on API restart and are not shared with the worker. |
| Output capping | Weak. `maxTokens` is plumbed end-to-end but **no caller ever sets it**. Anthropic default 2048; Gemini unbounded. |
| History compaction | **ABSENT** (no conversation history exists) |
| Summarization-to-fit | **ABSENT** |
| Retry | 3 attempts (synthesize completions; RAG embed batches). RAG chunking has **no** retry by design (deterministic). |

### 4e. Citation validation against real graph nodes / line ranges

Three independent code-enforced grounding passes. The model is never trusted.

**(1) Synthesize reading order — fileId must be a graph node** (`synthesize.ts:214-227`):
```ts
// GROUNDING: keep only steps whose fileId is a real graph node; renumber deterministically.
const grounded = steps
  .filter((step) => nodeIds.has(step.fileId))
  .sort((a, b) => a.order - b.order || a.fileId.localeCompare(b.fileId))
  .map((step, index) => ({ ...step, order: index + 1 }));
const droppedCitations = steps.length - grounded.length;

if (grounded.length === 0) {
  throw new Error("Synthesis reading order was empty after grounding (all citations ungrounded).");
}
```
`nodeIds` is built in `run()` as `new Set(graph.nodes.map(n => n.id))`. Dropped count is surfaced on `Synthesis.droppedCitations`, not hidden.

**(2) RAG chunk plan — fileId in graph AND line range inside the file** (`rag.ts:263-276`):
```ts
for (const chunk of planned) {
  const grounded =
    args.nodeIds.has(chunk.fileId) &&
    chunk.startLine >= 1 &&
    chunk.endLine >= chunk.startLine &&
    chunk.endLine <= lineCount;
  if (grounded) kept.push(chunk);
  else { droppedCount += 1; droppedFileIds.add(chunk.fileId); }
}
```
This is the strongest link: because chunks are cut from real line ranges of real files, every Q&A citation resolves to real coordinates **by construction**.

**(3) Q&A answer citations — chunkId must be one of THIS query's retrieved chunks** (`answer.ts:141-163`):
```ts
const byId = new Map(retrieved.map((c) => [c.id, c]));
// ...
for (const entry of cited) {
  const id = entry && typeof entry === "object" ? (entry as { chunkId?: unknown }).chunkId : undefined;
  const chunk = typeof id === "string" ? byId.get(id) : undefined;
  if (!chunk) { dropped.push(typeof id === "string" ? id : String(id)); continue; }
  const key = `${chunk.fileId}#${chunk.startLine}-${chunk.endLine}`;
  if (seen.has(key)) continue;
  seen.add(key);
  grounded.push({ fileId: chunk.fileId, startLine: chunk.startLine, endLine: chunk.endLine });
}
```
Coordinates come from the **retrieved chunk**, never from model output — the model only supplies an id used as a lookup key. Unresolvable ids land in `droppedCitations`. A malformed / `answered:false` / empty completion returns the honest `NO_ANSWER` with zero citations.

Plus an index-integrity guard reused by eval and production (`rag/homogeneity.ts`):
```ts
export function assertEmbeddingSpace(client: EmbeddingClientLike, space: EmbeddingSpace, context: string): void {
  if (client.model !== space.embeddingModel || client.dimension !== space.embeddingDim) {
    throw new Error(`Embedding client (provider ${client.provider}, model ${client.model}, dim ${client.dimension}) does not match the ${context} (model ${space.embeddingModel}, dim ${space.embeddingDim}). Cosine across embedding spaces is meaningless.`);
  }
}
```
The orchestrator additionally refuses to reuse a cached `rag` slice whose `(model, dim)` ≠ the configured stage's `embeddingTarget` (`orchestrator.ts:aiStageReusable`).

---

## 5. EVAL PACKAGE (full dump)

`packages/eval` — 8 source files, 586 LOC total.

| File | LOC | What it is |
|---|---|---|
| `src/index.ts` | 31 | Barrel. Re-exports `retrieve`/`cosineSimilarity` **from `@codeflow/analyzers`** so eval measures production retrieval, not a copy. |
| `src/dataset.ts` | 86 | `EvalDataset` / `RagEvalQuestion` contract, `EVAL_SCHEMA_VERSION = 1`, `TEMPLATE_DATASET`, `assertDatasetShape()`. |
| `src/score.ts` | 148 | All scoring math. Pure. |
| `src/runEval.ts` | 156 | `runEval(dataset, result, embeddingClient, options)` → `EvalReport`; `assertHomogeneity()`. |
| `src/thresholds.ts` | 18 | `EVAL_THRESHOLDS` — 3 numbers, each commented `PLACEHOLDER — tune in P7`. |
| `src/cli.ts` | 45 | `pnpm eval <dataset.json> <analysisResult.json>` → builds embedding client from env, prints report JSON, `exitCode = 1` on threshold failure. |
| `src/__tests__/fixtures.ts` | 109 | Synthetic 3-dim fixture. |
| `src/__tests__/{runEval,score}.test.ts` | 89+102 | 18 tests, all passing. |

### What it measures and how it scores

**Continuous, not binary.** Every metric is a real value in [0,1]; `thresholds.passed` is the only boolean and it's derived.

Synthesis (`scoreSynthesis(synthesis, keyFiles, nodeIds, expectedEntryPoints, k)` → `SynthesisScores`):
- `readingOrderRecallAtK` — `|expected ∩ surfaced| / |expected|`, where `surfaced = top-k readingOrder (by order) ∪ keyFiles.slice(0,k)`
- `citationResolutionRate` — `grounded / total` reading steps (≈1.0 by construction, since grounding already dropped the rest)
- `droppedCitationsRate` — `dropped / (total + dropped)`, i.e. how much the LLM hallucinated before grounding
- `surfaced[]` — the actual set, sorted, for eyeballing

RAG retrieval (`scoreQuestion` → `PerQuestionResult`; `aggregateRag` → `RagScores`):
- `recallAtK` per question — fraction of that question's targets hit in top-k. Targets are `expectedLines` (line-range **overlap** test) when authored, else `expectedFiles` (file-id equality).
- `reciprocalRank` — `1/(rank of first hit)`, 0 if none in top-k
- `hit` boolean, `missed[]` labels — **per-question detail is reported, not just the mean** ("a single number hides which files the AI missed")
- Aggregates: `meanRecallAtK`, `mrr`, `questionCount`

Thresholds (`evaluateThresholds`): fails if `readingOrderRecall@5 < 0.6`, or `droppedCitationsRate > 0.1`, or `ragRecall@5 < 0.6`. Returns `{passed, failures: string[]}`.

Homogeneity guard: `assertHomogeneity(client, dataset, rag)` throws if client-space ≠ dataset-space (delegating to the shared `assertEmbeddingSpace`) **or** index-space ≠ dataset-space.

### Real, stub, or empty harness?

**A real, working, fully-tested harness with NO real cases.** The scoring code is genuine and verified (18 passing tests, including a determinism test asserting byte-identical reports across two runs). What is missing is data and calibration:

- **Golden set / repo fixtures: effectively ABSENT.** The only shipped dataset is `TEMPLATE_DATASET`, every field a `REPLACE_*` placeholder, and `assertDatasetShape` **deliberately rejects it**: `if (d.commitSha.startsWith("REPLACE")) throw new Error("Dataset still contains TEMPLATE placeholders — author real ground truth first (P7).")`. So `pnpm eval` cannot run out of the box.
- The only usable dataset is `src/__tests__/fixtures.ts` `DATASET` — 3 questions over a synthetic 3-file repo in a hand-authored 3-dim vector space (`auth=[1,0,0]`, `db=[0,1,0]`, `util=[0,0,1]`), with q3 engineered as a deliberate miss. It proves the math, not the product.
- Thresholds are placeholders admitted as such in the source comments.
- **Not wired into CI.** `.github/workflows/ci.yml` runs typecheck/lint/test/build + `node --test tests/*.mjs`; `pnpm eval` appears nowhere.
- Note: `tests/fixtures/golden-world/` (6 tiny files) and `tests/fixtures/vault/` (7 files) exist at the repo root but belong to the **legacy** `tests/*.mjs` suite against `legacy/index.html` — they are not eval datasets.

**Grades final artifacts only, not the trajectory.** `runEval` takes an already-produced `AnalysisResult` and scores two of its fields (`ai.synthesis`, `ai.rag`). It never runs the pipeline, never inspects `result.pipeline.stages`, never scores per-stage behaviour, retries, cache hits, or cost. It also scores the **index**, not the answer: it uses `retrieve` and stops there — no `answerQuestion`, so answer quality, faithfulness, and citation correctness of the Q&A path are **unmeasured**.

---

## 6. STATE, JOBS, CONFIG

### Mongo collections

All six schemas are declared **twice** — once in `apps/api/src/db/models/*.ts` and again inline in `apps/worker/src/services/workerAnalysisService.ts` — kept in sync by hand.

| Collection | Model | Document shape |
|---|---|---|
| `repos` | `Repo` | `{provider:"github", owner, name, fullName (unique idx), defaultBranch, visibility:"public"|"private"|"unknown", cloneUrl?, stars?, lastAnalyzedAt?, createdAt, updatedAt}` |
| `analyses` | `Analysis` | `{repoFullName (idx), repositoryRef: Mixed, commitSha (idx), branch, mode:"public_hosted", analyzerVersion (idx), result: Mixed ← the whole AnalysisResult incl. every embedding vector, summary: Mixed, completedAt, durationMs, createdAt}` · unique compound `analysis_cache_key {repoFullName, commitSha, analyzerVersion}` |
| `jobs` | `Job` | `{jobId (unique idx), status: queued|cloning|parsing|analyzing|completed|failed, progress, currentStep, parsedFiles, totalFiles (default 42), repoFullName, analysisId?, cached, error?, runStatus?: completed|partial|failed|aborted, runStatusReason?: repo-too-large|budget-exhausted, repositoryRef: Mixed, mode, commitSha, analyzerVersion, createdAt, updatedAt}` |
| `jobevents` | `JobEvent` | `{jobId (idx), seq, message: Mixed (a ProgressMessage), createdAt}` · unique `{jobId, seq}` |
| `llmcache` | `LlmCache` | `{key (unique idx), value: Mixed, createdAt}` — completions, embeddings, chunk plans |
| `llmbudget` | `LlmBudget` | `{day (unique idx, UTC "YYYY-MM-DD"), spent: Number, createdAt, updatedAt}` — one doc per day; a new doc **is** the reset |
| `prReports` | `PRReport` | `{repoFullName, analysisId, pullRequestNumber, report: Mixed}` — **declared, never imported, never written** |
| `shares` | `Share` | `{analysisId, slug (unique), visibility}` — **declared, never imported, never written** |

### BullMQ

- Queue name: `"codeflow-analysis"` (`ANALYSIS_QUEUE_NAME`, declared separately in api and worker).
- Job name: **`"analyze"`** — `analysisQueue.add("analyze", payload, {jobId: payload.jobId, removeOnComplete:{age:3600,count:1000}, removeOnFail:{age:86400,count:1000}})`. Enqueue races a 1500 ms timeout; failure → 503 `QUEUE_UNAVAILABLE`.
- Job data = `AnalysisJobPayload`:
```ts
{ jobId: string; mode: "public_hosted"; repositoryRef: RepositoryRef; commitSha: string; analyzerVersion: string }
```
- Worker: `concurrency: 2`, `maxRetriesPerRequest: null`.
- Progress channel: worker `job.updateProgress(ProgressMessage)` → API `QueueEvents.on("progress")`, filtered by `jobId`.

### SSE

Endpoint `GET /api/job/:id/events`. Exactly **two** named event types (`apps/api/src/routes/jobs.ts:54,59`):
- `event: progress` — `data:` = a full `ProgressEvent` `{jobId, stage, stageIndex, stageCount, kind, status, label, detail?, progress, startedAt, durationMs, preview?, error?, emittedAt}`
- `event: done` — `data:` = `{jobId, status: PipelineRunStatus}`, then the stream closes.

`streamProgress` subscribes to live **before** replaying `jobevents`, queues live messages during replay, then drains — deduping the boundary on monotonic `stageIndex` plus a `terminalWritten` latch.

### Every env var read in code

| Var | Where | Default |
|---|---|---|
| `API_PORT` | `api/config/env.ts` | `4000` |
| `MONGO_URI` | api + worker | `mongodb://localhost:27017/codeflow` |
| `REDIS_URL` | api + worker | `redis://localhost:6379` |
| `ANALYZER_VERSION` | `api/config/env.ts` | **`"mock-v1"`** |
| `NODE_ENV` | api env, cors, worker, dotenv guards | `"development"` |
| `CORS_ORIGINS` | `api/middleware/cors.ts` | `""` (prod ⇒ nothing allowed) |
| `WEB_PORT` | `api/middleware/cors.ts` | `"5173"` |
| `npm_package_version` | `api/routes/health.ts` | `"0.0.0"` |
| `LLM_PROVIDER` | `analyzers/providers.ts` (via `ProviderEnv`) | unset ⇒ inferred |
| `EMBEDDING_PROVIDER` | same | unset ⇒ inferred |
| `ANTHROPIC_API_KEY` | same | unset ⇒ Synthesize unregistered |
| `GEMINI_API_KEY` | same | unset |
| `VOYAGE_API_KEY` | same | unset ⇒ RAG unregistered |
| `SYNTHESIS_MODEL` | same | `"claude-opus-4-8"` |
| `GEMINI_MODEL` | same | `"gemini-2.5-flash"` |
| `VOYAGE_MODEL` | same | `"voyage-code-3"` (dim 1024) |
| `GEMINI_EMBEDDING_MODEL` | same | `"gemini-embedding-001"` |
| `GEMINI_EMBEDDING_DIM` | same | `768` |
| `CODEFLOW_TMP_DIR` | `worker/publicRepoCloneService.ts` | `os.tmpdir()/codeflow-public-repos` |
| `CODEFLOW_KEEP_TMP` | same | unset ⇒ cleans up |
| `CODEFLOW_MAX_FILES` | same, `getMaxFiles()` | `5000` — **only read by `discoverRepoFiles`, which nothing calls (dead code)** |
| `CODEFLOW_GIT_TIMEOUT_MS` | same | `120_000` |
| `GIT_TERMINAL_PROMPT` / `GIT_ASKPASS` / `GCM_INTERACTIVE` | same — set for child git, not read | `"0"` / `""` / `"never"` |
| `VITE_API_BASE_URL` | `web/lib/apiClient.ts` | `"http://localhost:4000"` (after `window.__CODEFLOW_CONFIG__.apiBaseUrl`) |
| `API_BASE_URL` | `web/docker/40-codeflow-config.sh` (runtime, writes `/config.js`) | `""` |
| `GITHUB_*` (`ACTIONS ACTOR EVENT_PATH REF REF_TYPE REPOSITORY SHA TOKEN WORKSPACE`) | `card/lib/*.js` only — outside the workspace | — |

`dotenv` loads `../../.env` (repo root) from api and worker, **skipped when `NODE_ENV=test`**.

### The guardrails

| Guard | Where | How |
|---|---|---|
| **1 — repo-size cap** | `analyzers/stages/ingest.ts:82-93` | Post-clone, pre-parse. `measureRepoSize(repoPath)` (real fs walk in `worker/services/measureRepoSize.ts`, skips `.git/.hg/.svn` + symlinks) vs `MAX_FILES 25_000` / `MAX_BYTES 512MB` → throws `RepoTooLargeError` → run `"failed"`, `statusReason: "repo-too-large"`. **If `measureRepoSize` is not injected the cap is silently skipped** (the worker does inject it). A second, independent clone-time cap (`CODEFLOW_MAX_FILES`, default 5000) exists in `discoverRepoFiles`, but that function is dead. |
| **2 — parse concurrency** | `stages/inventory.ts` via `util/concurrency.ts` `createLimiter` | `PARSE_CONCURRENCY = 8` |
| **3 — per-file parse timeout** | `stages/inventory.ts` `withTimeout` | `FILE_TIMEOUT_MS = 5_000`; a timed-out file is recorded in `unparsedFiles`, run continues |
| **4 — per-IP rate limit** | `api/middleware/rateLimit.ts`, mounted in `app.ts` on `POST /api/analyze` **and** `POST /api/result/:id/ask` (one shared store) | Fixed window, `RATE_WINDOW_MS 60_000` / `RATE_MAX 30`. Over ⇒ 429 + `Retry-After`. Key = `req.ip`. **Store is an in-process `Map`** (`createInMemoryRateLimitStore`) — the Redis-backed store is described in the doc comment but **not implemented**, so the limit is per-API-instance and resets on restart. Reads (health/results/jobs) unlimited. |
| **5 — daily LLM-spend ceiling** | `analyzers/budget/budgetHandle.ts` (in-memory) + `worker/services/workerAnalysisService.ts:createMongoBudgetHandle` (Mongo `llmbudget`) | `DAILY_LLM_BUDGET = 5_000_000` "tokens" per UTC day. `BudgetHandle {check(estimated): Promise<boolean>; record(actual): Promise<void>}`. Checked in all 4 paid paths: synthesize completion, RAG embed batch, Q&A query embed, Q&A answer — always **cache-first, then budget, then call**. |

**How spend is actually measured — this is the weak point.** There is no tokenizer and no provider usage read-back. Every `check`/`record` uses the same estimate:
```ts
function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
```
- Synthesize records `estimateTokens(SYSTEM_PROMPT + "\n" + prompt)` — **input only**; the completion's output tokens are never counted.
- RAG records `sum(plan[i].tokenCount)` over cache-missing chunks, itself the same char/4 estimate.
- Q&A records `estimateTokens(SYSTEM_PROMPT + "\n" + prompt)` and, separately, `estimateTokens(question)`.
- Units are undifferentiated: embedding tokens and chat tokens are added into one counter, at one implied cost.
- The source comments call real usage plumbing "a P7 refinement".
- **The API and worker do not share a budget.** `worker/index.ts` uses `createMongoBudgetHandle()`; `api/services/ragQaService.ts` uses `createInMemoryBudgetHandle()` — a per-process, per-restart counter. Q&A spend is invisible to the persistent ceiling and vice versa.

---

## 7. BUILD & TEST HEALTH (actually executed)

### `pnpm -r typecheck` — **PASS** (exit 0)
11 packages, `tsc --noEmit` each with `pretypecheck` dependency builds. Zero errors.

### `pnpm test` — **PASS** (exit 0). 44 test files, 291 tests, 0 failures.

| Package | Files | Tests |
|---|---|---|
| `@codeflow/analyzers` | 14 | 160 |
| `@codeflow/web` | 11 | 47 |
| `@codeflow/api` | 1 | 26 |
| `@codeflow/eval` | 2 | 18 |
| `@codeflow/graph` | 6 | 16 |
| `@codeflow/worker` | 2 | 11 |
| `@codeflow/parsers` | 7 | 10 |
| `@codeflow/shared-types` | 1 | 3 |
| `@codeflow/config` | 0 | *No test files found* |
| `@codeflow/exports` | 0 | *No test files found* |
| `@codeflow/card-action` | 0 | *No test files found* |
| `@codeflow/local-cli` | 0 | *No test files found* |

Every package uses `vitest run --passWithNoTests`, so the four empty ones exit green.

**Legacy root suite** — `node --test tests/*.mjs`: **PASS**, 25 tests, 0 fail (195 ms). Runs against `legacy/index.html`.

### `docker compose -f docker-compose.app.yml build` — **PASS** (exit 0)
Full three-image build against Docker Engine 29.5.3 completed in ~4 min:
```
Image codeflow-api    Built    331 MB
Image codeflow-web    Built    74.2 MB
Image codeflow-worker Built    454 MB
```
`docker compose config --quiet` also passes — the compose file is structurally valid, all three build contexts resolve, and both `${GEMINI_API_KEY:?...}` required-var guards fire correctly when unset.

Dockerfiles: all three are repo-root-context, multi-stage `node:20-slim` → `pnpm install --frozen-lockfile` → `pnpm -r build` → `pnpm --filter=<app> deploy --prod /prod`. api/worker run non-root uid 1001; worker installs `git` at runtime; web builds to `nginx:1.27-alpine` with a `/docker-entrypoint.d/40-codeflow-config.sh` hook that rewrites `/config.js` from `$API_BASE_URL`. api has a `HEALTHCHECK` hitting `/health`; worker and web have none.

### TODO / FIXME / placeholder / stub inventory (tracked source only; `dist/` excluded)

```
apps/api/src/routes/analyze.ts:85          TODO (deferred): add a real inline pipeline runner … never a mock
apps/api/src/db/models/PRReportModel.ts:20 // Placeholder only. PR report behavior is deferred.
apps/api/src/db/models/ShareModel.ts:19    // Placeholder only. Share-link behavior is deferred.
apps/card-action/src/index.ts:1-5          createCardActionPlaceholder() → {status:"placeholder"}   ENTIRE FILE
apps/local-cli/src/index.ts:3-4            TODO: Connect this command to the local/private analyzer pipeline   ENTIRE FILE
apps/web/src/app/routes.tsx:3              TODO: Replace this simple route config with a real router
apps/web/src/features/graph/GraphToolbar.tsx:9   TODO: Replace with real graph controls when 2D/3D graph rendering is migrated
apps/web/src/features/graph/GraphLegend.tsx:3    aria-label="Graph legend placeholder"
apps/web/src/features/dashboard/DashboardShell.tsx:25  "…is a placeholder (its own session, P17)"
apps/web/src/lib/analysisNormalizer.ts:8   dependencies/symbols/entryPoints INTENTIONALLY empty post-Connect
packages/config/src/constants.ts:6,37      ALL VALUES ARE PLACEHOLDERS FLAGGED FOR P7 TUNING
packages/eval/src/thresholds.ts:15,16,17   PLACEHOLDER — tune in P7  (×3)
packages/eval/src/dataset.ts:41,84         TEMPLATE_DATASET REPLACE_* placeholders; assertDatasetShape rejects them
packages/exports/src/index.ts:1-4          TODO (deferred): real export contracts … will be ported here
packages/analyzers/src/stages/orient.ts:102  The AI "what is this project" 3-liner is deferred to P3 — no LLM here
packages/analyzers/src/stages/ingest.ts:96   stageIndex/stageCount are placeholders the orchestrator overrides
packages/shared-types/src/index.ts:139,140,565,689,692,693,694  slices "deferred — not produced this session"
```
`throw new Error("not implemented")` — **ABSENT** (zero occurrences repo-wide).

`"mock"` in non-test production paths: `ANALYZER_VERSION` default `"mock-v1"`; `analysisJobService.ts:60` fallback `currentStep: "Mock analysis completed"` with hardcoded `parsedFiles: 42 / totalFiles: 42`; `repositoryService.ts:22` synthesizes `commitSha: "mock-{owner}-{name}-{branch}"` when no real SHA was requested; `apiClient.ts` error strings say "or use mock local mode"; `web/lib/mockAnalysis.ts` (190 LOC) is a deliberate demo-data path reachable from the UI.

### Empty / near-empty source files
```
  0 LOC ×10   card/examples/*.svg                       ALL TEN ARE ZERO BYTES
  4 LOC       packages/exports/src/index.ts             `export {}` — package has no API
  1 LOC       apps/web/src/test/setup.ts
  1 LOC       apps/web/src/vite-env.d.ts
  3 LOC       apps/web/src/lib/formatters.ts
  4 LOC       apps/web/public/config.js                 (intentional runtime-injection stub)
  5 LOC       apps/web/src/App.tsx                      (trivial wrapper)
  5 LOC       apps/local-cli/src/index.ts               stub
  7 LOC       apps/card-action/src/index.ts             stub
 10 LOC       apps/web/src/features/graph/GraphLegend.tsx           static markup
 10 LOC       apps/web/src/features/onboarding/OnboardingPanel.tsx
 12 LOC       apps/web/src/features/graph/GraphToolbar.tsx          static markup
 12 LOC       apps/web/src/features/repo-input/RepoInput.tsx
```

### Slices declared with NO producer

`AnalysisResultSlices` declares 14 keys. Only 7 are `owns:`-ed by a stage (`orientation`, `structure`, `inventory`, `graph`, `metrics`, `aiSynthesis`, `aiRag`). The rest:

| Slice | Producer | Consequence |
|---|---|---|
| `files` | none — **derived** from `graph.nodes` at assembly | fine, documented |
| `symbols`, `entryPoints`, `dependencies` | **none** | always `[]`; documented as deferred; web reads `graph`/`inventory` instead |
| `issues` | **none** | always `[]`; `analysisNormalizer` derives risk level from an always-empty array ⇒ always "low" |
| `summary` | **none** | `assembleResult` falls back to `defaultSummary()` ⇒ **`result.summary` is always `{files: 0, functions: 0, connections: 0, healthScore: null, healthGrade: null}`**. That is what gets written to the `analyses.summary` field and what `routes/analyze.ts:29` reads as `cached.summary.files` on a cache hit. Web masks it with `result.summary.files || nodes.length`. |
| `aiProjectSummary` | **none** | `result.ai.projectSummary` is never populated, despite the type slot, the `AiAnalysis` field, the orchestrator's `seedSlicesFromResult` handling, and a contract test exercising it. Orient is deterministic-only. |

### AI stages that silently no-op without a key — where "partial" comes from

**Registration-time no-op (silent to the user).** `pipelineJobProcessor.ts:129-137`:
```ts
if (deps.synthesisClient) stages.push(createSynthesizeStage({ client: deps.synthesisClient, now }));
if (deps.embeddingClient) stages.push(createRagStage({ client: deps.embeddingClient, readFile: deps.readFile, now }));
```
`worker/index.ts` builds those clients from env and `console.log`s `"Synthesize (AI) disabled: no chat provider key configured (deterministic pipeline only)."` / `"RAG (AI) disabled: …"`. That log goes to the **worker's stdout only** — it never reaches the API, the job record, `result.warnings`, or the UI. Consequences:
- With no keys the run has 6 stages, no AI stage fails, and the run status is **`"completed"`** — a fully green pipeline with `result.ai === undefined`. The web `PipelinePanel` seeds 8 pending stages from its own `PIPELINE_STAGES` constant, so stages 7–8 sit visually "pending" forever with no explanation.
- `result.ai.synthesis` missing → `dashboard.ts` sets `StartHere.available = false` and falls back to keyFiles-as-reading-order (honest, but the *reason* isn't surfaced).
- `result.ai.rag` missing → `POST /api/result/:id/ask` returns 200 with `{unavailable: true, answer: "Q&A is unavailable for this analysis (no searchable index was built — e.g. a deterministic-only or partial run)."}`.

**`"partial"` comes from exactly one place** — an AI stage that *was* registered and then **threw**. `orchestrator.ts` `catch`: `stage.kind === "ai"` ⇒ `aiFailed = true` plus a `warnings` entry, never `deterministicFailed`; status resolves `failed > aborted > partial > completed`. The four ways an AI stage throws:
1. Synthesize: all 3 attempts failed (network/API error, or output rejected by schema/grounding, or empty-after-grounding).
2. Synthesize/RAG: `BudgetExceededError` from the daily-ceiling pre-check → `statusReason: "budget-exhausted"`.
3. RAG: embedding API failed 3× on a batch.
4. RAG: `"RAG produced no grounded chunks; nothing to index."`, or on a no-disk retry `"RAG has no repoPath and no cached chunk plan"`.

A `"partial"` result **is** persisted (`shouldSave = status === "completed" || "partial"`) with a deterministic-only `producedBy`, which the cache's two-tier coverage logic then treats as an "AI-only retry" — a later run reuses the deterministic slices and re-attempts just the AI stages without re-cloning.

**Other silent-degradation paths, for completeness:**
- `createIngestStage` without `measureRepoSize` ⇒ Guard 1 skipped silently.
- `runPipeline` without `budget` ⇒ AI stages call providers unconditionally, no ceiling.
- `eventLogStore.append` swallows every error (`console.warn`, never rejects) ⇒ SSE replay can silently lose stages.
- Mongo down: `analysisCacheService` / `analysisJobService` / `repositoryService` all fall back to **in-process `Map`s** without telling the caller — the API keeps returning 2xx while persisting nothing durable.

---

## 8. VERDICT

What genuinely works end-to-end today is the deterministic spine and the plumbing around it. Paste a public GitHub URL, and the API validates it, writes a `jobs` row, enqueues a BullMQ `analyze` job, and streams SSE; the worker shallow-clones the repo, enforces a post-clone size cap, then runs six real deterministic stages — manifest/README orientation, a gitignore-aware file walk with role classification, a genuinely concurrent and timeout-guarded parse of JS/TS/JSX/TSX/Python into an uncapped symbol list, import extraction and resolution into a complete dependency graph keyed by POSIX path, and real graph algorithms (degree centrality, transitive blast radius, cycle detection, coupling) — assembles one `AnalysisResult`, persists it to Mongo under a `{repo, sha, analyzerVersion}` unique key, and the React SPA renders a live 8-row pipeline panel, a dashboard, a file drilldown, and a force-directed graph off it. With a `GEMINI_API_KEY` the two AI stages register and are, as far as the code goes, complete: Synthesize builds a bounded metadata-only prompt and has every citation checked against real graph nodes; RAG cuts deterministic symbol-aware chunks whose line ranges are validated against the files they came from, embeds them with content-addressed caching, and `POST /api/result/:id/ask` does cosine top-6 with a similarity floor that refuses to call the LLM rather than fabricate. Typecheck is clean across 11 packages, 291 tests pass in 44 files plus 25 legacy ones, and all three Docker images build.

What is scaffolded but hollow: `packages/exports` is literally `export {}`; `apps/local-cli` and `apps/card-action` are 5- and 7-line console/placeholder stubs while the real 1750-LOC `card/` action sits outside the workspace, unreferenced, with all ten of its example SVGs at zero bytes; `legacy/index.html` (6845 LOC) is dead as an app but still load-bearing as a CI test fixture; `prReports` and `shares` Mongo models are declared and never touched; `routes.tsx`, `GraphToolbar`, and `GraphLegend` are placeholders; and the eval package is a real, tested, continuous-scoring harness with no real cases in it at all.

The top five incomplete or fragile things: **(1)** cost control is estimated, not measured — one `Math.ceil(len/4)` heuristic in three copies, counting input only, mixing chat and embedding tokens into one counter, with the API's Q&A budget living in a per-process `Map` the worker's Mongo ceiling never sees, and no tokenizer, no provider usage read-back, no context-window budgeting, and no `maxTokens` ever actually set by a caller. **(2)** Seven declared slices have no producer; the load-bearing ones are `summary` and `issues` — nothing owns them, so `result.summary` is *always* the orchestrator's zero-filled default (`files: 0, functions: 0, healthScore: null`), which is what gets cached to Mongo and what `analyze.ts` reads as `cached.summary.files` on a cache hit — and nothing owns `aiProjectSummary` despite the type slot, the `AiAnalysis` field, and the orchestrator's seeding logic for it. **(3)** The no-key path is invisible — with no provider configured the run reports `"completed"` with `result.ai === undefined` and stages 7–8 stuck "pending" in the UI, the only signal being a `console.log` in the worker. **(4)** The vector store is `RagChunk[]` with full text and full embeddings inside a single Mongo document, retrieved by brute-force cosine in the API process, hard-capped by the 16 MB BSON limit, with no vector index, no reranking, no hybrid search, and single-turn-only Q&A. **(5)** The per-IP rate limit and every Mongo-down fallback are in-process `Map`s — the rate limit resets on restart and doesn't hold across API instances, and when Mongo is unavailable the job/analysis/repo services silently persist to memory while still returning 2xx.

Behind all of that, the repo is a single squashed commit on a fresh root with no shared ancestry with `main` or `upstream/main`, `codeflow.env` (which QUICKSTART requires) does not exist, and `ANALYZER_VERSION` defaults to the string `"mock-v1"`.
