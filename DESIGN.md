# CodeFlow — design, decisions, process

`README.md` is the public page: what CodeFlow is, quickstart, CLI, GitHub Action, measured accuracy.
This file is for whoever works on it: how it is built, why, how to run and ship it, and **where the
work stands** (section 7 — start there in a new session). Paths are relative to the repo root.

---

## 1. Architecture

### 1.1 Components

| Part | What it is |
|---|---|
| `apps/web` | React 18 + Vite SPA: a site plus a workbench (`workbench/Tab{System,Explore,Impact,Domains}.tsx`). The dependency map is a hand-written radial SVG (`lib/radial.ts`, `components/RadialGraph.tsx`). |
| `apps/api` | Express. Takes jobs, streams progress over SSE, serves results, answers Q&A. Can also host the worker in-process. |
| `apps/worker` | BullMQ consumer. Clones the repo, runs the pipeline, saves the result. |
| `apps/mcp` | MCP server over stdio. Graph, retrieval and verifier tools over a saved analysis. Never runs an analysis. |
| `apps/local-cli` | `codeflow-local`: offline `analyze`, `ask`, `verify`, `impact`. No key, no network. |
| `action.yml` (+ `.github/workflows/codeflow-impact.yml`) | PR-impact GitHub Action, built from local-cli source inside the job. |
| `packages/*` | `shared-types`, `config` (base layer); `parsers`; `graph`; `retrieval`, `memory` (drivers injected); `analyzers` (stages, orchestrator, providers, budget — filesystem-free); `agents` (Q&A agent, fan-out); `arena` (exact verifiers); `observability`; `eval`. |

### 1.2 One analysis, end to end

1. `POST /api/analyze` — only `mode: "public_hosted"`; owner/repo, branch and SHA checked by regex
   (`apps/api/src/utils/repoRef.ts`); rate-limited; job written to Mongo and queued on BullMQ
   `codeflow-analysis`. Queue down ⇒ 503 `QUEUE_UNAVAILABLE`, job marked failed, never a fake result.
2. The worker clones `https://github.com/{owner}/{repo}.git` with `--depth=1 --single-branch`
   (`apps/worker/src/services/publicRepoCloneService.ts`).
3. The orchestrator checks the cache before and after Ingest: full hit / AI-only retry / miss
   (`packages/analyzers/src/pipeline/orchestrator.ts`, `decideCacheAction`).
4. Each stage emits one progress event: worker `job.updateProgress` → API QueueEvents → SSE
   `GET /api/job/:id/events`, which replays the Mongo `jobevents` log first, then tails live events.
5. Only `completed` and `partial` runs are saved, unique on `{repoFullName, commitSha, analyzerVersion}`.
6. `GET /api/result/:id`. Q&A: `POST /api/result/:id/ask` runs the bounded agent
   (`packages/agents/src/askAgent.ts`).

Routes: `POST /api/analyze` · `GET /api/job/:id` · `GET /api/job/:id/events` · `GET /api/result/:id` ·
`GET /api/analysis/:analysisId` · `POST /api/result/:id/ask` · `GET /api/meta` · `GET /health`.

### 1.3 The pipeline

Stages live in `packages/analyzers/src/stages/`, scheduling in `pipeline/schedule.ts`.

- **Deterministic, always run:** ingest → orient → map-structure → inventory → connect → analyze.
- **AI, optional:** `synthesize` registers only when a chat key resolves; `rag` only with an embedding
  client plus vector and text stores. No keys ⇒ `runMode: "deterministic-only"` with typed `degradations[]`.
- A deterministic failure ⇒ `failed`. An AI failure ⇒ `partial` (the map survives). Abort ⇒ `aborted`.
- The result is assembled per slice, never deep-merged. AI output lives only under `result.ai.*`.
- Sequential by default. `PARALLEL_STAGES=true` launches a stage when its reads are ready; the only real
  parallel pair is `synthesize` ∥ `rag`. Speculative prefetch (builds RAG's chunk plan while synthesis
  waits) is a library default but **off in the worker** unless `SPECULATIVE_PREFETCH=true` — proven on the
  hermetic bench, not yet against a real provider.

