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
JavaScript, JSX, TypeScript, TSX, Python, Go, Java, C# and C/C++ (C uses the C++ grammar). Grammars load **per language, on demand**: a
pipeline asks only for the languages its files need (`grammarsFor`), because grammars range from 0.2 MB
(Go) to 5.4 MB (C++). A regex parser per language takes over when a grammar fails, when a file is over
`TREE_SITTER_MAX_BYTES` (2 MB of characters), or when a parse returns null. Raw NUL bytes are replaced by
spaces before tree-sitter sees them (it stops at the first NUL; positions are unchanged).

**Parse once, walk once, cache by content.** For Go, Java, C# and C/C++, Inventory and Connect read the same
per-file extract: Inventory's is kept (consume-once, `treesitter/extractCache.ts`) and Connect takes it,
so each file is parsed once per run; each extractor collects all its node types in ONE tree walk
(`collectByType`). A pluggable `FactsStore` (`parsers/src/factsStore.ts`) keeps every file's parse
output by (kind, `ANALYZER_VERSION`, language, path, content hash): the CLI backs it with
`.codeflow/cache`, `impact` with one in-memory store for head and base. The CLI streams `--out` JSON
(`apps/local-cli/src/jsonOut.ts`) instead of building one giant string.

**Connect runs in two passes**: extract facts from every file, then resolve. Go, Java and C# resolve a name
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
| C# | the compiler's lookup: own types → same and **enclosing namespaces** (no `using`) → nested types of the type and its base classes → `using`s (one written inside a namespace is relative to it), project-level global usings (`global using`, `<Using>` in the .csproj and imported .props/.targets) → aliases; dotted names bind their first part from the innermost namespace outwards. Names carry **generic arity**; `[Test]` is `TestAttribute`; a part of a `partial` type depends on the parts it names. **Projects**: a file sees its own project and its transitive ProjectReferences only — not a same-named type elsewhere, nor source the build takes as a NuGet package or DLL, nor a file no project compiles; its own project's type wins a name clash. A file whose `#if` splits a construct is parsed once per branch | `csharpResolver.ts`, `msbuild.ts` |
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
| Resolve to the **declaring file**, not the package (Go, Java, C#) | "What breaks if this file changes" must answer at file granularity | `goResolver.ts`, `javaResolver.ts`, `csharpResolver.ts` |
| Java imports are `lazy` (no load-time cycles) | Java class cycles are legal; flagging them would be noise in every PR | `parsers/src/treesitter/cpg.ts` |
| `.gitignore` never drops a file git TRACKS (`git ls-files`) | It only governs untracked files; zlib commits its gitignored `zconf.h` | `mapStructure.ts`, both apps' `gitTrackedFiles` |
| Go same-package references are call edges, not import edges | Go forbids package cycles; file-level same-package edges would invent cycles | `connect.ts` |
| Grammars load per language, on demand | 25× size spread; a Go repo must not pay for C++ | `parsers/src/treesitter/runtime.ts` |
| Parse each file once per run; one tree walk per extractor; parse output cached by content hash | Profiling Kubernetes showed 13.5 s of 33 s parsing every file twice and ~9 s re-walking trees; a re-run should parse only what changed | `extractCache.ts`, `ast.ts` `collectByType`, `factsStore.ts` |
| Test selection fails safe: a change the graph cannot trace selects every test | A skipped failing test costs more than one extra test run; proven by fault injection, not argued | `apps/local-cli/src/impact.ts` `selectTests` |
| The PR bot is quiet by default | A bot that comments on every push gets muted; it speaks for cycles, broken imports, rule breaks, risky untested changes | `isNotable`, `action.yml` |
| Architecture rules are checked on the resolved graph, from a committed file | Boundaries break through aliases and workspace package names a text search cannot see | `apps/local-cli/src/rules.ts`, `codeflow.rules.json` |
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
- `lint` is `tsc --noEmit` per package (no ESLint). Packages' `pre*` scripts rebuild their dependencies,
  so build serially (`pnpm -r --workspace-concurrency=1 build`): in parallel two prebuilds can rewrite the
  same package's `.d.ts` while a third reads it (seen once: implicit-`any` errors in parser tests).
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
| `csharp-accuracy` | C# vs Roslyn (from the .NET 10 SDK) on MediatR (pinned SHA), same thresholds, ≥ 500 edges |
| `python-accuracy` | Python vs the import system (`importlib` PathFinder) on click (pinned SHA), same thresholds, ≥ 150 edges |
| `docker-smoke` | Builds and boots the stack, analyses a real repo end to end |
| `codeql.yml`, `codeflow-impact.yml`, `eval-scored.yml` (manual, keys) | Static analysis; dogfood PR report; scored eval |

### 3.3 Accuracy checks and evals

```bash
node apps/local-cli/dist/index.js analyze <repo> --no-index --out r.json
node scripts/graph-accuracy.mjs <repo> r.json        # TS/JS vs tsc
node scripts/accuracy/go.mjs    <repo> r.json        # Go vs go list   (local go, else Docker golang image)
node scripts/accuracy/java.mjs  <repo> r.json        # Java vs javac   (local JDK 17+, else Docker temurin)
node scripts/accuracy/csharp.mjs <repo> r.json       # C# vs Roslyn    (local .NET 10 SDK, else Docker dotnet/sdk:10.0)
node scripts/accuracy/c.mjs     <repo> r.json [--cmake "-DX=OFF"]   # C/C++ vs clang 21 (Docker; CMake projects)
node scripts/accuracy/python.mjs <repo> r.json      # Python vs importlib (local python3; nothing is executed)
```

`--truth <file>` reuses a saved truth JSON; Go's `--gopath <import path>` scores a GOPATH-era repo; C#'s
`--save-truth <file>` keeps the truth, and `CSHARP_TRUTH_EXPLAIN=<path part>` prints what each name in that
file bound to (stderr) — the way to find out why an edge differs.

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

**Hosted demo (`render.free.yaml`; what runs today)**: one Render Docker web service (API with
`RUN_WORKER_IN_PROCESS=true`), one Render static site, and three external free stores that do not
expire: Atlas M0 (Mongo), Neon (Postgres + pgvector), Upstash (Redis). AI: one OpenAI key for chat
(`gpt-4.1-mini`) and embeddings (`text-embedding-3-small`); no key = "map only".
1. Atlas: cluster running (a free cluster pauses after weeks with no connections — resume it),
   Network Access `0.0.0.0/0`, URI ending `/codeflow`. Neon: `CREATE EXTENSION vector` once. Upstash:
   the TCP `rediss://` URL with `?family=0` (IPv4; Render cannot reach it over IPv6).
2. OpenAI: prepaid credit with auto-recharge OFF (the hard spending cap), a project, a key.
3. API service env (all in `render.free.yaml`'s group): `MONGO_URI`, `POSTGRES_URL`, `REDIS_URL`,
   `OPENAI_API_KEY`, `LLM_PROVIDER=openai`, `EMBEDDING_PROVIDER=openai`, `OPENAI_MODEL`, the four
   `DAILY_*` guards, `LLM_PRICING`, `MAX_REPO_FILES=3000`, `MAX_INDEX_CHUNKS=4000`, `EMBEDDING_CACHE=false`,
   `TRUST_PROXY_HOPS=1`, `NODE_ENV`,
   `RUN_WORKER_IN_PROCESS`, `CORS_ORIGINS` = the site URL. **Remove any other vendor's key** (two keys
   without `LLM_PROVIDER` stop the boot, and the log says so). Never set `API_PORT`.
4. Static site: build command from the blueprint (`npm install -g pnpm`, not corepack — EROFS on
   Render's builder), publish `apps/web/dist`, rewrite `/*` → `/index.html`, `VITE_API_BASE_URL` = API
   URL (baked at build: change it ⇒ "Clear build cache & deploy").
5. Deploy from `main`; check `/health` (`warmedUp: true`, `retrieval.mode: postgres`) and `/api/meta`
   (`ai.enabled: true`, the model names). Then `node scripts/prewarm-demos.mjs <api-url>` so the demo
   repositories open instantly (spends cents; re-run after an `ANALYZER_VERSION` bump).
6. Free plan sleeps after 15 min (wake ≈ 30–60 s, the site shows "Warming…"); `starter` ($7/month)
   never sleeps and has 5x the CPU. No keep-alive pinger — it exhausts free hours and suspends the service.

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
| Worker | `WORKER_CONCURRENCY` (default 2, max 8), `MAX_REPO_FILES` / `MAX_REPO_BYTES` (size to memory: ≈ 150 MiB + 30 KiB per file per job), `WORKER_HEALTH_PORT`, `CODEFLOW_GIT_TIMEOUT_MS`, `CODEFLOW_TMP_DIR`, `CODEFLOW_KEEP_TMP` |
| Memory/storage guards | `MAX_INDEX_CHUNKS` (Q&A index cap; most connected files first; 4,000 on a 512 MB host), `EMBEDDING_CACHE=false` (no second copy of every vector in Mongo) |
| Spending guards | `DAILY_LLM_BUDGET` / `DAILY_EMBEDDING_BUDGET` (tokens per UTC day, all visitors; default 5,000,000 each), `DAILY_AI_ANALYSES_PER_IP` / `DAILY_QUESTIONS_PER_IP` (per visitor per UTC day; unset = no cap; "map only" is never capped) |
| Cost/observability | `LLM_PRICING`, `LANGFUSE_*`, `HELICONE_*`, `GIT_SHA` |
| MCP/eval | `CODEFLOW_MCP_SCOPES`, `CODEFLOW_MCP_RESULT`/`_API`/`_JOB`, `EVAL_DATASET`, `EVAL_FAIL_ON_THRESHOLD` |

Constants, not env vars (`constants.ts`): `DAILY_LLM_BUDGET` 5,000,000 (the default; env overrides) · `RATE_MAX` 30 per 60 s ·
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
| C# | Roslyn from the .NET SDK: every `.csproj` compiled as MSBuild would (Compile items, ProjectReferences, global usings, each target framework × Debug/Release), every name bound to an in-repo type → the files declaring that type (`scripts/accuracy/csharp-truth/`) | file → file |
| C/C++ | CMake `compile_commands.json` + clang 21 direct-per-file include reporting (`scripts/accuracy/c.mjs`) | file → included file |
| Python | `ast` + `importlib.machinery.PathFinder`, segment by segment, from `src/`, the root, nested projects and the file's first non-package ancestor (`scripts/accuracy/python-truth.py`) | (file, import) → file |

Results (2026-11-16) are in the README. Summary: TS/JS 100% precision, ≥99.76% recall (5 repos);
Go 100% / 100% on Kubernetes (59,823 edges), Hugo, etcd, etcd v3.3 (GOPATH) and cobra; Java 100% / 100%
on gson, commons-lang, jsoup, and ≥99.88% on JUnit 4 and Apache Ant (legacy layout); C/C++ 100% / 100%
on libuv, leveldb, fmt and zlib; C# 100% recall on MediatR, Serilog, Polly, Newtonsoft.Json and NUnit v2
(legacy, 59 old-style projects), precision 100% / 99.90% / 99.91% / 99.13% / 99.93%; Python 100% / 100% on click, httpx and requests, 98.45% / 100% on
flask and 99.97% / 100% on django (9,192 edges).

Known truth-tool artifacts (not CodeFlow errors): Go "extra" edges are files behind build tags a default
`go list` skips. Java: the truth compiles without third-party jars, so where a single-type import names a
missing library class, javac falls back to a same-package class of the same name (JUnit 4, Ant's
`MimeMailer`); Ant's test fixtures declare duplicate classes, and one javac task maps them all to the
first copy. Python: a test that edits `sys.path` at runtime (flask's conftest, one django test) makes
imports work that no static truth sees — CodeFlow's "extra" edges there are real. C#: CodeFlow reads both
sides of every `#if`, the compiler only the side a project builds (Newtonsoft.Json's polyfills for
frameworks no project builds, Polly's Windows-only test target, Serilog's pre-.NET 8 `TimeProvider`); the
reference build is Linux, so WinForms code does not bind; it cannot read Polly's own InternalsVisibleTo item;
and "Color Color" (`TestName.Name` where `TestName` is also a property) cannot be told apart without types.

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

**Where things stand (2026-11-25):** the priority is the hosted demo; Rust and PHP (Phase 1) wait until
after it. Deploy-readiness work done on `feat/languages`, all verified in the API image under a 512 MB
limit with the worker in-process (Mongo/Redis/pgvector local; AI against a local OpenAI-compatible stub,
so no money spent):
- **Two modes**: "Map only" (free, no AI, never capped) and "Map + AI", chosen per analysis (`withAi`);
  `/api/meta` reports `ai` + `limits`; an AI result replaces a stored map-only one for the same commit
  (it used to be discarded: first write won).
- **Cost guards for a few dollars of prepaid credit**: OpenAI default `gpt-4.1-mini`; env daily token
  ceilings (`DAILY_LLM_BUDGET`, `DAILY_EMBEDDING_BUDGET`); per-visitor daily caps (`DAILY_AI_ANALYSES_PER_IP`,
  `DAILY_QUESTIONS_PER_IP`, 429 `DAILY_LIMIT`); an answer cache on the agent Q&A path (a repeated
  question made 0 model calls); prices via `LLM_PRICING`.
- **Memory on 512 MB (measured)**: map only — nestjs/nest 2,811 files, 12 s, peak 280 MiB. With AI the
  same repository **ran the process out of heap** (V8 limit ≈ 256 MB) because every vector was held
  at once; with `MAX_INDEX_CHUNKS=4000` (most connected files first) it finished in 32 s at 316 MiB.
  Embedding-cache round trips now run 16 at a time instead of one by one; `EMBEDDING_CACHE=false` keeps
  vectors out of Mongo; `llmcache` entries expire after 30 days.
- **Boot failures are logged** (they exited silently); OpenAI inputs over the embedding limit are trimmed;
  Dockerfiles build only their app, one package at a time; `OPENAI_BASE_URL` for compatible endpoints.
- **Website** rebuilt to the owner's design (fonts, colours, full-height hero with the real snapshot graph,
  scroll-driven pipeline replay, routed C4 diagram), with the mode switch and plain-language banners;
  no sample number from the design ships.
What remains needs the owner: data stores awake, an OpenAI key and credit, Render env, merge, `NPM_TOKEN`
+ tag (the site shows `npx codeflow-local`), a recording.

| Phase | Status | What is left |
|---|---|---|
| **0. Land** | PR #4 (`fix/real-repo-correctness`) open; `feat/languages` builds on it (fast-forward of `main`, no conflicts) | Owner: merge; an OpenAI key (the owner has no Gemini key) so the AI half runs against a real model for the first time; grow eval sets from 8/10 to ~50 questions |
| **1. Languages** | **Go, Java, C# and C/C++ done**, Python benchmarked too (above). C#: 100% recall on 5 repositories against Roslyn, CI on MediatR. Entry points also come from the code itself (`main-function` evidence: Go `func main` in `package main`, Java/C# `static void main`, C/C++/Rust `main`, Python `if __name__ == "__main__":`) | **Rust** — truth: `rust-analyzer lsif` (JSON lines: every reference → its definition's file) in the official `rust` image after `cargo fetch`; count `use` paths and type/function paths, not method calls (type inference, as with Java/C# member access). Resolver: the `mod` tree (`foo.rs` / `foo/mod.rs` / `#[path]`), `crate::`/`super::`/`self::`, Cargo workspaces, and `pub use` re-export chains (the hard part). **PHP** — truth: composer's class map + nikic/php-parser's NameResolver (`php:cli` image) over every file; resolver: PSR-4/PSR-0 from `composer.json`, `use` and namespaces, plus legacy `include`/`require` paths. Kotlin later. Follow §3.4; each is the size of the C# work. |
| **2. Speed & scale** | **Done.** Kubernetes 34 s → 20.7 s and 1.95 GB → 1.07 GB peak (parse once, one walk per file, streamed output); a one-file change re-analyses it in 7.8 s; graph identical throughout. Load test (`scripts/load-test.sh`: 26 repos as PR bots, 20 browsing users), 2026-11-16: 1 / 2 / 4 workers → 26/26 jobs each, 26.7 / 52.5 / 91.1 jobs/min (1.97x, 3.4x), job p50 25.7 / 14.8 / 7.6 s, API read p95 ≤ 50 ms, slowest request 115 ms, 0 errors in 15,549 requests; a worker at concurrency 2 peaked at 499 MiB. The first run's anomalies did not recur (`urfave/cli` completed in all 3 runs — its old error was never recorded, so which fix resolved it is unknown; no request exceeded 5 s — the old 205 s request is unexplained, and the 30 s deadline + slow-request log would now catch one). Memory per analysis ≈ 150 MiB + 30 KiB per file (MediatR 224 files 148 MiB, Hugo 2,615 / 264 MiB, django 7,030 / 293 MiB, Kubernetes 26,595 / 890 MiB; CLI, fresh cache), so the repo cap is a per-worker memory budget (`MAX_REPO_FILES` / `MAX_REPO_BYTES`, default 25,000); the Render blueprints are sized to 512 MB. Speculative prefetch is opt-in; fan-out/best-of-N off. | Optional: re-run the load test against the deployed demo (real network, real instances), and add one 10k+-file repository to the burst. |
| **3. Online beats Claude alone** | **Pilot done** (README table, 76 runs, $4.02). Impact questions: + CodeFlow takes half the turns at 40–46% lower cost with equal accuracy; direct questions: a tie. Tuned from the runs: MCP server instructions (CodeFlow adoption 2/4 → 8/8), `listLimit` (MCP gets full lists; the 25-item cap had sent the client searching). `find_usages` added. | Scale the benchmark to large repositories (Kubernetes: Go truth is package-level, so impact questions per package) and more questions per kind; repeat runs to report variance. Ask the owner before spending on it. |
| **4. Real-problem checks** | **Done.** `codeflow-local tests` (test selection; proven by fault injection on CodeFlow's own suites: 32 faults, 193 failing test files, 0 missed, 80% of the analyzers suite skipped), `check` + `codeflow.rules.json` (CodeFlow's own layering, enforced in CI), `unused`, `impact --quiet` / the action's `quiet` input. History replay (`scripts/replay-history.mjs`): the last 50 commits each of zod, jsoup and Hugo — silent on all 150 (no false alarms); the replay also exposed and fixed a CLI bug (JSON output over 64 KB was cut off when stdout was a pipe) | Run the fault-injection proof on a third-party suite (needs the owner's OK to install and run it, e.g. in a container). Filing upstream issues for real findings is the owner's call. |
| **5. Ship** | **Prepared.** `.github/workflows/release.yml`: a `v*` tag publishes `codeflow-local` to npm with provenance (needs the `NPM_TOKEN` secret), pushes `ghcr.io/<owner>/codeflow-{api,worker,web,mcp}`, and creates the GitHub release. README leads with Map / Check / Ask and a quickstart. Demo snapshot regenerated (analyser 1.4.0). The ten longest essay comments are trimmed to their essentials | Owner: add `NPM_TOKEN`, push the first tag, tick "Publish to Marketplace" on that release, deploy a demo (DESIGN §3.5), record the GIF. Write the one post. |

Working rules: run the full gate (§3.2) before every commit; never add Claude/AI attribution to commits
or PRs; never claim a number that was not measured, and say where each one came from.
