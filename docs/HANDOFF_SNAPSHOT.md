# CodeFlow — Handoff Snapshot (read-only audit)

**Audited:** 2026-09-15 · **Working tree:** `D:\Code_Flow` · **Branch:** `V2-codeflow` @ `ddacc83`
**Method:** verified against the LIVE tree. Every doc in this repo (`CODEBASE_SNAPSHOT.md`,
`CURRENT_STATE.md`, `PHASE_LOG.md`, …) was treated as a claim to check, not as evidence.
Anything I could not verify is marked **UNVERIFIED**.

**One-line verdict:** the tree is GREEN (typecheck, 1376 tests, build, 25 legacy tests all exit 0),
the engineering is unusually honest, and the two biggest problems are that **the flagship features
are off by default** and that **the documented one-command Docker path ships Q&A silently broken**.

---

## A. Git & branch reality

### Current branch and status

```
branch:  V2-codeflow  (tracks origin/V2-codeflow)
status:  clean  (no uncommitted, no untracked)
```

> **Disclosure — one file changed during this audit and was restored.** At 15:20 in this session
> `SECURITY_TRIAGE.md` lost a literal U+2028 byte (10857 → 10854 bytes), which `git status` at
> session start had not reported. No hook, no `.gitattributes` rule for `.md`, and no write command
> I issued explains it; **cause UNVERIFIED**. I ran `git checkout -- SECURITY_TRIAGE.md` to put it
> back. `git status` is clean again. No other file was touched except this report.

### `git log --oneline -15`

```
ddacc83 feat(deploy): Render blueprint + the platform PORT bug it exposed
c1c5fd0 fix(security): make every ReDoS-flagged pattern linear — 22 CodeQL alerts, 0 dismissed
a861ac7 docs: backfill V3-P5, record V3-FINAL, verify Phases 0-5, write the runbook
510cee5 refactor(eval): share the Arena's citation rule instead of keeping a fourth copy
5d14082 feat(web): build both surfaces from the design — paper site + dark workbench
fde623b feat: the data every new view needs, so no component has to invent a number
49d157a fix(observability): make the measured cost actually reach somewhere — and charge for rejected completions
b55e523 feat(analyzers): wire speculative prefetch into the pipeline orchestrator (P5 DoD 1d)
7a56eb0 feat(agents): put the versioned blackboard on the live fan-out path (P5 DoD 2e)
beaa8d8 fix(api): register the API's real warm-up tasks (P5 DoD 1e)
3106f70 feat(observability): wire trace export at the worker composition root (P5 DoD 2d)
1193d93 fix(observability): stop embedding a raw NUL byte in the tracer source
81b3bb9 docs: ENGINEERING_LOG.md — decisions with the measurement behind them
73582d2 feat(agents): offline consolidation into a compact queryable repo KB
89223a1 feat(deploy): health, autoscale, CDN + ledger #20 and #21 resolved
```

### All branches, and divergence from `origin/main`

| Branch | Kind | Behind `origin/main` | Ahead | Last commit |
|---|---|---:|---:|---|
| `V2-codeflow` ← **HEAD** | local + `origin/` | 1 | 0 | 2026-09-01 `ddacc83` |
| `v3/final-build-verify` | local only | 54 | 51 | 2026-09-01 `a997906` |
| `v3/p5-marvel-reach` | local only | 54 | 41 | 2026-08-31 `ca89bb1` |
| `v3/p4-agent-fanout` | local only | 54 | 34 | 2026-08-31 `2423125` |
| `v3/p3-agentic-memory` | local only | 54 | 31 | 2026-08-31 `acd75bc` |
| `v3/p2-retrieval` | local only | 54 | 27 | 2026-08-31 `5c77462` |
| `v3/cleanup-deadcode` | local only | 54 | 22 | 2026-08-30 `b3d2bdd` |
| `v3/p0-backfill-foundations-arena` | local only | 54 | 14 | 2026-08-30 `f75ef76` |
| `v3/p1-treesitter-cpg` | local only | 54 | 8 | 2026-08-30 `3a53c1c` |
| `phase1-rebuild` | local only | 54 | 3 | 2026-08-28 `3333f34` |
| `main` | tracks `upstream/main` | 55 | 113 | 2026-05-03 `8cb11ee` |
| `codeflow-cleanup` | local only | 55 | 150 | 2026-06-19 `6765f1f` |
| `fresh-main` | tracks `origin/main` | 54 | 0 | 2026-06-19 `799b6ff` |
| `codeflow-mern-phase-6-mongo-cache` | `git-the-point/` | — | — | 2026-05-30 `3aa1839` |

Remotes: `origin` = `AnshulMohanty/Code_Flow`, `git-the-point` = `AnshulMohanty/GitThePoint`,
`upstream` = `braedonsaunders/codeflow` (this project is a **fork**; the `card/` action is still
authored `braedonsaunders`).

### The direct answers

- **`origin/main` is `9bf2a45`**, a merge commit: *"Merge pull request #1 from AnshulMohanty/V2-codeflow"*.
  So `origin/main` = `V2-codeflow` + the merge. Nothing is lost.
- **Is the V3 work pushed?** **Yes — via `V2-codeflow`.** `V2-codeflow` @ `ddacc83` is the tip of the
  whole V3 line (P0→P5→FINAL squashed onto one branch) and is pushed to `origin` *and* merged into
  `origin/main` through PR #1. The **ten `v3/*` phase branches are local-only** — they exist on no
  remote. They are historical working branches; their content is contained in `V2-codeflow`.
  Losing this laptop loses the per-phase history but not the code.
- **Newest real branch:** `V2-codeflow` (2026-09-01). `v3/final-build-verify` shares the same date
  but its content is already folded into `V2-codeflow`.
- **Is the tree red or green?** **GREEN.** See §E — typecheck exit 0, 1376 vitest tests passing,
  build exit 0, 25/25 legacy tests. Verified on this machine, this session.

---

## B. Live workspace map

### Tree to depth 3 (excluding `node_modules`, `dist`, `build`, `.git`, `coverage`)

```
.
├── .github/workflows/{ci.yml, codeql.yml, eval-scored.yml, keepalive.yml}
├── apps/
│   ├── api/       {Dockerfile, package.json, src/, tsconfig.json}
│   ├── local-cli/ {package.json, src/, tsconfig.json}
│   ├── mcp/       {Dockerfile, package.json, src/, tsconfig.json}
│   ├── web/       {Dockerfile, docker/, index.html, public/, src/, vite.config.ts, …}
│   └── worker/    {Dockerfile, package.json, src/, tsconfig.json}
├── packages/
│   ├── agents/ analyzers/ arena/ config/ eval/ graph/
│   └── memory/ observability/ parsers/ retrieval/ shared-types/
├── card/          {index.js, action.yml, lib/, render/, examples/*.svg}   ← legacy GitHub Action
├── legacy/index.html                                                     ← 6,845-line old app
├── scripts/       {keepalive.mjs, live-benchmark.mjs}
├── tests/         {codeflow-golden.test.mjs, md-extractors*, verify-brain-vault.mjs, fixtures/}
├── docker-compose.yml · docker-compose.app.yml · render.yaml
├── start.sh · start.bat · tsconfig.base.json · pnpm-workspace.yaml
├── screenshot.png (1.0 MB) · codeflow-social.png (297 KB)               ← tracked, 0 in-repo refs
└── *.md × 12 (README, PLAN, V3_PLAN, CURRENT_STATE, PHASE_LOG 218 KB, …)
```

`pnpm-workspace.yaml` is exactly `apps/*` + `packages/*` → **16 workspaces**. `card/` and `legacy/`
are **not** workspaces. `docs/` did not exist before this report.

### Per-workspace reality

LOC = non-test `.ts`/`.tsx` under `src/`. "Builds" verified by `pnpm -r build` exit 0 (§E).