**Graph.** `graph.edges` = dependencies only (fan-in/out count these). `graph.cpgEdges` (call, extends,
implements; weighted) and `graph.routes` are separate. Louvain runs on the union. `fileId` is always the
repo-relative POSIX path. Cycles count **load-time** edges only: `typeOnly`, `lazy` (imports inside a
function, and every Java import — the JVM loads classes on first use) and dynamic imports are excluded.

**Parsing** (`packages/parsers`). tree-sitter WASM (`web-tree-sitter` + `@vscode/tree-sitter-wasm`) for
JavaScript, JSX, TypeScript, TSX, Python, Go, Java and C/C++ (C uses the C++ grammar). Grammars load **per language, on demand**: a
pipeline asks only for the languages its files need (`grammarsFor`), because grammars range from 0.2 MB
(Go) to 5.4 MB (C++). A regex parser per language takes over when a grammar fails, when a file is over
`TREE_SITTER_MAX_BYTES` (2 MB of characters), or when a parse returns null. Raw NUL bytes are replaced by
spaces before tree-sitter sees them (it stops at the first NUL; positions are unchanged).

**Parse once, walk once, cache by content.** For Go, Java and C/C++, Inventory and Connect read the same
per-file extract: Inventory's is kept (consume-once, `treesitter/extractCache.ts`) and Connect takes it,
so each file is parsed once per run; each extractor collects all its node types in ONE tree walk
(`collectByType`). A pluggable `FactsStore` (`parsers/src/factsStore.ts`) keeps every file's parse
output by (kind, `ANALYZER_VERSION`, language, path, content hash): the CLI backs it with
`.codeflow/cache`, `impact` with one in-memory store for head and base. The CLI streams `--out` JSON
(`apps/local-cli/src/jsonOut.ts`) instead of building one giant string.

**Connect runs in two passes**: extract facts from every file, then resolve. Go and Java resolve a name
to the file that **declares** it, which needs every file's declarations first. Committed JavaScript
bundles (webpack / browserify / Parcel runtime signatures) are kept as nodes but not parsed for imports —
their `require("./_x")` calls address the bundle's own module table.

**Resolution** (`stages/moduleResolver.ts` is the single entry point):

| Language | Rules | File |
|---|---|---|
| JS/TS | relative, `.js`→`.ts`, tsconfig/jsconfig `paths` + `baseUrl` (with `extends`/`references`), workspace packages (exports/main, dist→src), `.d.ts` fallback | `moduleResolver.ts` |
| Python | relative + absolute, src layouts, submodule imports | `moduleResolver.ts` |
| Go | import path → package dir via `go.mod`, local `replace`, `go.work`, nested modules; GOPATH-era repos get their checkout prefix **inferred** from their own imports (one winner, ≥2 votes); the edge targets the file declaring the name used (`store.Open`) | `goResolver.ts` |
| Java | javac's order: own types → single-type imports → **same package (no import)** → on-demand imports; fully qualified uses; indexed by declared `package`, not path (Maven, Gradle, Ant, flat) | `javaResolver.ts` |
| C/C++ | compiler order: `"x"` beside the includer → ancestors and `include/` dirs (standing in for `-I`) → a path suffix (never for a bare `<x.h>`, which is a system header). Missing `"x.h"` ⇒ external (usually generated). A call reaches the file defining that function. Includes come from the tree **and** a line scan, because the grammar can lose its place in a preprocessor condition | `cResolver.ts` |

**Grounding (enforced in code).** (1) A reading-order step must name a real graph node or it is dropped
(`stages/synthesize.ts`). (2) A RAG chunk's line range must lie inside its file (`stages/rag.ts`).
(3) Q&A: the model may only emit a **chunk id**; file and lines come from the chunk actually retrieved,
unknown ids are dropped, `answered:true` with no surviving evidence becomes a refusal. One predicate,
`citationInRetrieved` (`packages/arena/src/verifiers/grounding.ts`), shared with the eval.

**Retrieval** (`packages/retrieval/src/hybridSearch.ts`): vector + BM25 → RRF (k=60) → chunk text →
reranker (lexical by default) → MMR (λ=0.7) → top 6. The refusal floor (`RAG_MIN_SIMILARITY` 0.2) is
checked against the vector arm's raw cosine, before fusion.

**Q&A agent**: prompted ReAct (not native tool calling). Tools `search_code`, `find_references`,
`get_callers`, `get_blast_radius`, `symbol_search`, `what_changed`. Caps: 6 turns, 10 tool calls, 4000
chars per tool result (`packages/config/src/constants.ts`).

**Fan-out synthesis** (`FANOUT_SYNTHESIS=true`, off by default): five specialist lenses per Louvain
community (≤12, concurrency 5) and a supervisor; best-of-N (N=3) on ≤3 hard communities, scored by an
exact verifier. 5N+1 provider calls. The only path that fills the Domains tab.

### 1.4 Data stores

| Store | Holds | Why | If missing |
|---|---|---|---|
| MongoDB | repos, analyses (+ overflow), jobs, llmcache, jobevents | Results cached by commit; LLM/embedding cache; SSE replay | API and worker exit at boot (5 s timeout). If it drops later, the API keeps runs in memory and reports `mongo-unavailable`. |
| Redis | BullMQ, shared daily budget, rate limit, sessions, repo memory, answer cache | One ceiling across processes and replicas | API falls back per-process and says so; the worker cannot consume. **Must be `noeviction`** or jobs vanish. |
| Postgres + pgvector | `codeflow_vectors_<dim>` (HNSW cosine) + `codeflow_chunk_text` | Worker writes the index, API reads it | In-memory per process, announced; in split mode every question is refused. `GET /health` → `retrieval.mode`. |

Mongo's 16 MB limit: above 8 MB of JSON the API moves `cpgEdges`, then `routes`, then `edges` to the
overflow collection; `nodes` never move (`apps/api/src/services/analysisOverflow.ts`).

### 1.5 Run modes

| Mode | How | Notes |
|---|---|---|
| Split hosted | `render.yaml`, `docker-compose.app.yml` | API and worker scale on different signals (requests vs queue depth). |
| Embedded | `RUN_WORKER_IN_PROCESS=true` (`render.free.yaml`) | Render has no free worker type. Concurrency forced to 1. |
| Offline CLI | `apps/local-cli` | Same deterministic stages, no synthesize. Vector store = JSON file; embedder = 256-dim feature hashing (lexical). Floor `LOCAL_MIN_SIMILARITY` 0.15. `zeroEgress.test.ts` checks the built bundle for network code. |
| MCP | `apps/mcp` | `CODEFLOW_MCP_RESULT`, or `CODEFLOW_MCP_API` + `CODEFLOW_MCP_JOB`. Tools: `find_references`, `get_callers`, `get_blast_radius`, `symbol_search`, `search_code`, `graph_facts`, `verify_citations`, `verify_answer`. Default-deny scopes (`CODEFLOW_MCP_SCOPES`). |

---

## 2. Critical decisions