| Workspace | Purpose (one line) | LOC | Main entry | Builds |
|---|---|---:|---|:--:|
| `apps/api` | Express: enqueue, SSE progress, results, grounded Q&A. Mongo + Redis/BullMQ. | 3250 | `src/index.ts` → `src/app.ts` | ✅ |
| `apps/worker` | BullMQ consumer: clones, runs the 8 stages, persists. The composition root. | 2057 | `src/index.ts` | ✅ |
| `apps/web` | React 18 + Vite SPA: marketing site + dark "workbench" (4 tabs). | 4636 | `src/main.tsx` → `src/App.tsx` | ✅ |
| `apps/mcp` | MCP stdio server exposing 7 graph/retrieval/verify tools over a saved analysis. | 622 | `src/index.ts` → `src/server.ts` | ✅ |
| `apps/local-cli` | Keyless on-device analysis + local index. No network in its import graph. | 467 | `src/index.ts` → `src/analyzeLocal.ts` | ✅ |
| `packages/analyzers` | The 8 stages, orchestrator, DAG schedule, LLM/embedding adapters, model router, budget. | 6425 | `src/index.ts` | ✅ |
| `packages/agents` | Q&A agent loop + tools; fan-out orchestrator (specialists/blackboard/supervisor/best-of-N); KB consolidation. | 4239 | `src/index.ts` | ✅ |
| `packages/eval` | Golden datasets, scorers, judge, parser-parity, threshold CLIs. | 2983 | `src/index.ts` + 5 CLIs | ✅ |
| `packages/retrieval` | BM25 + vector + RRF + MMR + reranker; pgvector/in-memory/file stores; local embedder. | 2655 | `src/index.ts` | ✅ |
| `packages/parsers` | tree-sitter WASM (JS/TS/JSX/TSX/Python) + regex fallback; CPG extraction; import resolution. | 2377 | `src/index.ts` | ✅ |
| `packages/shared-types` | The contract surface for every slice + a contract test. | 1367 | `src/index.ts` | ✅ |
| `packages/observability` | Recording tracer, cost model, exporters (HTTP/OTel-bridge), versioned blackboard. | 1207 | `src/index.ts` | ✅ |
| `packages/graph` | Dependency + code-property graph, centrality, cycles, blast radius, Louvain communities. | 1073 | `src/index.ts` | ✅ |
| `packages/arena` | Task/verifier/reward contracts; grounding + graph-oracle verifiers; synthetic tasks. | 1027 | `src/index.ts` | ✅ |
| `packages/memory` | Session + repo memory, Redis-backed with in-memory fallback. | 819 | `src/index.ts` | ✅ |
| `packages/config` | Shared constants (budgets, top-k, thresholds). Zero deps. | 177 | `src/index.ts` | ✅ |
| **Total** | | **~35.4k** non-test (≈56.5k incl. tests) | | **16/16** |

Not workspaces: `card/` (~1.5k LOC CommonJS GitHub Action) and `legacy/index.html` (6,845 lines).

---

## C. State-doc digest

`V3_PLAN.md`, `PLAN.md`, `CURRENT_STATE.md`, `PHASE_LOG.md`, `ENGINEERING_LOG.md`, `GO_LIVE.md`,
`QUICKSTART.md`, `README.md` all exist. Also present: `DEPLOY.md`, `VERIFICATION_REPORT.md`,
`SECURITY_TRIAGE.md`, `CLEANUP_MANIFEST.md`, `CODEBASE_SNAPSHOT.md`.

**`README.md`** (8 KB, last touched 2026-06-19 — the oldest of the set)
1. Positions CodeFlow as a self-hostable 8-stage code-analysis app; the stage table matches the code exactly.
2. Claims everything the AI says is grounded and validated against graph nodes and line ranges — **true on the live path** (§D).
3. Claims a **"2D dependency graph — interactive force-directed graph"** — **FALSE against the live tree.** `react-force-graph-2d` was deliberately removed; the UI is a deterministic radial SVG.
4. Claims bring-your-own-AI (Gemini/Anthropic chat, Gemini/Voyage embeddings) — true, `providers.ts`.
5. Claims guardrails: repo-size cap, per-IP rate limit, daily LLM ceiling — all three exist in code.

**`QUICKSTART.md`** (2 KB)
1. Promises Docker Desktop + a free Gemini key + `./start.sh` → working app on `localhost:5173`.
2. Names `docker-compose.app.yml` as the one-command path.
3. States Gemini powers both chat and embeddings from one key — true.
4. Lists ports 5173 / 4000 / 27017 / 6379.
5. **Omits Postgres entirely** — and so does `docker-compose.app.yml`, which is why Q&A silently returns nothing on this path (§G, the blocker).

**`PLAN.md`** (11 KB, 2026-06-10) — "canonical intent"
1. Hosted web app, public GitHub repos only, explicitly "do not claim private-repo support".
2. Positions it as a fullstack-AI-engineer portfolio piece: MERN + job queue + grounded AI.
3. Locks provider-agnostic AI behind injectable clients selected by env.
4. Names the staged SSE pipeline as the USP.
5. Predates all V3 work — says nothing about tree-sitter, CPG, communities, agents, MCP, or the local CLI.

**`V3_PLAN.md`** (43 KB, 2026-09-01)
1. The V3 "Cartograph" build plan: phases P0–P5 with entry gates and acceptance criteria, all ticked.
2. Lists 7 global invariants, all marked ✅ (deterministic spine, three grounding passes, measured cost, no secrets, runtime validation at untrusted boundaries only, visible degradation, tests never regress).
3. Amends the original "zod at every boundary" invariant to "typed interfaces + contract tests; runtime validation only at untrusted boundaries" — an honest retcon, stated as one.
4. Its §5 asked for **LanceDB + int8 MiniLM**; neither shipped (§D).
5. Names `docs/CodeFlow-v3-Design-Doc.md` as the companion "why" doc — **that file does not exist in this tree**.

**`CURRENT_STATE.md`** (129 KB)
1. Header says *"Last updated: 2026-08-31 — V3-P4"* — **stale**; the body goes through V3-P5 and the file was written 2026-09-01.
2. Carries the **"955 tests"** figure in its V3-P4 block. That number is a V3-P4-era snapshot, superseded (§E).
3. Holds the 33-item **deferred ledger** — the single most useful artefact in the repo.
4. Documents the V3-P5 DoD table, including *"Deploy — CONFIG MET, execution deferred. ⚠️ Nothing deployed."*
5. Explicitly records the two local-CLI substitutions as owner-deferred rather than hiding them.

**`PHASE_LOG.md`** (218 KB, append-only)
1. Session-by-session execution record from 2026-05-30 to V3-FINAL.
2. Records the original cleanup that deleted `mockAnalysisFactory.ts` (hardcoded `healthScore: 82` etc.).
3. Records per-phase test counts as they grew (291 → 526 → 742 → 881 → 955 → 1207 → 1336).
4. Records measurements (supervisor prompt 668 tokens at both 12 and 60 communities; 496ms → 126ms fan-out).
5. Uses **two conflicting `#N` numbering schemes** — an early P-phase one and the ledger one — so "#20" means two different things depending on the paragraph (§C ledger note).

**`ENGINEERING_LOG.md`** (17 KB)
1. Decisions where a measurement changed the outcome; explicit rule that an entry must contain a number.
2. The dependency-weighing table: `onnxruntime-node` 211 MB REJECT, `@huggingface/transformers` REJECT, `@lancedb/lancedb` 656 MB REJECT, `pg` +4 MB ACCEPT.
3. Documents the radial-vs-force-graph decision (determinism + ~90 kB bundle).
4. Documents why routing is by declared task, not by prompt inspection.
5. Quotes ratios rather than absolute times where the number is machine-dependent. This is the strongest doc in the repo.

**`GO_LIVE.md`** (12 KB) — opens with *"Nothing in this file has been executed."*
1. Gate expectation: **"1336 tests, legacy 25/25, every command exit 0"** — near-exact (§E: 1376).
2. Required env: a chat key, an embedding key, `MONGO_URI`, `REDIS_URL`, `POSTGRES_URL`; corrects the myth that `DAILY_LLM_BUDGET` is an env var (it is a compile-time constant).
3. Lists 5 proofs that have **never** run against a real service: Langfuse/Helicone, Redis-backed stores across replicas, pgvector, the provider adapters, MCP from a real agent.
4. States cost currently reports `usd: null` unless `LLM_PRICING` is set.
5. Confirms the fan-out and parallel stages are **opt-in**, and that no fan-out means the DOMAINS tab is empty.