| Decision | Why | Where |
|---|---|---|
| Stages 1–6 are byte-deterministic for `{repo, sha, analyzerVersion}` | The cache is keyed on the SHA; two answers for one key = wrong answers | `packages/config/src/constants.ts` |
| **Bump `ANALYZER_VERSION` whenever deterministic output changes** (now `1.2.0`) | Invalidates the whole cache without a purge | `constants.ts` |
| Import accuracy is scored against each language's **own toolchain**, in CI | The resolver once missed 102 of 543 of this repo's imports while every test passed | §4, `.github/workflows/ci.yml` |
| Resolve to the **declaring file**, not the package (Go, Java) | "What breaks if this file changes" must answer at file granularity | `goResolver.ts`, `javaResolver.ts` |
| Java imports are `lazy` (no load-time cycles) | Java class cycles are legal; flagging them would be noise in every PR | `parsers/src/treesitter/cpg.ts` |
| `.gitignore` never drops a file git TRACKS (`git ls-files`) | It only governs untracked files; zlib commits its gitignored `zconf.h` | `mapStructure.ts`, both apps' `gitTrackedFiles` |
| Go same-package references are call edges, not import edges | Go forbids package cycles; file-level same-package edges would invent cycles | `connect.ts` |
| Grammars load per language, on demand | 25× size spread; a Go repo must not pay for C++ | `parsers/src/treesitter/runtime.ts` |
| Parse each file once per run; one tree walk per extractor; parse output cached by content hash | Profiling Kubernetes showed 13.5 s of 33 s parsing every file twice and ~9 s re-walking trees; a re-run should parse only what changed | `extractCache.ts`, `ast.ts` `collectByType`, `factsStore.ts` |
| Experimental speed-ups (fan-out, best-of-N, parallel stages, speculative prefetch) are opt-in until a real-provider run measures them | An unmeasured optimisation does not get to be a default | `workerAnalysisService.ts` |
| Performance work is accepted only with an identical graph | A faster wrong answer is worse than a slow right one | `README.md` speed table, checked edge for edge |
| Louvain is seeded (xorshift32, seed 1, sorted ids, canonical relabel) | Plain Louvain gives a different partition each run | `packages/graph/src/communities.ts` |
| tree-sitter fallback is a size ceiling, never a timeout | A clock-based cut-off breaks determinism | `parseTreeSitter.ts` |
| WASM tree-sitter, not native bindings | One build for worker and CLI; no native toolchain | `packages/parsers/package.json` |
| Regex fallback kept for every language | Coverage never regresses when a grammar fails | `parsers/src/registry.ts` |
| AI failure ⇒ `partial`; failed/aborted runs not cached; partial runs are | The map must survive a provider outage; a partial run can be reused for an AI-only retry | `orchestrator.ts`, `pipelineJobProcessor.ts` |
| Cached RAG slice reused only if embedding model and dim match; cache keys include provider/model/dim/input type | Never mix vector spaces or another model's output | `orchestrator.ts`, `rag/embedCache.ts` |
| Check the cache before the budget; charge the budget when the provider call succeeds | A cache hit is free; rejected retries were billed but never counted | `synthesize.ts`, `rag.ts` |
| One Redis daily budget per UTC day, shared, fails **open** | Process-local ceilings could not see each other | `budget/budgetHandle.ts` |
| More than one provider key without `LLM_PROVIDER`/`EMBEDDING_PROVIDER` ⇒ boot error | A silent pick decides the bill and the embedding space | `analyzers/src/providers.ts` |
| Citations carry only a chunk id | A made-up line number cannot be expressed | `askAgent.ts` |
| Embedding dim is in the pgvector table name | `vector(n)` is fixed-width; one space per table | `pgvectorStore.ts` |
| Report `null`, never `0`, for unknowns (`usd`, `queueDepth`) | A 0 queue depth would scale in exactly when Redis breaks | `healthServer.ts`, `observability/src/exporters.ts` |
| `/health` never awaits a dependency | A blocking health check turns one outage into two | `apps/api/src/routes/health.ts` |
| Radial map, not force-directed | Positions must be reproducible (ring = fan-in rank) | `apps/web/src/lib/radial.ts` |
| No mock data in the UI; the demo is a real, labelled snapshot | Fake data looked like a real analysis | `scripts/build-demo-snapshot.mjs` |
| The clone is untrusted: a file whose real path leaves the clone is not read | `README.md -> /proc/self/environ` would put secrets in the result, the index and a prompt | `apps/worker/src/services/repoFileReader.ts` |
| Rate limit trusts an exact number of proxy hops (`TRUST_PROXY_HOPS`), never `true` | Without it everyone behind Render's proxy shares one bucket; `true` lets clients spoof their IP | `apps/api/src/app.ts` |
| No raw control bytes in source | A raw NUL once made two stage files invisible to grep and git | `tests/source-hygiene.test.mjs` |
| Few dependencies: no vendor SDKs (raw `fetch`), no ONNX/LanceDB/zod/OTel SDK; hand-written BM25 and Louvain | Install weight, hermetic tests, no running untrusted repos' toolchains | `package.json` files |

### Critical changes log