### The ledger — 33 items in `CURRENT_STATE.md` §"Deferred ledger"

| # | Item | Status |
|---:|---|---|
| 1 | Barrel re-export provenance (Inventory) | **OPEN** |
| 2 | Entry-point manifest source duplication | **OPEN** |
| 3 | `clusters`/modules metric | RESOLVED (V3-P1, Louvain) |
| 4 | Delete unwired `analysisProcessor.ts` | RESOLVED (was already gone; entry was stale) |
| 5 | Anthropic adapter is integration-only | **OPEN** (never run against the real API) |
| 6 | RAG AI-retry needs file access | RESOLVED |
| 7 | Synthesis prompt sizes are fixed constants | **OPEN** |
| 8 | Result-slice vectors vs Mongo 16 MB BSON | RESOLVED (V3-P2, index left the document) |
| 9 | Ask-the-repo query path + budget split | RESOLVED |
| 10 | Chunk-size / role-allowlist tuning | **OPEN** |
| 11 | Re-export provenance for chunk citations | **OPEN** |
| 12 | Gemini adapters are integration-only | **OPEN** |
| 13 | Eval built but not scored / not gating CI | **OPEN** |
| 14 | P4 guardrails (b),(c) | RESOLVED; **(a),(d),(e) OPEN** |
| 15 | Legacy P5-era mock panels | RESOLVED (all 11 components verified gone) |
| 16 | tree-sitter coverage is JS/TS/JSX/TSX/Python only | **OPEN** (by design) |
| 17 | Scored-eval comparison still owed | **OPEN** — needs a key, costs money |
| 18 | SCIP indexer deferred | **OPEN** (explicitly optional) |
| 19 | The zod invariant | RESOLVED by amending the invariant |
| **20** | `cpgEdges` + `routes` grow the stored analysis doc (16 MB BSON) | **RESOLVED (V3-P5 `4abd45f`)** — the document now measures itself and externalises heavy optional fields only near the ceiling; fails loudly with sizes when it cannot fit |
| **21** | Q&A answer cache was per-API-process | **RESOLVED (V3-P5 `4abd45f`)** — answer cache *and* repo memory are Redis-backed with announced in-memory fallback |
| 22 | Gemini batch-embed reports no usage → estimate | **OPEN** (flagged in data as `measured: false`) |
| 23 | No human judge labels, so faithfulness cannot gate | **OPEN** |
| 24 | `EVAL_THRESHOLDS` are placeholders | **OPEN** — verified: 6 constants literally commented `PLACEHOLDER` |
| 25 | Redis-backed stores are integration-only | **OPEN** |
| 26 | Local vector store is a JSON file, not LanceDB | **OPEN — owner-deferred** |
| 27 | Local embeddings are feature-hashed, not MiniLM | **OPEN — owner-deferred** |
| 28 | `Span.recordUsage` had no call site → every trace $0.00 | RESOLVED (V3-FINAL) |
| 29 | Rejected completions charged by provider, never by budget | RESOLVED |
| 30 | Q&A answer-latency p50 is per-process | **OPEN** |
| 31 | MCP server never called by a real agent | **OPEN** |
| 32 | Retrieval backend invisible from `/health` (log-only) | **OPEN** |
| 33 | Render static site bakes API URL at build time | **OPEN** |

**Roughly 19 of 33 open.** Note the numbering collision: `PHASE_LOG.md` also uses "#19/#20" for an
older SSE-replay/REST-terminal-state pair that is unrelated to ledger #19/#20. Anyone reading the
docs cold will conflate them.

### Docs that claim something the code does not support

| Doc | Claim | Reality |
|---|---|---|
| `README.md` | "2D dependency graph — **interactive force-directed** graph" | `apps/web/src/lib/radial.ts` is a deterministic radial layout and its header documents removing `react-force-graph-2d`. No force library in `pnpm-lock.yaml`. |
| `V3_PLAN.md` §5 | "int8 MiniLM local embeddings" + LanceDB | Feature-hashed bag-of-words + a JSON file store. The code says so loudly; the plan was never updated. |
| `CURRENT_STATE.md` header | "Last updated 2026-08-31 — V3-P4" | Body covers V3-P5 and V3-FINAL; file mtime 2026-09-01. |
| `CURRENT_STATE.md` | "**955 tests**" | Actual: **1376** (§E). 955 is a V3-P4 snapshot left in a `>` quote block. |
| `V3_PLAN.md` | Companion doc `docs/CodeFlow-v3-Design-Doc.md` | **Does not exist** in this tree. |
| `GO_LIVE.md` | `CODEFLOW_MCP_SCOPES` (§1) vs "`MCP_SCOPES` set" (§4) | Code reads `CODEFLOW_MCP_SCOPES`. §4's wording is wrong. |
| `CODEBASE_SNAPSHOT.md` | "branch `fresh-main` @ `799b6ff`, tracked files 280" | Stale by 54 commits and ~5 weeks. Tracked files are now 447. **Do not use this file.** |
| `QUICKSTART.md` | Paste a repo → ask questions about it | On the compose path Q&A returns nothing, because there is no Postgres (§G). |

---

## D. Feature reality matrix

"Production path" = what a user gets from `docker compose -f docker-compose.app.yml up` or
`render.yaml`, not what a unit test can reach.

### 1. 8-stage deterministic pipeline (ingest → analyze) — **[SHIPPED-on-real-path]**
Files: `packages/analyzers/src/pipeline/orchestrator.ts`, `stages/{ingest,orient,mapStructure,inventory,connect,analyze,synthesize,rag}.ts`,
wired in `apps/worker/src/processors/pipelineJobProcessor.ts:~250`.
Stages 1–6 are deterministic and always registered; 7 (synthesize) registers only with a chat key,
8 (rag) only with an embedding key + both stores. Cache lookup by commit SHA short-circuits a run.
**Wired end-to-end: yes.** Honest caveat — "8 stages" is 6 guaranteed + 2 conditional, and the code
labels the skipped ones (`runMode: "deterministic-only"`, typed `degradations[]`) rather than hiding it.

### 2. AI synthesis + grounded onboarding — **[SHIPPED-on-real-path]**
`packages/analyzers/src/stages/synthesize.ts`. Parses the completion, schema-validates, then drops
reading-order steps whose `fileId` is not a graph node, counting the drops. Throws if *everything*
is ungrounded (`"Synthesis reading order was empty after grounding"`). Prompt-cached on a stable
prefix; completions cached on `(commitSha + prompt hash)` in Mongo. **Wired: yes, when a key is set.**

### 3. Grounded Q&A with citations — **[SHIPPED-on-real-path]**, and stronger than "validated"
`apps/api/src/routes/ask.ts` → `services/ragQaService.ts` → `packages/agents/src/askAgent.ts`
(graph present) or `packages/analyzers/src/rag/answer.ts` (no graph).

**Are citations validated against graph nodes / line ranges on the live path? Yes — structurally.**
The model is only allowed to emit a `chunkId`. `deriveAnswer` (`answer.ts:200-242`) and `askAgent.ts:319-368`
look that id up in the set of chunks retrieved *this session*; the `fileId`, `startLine` and `endLine`
are then read **off the retrieved chunk**, never off the model. Unmatched ids are dropped and counted
(`droppedCitations`). So a fabricated line number is not merely rejected — it cannot be expressed.
`askAgent` additionally downgrades `answered: true` to a refusal when no grounded evidence survives.
The same rule is exported once as `citationInRetrieved` (`packages/arena/src/verifiers/grounding.ts`)
and reused by `packages/eval/src/answerScore.ts`, so there is one definition, not four.
**Caveat:** on the compose path the retrieval store is empty, so the answer is an honest "I don't know"
rather than a wrong citation (§G).