| Date | Change |
|---|---|
| 2026-11-16 | Import resolver rewritten and scored against tsc (0% → 100% of Zod's `.js`→`.ts` imports). Docker worker fixed (it exited on boot; jobs stayed queued). Load-time-only cycles. Tests parsed. Entry points filled. `verify`, `impact`, `verify_citations`, GitHub Action. (PR #4) |
| 2026-11-16 | Go (scored vs `go list`), Java (scored vs javac), C/C++ (scored vs clang), tracked files never dropped by `.gitignore`, lazy grammars, two-pass connect, bundle skipping, NUL handling. Symlink containment in both file readers; `TRUST_PROXY_HOPS`. TypeScript 6: `baseUrl` removed, every tsconfig `paths` made config-relative. Upstream `legacy/`, `card/` and their tests removed; the old docs folded into this file. Dead clone-time discovery code (and its no-op `CODEFLOW_MAX_FILES`) removed. `ANALYZER_VERSION` 1.2.0. |

---

## 3. Process

### 3.1 Develop

- Node 20, pnpm 9.15.4 (`npx -y pnpm@9.15.4` works without a global install). `docker-compose.yml` runs
  only the dev stores; `docker-compose.app.yml` is the full stack.
- `pnpm test` is serial (`--workspace-concurrency=1`); the parallel `pnpm -r test` can run out of memory.
- `lint` is `tsc --noEmit` per package (no ESLint). Packages' `pre*` scripts rebuild their dependencies.
- After an interrupted build, `rm -rf dist` and rebuild before trusting a failure.

### 3.2 CI gates (`.github/workflows/`)

| Gate | Proves |
|---|---|
| `ci.yml` → `gate`: frozen install, typecheck, lint, `pnpm test`, build | Types, the hermetic suite, the builds. No secrets, no service containers. |
| parity / eval check | tree-sitter ≥ regex on authored ground truth; golden datasets valid and pinned |
| repo hygiene | No raw control bytes in source |
| graph accuracy vs tsc (self) | TS/JS precision = 1, recall ≥ 0.99 on this repo |
| `go-accuracy` | Go vs `go list` on etcd (pinned SHA), precision = 1, recall ≥ 0.99, ≥ 1000 edges |
| `c-accuracy` | C vs clang 21 with the project's CMake flags on libuv (pinned SHA), same thresholds |
| `java-accuracy` | Java vs javac on jsoup (pinned SHA), same thresholds |
| `docker-smoke` | Builds and boots the stack, analyses a real repo end to end |
| `codeql.yml`, `codeflow-impact.yml`, `eval-scored.yml` (manual, keys) | Static analysis; dogfood PR report; scored eval |

### 3.3 Accuracy checks and evals

```bash
node apps/local-cli/dist/index.js analyze <repo> --no-index --out r.json
node scripts/graph-accuracy.mjs <repo> r.json        # TS/JS vs tsc
node scripts/accuracy/go.mjs    <repo> r.json        # Go vs go list   (local go, else Docker golang image)
node scripts/accuracy/java.mjs  <repo> r.json        # Java vs javac   (local JDK 17+, else Docker temurin)
node scripts/accuracy/c.mjs     <repo> r.json [--cmake "-DX=OFF"]   # C/C++ vs clang 21 (Docker; CMake projects)
```

`--truth <file>` reuses a saved truth JSON; Go's `--gopath <import path>` scores a GOPATH-era repo.

Scored eval (keys, money): put `packages/eval/results/<dataset>.json` (a full run, with AI stages, at the
dataset's pinned SHA, in its embedding space — gitignored), then `pnpm --filter @codeflow/eval run
eval:scored` or dispatch `eval-scored.yml`. Thresholds in `packages/eval/src/thresholds.ts` are
placeholders until a real run. The LLM judge gates only with ≥20 human labels and κ ≥ 0.6.

### 3.4 Adding a language (the recipe Go and Java followed)

1. `LanguageId` (`shared-types`), extension (`parsers/src/language.ts`), grammar (`treesitter/runtime.ts`).
2. Extractor `treesitter/<lang>.ts`: graph facts (imports, declarations, references, calls, inheritance,
   routes) and Inventory symbols. Regex fallback adapter `parsers/<lang>Parser.ts`.
3. `cpg.ts`: `<lang>Facts` + regex branch. Resolver `analyzers/src/stages/<lang>Resolver.ts`, routed
   through `moduleResolver.ts`; `connect.ts` maps the extension to the resolver language.
4. Tests: parser facts, resolver rules (one test per language rule), a connect end-to-end test.
5. A **truth tool from the language's own toolchain** in `scripts/accuracy/`, scored on ≥3 real repos
   including a legacy one; fix every miss that is ours; document truth-tool artifacts.
6. A pinned-repo CI job; README table; bump `ANALYZER_VERSION`.

### 3.5 Deploy

Images: `node:20-slim`, `pnpm deploy --prod`, non-root. API exposes 4000 with a `/health` HEALTHCHECK;
API and worker install `git` + `ca-certificates` (without them every https clone fails). Worker sets
`WORKER_HEALTH_PORT=4100`. Web: `nginx:1.27-alpine`, `/healthz`, `/config.js` written from
`API_BASE_URL` at start. MCP: stdio, no HEALTHCHECK.

**Render paid (`render.yaml`)**
1. Create MongoDB Atlas; check the URI with `mongosh "<URI>" --eval 'db.runCommand({ping:1})'`.
2. New → Blueprint → `render.yaml` (api, worker, static web, key value `noeviction`, Postgres 16; one region).
3. Fill env group `codeflow-shared`: `MONGO_URI`, provider keys, `LLM_PROVIDER`/`EMBEDDING_PROVIDER` if
   more than one key. `POSTGRES_URL`/`REDIS_URL` come from the blueprint. **Never set `API_PORT`.**
4. Set `CORS_ORIGINS` on the API to the web URL, redeploy. (`TRUST_PROXY_HOPS=1` is in the blueprint.)
5. Verify: `curl $API/health | jq '{warmedUp, retrieval}'` → `warmedUp: true`, `retrieval.mode: postgres`;
   `curl -N $API/api/job/<id>/events` streams line by line.
6. Run one analysis, then ask a question — a cited answer proves worker and API share Postgres and Redis.
7. Optional: `node scripts/prewarm-demos.mjs <api-url>` (spends money; re-run after a version bump).

**Render free (`render.free.yaml`)**: one API with `RUN_WORKER_IN_PROCESS=true`, static web, free Key
Value and Postgres, Gemini for chat and embeddings. Set `CODEFLOW_API_HOST` on the site and
`CORS_ORIGINS` on the API by hand.

**Demo snapshot**: `node scripts/build-demo-snapshot.mjs --repo <path> --name owner/repo` (offline;
refuses a dirty tree without `--allow-dirty`), commit `apps/web/src/demo/snapshot.json`.

**npm (not yet done)**: `cd apps/local-cli && pnpm build && pnpm bundle && npm pack --dry-run && npm publish --access public`.

### 3.6 Environment (`.env.example` is the full list)

| Group | Variables |
|---|---|
| Stores | `MONGO_URI`, `REDIS_URL`, `POSTGRES_URL` (API and worker must name the same instances) |
| Providers | `LLM_PROVIDER` (anthropic \| gemini \| openai), `EMBEDDING_PROVIDER` (voyage \| gemini \| openai), `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `VOYAGE_API_KEY`, `OPENAI_API_KEY` |
| Models | `SYNTHESIS_MODEL`, `GEMINI_MODEL`, `OPENAI_MODEL`, `VOYAGE_MODEL`, `GEMINI_EMBEDDING_MODEL`/`_DIM`, `OPENAI_EMBEDDING_MODEL`/`_DIM` |
| Flags | `FANOUT_SYNTHESIS`, `PARALLEL_STAGES`, `SPECULATIVE_PREFETCH`, `FAST_MODEL`, `RUN_WORKER_IN_PROCESS` (all off by default) |
| API/web | `API_PORT` → `PORT` → 4000, `CORS_ORIGINS`, `TRUST_PROXY_HOPS`, `WEB_PORT`, `API_BASE_URL`, `VITE_API_BASE_URL` (build time) |
| Worker | `WORKER_CONCURRENCY` (default 2, max 8), `WORKER_HEALTH_PORT`, `CODEFLOW_GIT_TIMEOUT_MS`, `CODEFLOW_TMP_DIR`, `CODEFLOW_KEEP_TMP` |
| Cost/observability | `LLM_PRICING`, `LANGFUSE_*`, `HELICONE_*`, `GIT_SHA` |
| MCP/eval | `CODEFLOW_MCP_SCOPES`, `CODEFLOW_MCP_RESULT`/`_API`/`_JOB`, `EVAL_DATASET`, `EVAL_FAIL_ON_THRESHOLD` |

Constants, not env vars (`constants.ts`): `DAILY_LLM_BUDGET` 5,000,000 · `RATE_MAX` 30 per 60 s ·
`MAX_FILES` 25,000 and `MAX_BYTES` 512 MB (checked after clone) · `FILE_TIMEOUT_MS` 5 s · RAG and agent caps.

### 3.7 Operating

| Symptom | Cause / fix |
|---|---|
| Every question says "could not find that" | `/health` → `retrieval.mode: memory`: Postgres not reached |
| CORS errors against a healthy API | `CORS_ORIGINS` not set |
| One user's traffic rate-limits everyone | `TRUST_PROXY_HOPS` unset behind a proxy |
| Render marks the API unhealthy | `API_PORT` is set — remove it |
| Jobs queue but never run | No worker, or a typo in `RUN_WORKER_IN_PROCESS` (treated as false, logged) |
| `queueDepth: null` | Redis unreadable — do not treat as 0 |
| Q&A empty after changing embedding provider/dim | Expected: new `codeflow_vectors_<dim>` table; re-analyse |

Scale the worker on `/metrics` `queueDepth`, not CPU; termination grace ≥ 300 s (a killed job re-pays).

---

## 4. Measured accuracy (how, and the numbers)

Each language's graph is compared with **that language's own resolver**, edge by edge:

| Language | Truth | Unit compared |
|---|---|---|
| TS/JS | `ts.resolveModuleName` under the nearest tsconfig (`scripts/graph-accuracy.mjs`) | (file, specifier) → file |
| Go | `go list -deps -test` per module + go/parser (`scripts/accuracy/go-truth.go`) | (file, import) → package directory |
| Java | javac Compiler Tree API: every source name that resolves to an in-repo type (`scripts/accuracy/JavaTruth.java`) | file → file |
| C/C++ | CMake `compile_commands.json` + clang 21 direct-per-file include reporting (`scripts/accuracy/c.mjs`) | file → included file |

Results (2026-11-16) are in the README. Summary: TS/JS 100% precision, ≥99.76% recall (5 repos);
Go 100% / 100% on Kubernetes (59,823 edges), Hugo, etcd, etcd v3.3 (GOPATH) and cobra; Java 100% / 100%
on gson, commons-lang, jsoup, and ≥99.88% on JUnit 4 and Apache Ant (legacy layout); C/C++ 100% / 100%
on libuv, leveldb, fmt and zlib.

Known truth-tool artifacts (not CodeFlow errors): Go "extra" edges are files behind build tags a default
`go list` skips. Java: the truth compiles without third-party jars, so where a single-type import names a
missing library class, javac falls back to a same-package class of the same name (JUnit 4, Ant's
`MimeMailer`); Ant's test fixtures declare duplicate classes, and one javac task maps them all to the
first copy. Python has no reference-resolver benchmark yet.

---

## 5. Security notes (checked against code)

- Only `public_hosted` jobs; owner/repo/branch/SHA regex-checked; clone URL built server-side. `git` via
  `spawn` with `shell:false`, `GIT_TERMINAL_PROMPT=0`, empty `GIT_ASKPASS`, a timeout.
- The clone is untrusted: both file readers refuse a path whose real path leaves the repository; the
  walkers skip symlinks; size caps are checked after clone, before parsing.
- Production CORS is an allow-list; JSON bodies ≤ 1 MB; `/api/analyze` and `/ask` rate-limited per client
  IP (429 + `Retry-After`); limit and budget fail open when Redis errors — by design.
- MCP is default-deny; no tool analyses, writes, or calls the Q&A agent.
- Secrets only at runtime; `.env*` and `codeflow.env` gitignored; Render secrets `sync:false`; CI gate
  has no secrets.
- ReDoS: 22 CodeQL alerts fixed with linear patterns, none dismissed (cloned source is hostile input);
  regression tests require a 200k-char hostile input in < 2 s. No input-length cap (it would drop
  imports on minified files).
- The product does no security analysis, and never labels an issue "security".

---

## 6. Never exercised against real services

Provider adapters with a real key, the scored eval and judge labels, Redis guards across two replicas,
pgvector on a managed host, Langfuse/Helicone, a real MCP client, the live benchmark, any deployment.

---

## 7. Roadmap and status — start here

The plan (agreed 2026-11-16): CodeFlow is a resume project that must show **measured correctness**,
**speed at scale under load**, and **real engineering problems solved** — keep the distributed
architecture, but every part must earn its place with a number. Two modes: offline = facts (no model),
online = explanation (the user's own Claude/Cursor over MCP, or a built-in AI with their key).
Out of scope: an AI line-by-line reviewer, auto-fixing, production tracing, an IDE plugin, migration tools.

| Phase | Status | What is left |
|---|---|---|
| **0. Land** | PR #4 (`fix/real-repo-correctness`) open; `feat/languages` builds on it | Owner: merge PRs; provide an API key (Gemini free tier) so the AI half and the scored eval run for the first time; grow eval sets from 8/10 to ~50 questions |
| **1. Languages** | **Go, Java and C/C++ done** (above). C# extractor + resolver drafted on branch `wip/csharp` (not built or measured) | C# (finish; truth: Roslyn), Rust (truth: the crate module tree from `rustc`), PHP (truth: composer's class map); Kotlin later. Content-based entry points (`func main`, `static void main`, `int main`). Follow §3.4. |
| **2. Speed & scale** | **Done:** Kubernetes 34 s → 20.7 s and 1.95 GB → 1.07 GB peak (parse once, one walk per file, streamed output); incremental analysis — a one-file change re-analyses Kubernetes in 7.8 s; graph identical throughout | Load test: harness built (`scripts/load-test.sh` + `.mjs`, `docker-compose.loadtest.yml`: 24 repos as PR bots, 20 browsing users, 1/2/4 workers). First run: 2 workers → 23/24 jobs in 27.9 s, API reads p95 ≤ 21 ms, 0 errors. **Not yet trustworthy**: `urfave/cli` fails every run (it analyses fine with the CLI, so the cause is the clone/worker path — the script now records each failed job's error), the files-analysed count read 0 (fixed: read from the result), and at 4 workers one `/api/result` request hung 205 s, which also stretched the computed throughput (fixed: 30 s request deadline, slow requests logged with timestamps, throughput from the jobs' own timeline). Re-run before quoting scaling numbers. Speculative prefetch is now opt-in (`SPECULATIVE_PREFETCH`); fan-out/best-of-N were already off. Still open: replace the hosted 25k-file cap with streaming. |
| **3. Online beats Claude alone** | **Pilot done** (README table, 76 runs, $4.02). Impact questions: + CodeFlow takes half the turns at 40–46% lower cost with equal accuracy; direct questions: a tie. Tuned from the runs: MCP server instructions (CodeFlow adoption 2/4 → 8/8), `listLimit` (MCP gets full lists; the 25-item cap had sent the client searching). `find_usages` added. | Scale the benchmark to large repositories (Kubernetes: Go truth is package-level, so impact questions per package) and more questions per kind; repeat runs to report variance. Ask the owner before spending on it. |
| **4. Real-problem checks** | `impact` exists | Test selection proven on real commit history; architecture rules file in CI; dead-code report; quiet PR comment; replay OSS PR history and file real issues |
| **5. Ship** | — | npm publish, Marketplace listing, live demo, 60-second GIF, README around Map / Check / Ask, one write-up |

Working rules: run the full gate (§3.2) before every commit; never add Claude/AI attribution to commits
or PRs; never claim a number that was not measured, and say where each one came from.