### 4. Dependency graph rendering — **[SHIPPED-on-real-path], 2D only. 3D is [ABSENT].**
File: `apps/web/src/components/RadialGraph.tsx` + `apps/web/src/lib/radial.ts`.
**Library: none.** Hand-written inline `<svg>`. Layout = radial, ring by fan-in *rank*, angle by a
stable sort — a pure function of the graph, so two loads of the same repo draw the same picture.
`pnpm-lock.yaml` contains no `three`, no `react-force-graph*`, no `cytoscape`, no `d3-force`.
An empty graph renders an explicit "NO RESOLVED MODULES" empty state. README's "force-directed" is wrong.

### 5. CPG / find_references / blast radius / callers / symbol search — **[SHIPPED-on-real-path]**
`packages/parsers/src/treesitter/cpg.ts` extracts call/inheritance edges; `packages/graph/src/codePropertyGraph.ts`
unions them with import edges; `packages/graph/src/{traversal,blastRadius,centrality,cycles,coupling}.ts`
provide the algorithms. Exposed as agent tools in `packages/agents/src/tools/graphTools.ts`
(`get_callers`, `find_references`, `get_blast_radius`, `symbol_search`) and as MCP tools.
**Wired: yes** — the agent path is the default `/ask` handler whenever the analysis has a graph.
Caveat: CPG extraction covers **JS/TS/JSX/TSX/Python only** (ledger #16). Everything else falls back
to regex/LOC-only parsing.

### 6. Hybrid retrieval / vector store abstraction — **[SHIPPED-on-real-path]**
`packages/retrieval/src/hybridSearch.ts`: vector arm + BM25 arm → RRF (fuses *ranks*, not scores) →
text fetch → reranker → MMR → top-k. The refusal floor is compared against the **vector arm's raw
cosine**, before fusion or reranking — a genuinely careful detail.
Store abstraction is real: `pgvectorStore` (HNSW cosine, dimension in the table name),
`memoryVectorStore`, `fileVectorStore`, behind one `VectorStore` interface, chosen by
`stores/createStores.ts`. **Wired: yes on Render; degrades to in-memory on compose (§G).**

### 7. Multi-agent fan-out per community + community detection — **[PARTIAL — built, but OFF by default]**
Community detection: **[SHIPPED-on-real-path]** — `packages/graph/src/communities.ts`, deterministic
Louvain (seeded permutation, index tie-breaks, canonical relabelling), always runs in stage 6.
Fan-out: `packages/agents/src/orchestrator/{runFanOut,specialists,supervisor,blackboard}.ts` —
5 specialist lenses × N communities in bounded parallel, structured findings on a versioned blackboard,
one supervisor over a bounded selection.
**But `FANOUT_SYNTHESIS` defaults to `false`** in `docker-compose.app.yml` (absent) *and* is
explicitly `value: "false"` in `render.yaml:236`. Rationale is stated (5N+1 provider calls vs 1) and
defensible — but the multi-agent centrepiece does not run unless someone flips a flag, and the
web UI's **DOMAINS tab is empty** without it.

### 8. Best-of-N / verifier "arena" — **[PARTIAL]**
Best-of-N: `packages/agents/src/orchestrator/runFanOut.ts` (`BEST_OF_N = 3`, only on communities
whose complexity ≥ `HARD_COMMUNITY_COMPLEXITY = 0.6`; extra calls reported separately as
`bestOfNExtraCalls`). Lives **inside the fan-out**, so it inherits fan-out's off-by-default state.
Arena: `packages/arena/` is a real task/verifier/reward harness with exact verifiers. Its production
consumers are **`apps/mcp` only** (`verify_answer`, graph oracle) plus `packages/eval`. It is **not**
on the web app's request path. Calling it an "arena" oversells a verifier library + a runner loop.

### 9. Model routing (small vs frontier) — **[SHIPPED-on-real-path, but inert by default]**
`packages/analyzers/src/llm/modelRouter.ts`, wired at `apps/worker/src/index.ts:~100`.
Genuinely well-designed: `createRoutedLlmClient` **is** an `LlmClient`, so routing is added at the
composition root with zero call-site edits; routes by declared task + P4 complexity, never by prompt
inspection; defaults an un-hinted call **up** to frontier; `maybeRouted` returns the single client
*unwrapped* when only one tier exists so cache keys are unchanged.
**Requires `FAST_MODEL` + `GEMINI_API_KEY`.** `render.yaml:224` has `FAST_MODEL` as `sync: false`
(unset). Compose does not set it. So by default there is one tier and the router is bypassed.

### 10. Persistent warm worker pool + latency scheduling (DAG-layered) — **[PARTIAL]**
Warm-up: `packages/analyzers/src/pipeline/warmup.ts` + registrations in `apps/worker/src/index.ts`
and `apps/api/src/health/warmup.ts`. **Wired end-to-end: yes**, and gates `/ready`.
The file itself is refreshingly honest: *"the 'warm pool' here is not a pool of processes … it is a
registry of PROCESS-LIFETIME resources. Calling it a pool of workers would be describing an
architecture this does not have."* **So "persistent warm worker pool" is an overclaim; warm caches
in one long-lived process is what exists.** Scaling out = more BullMQ replicas.
DAG scheduling: `packages/analyzers/src/pipeline/schedule.ts` — Kahn's algorithm over declared
`STAGE_READS`. Also honest: the deterministic chain is genuinely linear, so **there is exactly one
parallel layer** (synthesize ∥ rag). Gated behind `PARALLEL_STAGES`, **`"false"` in `render.yaml:232`.**

### 11. MCP server (`apps/mcp`) — **[SHIPPED — but never exercised by a real client]**
`apps/mcp/src/{index,server,tools,scope}.ts`. 7 tools: `find_references`, `get_callers`,
`get_blast_radius`, `symbol_search`, `search_code`, `graph_facts`, `verify_answer`.
Handlers are plain functions over plain data; the SDK is imported **dynamically** and bound to stdio
in `index.ts`. Scope-gated by `CODEFLOW_MCP_SCOPES` — **unset ⇒ the server exposes nothing**, and an
out-of-scope tool is *absent* rather than present-and-refusing (the right choice).
It does not analyse; it reads a saved `AnalysisResult` JSON or fetches one from a running API.
**Ledger #31: never called by a real agent.** 33 tests, all against the core, none through the SDK.

### 12. Local-first CLI + LanceDB + MiniLM + zero egress — **[PARTIAL]**
- CLI: **[SHIPPED]** — `apps/local-cli/src/analyzeLocal.ts`, shares the real stages (ingest excluded; synthesize excluded — no keyless LLM).
- **Zero code egress: [SHIPPED] and provable** — the module's entire import graph contains no HTTP client, no socket, no provider key. You can verify it by reading the imports.
- **LanceDB: [ABSENT]** — `createFileVectorStore` is a JSON file with an exact cosine scan. LanceDB was measured at 656 MB with a Rust NAPI binary that drags `onnxruntime-node` back in, and rejected.
- **MiniLM: [ABSENT]** — `createLocalEmbeddingClient` is **feature hashing** (256-dim, L2-normalised bag-of-words over the shared code tokenizer). It captures lexical overlap and explicitly **cannot** tell that "authenticate" and "login" are related.

The code is scrupulous about this — `localEmbedding.ts` opens with *"WHAT V3_PLAN §5 ASKED FOR … WHAT
SHIPS …"* and the identifier is deliberately not named "minilm". **`V3_PLAN.md` was never corrected**,
so anyone reading the plan will believe MiniLM and LanceDB shipped.

### 13. OpenTelemetry spans + token/$ read-back + versioned blackboard — **[PARTIAL]**
- **OTel: no `@opentelemetry/*` dependency exists anywhere.** `packages/observability/src/tracer.ts` is a **home-grown** recording tracer with deterministic span ids (`s1`, `s2`, …). `exporters.ts` provides a `fetch`-based JSON exporter (Langfuse/Helicone shape) and an **OTel *bridge* that takes an injected tracer-provider** — nobody injects one. So: **OTel-*shaped*, not OpenTelemetry. [STUB-or-mock-only] for the OTel claim specifically.** Never verified against a real backend (ledger, GO_LIVE §4).
- **Token read-back: [SHIPPED]** — `measuredUsage` reads provider counters (`input_tokens`/`cache_read_input_tokens`; `promptTokenCount`/`cachedContentTokenCount`), falls back to `estimatedUsage` flagged `measured: false`. `recordUsage` is wired in `pipelineJobProcessor.ts` for **every** event, not just terminal ones, so a run that spent money across three rejected attempts and then failed is still charged.
- **$ read-back: [PARTIAL]** — pricing is injected, never baked in. With `LLM_PRICING` unset (the default everywhere) `usd` is **`null`, never `0`**. Tokens are real; dollars are not populated out of the box.
- **Versioned blackboard: [SHIPPED]** — `packages/observability/src/versionedBlackboard.ts`, wired at `runFanOut.ts:134`. Inherits fan-out's off-by-default state.

### 14. Offline memory consolidation / repo KB — **[PARTIAL]**
`packages/agents/src/orchestrator/consolidate.ts`. **Extractive, not generative** — sorting, merging
by normalised headline, de-duplicating, templating. No clock, no RNG, no provider, so the same
blackboard always yields a byte-identical KB. Re-checks every `fileId` against `graph.nodes` and
counts drops. `corroboratedBy` (two independent lenses agreeing) is genuinely new information.
**Consumes fan-out findings ⇒ produces nothing when `FANOUT_SYNTHESIS=false`, i.e. by default.**

### 15. Security scanner / architecture rules / PR risk / ownership+churn / test impact
- **Security scanner: [STUB-or-mock-only]** — the only "security" on any path is an LLM **prompt persona** (`packages/agents/src/orchestrator/specialists.ts:61`, *"What in this group of files handles trust boundaries, secrets, authentication or untrusted input?"*). No secret detection, no CWE/OWASP rules, no SAST, no dependency-vulnerability check. And it only runs under fan-out (off by default).
- **Architecture rules / `.codeflow.yml`: [ABSENT]** — grep for `codeflow.yml`, `codeflow.yaml`, `architectureRules`, `archRule` across all `.ts` and `.md` returns **zero hits**. No parser, no schema, no enforcement, not even a mention.
- **PR risk: [ABSENT]** — no `prRisk`/`riskScore` on any path. (`card/lib/pr.js` posts a sticky PR comment from the *legacy* analyzer — unrelated.)
- **Ownership / churn: [ABSENT]** — no git-blame, no commit-frequency, no `git log` analysis anywhere. `summary.ts`'s single "ownership" hit is a comment about *slice* ownership.
- **Test impact: [ABSENT]** — nothing maps changed files to affected tests.

`CLEANUP_MANIFEST.md` confirms `SecurityPanel`, `ArchitectureRulesPanel` and `PRRiskPanel` were
P5-era **mock** components and were deleted. Their removal was the honest call; the features were
never built. **If any of these appear on a résumé or a README, they are not in this codebase.**

### 16. SVG card endpoint — **[ABSENT as an endpoint]; [SHIPPED] as a legacy GitHub Action**
No API route serves SVG. The full API surface is:
`POST /api/analyze` · `GET /api/job/:id` · `GET /api/job/:id/events` (SSE) · `GET /api/result/:id` ·
`GET /api/analysis/:analysisId` · `GET /api/meta` · `GET /health` · `POST /api/result/:id/ask`.

`card/` is a GitHub Action (`action.yml`, author `braedonsaunders` — inherited from upstream) that
renders an SVG + a PR receipt. **It is powered by the OLD analyzer**: `card/lib/analyzer.js` slices
a JS block out of `legacy/index.html` between `// ===== CODEFLOW_ANALYZER_START =====` markers and
runs it in a `vm`. I verified both markers still exist (`legacy/index.html:765` and `:3361`), so it
would still run — **against a 6,845-line vanilla-JS analyzer that shares no code with
`packages/analyzers`.** No workflow in `.github/workflows/` references it.

---

## E. Tests, gates, build health

All four gates run on this machine, this session, offline, no keys. **All green.**

| Gate | Command | Result |
|---|---|---|
| Typecheck | `pnpm -r typecheck` | ✅ **exit 0** — 16/16 workspaces |
| Tests | `pnpm test` (serial, `--workspace-concurrency=1`) | ✅ **exit 0** — **1376 passed, 0 failed, 0 skipped** |
| Build | `pnpm -r build` | ✅ **exit 0** — 16/16, incl. `vite build` (`✓ built in 1.55s`) |
| Legacy | `node --test tests/*.mjs` | ✅ **25 pass, 0 fail, 0 skipped** |

### Per-workspace test counts

| Workspace | Files | Tests |
|---|---:|---:|
| `packages/analyzers` | 19 | 313 |
| `packages/agents` | 7 | 225 |
| `packages/retrieval` | 7 | 159 |
| `packages/eval` | 7 | 113 |
| `apps/api` | 8 | 111 |
| `apps/web` | 5 | 88 |
| `packages/arena` | 3 | 68 |
| `packages/memory` | 3 | 62 |
| `packages/observability` | 2 | 55 |
| `apps/worker` | 4 | 49 |
| `packages/parsers` | 9 | 47 |
| `packages/graph` | 7 | 33 |
| `apps/mcp` | 1 | 33 |
| `apps/local-cli` | 1 | 17 |
| `packages/shared-types` | 1 | 3 |
| `packages/config` | 0 | 0 |
| **Total (vitest)** | **84** | **1376** |
| Legacy (`node --test`) | 5 | 25 |
| **Grand total** | **89** | **1401** |

### The "955 tests" claim — **REFUTED**

The real number is **1376** vitest tests (+25 legacy). 955 is a **V3-P4-era snapshot** left inside a
quote block in `CURRENT_STATE.md`; `PHASE_LOG.md` shows the progression 291 → 526 → 742 → 881 → 955
→ 1207 → 1336. `GO_LIVE.md` and `VERIFICATION_REPORT.md` say **1336**, which is close but also now
stale by 40 — those were written on `v3/final-build-verify`, before the last two commits on
`V2-codeflow`. **955 undercounts by 421. Use 1376.**

### Skipped / flaky / quarantined / network

- **Skipped: zero.** Grep for `it.skip`, `describe.skip`, `test.skip`, `.todo(`, `it.only`, `describe.only` across `apps/`, `packages/` and `tests/` returns **no hits**.
- **Network: none.** No `await fetch(` in any test file. Providers are injected mocks; `fetch` is stubbed in `providers.test.ts` and `observability.test.ts`; Postgres and Redis are behind `createClient` test seams so the degradation paths are exercised at zero I/O; `NODE_ENV=test` suppresses `dotenv` so a developer's `.env` can never leak in.
- **Flaky:** none observed in this run. UNVERIFIED across repeat runs — I ran the suite once.
- Two harmless side effects: `tests/verify-brain-vault.mjs` writes `/tmp/codeflow-verify.json`, and the `pretest` hooks rebuild every dependency serially, which is why a full `pnpm test` takes ~15 minutes on this machine.
- **CI (`ci.yml`) is hermetic by design** — no secrets, no service containers — and additionally runs parser parity, the keyless eval check, and builds all three Docker images. The scored eval (`eval-scored.yml`) needs keys, spends money, is `workflow_dispatch`-only, sits behind an approval environment, and **defaults `fail-on-threshold: false`** because the thresholds are still placeholders (ledger #24).
- **25 of the 1401 tests test dead code.** `tests/*.mjs` load `legacy/index.html` and exercise the old single-file analyzer's markdown/wikilink extractors. They are green and meaningless to the product.

---

## F. Stack & dependency reality

### Is it still MERN? Mostly — but "MERN" now undersells and mis-describes it.

| MERN letter | Present? | Reality |
|---|---|---|
| **M**ongo | ✅ | `mongoose@9`. Collections: `repos`, `analyses`, `jobs`, `llmcache`, `jobevents` (+ an abandoned `llmbudget`). Stores results, the analysis cache, the LLM-output cache and the SSE replay buffer. |
| **E**xpress | ✅ | `express@4`, 8 routes, custom CORS / rate-limit / error middleware. |
| **R**eact | ✅ | React 18 + Vite 5, TypeScript strict. No Next.js, no CRA, no Redux, no router library (hash-based). |
| **N**ode | ✅ | Node ≥ 20, ESM throughout, pnpm 9.15.4 workspaces. |

But the interesting parts are **not** MERN: **Redis** (BullMQ queue + shared budget ledger + rate
limit + sessions + repo memory + answer cache), **Postgres/pgvector** (the retrieval index), and a
separate worker process. A better description: *TypeScript monorepo, 4 services, 3 datastores.*

### What is ACTUALLY wired

| Category | Wired | Notes |
|---|---|---|
| Databases | MongoDB 7, Redis 7, Postgres 16 + `pgvector` | Postgres on Render only — **not in `docker-compose.app.yml`** |
| Queue | BullMQ 5 on Redis (`codeflow-analysis`) | `stop_grace_period: 300s`; needs `noeviction` |
| Chat providers | Anthropic, Google Gemini | Raw `fetch`, **no vendor SDK**. Default model const: `claude-opus-4-8` |
| Embedding providers | Voyage, Gemini, `local` (feature hashing) | Selected by env, ambiguity throws at boot |
| Parsers | `web-tree-sitter@0.26.13` + `@vscode/tree-sitter-wasm@0.3.1` | WASM (chosen over native so the local CLI can run); JS/TS/JSX/TSX/Python; regex fallback elsewhere |
| Graph | **Hand-written** — Louvain, Kahn, Tarjan-style cycles, centrality | No `graphlib`, no `ngraph`, no `d3` |
| Vector | `pgvector` (HNSW cosine) / in-memory / JSON file | One `VectorStore` interface |
| Lexical | **Hand-written BM25** | `packages/retrieval/src/bm25.ts` |
| MCP | `@modelcontextprotocol/sdk@1.30.0` | Dynamically imported |
| Frontend | React 18, Vite 5 | **No UI library, no CSS framework, no chart/graph library** — one hand-written `styles.css` |
| Tests | Vitest 2, jsdom, Testing Library, supertest | |
| Tracing | **Home-grown** | No `@opentelemetry/*` anywhere |

### Heavy / unusual dependencies

| Dependency | Size/weight | Used on a real path? |
|---|---|---|
| `@vscode/tree-sitter-wasm` + `web-tree-sitter` | ~5 WASM grammars, warmed at boot | **Yes** — stage 4/5 symbol + CPG extraction |
| `mongoose@9` | heavy ORM | **Yes** — 5 schemas, unique compound cache index |
| `bullmq@5` + `ioredis@6` | | **Yes** — the whole worker path |
| `pg@8` | +4 MB, pure JS (chosen for exactly that) | **Yes on Render, no on compose** — dynamically imported, absent URL ⇒ in-memory |
| `@modelcontextprotocol/sdk@1.30.0` | | **Yes**, dynamically — but never driven by a real client (ledger #31) |
| `jsdom@29` | heavy | **Yes** — web test env (declared but never `import`ed, correct for vitest) |
| `supertest@7` | | **Yes** — API route tests |
| `dotenv@16` | | **Yes**, and correctly skipped under `NODE_ENV=test` |
| `tsx`, `prettier`, `vitest`, `typescript` | root dev | Yes |

**Genuinely notable: there is almost no bloat.** No SDKs for Anthropic/Gemini/Voyage/OTel/Langfuse —
all raw `fetch`. No ONNX, no `sharp`, no LanceDB, no transformers. `ENGINEERING_LOG.md` §1 documents
each rejection with a measured install size. This is the single most defensible thing in the repo.

**Vestigial / dead weight:**
- `legacy/index.html` (471 KB, 6,845 lines) — the old app. Load-bearing for `card/` and for the 25 legacy tests, dead for everything else.
- `card/` (~1.5k LOC) — a fork-inherited GitHub Action powered by that legacy analyzer. No workflow invokes it.
- `screenshot.png` (1.0 MB) + `codeflow-social.png` (297 KB) — 1.3 MB of tracked binary with **zero in-repo references**. `CLEANUP_MANIFEST.md` explicitly flags them as an owner decision.
- `runLatencyBench` — exported from the `@codeflow/analyzers` barrel, called by **nothing** but its own test. A bench harness, so defensible, but it is not on any path.
- The `llmbudget` Mongo collection — nothing writes it any more (documented in the code).

---

## G. Deployment & infra readiness

### The two compose files

| | `docker-compose.yml` | `docker-compose.app.yml` |
|---|---|---|
| Purpose | **Dev stores only**, for `pnpm dev:*` on the host | **The documented "download and run" stack** |
| Services | mongo, redis, **postgres (pgvector/pg16)** | mongo, redis, api, worker, web |
| Postgres | ✅ with `pg_isready` healthcheck | ❌ **absent** |
| Healthchecks | postgres only | mongo (`mongosh ping`), redis (`redis-cli ping`) |
| Volumes | `mongo-data`, `postgres-data` | `mongo-data` only |
| Secrets | none needed | `GEMINI_API_KEY` required via `${VAR:?err}`, injected at runtime |

The two files **disagree about whether Postgres is part of the system**, and the app file — the one
every doc points users at — is the one missing it.

### Dockerfiles

All four multi-stage on `node:20-slim`; api/worker/mcp run as non-root `USER codeflow`.
- `api`: `EXPOSE 4000`, HEALTHCHECK fetches `/health` on `API_PORT||4000`.
- `worker`: `EXPOSE 4100`, sets `WORKER_HEALTH_PORT` **in the image** so the HEALTHCHECK has something to probe; `stop_grace_period: 300s` in compose.
- `web`: builds with Vite, serves via `nginx:1.27-alpine`; HEALTHCHECK hits nginx's own `/healthz` (not `/`, because the SPA fallback would return 200 for anything); `config.js` injected at container start so one image works across environments.
- `mcp`: **no HEALTHCHECK, with the reason written in the file** — it is a stdio server with nothing to probe.

`start.sh` / `start.bat`: thin wrappers that require `codeflow.env`, then
`docker compose --env-file codeflow.env -f docker-compose.app.yml up -d --build`.

### Workflows

| Workflow | Trigger | State |
|---|---|---|
| `ci.yml` | every push + PR | **Active.** typecheck → lint → test (serial) → build → parser parity → eval check → legacy tests → build all 3 images. Hermetic, no secrets. |
| `codeql.yml` | — | Active. 22 alerts found, 22 fixed, 0 dismissed (`SECURITY_TRIAGE.md`) — all `js/polynomial-redos`. |
| `eval-scored.yml` | `workflow_dispatch` | Manual, approval environment, concurrency lock, **`fail-on-threshold: false`**. |
| `keepalive.yml` | schedule + dispatch | **Disabled** — guarded on a `CODEFLOW_API_URL` repo variable that is unset. |

### What is required to go live (per `GO_LIVE.md` + `DEPLOY.md`)

`GO_LIVE.md` opens: **"Nothing in this file has been executed."** `DEPLOY.md` opens: **"No service was created, no key was set, no image was pushed."**

**Required:** a chat key (`ANTHROPIC_API_KEY` *or* `GEMINI_API_KEY`), an embedding key
(`GEMINI_API_KEY` *or* `VOYAGE_API_KEY`), `MONGO_URI` (Atlas), `REDIS_URL` (**must be `noeviction`**
or BullMQ jobs are evicted mid-flight with no error anywhere), `POSTGRES_URL` (pgvector), and
`CORS_ORIGINS` — which **cannot be derived from the blueprint** (the web build needs the API URL and
the API needs the web URL), so until it is set the browser gets CORS errors against a healthy API.
On a managed host, bind **`PORT`, not `API_PORT`** — setting `API_PORT` on Render binds a port the
proxy is not routing to. `render.yaml` defines 5 services + 1 Postgres and is complete.

**Still deferred / manual:**
- Everything in `DEPLOY.md` and `GO_LIVE.md`. Nothing deployed.
- 5 proofs never run against a real service: Langfuse/Helicone export, Redis stores across 2 replicas, pgvector, the Anthropic/Gemini/Voyage adapters, MCP from a real agent.
- The scored eval (ledger #17) — thresholds stay placeholders until it runs.
- ≥20 hand-labelled judge pairs; `judgeIsGateable` demands sample size **and** Cohen's κ ≥ 0.6 **and** a CI lower bound ≥ 0.7. Faithfulness cannot gate until then.
- `LLM_PRICING` unset ⇒ every `usd` reads `null`.
- The live benchmark (`pnpm bench:live`) needs a deployed URL.
- Keepalive workflow disabled.

### Is anything blocking a clean `docker compose up` from a fresh clone?

**The stack will come up. Analysis will work. Q&A will silently return nothing.**

`docker-compose.app.yml` sets `EMBEDDING_PROVIDER: gemini` on both api and worker, so both build an
embedding client — but **neither gets a `POSTGRES_URL`**, because there is no Postgres service.
`createRetrievalStores` (`packages/retrieval/src/stores/createStores.ts:60-68`) then takes the
**no-URL branch**, which returns the in-memory pair **with no `degradation` string at all**:

```ts
const url = options.postgresUrl?.trim();
if (!url) {
  return { vectorStore: createMemoryVectorStore(...), textStore: ..., mode: "memory", sql: null };
  //  ^ no `degradation` field — so the loud warnings in index.ts and ragQaService.ts never fire
}
```

Consequence chain, all verified in code:
1. Worker boots, logs a bland `Retrieval index: … (mode memory)` and **no warning**.
2. Stage 8 runs and writes the index into the **worker process's heap**.
3. `ai.rag` metadata *is* persisted to Mongo, so `/api/result/:id/ask` passes its `if (!cached.result.ai?.rag)` guard.
4. The API queries **its own, empty** in-memory store. No chunks clear the similarity floor.
5. The user gets an honest "I could not find that in this repository" — for **every question, about every repo**.

So the headline feature in `README.md` and `QUICKSTART.md` is non-functional on the exact path both
documents tell a new user to take, and the codebase's own honest-degradation discipline — which is
excellent everywhere else — **has a hole precisely where it is needed**: the unset-URL branch is the
one path that does not announce itself.

**Fix is small:** add the `pgvector/pgvector:pg16` service (it already exists in `docker-compose.yml`)
plus `POSTGRES_URL` on api and worker, and set a `degradation` string on the no-URL branch.

Secondary: first `up` builds 3 images (several minutes) and `GEMINI_API_KEY` is mandatory via
`${GEMINI_API_KEY:?…}` — so a keyless `docker compose up` **fails fast with a clear message**, which
is correct behaviour, not a bug.

---

## H. Honest self-critique

### Top 5 things an SDE2 FAANG interviewer would poke holes in

1. **"Multi-agent system" that is off by default.** `FANOUT_SYNTHESIS="false"` in `render.yaml:236`
   and absent from compose. The specialists, blackboard, supervisor, best-of-N, versioned blackboard
   and KB consolidation — the five most impressive things in the repo — do not execute in any
   default deployment. *"So you've never actually run the multi-agent path against a real repo with
   real keys?"* The honest answer is no: **nothing here has run against a live provider, ever.**
   Same for model routing (`FAST_MODEL` unset) and parallel stages (`"false"`).

2. **Zero production evidence.** No deployment, no live benchmark, no scored eval, no real provider
   call, no real Redis/Postgres/Mongo integration run, no real MCP client. 1376 hermetic tests prove
   the code does what its authors believe; they cannot prove the Anthropic adapter's response parser
   matches Anthropic's actual response. Ledger #5, #12, #25, #31 and GO_LIVE §4 all say this
   explicitly — which is honest, and also the exact list an interviewer would work through. The
   headline numbers ("3.9× speedup", "1.76× scheduling win") are **hermetic, mock-provider,
   orchestration-only**, and the docs say so; quoting them without that qualifier would be the trap.

3. **Eval exists but gates nothing.** Six `EVAL_THRESHOLDS` are literally commented `PLACEHOLDER`.
   `eval-scored.yml` defaults `fail-on-threshold: false`. Two golden datasets (`chalk`, `requests`).
   No judge labels, so faithfulness is structurally ungateable (κ ≥ 0.6 + CI ≥ 0.7 required). *"How
   do you know the retrieval is any good?"* → *"I don't yet."* The measurement apparatus is
   thoughtfully built and has never produced a number that changed a decision.

4. **The 16 MB BSON ceiling and the single-document design.** The whole `AnalysisResult` — graph,
   CPG edges, routes, metrics, communities, AI slices — is one Mongo document. Ledger #20 is marked
   resolved by a self-measuring shed-and-externalise mechanism, but that mechanism has **never been
   exercised on a genuinely large repository**. *"What happens on Linux or Chromium?"* → unknown.
   Related: `CODEFLOW_MAX_FILES` caps input, so the answer to "does it scale" is currently "it
   refuses".

5. **Language coverage is narrower than the pitch.** tree-sitter covers **JS/TS/JSX/TSX/Python only**
   (ledger #16). *"Analyse any codebase"* means: everything else gets regex import-scanning and
   LOC counts — no symbols, no CPG, no call edges, so `find_references`, `get_callers` and blast
   radius silently return nothing useful for a Go, Rust, Java or C# repo. The code degrades
   gracefully; the README does not mention the limit.

Honourable mentions: prompted ReAct tool-calling instead of native provider tool-calling (a
documented, reasoned choice, still a "why not native?"); SSE progress through a Mongo replay buffer
rather than a real event log; and the fact that **two of the four gate commands take ~15 minutes**
because every workspace's `pretest`/`pretypecheck` rebuilds all its dependencies serially — a Turbo/Nx
task graph is the obvious fix and its absence will get noticed.

### Stubs / canned data / mocks on a PRODUCTION path

**Sweep result: essentially clean.** `TODO|FIXME|HACK|XXX|not implemented|@ts-ignore` across every
non-test file in `apps/*/src` and `packages/*/src` returns **two** hits, and I verified neither is a stub:

| Location | What it is | Verdict |
|---|---|---|
| `apps/api/src/routes/analyze.ts:85` | `TODO (deferred): add a real inline pipeline runner … never a mock.` The code path it annotates returns an honest **503 QUEUE_UNAVAILABLE** and marks the job failed. | ✅ Not a stub |
| `packages/eval/src/thresholds.ts:37` | `TODO (owner, out-of-band)` on threshold **calibration**. Code is real; constants marked `PLACEHOLDER`; nothing gates on them. | ✅ Not a stub |

Also checked and cleared:
- `repositoryService.ts:19` — `commitSha: "pending-<owner>-<repo>-<branch>"`, deliberately **not valid hex** so it can never be mistaken for a SHA, replaced by Ingest.
- `useAnalysis.ts:22` — records that the old "Use Mock Data Instead" button was **removed**. There is no mock path in the UI.
- Every `mock`/`fake` hit outside tests is a **comment explaining an injection seam**, not a mock.
- `PHASE_LOG.md` confirms `mockAnalysisFactory.ts` (hardcoded `healthScore: 82`, `securityIssues: 2`) was deleted in the 2026-05-30 cleanup, and `CLEANUP_MANIFEST.md` confirms all 11 mock panels are gone (verified: zero grep hits).

**The one thing that is arguably a stub on a production path** is §D.15's security "scanner": an LLM
prompt persona presented under a security heading. It produces text, not findings.

### Dead code, half-finished phases, docs that overclaim

**Dead / near-dead:**
- `legacy/index.html` — 471 KB, 6,845 lines, shares no code with the product. Kept alive only by `card/` and the 25 legacy tests.
- `card/` — fork-inherited Action, no workflow invokes it, powered by the legacy analyzer.
- `screenshot.png` + `codeflow-social.png` — 1.3 MB tracked binary, zero in-repo references.
- `runLatencyBench` — exported, never called outside its test.
- The `llmbudget` Mongo collection — nothing writes it.
- `.button-row` in `styles.css` — zero `.tsx` references (documented in `CLEANUP_MANIFEST.md`).
- 10 local-only `v3/*` branches that duplicate what is already in `V2-codeflow`.

**Half-finished:** Phase 7 / go-live in its entirety; the scored eval; judge calibration; all five
"never run against a real service" proofs. ~19 of 33 ledger items open.

**A concrete latent bug — the same one, fixed once and left in two other files.** Commit `1193d93`
*"stop embedding a raw NUL byte in the tracer source"* replaced a literal `\0` with the escape
`"\u0000"` in `packages/observability/src/tracer.ts`. **The identical pattern survives in two
production files:**

- `packages/analyzers/src/stages/analyze.ts:97` — `a.files.join("<NUL>")` (2 raw NUL bytes)
- `packages/analyzers/src/stages/inventory.ts:322` — `` `${normalized}<NUL>${kind}<NUL>${evidence}` `` (2 raw NUL bytes)

Runtime behaviour is correct. But `git` and `grep` classify both files as **binary** — `grep` skips
them silently (I hit this mid-audit: searching `analyze.ts` returned `Binary file … matches` and no
content), and a diff or copy-paste can silently drop the byte. The fix is the one already applied to
`tracer.ts`: write `"\u0000"`. **Two of the pipeline's eight stages are currently un-greppable.**

**Docs that overclaim** — the full list is the table at the end of §C. The worst four:
`README`'s "force-directed graph"; `V3_PLAN`'s MiniLM + LanceDB; `CURRENT_STATE`'s "955 tests" and
its V3-P4 header; and `CODEBASE_SNAPSHOT.md` in its entirety (54 commits stale — **delete it or
stamp it stale**, it is the file most likely to mislead the next reader). Note the pattern: the
**code** is consistently more honest than the **plans**. `localEmbedding.ts`, `warmup.ts`,
`schedule.ts` and `consolidate.ts` all open by stating what was asked for versus what shipped. The
planning docs were simply never back-annotated.

### The 3 genuinely strong and defensible pieces

1. **Grounding is structural, not policed.** The model can only emit a `chunkId`; `fileId`,
   `startLine` and `endLine` are read off the retrieved chunk. A fabricated line number is not
   caught — it is **inexpressible**. Layered on top: ungrounded reading-order steps dropped and
   counted, an all-ungrounded synthesis rejected outright, `answered: true` with no evidence
   downgraded to a refusal, citations linked to GitHub **at the analysed commit SHA** so a reader can
   check them, and the rule exported **once** (`citationInRetrieved`) and shared by production, eval
   and the arena. This is a genuinely strong answer to *"how do you stop the LLM hallucinating?"*

2. **Dependency discipline backed by measurement.** `ENGINEERING_LOG.md` §1 is a table of *installed
   sizes*: `onnxruntime-node` 211 MB, `@lancedb/lancedb` 656 MB, `pg` +4 MB. Each was installed into
   a scratch workspace, weighed, and rejected or accepted **on the number**. Downstream: no vendor
   SDKs (Anthropic, Gemini, Voyage, OTel, Langfuse all raw `fetch`), no UI framework, no graph
   library, hand-written BM25 and Louvain — and a test suite that stays hermetic *because* of it.
   That is a real engineering value system, applied consistently.

3. **Determinism as a load-bearing invariant, with the trade-offs written down.** Seeded Louvain with
   canonical relabelling; radial layout chosen over force-directed *because* positions must be
   reproducible; deterministic span ids so traces are assertable; a test proving the parallel schedule
   produces **byte-identical** slices to the sequential one; extractive (not generative) KB
   consolidation so the KB can be diffed and cached. Determinism is what makes the SHA-keyed cache
   and the eval set possible at all, and every place it costs something, the cost is stated.

Runner-up worth naming in an interview: **honest degradation as a design discipline** — `runMode`,
typed `degradations[]`, `usd: null` never `0`, `queueDepth: null` never `0`, a warm-up that
constructs provider clients but never probes them ("a warm-up that spent money would be charging the
owner for a health check"), and `maybeRouted` returning the client *unwrapped* so cache keys don't
churn. The `docker-compose.app.yml` Postgres hole is the one place this discipline fails.

### The 3 weakest / riskiest

1. **Nothing has ever run in production, or against a live provider.** No deploy, no real API call,
   no real Postgres/Redis integration run, no scored eval, no real MCP client. Every quality claim
   rests on hermetic tests and mock providers. The first real run will surface response-shape
   mismatches, rate limits, timeouts and cost surprises that no test here can predict — and there is
   no rollback experience, no dashboard, no on-call story.

2. **The compose path ships the headline feature broken, silently.** §G. A recruiter or interviewer
   following `QUICKSTART.md` gets an app that analyses fine and answers **no** question, with no
   error and no warning in the logs. This is the single highest-impact defect in the repo and the
   fix is ~10 lines. It is also the most damaging kind of bug for a project whose entire thesis is
   "degrade visibly, never silently".

3. **The gap between what the docs promise and what runs by default.** Roughly 250 KB of planning
   documents describe a multi-agent, best-of-N, model-routed, DAG-parallel, OTel-traced system.
   What a default deployment actually runs is a single-shot LLM call, one model tier, sequential
   stages, an in-process tracer exporting to a memory buffer, and `usd: null`. Everything else is
   behind a flag that is off, or behind an env var that is unset, or is OTel-shaped rather than OTel.
   Each individual default is defensible **and stated**; the aggregate is a system whose most
   impressive half has never executed outside a unit test. Close behind: **two pipeline stages are
   binary to `grep`** (`analyze.ts`, `inventory.ts`) from a bug that was already found and fixed
   once — a small thing that suggests the fix was applied where it was noticed rather than where it
   occurred.

---

## I. One-paragraph plain-English summary

CodeFlow is a self-hostable TypeScript monorepo — four services (React/Vite SPA, Express API, BullMQ
worker, MCP stdio server) over MongoDB, Redis and Postgres/pgvector — that clones a public GitHub
repo and runs an **eight-stage pipeline** (six deterministic: clone → manifests → file tree → symbols
via tree-sitter WASM → import + call graph → centrality/cycles/blast-radius/Louvain communities; two
AI-conditional: a grounded onboarding synthesis and a RAG index), streams the stages to the browser
over SSE, and then answers questions about the repo through a bounded multi-turn agent with
graph tools and hybrid BM25+vector retrieval, where **every citation is structurally forced to
resolve to a chunk that was actually retrieved** — the model emits only a chunk id and the file and
line range are read off the real chunk, so a fabricated line number cannot be expressed. It is
**green and real** (1376 hermetic tests, typecheck, build and 25 legacy tests all exit 0 on this
machine) and unusually honest in-code about its own substitutions — but **nothing in it has ever run
against a live provider or a deployed environment**, its most impressive machinery (five-specialist
fan-out over code communities, best-of-N, small/frontier model routing, DAG-parallel stages) is
**off by default in both the compose file and the Render blueprint**, its eval measures nothing yet
because every threshold is a placeholder, and the documented one-command Docker path ships **without
Postgres**, which silently leaves Q&A — the headline feature — unable to answer anything.

---

### Appendix: what I ran

```
git rev-parse / status / log / branch -vv / branch -r / rev-list --left-right --count   (read-only)
pnpm -r typecheck            exit 0
pnpm test                    exit 0    1376 passed, 0 failed, 0 skipped
pnpm -r build                exit 0    16/16, vite ✓ built in 1.55s
node --test tests/*.mjs      exit 0    25 pass, 0 fail
```

**Not run** (needs network / keys / a deployed service, per the hard rules): `pnpm install`,
`pnpm eval`, `pnpm --filter @codeflow/eval run eval:scored`, `pnpm bench:live`, `docker compose up`,
`docker build`, any provider call, any real Mongo/Redis/Postgres connection, any `git push`/`fetch`.

**Marked UNVERIFIED in this report:** the cause of the `SECURITY_TRIAGE.md` byte change (§A);
test flakiness across repeat runs (§E); whether the ledger-#20 BSON shed mechanism works on a large
repo (§H); whether the Anthropic/Gemini/Voyage response parsers match the real APIs (§H).
