# CodeFlow — Current State

> Live status. Canonical intent lives in [PLAN.md](PLAN.md); execution history in
> [PHASE_LOG.md](PHASE_LOG.md). When this conflicts with PLAN.md, PLAN.md wins.

_Last updated: 2026-08-31 — V3-P2: retrieval (real vector store, AST-enriched chunks, hybrid/rerank/MMR, synthetic flywheel) (branch `v3/p2-retrieval`)._

> ✅ **V3-P2 is DONE** — retrieval is a real pipeline and the index has left the Mongo document.
> New `@codeflow/retrieval` sits BELOW analyzers and owns the ONE `VectorStore` interface: an
> in-memory exact-cosine pair is the hermetic default the whole suite and the eval run against,
> pgvector + Postgres is production behind an injected `SqlClientLike`, and one factory
> (`createRetrievalStores`) serves both the worker and the API so they cannot disagree about which
> index they are talking to. `Rag` is now metadata + a `store` reference — **ledger #8 resolved**;
> a pre-P2 index is refused with a rebuild instruction rather than answered from zero chunks.
> Chunks are AST-enriched on the EMBEDDING side only (`RagChunk.text` stays byte-exact for its line
> range), measured hermetically at **recall@3 0.500 → 1.000, MRR 0.333 → 0.667, 3 won / 0 lost** —
> with the mechanism-not-magnitude caveat written into the module. Query time is
> **BM25 + vector → RRF → rerank → MMR**, and the **similarity-floor refusal is unchanged**: it
> reads the vector arm's real cosine, before any rerank, asserted by a test. NO cross-encoder
> dependency: `onnxruntime-node` is 211 MB with a downloading postinstall, transformers.js adds
> `sharp`, fastembed is native NAPI — so the deterministic lexical reranker ships and the real one
> is a drop-in behind `CrossEncoderSession`. Plus the **synthetic-data flywheel**: guaranteed-correct
> Q&A generated from the CPG with labels from the graph oracle (never a model), graph-shaped hard
> negatives, and generated negative controls. **742 tests** (was 526).

> ✅ **V3-CLEANUP is DONE** — a leaner tree by PROOF, not by eye. The audit lives in
> [CLEANUP_MANIFEST.md](CLEANUP_MANIFEST.md), committed **before** anything was deleted: 13 REMOVE
> verdicts each with a grep/import-graph receipt, 12 KEEP verdicts each with the reason written down
> so the next pass does not re-litigate them, and 3 items left for the owner to call. Removed the
> empty `@codeflow/exports` package, the `apps/card-action` stub, two never-written Mongo models,
> six unreferenced web files (two of them placeholders superseded by shipped work) + 71 lines of
> orphaned CSS, the `Citation`/`ProjectSummary` types V3-P0 orphaned, and 11 dead symbols — including
> the `llmBudgetSchema`/`LlmBudgetModel` that V3-P0's move to the Redis budget left behind.
> **331 → 318 tracked files, net −265 lines, and 526 tests + legacy 25/25 unchanged** — nothing
> referenced any of it, which is the whole point. **Three of the brief's premises were wrong**:
> ledger #4 and #15 were already done (the files do not exist here), and `card/examples/*.svg` are
> real 1.7–12 KB SVGs, not zero-byte. `card/` is KEPT — it is a **published GitHub Action** with
> external consumers whose analyzer reads `legacy/index.html` at runtime. Closes ledger #4 and #15.

> ✅ **V3-P0 (Foundations + Arena) is DONE** — ran AFTER P1, out of plan order and by design (P1 did
> not depend on it). Cost is now **measured**: one token utility, real provider usage read-back, and
> ONE Redis budget the worker and the API both decrement (they used to keep two blind ceilings).
> Guard 4 has its Redis store. Degradation is **visible**: `runMode: "deterministic-only"` + typed
> `degradations[]`, including the previously-silent Mongo-down fallback. `issues` has a producer and
> `aiProjectSummary` is gone. The eval scores the **answer path** with a calibration-gated judge
> against a **real golden set** (chalk + requests, cloned and read at pinned SHAs), split into a
> keyless CI check and a manual scored workflow. New `@codeflow/arena` grades exactly with **no LLM
> call**. This closes ledger 14(b), 14(c), #9 and #19; **#17 remains open** until the scored run —
> the dataset exists, the number does not yet.

> ✅ **V3-P1 (tree-sitter CPG + communities) is DONE** — parsing is tree-sitter (WASM) with the regex
> parsers as a per-language fallback, Connect builds a code property graph (calls / inheritance /
> HTTP routes alongside imports), and `metrics.clusters` carries a **deterministic** Louvain partition
> with modularity (closing deferred ledger #3). Accuracy is MEASURED, not asserted: on 6 authored
> ground-truth cases tree-sitter scores **100% precision and recall** on both symbols and imports vs
> the regex baseline's 88.9%/59.3% and 94.7%/90.0%. `ParserAdapter` is unchanged and the grammars are
> proven to load inside the pruned `node:20-slim` image with no native toolchain.
> ⚠️ **But the V3 Phase 0 entry gate was NOT met at the time** (no eval golden set, no Arena, no token
> utility), so the scored "retrieval >= Phase 0 baseline" comparison could not be run — see ledger #17.
> (V3-P0 has since been backfilled: the golden set, the Arena and the token utility all exist now. Only
> the scored RUN itself is still owed, because it needs a real key.)

> ✅ **Ship-prep (Dockerfiles + CI) is DONE** (authored; CI/P7 is the build proof): three
> pnpm-workspace-aware multi-stage Dockerfiles (api/worker/web) + `.dockerignore` + `.env.example` +
> `.gitattributes`, and `.github/workflows/ci.yml` running the **hermetic gate** (typecheck → lint →
> **serial** test → build → legacy tests) on push/PR with **no secrets and no service containers**,
> plus an optional `docker-build` job. The web image takes its API URL at **runtime** (`/config.js`
> from `$API_BASE_URL`). The local Docker daemon wasn't running in-session, so image builds are
> proven by the CI `docker-build` job / P7, not this session; the gate commands were all run locally.

> ✅ **Ask-the-repo (RAG query path) is DONE** (hermetic against mock): a grounded, cited,
> wallet-guarded Q&A path. `retrieve` is now ONE canonical primitive in `@codeflow/analyzers`
> shared with the eval; `answerQuestion` answers ONLY from retrieved chunks (honest no-answer below
> the similarity floor — never fabricates), grounds citations to real file+line, and is guarded by
> embedding-space homogeneity + cache-before-budget + per-IP rate limit. `POST /api/result/:id/ask`
> + an Ask tab with clickable citations → drill-down. Embed cache key is now `input_type`-scoped.
> Closes ledger #9. Answer streaming deferred.

> ✅ **2D dependency graph is DONE** (hermetic against mock): the P16 Graph placeholder is now an
> interactive canvas force-graph (`react-force-graph-2d`) reading the grounded graph model — default
> backbone (top-N by centrality, honest "N of M"), node click → k-hop focus + dashboard
> selected-file, cycles highlighted, degenerate graphs degrade gracefully, full model never
> truncated. An enhancement, not the only path (canvas isn't screen-readable — Structure + Drill-down
> cover the same data).

> ✅ **Dashboard (Start Here / Structure / Drill-down) is DONE** (hermetic against mock): three
> data-read views in a tabbed shell beside the P15 pipeline panel, reading the normalized result
> (imports from `graph.edges`, symbols from `inventory`). Start Here degrades honestly on a partial
> run; render caps are render-only (full data behind "show all"). The 2D graph is a placeholder
> slot (P17); Ask-the-repo is later.

> ✅ **Live pipeline panel + SSE replay are DONE** (P5, hermetic against mock): a late-connecting
> client watches the pipeline from Ingest to the honest terminal state. #19 (REST surfaces
> `runStatus`/`runStatusReason`; web SSE-shape + graph-derived normalizer) and #20 (SSE replay
> buffer) are CLOSED. Real Redis/BullMQ+Mongo SSE-wire smoke remains P7.

> ✅ **P4 guardrails are DONE** (all 5, hermetic) — repo-size cap, parsing concurrency, per-file
> parse timeout, per-IP rate limit, and the global daily LLM budget. Limits are `@codeflow/config`
> constants flagged for P7 tuning; the *measured* large-repo run ("tested to N files in Y sec") is
> a **P7** data task.

> ✅ **Eval harness is DONE** (hermetic) — scores synthesis + RAG retrieval against authored ground
> truth, deterministic, fixture-driven. Ships the dataset schema + a `TEMPLATE` (no fabricated
> ground truth). **NOT in CI gating** — the real scored run + dataset authoring + threshold tuning
> are P7 data tasks.

> ✅ The producedBy cache-coverage split is **DONE** — AI-only failures cost an AI retry, never a
> full re-analyze.
> ✅ **RAG / Q&A index (stage 8) is DONE** — index-build only (chunk → embed → store under
> `result.ai.rag`); the ask-the-repo query path is a separate later session.
> ✅ **Multi-provider AI layer is DONE** — both AI stages are provider-swappable behind the existing
> injectable interfaces: chat on Anthropic **or** Gemini, embeddings on Voyage **or** Gemini,
> selected by env (a single `GEMINI_API_KEY` can power the whole AI layer). Cache keys are
> provider/model/dim-scoped; mismatched RAG embedding spaces rebuild rather than mix.

## Where we are

The mock/stub scaffolding from the Phase 6–10 checkpoint has been removed. The pipeline now
produces a **real** `AnalysisResult` from parsed repository data; nothing fabricates health
scores, security/architecture findings, or analysis results anymore. This was the prerequisite
for PLAN **P1** (orchestrator) and is now done.

### Worker analysis (`apps/worker`) — full deterministic pipeline + Synthesize (AI, conditional)

- The BullMQ worker calls `runAnalysisJob` → `runPipeline([ingest, orient, map-structure, inventory, connect, analyze, synthesize, rag], …)`.
  The deterministic slices carry `orientation`, `structure`, `inventory`, `graph` (dependency-graph
  STRUCTURE; `result.files` derives from `graph.nodes`), and `metrics` (key files, blast radius,
  cycles, coupling, complexity proxy). **Synthesize (stage 7, the FIRST AI stage)** adds
  `result.ai.synthesis` (onboarding narrative + grounded reading order) — but is **registered only
  when an LLM client is configured** (`ANTHROPIC_API_KEY` set); with no key the worker runs the
  deterministic pipeline only. The worker passes a Mongo-backed `AnalysisCacheHandle`
  (`createMongoCacheHandle`, `llmcache` collection) as the run's `cache` so AI completions persist
  across runs. Cache miss with a usable result
  (completed/partial) → persist to Mongo keyed on the resolved commit SHA; cache hit → no re-save;
  failed/aborted → not persisted. Run status is surfaced onto the job (`runStatus`).
- The result is stamped with `producedBy` (the stages that ran). The cache read is now **two-tier**
  (see "Cache stamp" below): a result whose deterministic stages are all covered is reusable even if
  an AI stage is missing — that triggers an AI-only retry rather than a full re-analyze.
- Real `RepoCloner` (`gitRepoCloner`) wraps clone + SHA resolution; `readRepoFile` reads specific
  files (Orient manifests/README, Map-structure `.gitignore`); `readRepoDir` is the fs walker for
  Map-structure (skips symlinks); working tree cleaned up.
- **Regression to restore (expected):** the rich parse → dependency-graph → metrics path still
  lives in `processAnalysisJob` (kept, **unwired**, as the reference). Stages 4–6 will reimplement
  it as pipeline stages; the truncation split + env caps move into the `analyze` stage then.

### Cache stamp — `producedBy` (anti-poisoning) + two-tier coverage (the wallet fix)

- Each assembled `AnalysisResult` is stamped with `producedBy: PipelineStageId[]` (completed
  stages, sorted — an explicit list, not a hash, so coverage ≠ equality is expressible).
- **Two-tier coverage** (orchestrator cache read). `producedBy` stays as-is; only the
  INTERPRETATION is two-tier, partitioning the configured stages by their first-class `kind`:
  - `detCovered = configured.deterministic ⊆ producedBy`, `aiCovered = configured.ai ⊆ producedBy`.
  - **det+ai covered → FULL HIT** (return cached, run nothing, spend nothing).
  - **det covered, !ai → AI-ONLY RETRY** (seed from cache, run only the uncovered AI stages).
  - **!det → FULL MISS** (re-analyze from scratch). Empty `configured.ai` (no API key) ⇒ `aiCovered`
    trivially true ⇒ collapses to a deterministic-only hit.
- **Where it runs:** the cloner resolves the SHA only by cloning, so the decision runs
  **pre-Ingest** keyed on `input.requestedCommitSha` (enables a true no-clone full-hit / AI-retry —
  the wallet win), with a **post-Ingest fallback** by the resolved SHA for the branch/unknown-SHA
  first analysis. One shared `decideCacheAction` helper.
- **AI-only retry resume:** `seedSlicesFromResult` hydrates the slice accumulator from the cached
  result's deterministic (+ covered-AI) slices; the single run loop **skips covered stages** (records
  them `completed` so the re-stamp stays honest) and runs only the uncovered AI stages off
  `ctx.prior`. **Asserted:** no cloner / no parse / no graph / no metrics on an AI-only retry; the
  output's deterministic slices are the cached ones, not recomputed; `producedBy` re-stamps with
  `synthesize`. The resume is GENERAL (runs whatever AI stages are uncovered), not hardcoded to "AI
  needs no disk" — see the RAG forward-flag in the ledger.
- **Reusability keys on DETERMINISTIC completeness:** an AI failure yields status `"partial"` (all
  deterministic done) and IS persisted with det-only `producedBy` → reused as an AI-retry next view.
  A deterministic failure yields `"failed"` and is NOT persisted → always a full miss. (This split
  already falls out of the status logic + the worker save policy; the fix is the READ side.)
- The two caches **compose**: an AI-only retry that re-synthesizes an identical assembled prompt hits
  the LLM-output cache (zero API $); a retry after a genuine synthesis failure (no cached completion)
  makes a real call. Both correct, no special-casing.

### API (`apps/api`) — fails honestly + streams progress

- When the job queue is unavailable (e.g. Redis down), `POST /api/analyze` marks the job
  `failed` and returns **503 `QUEUE_UNAVAILABLE`** (unchanged). No fake save.
- `GET /api/result/:id` for a completed job with **no** `analysisId` returns a real error (500).
- **SSE:** `GET /api/job/:id/events` **replays the buffered event log from Ingest, then tails the
  live channel** (the #20 fix). It subscribes FIRST (queuing live messages) so no event emitted
  during the log read is lost, replays the log, drains the queue, then continues live — deduping the
  replay/live boundary on the monotonic `stageIndex` (one authoritative event per stage) + the
  terminal `done`. So a late-connecting client sees every stage exactly once, in order. 404 (JSON)
  for an unknown job is still returned before switching to the event stream. `streamProgress` takes
  an optional `EventLogStore`; with none it's the original live-only stream (back-compat).
- **`GET /api/job/:id` surfaces `runStatus` + `runStatusReason`** (the #19 fix) — REST answers "what
  happened" on a reconnect after completion (SSE is for live watching only). The worker writes both
  onto the job; the API JobModel + `getAnalysisJobProgress` now carry them.
- Removed dead mock services (`mockAnalysisFactory`, `mockJobStore`) and their unused types.

### Cross-process progress channel

- Worker emits `ProgressEvent`s in its process; SSE clients consume them in the API process. The
  contracts (`ProgressMessage`/`ProgressPublisher`/`ProgressSubscriber`) live in shared-types.
- **Production transport:** worker `job.updateProgress(ProgressMessage)` → API `QueueEvents`
  `"progress"` listener filtered by jobId (BullMQ only — no new dependency). Tests use an
  in-memory channel implementing the same interfaces (the BullMQ/QueueEvents transport itself is
  not exercised in tests).
- **Replay buffer (`EventLogStore`, the #20 fix):** the live QueueEvents transport does NOT replay,
  so the worker ALSO appends every emitted message (each per-stage `ProgressEvent` + the terminal
  `done`) to an append-only per-job `EventLogStore`; the API replays it before tailing live (see API
  §). Mongo-backed (`jobevents` collection, `seq`-ordered) in prod — the worker writes, the API
  reads the same collection; in-memory in tests. Real Redis/BullMQ + Mongo SSE wire smoke is **P7**.

### Frontend (`apps/web`) — public-hosted only + the LIVE PIPELINE PANEL (P5 centerpiece)

- `private_local` mode removed entirely. `AnalysisMode` collapsed to `"public_hosted"`; `RepoInput`
  renders only the public repo form.
- **Live pipeline panel** (`features/analysis/PipelinePanel.tsx`) — the USP centerpiece, NOT a
  default stepper: a horizontal "reactor rail" of the 8 stages (connector fills as stages settle;
  the running node pulses) above a chain-of-thought **feed** that appends one entry per reported
  stage. Each entry renders its `detail` + a **generic preview slot** (`Object.entries(preview)` →
  chips) — stage-agnostic, no per-stage hardcoding. The terminal state + `runStatusReason` are
  surfaced honestly in a banner ("Demo at capacity" for `budget-exhausted`, "Repository too large"
  for `repo-too-large`, "Partial analysis", etc.) — the user never sees a silent stall. Status is
  conveyed by glyph + word (not color alone); `prefers-reduced-motion` disables the motion. Replaced
  the old `AnalysisProgress` bar.
- **Pipeline state** lives in the store (`lib/pipeline.ts`: `initialPipelineState` seeds 8 pending
  from Ingest; `applyProgressEvent` upserts by `stageIndex` (dedupe); `applyDoneEvent` records the
  terminal status+reason). `PublicRepoInput` opens `streamJobEvents` (real SSE) to feed the panel
  live, with a **polling fallback** when `EventSource` is unavailable (tests/SSR); the terminal read
  uses `getJob` for `runStatus`/`runStatusReason` (#19) then `getResult` for the dashboard.
- **`streamJobEvents`** now parses the REAL `ProgressEvent` shape (per-stage) + the terminal
  `{ jobId, status }` frame (#19), replacing the stale `ApiJobProgress` shape it expected.
- **Normalizer derives from `graph` + `inventory`** (#19): `result.dependencies`/`symbols`/
  `entryPoints` are intentionally empty post-Connect, so per-file imports come from `graph.edges`,
  functions/exports from `inventory.symbols`, entry points from `inventory.entryPoints` — the empty
  legacy projections are ignored, not read.
- **`mockAnalysis.ts` replaced** with the current shapes: `mockAnalysisResult()` (a faithful
  `AnalysisResult` with `structure`/`graph`/`inventory`/`metrics`/`ai.synthesis`, a **partial** run
  with `pipeline.statusReason="budget-exhausted"`), `mockProgressEvents()` (an 8-stage sequence),
  `mockPipelineState()` (derived, partial + reason), and `mockBigResult(n)` (render-cap fixture).
  `createMockAnalysis()` now wraps `normalize(mockAnalysisResult())` for the "Use Mock Data" path.
- **Dashboard (P16)** — three data-read views in a tabbed `DashboardShell` (Start here / Structure /
  Graph placeholder / Drill-down) beside the pipeline panel; visually consistent with it.
  - **Read model** `lib/dashboard.ts` `buildDashboard(result) → DashboardModel`: derived ONCE from
    the result per the P15 rules (imports/importers from `graph.edges`, symbols from
    `inventory.symbols`, entry points from `inventory.entryPoints`, metrics from `metrics.perFile`).
    Views READ this; they never re-derive. **Render caps are render-only** — the model keeps full
    lists; views paginate over them.
  - **Start Here** renders `ai.synthesis` (summary + ranked reading path + key concepts); on a
    partial / `budget-exhausted` run (synthesis absent) it degrades HONESTLY to `metrics.keyFiles`
    as "start with these" + an "AI summary unavailable — demo at capacity" note (never blank).
    Reading steps open the file in drill-down.
  - **Structure map**: `structure.layout` badge + file-role counts + the file list (sorted by path,
    directory headers), capped to 20 rows with **"Show all (N)"** (the model list is never
    truncated). Files open drill-down.
  - **File drill-down**: per-file `centrality`/`fanIn`/`fanOut`/`blastRadius` + LOC/symbols;
    **`complexity` shown as a RELATIVE rank + bar** with an explicit "structural proxy … not
    cyclomatic" note (never a bare absolute); symbols list; imports + importers from `graph.edges`,
    each a grounded, clickable neighbour → drill-down (no dangling links).
  - Selected-file context lives in the store (`selectedFileId`/`selectFile`); the shell switches to
    Drill-down when a file is opened from any view.
  - **Graph (P17)** — the tab now renders an interactive **2D force-directed dependency graph**
    (`features/graph/DependencyGraph.tsx`, canvas via `react-force-graph-2d`; an ENHANCEMENT — the
    same data is reachable via Structure + Drill-down since canvas isn't screen-readable). Reads a
    **grounded** read-model `lib/graphModel.ts` `buildGraphModel(result)`: nodes = real files only
    (externals tallied-not-nodes), links with both endpoints resolving to a node (dangling dropped),
    `inCycle` from `metrics.cycles`, size by centrality; unresolved/external surfaced as honest
    counts, never faked edges. **Render caps are render-only** (`lib/graphView.ts`): default
    `backboneView` = top-`GRAPH_BACKBONE_NODES` by centrality + induced edges with an honest
    "showing N of M files"; `focusView` = a node's `GRAPH_FOCUS_HOPS`-hop neighbourhood; `fullView`
    = "Show all" (perf warning past `GRAPH_PERF_WARN_NODES`). The three constants live in
    `@codeflow/config`, **P7-tunable**. Node click → focus its neighbourhood AND set the dashboard
    selected-file (drill-down reads it); cycles highlighted (node + edge); `prefers-reduced-motion`
    settles the sim fast (warmupTicks, cooldownTicks 0); empty/degenerate graph → graceful empty
    state. The store holds `graph: GraphModel` (built alongside `dashboard`).
- The legacy P5-era mock panels (`RepositorySummary`/`HealthPanel`/`SecurityPanel`/etc.) are no
  longer rendered (the dashboard replaces them); the files remain on disk, superseded — flagged for
  a cleanup pass (ledger).

### Pipeline (PLAN P1/P2/P3) — deterministic complete + first AI stage (Ingest → … → Analyze → Synthesize)

- **Stage contract** lives in `@codeflow/shared-types` (`PipelineStage`, `PipelineContext`,
  `ProgressEvent`, `AnalysisResultSlices`, run-summary/error contract). `AnalysisResult` was
  extended additively with separated slices (`orientation`/`structure`/`entryPoints` det.;
  `ai` slice for AI) + `producedBy`. `PipelineContext.repoPath`/`commitSha` are **optional** —
  Ingest resolves them and the orchestrator populates ctx before stages 2+.
- **Orchestrator** (`@codeflow/analyzers` → `runPipeline`): runs stages in declared order;
  assembles the result by **per-key slice assignment** (never deep-merge); emits **one
  ProgressEvent per stage** with authoritative `stageIndex`/`stageCount`/`status`/timing;
  error contract — deterministic fail → `"failed"` + dependents skipped + partial result; AI fail
  → `"partial"`; **abort → `"aborted"`**. The **cache read lives in the orchestrator** and is now
  **two-tier** (`decideCacheAction`): full-hit / AI-only-retry / miss, decided pre-Ingest (by
  `requestedCommitSha`) with a post-Ingest fallback — see "Cache stamp" above. Returns
  `{ result, cached }`.
- **Ingest stage** (stage 1, deterministic): pure — validate + shallow-clone + resolve the real
  commit SHA (behind `RepoCloner`), write `repoPath`/`commitSha` into ctx. Owns **no** slice.
- **Orient stage** (stage 2, deterministic): reads ROOT manifests + README only (behind a
  `readFile` interface — never walks the tree). Detects languages (from which manifests exist +
  a `typescript` dep), frameworks (curated keyword scan of manifest contents), and a best-effort
  `projectType` (monorepo > cli > library > application), and captures the **full raw README** as
  a fact for P3. Owns the `orientation` slice. **No LLM** — the AI 3-line summary is deferred to P3.
- **Map-structure stage** (stage 3, deterministic): walks the full repo tree behind a `readDir`
  interface (the stage owns recursion + ignores: a hard ignore set for `node_modules`/`.git`/
  `dist`/`build`/`vendor`/`.venv`/… plus a pragmatic-subset `.gitignore` matcher). Classifies each
  file by role (`source`/`config`/`test`/`docs`/`build`/`asset`/`other`) from path + ext + filename
  conventions, records `{ path, ext, role, language, sizeBytes }`, and detects layout
  (`monorepo`/`src-rooted`/`app-rooted`/`flat`). Owns the `structure` slice; the file list is keyed
  by **path** and is **complete/uncapped** (Inventory + Connect join on it next). It does NOT read
  source for symbols or build the graph. Layout is the owned fact — it does not overwrite Orient's
  `projectType` on disagreement (just logs).
- **Inventory stage** (stage 4, deterministic): drives off `structure.files` (role==='source'),
  reads contents behind the same `readFile` interface, parses via `@codeflow/parsers` (regex/token —
  **no AST dep**). Owns the new `inventory` slice = `{ symbols, entryPoints, symbolCount, loc,
  projectTypeSignal?, unparsedFiles? }`, all keyed by **repo-relative POSIX path** (Inventory has no
  FileNode ids yet — the fileId-keyed `files`/`symbols`/`entryPoints` projections are deferred to
  Connect, which joins `structure.files` + `inventory.loc` + graph **once**). Symbols come from the
  parser's declarations + export surface (export flips `exported` on in-file names; barrel re-exports
  become their own symbols); kinds normalized to
  `function|class|method|interface|type|enum|variable|export`. Entry points: package.json
  bin⇒cli-bin / main / exports + filename conventions (index/main/server/app.*) + cheap framework
  conventions (manage.py / wsgi / asgi / `__main__`), each with `evidence`. Real LOC captured into
  `inventory.loc` (the ONE place LOC is produced). The symbol list is **complete/uncapped**. A single
  unparseable/unreadable file is recorded in `unparsedFiles` and skipped — not a stage failure.
- **projectType reconciliation** (orchestrator-owned): Inventory emits a hard-evidence verdict
  (`inventory.projectTypeSignal`, ONLY on a package.json `bin` ⇒ cli) inside its OWN slice. The
  orchestrator's explicit `reconcileProjectType` step (after the stage loop) writes the **single
  canonical** `orientation.projectType` — Inventory wins on hard evidence, else Orient's heuristic
  stands. No stage reaches into another's slice; no second competing projectType field.
- **Connect stage** (stage 5, deterministic): builds the dependency-graph STRUCTURE from real
  imports. Owns the `graph` slice = `RepoGraph { nodes: FileNode[], edges: RepoDependencyEdge[],
  resolution }`. **`fileId === repo-relative POSIX path`** (no opaque ids — `@codeflow/graph` uses
  `file.id` directly; no translation map). One `FileNode` per `structure.files` entry, joining
  `structure.files` (role/language) + `inventory.loc` (real LOC; **non-source nodes report
  `lines=0`** — LOC is a source-code metric) + per-file `symbolCount`. **`result.files` is a derived
  view of `graph.nodes`** (single FileNode[] home). Import extraction via `@codeflow/parsers`
  (import/require/dynamic/python) + a Connect-local `export … from` re-export pass; resolution is
  Connect's own pass against the discovered POSIX file set (relative + ext + `index.*`; Python
  `.py`/`__init__.py`). Bare/package/`node:` specifiers → **external** (tallied, never nodes);
  unresolvable relative imports → recorded in `resolution`, never a crash. Feeds `@codeflow/graph`
  `buildDependencyGraph` to construct the live graph but **stores plain data only**. **NO metrics**
  (centrality/cycles/coupling/degree are Analyze, stage 6); node + edge lists **uncapped**.
- **Analyze stage** (stage 6, deterministic — the LAST deterministic stage): rebuilds the live
  `@codeflow/graph` object from Connect's plain `RepoGraph` (nodes + edges) and runs the EXISTING
  algorithms (no reimplementation) to produce the `metrics` slice = `RepoMetrics { perFile:
  FileMetrics[], keyFiles, hotspots, cycles, summary }`. Per-file: `centrality` (degree = fanIn +
  fanOut), `fanIn`/`fanOut`, `blastRadius` (transitive dependents — reverse reachability, not just
  direct), and `complexity`. **`complexity` is a declared STRUCTURAL PROXY, NOT cyclomatic** (no
  AST/control-flow): `complexity = loc + symbolCount + fanIn + fanOut`. Metrics reference nodes by
  `fileId (=== POSIX path)` and are **never written back onto `graph.nodes`** (Connect owns `graph`;
  FileNode stays metrics-free). **Determinism is load-bearing** (SHA cache + P3 eval): identical
  graph ⇒ identical numbers AND ordering (perFile sorted by fileId; all rankings tie-broken by
  fileId; cycles sorted). Rankings are **uncapped** (top-N is a P5 render concern). Degenerate graphs
  (edgeless/empty) don't crash. **`clusters`/modules are OMITTED** — no clustering algorithm in
  `@codeflow/graph` yet (its own session; see deferred ledger). NO AI / no prose.
- **Synthesize stage** (stage 7, AI — the FIRST AI stage): reads the deterministic facts (2–6) and
  produces `result.ai.synthesis` = `Synthesis { summary, readingOrder: ReadingStep[], keyConcepts?,
  droppedCitations? }` — a "where do I start" onboarding narrative + ranked reading order, every
  `ReadingStep.fileId` a real `graph.nodes` id. **Grounding is enforced by code**: after the LLM
  returns, a deterministic post-validation drops steps whose fileId ∉ graph.nodes (records
  `droppedCitations`); empty-after-grounding ⇒ retry. **Context budget**: the stored slices stay
  uncapped; the LLM prompt is a bounded read-only VIEW (orientation + README head + layout +
  metrics.summary + top-30 keyFiles + entryPoints + top cycles/impact) — never the full symbol/node
  list. **LLM-output cache** (wallet defense): `ctx.cache` keyed
  `synthesis/v2/{provider}/{model}/{commitSha}/{sha256(prompt)}` (the `v2` provider+model scoping
  landed with the multi-provider work — without it, switching providers would serve a completion
  from the wrong model), checked before every call, temperature 0; Mongo-backed in the worker. LLM
  is behind an injectable `LlmClient` (tests mock it; fetch-based `createAnthropicClient` /
  `createGeminiClient` are the production adapters, selected by env). Retry ≤3; exhausted ⇒ AI failure.
- **AI error contract** (verified): a Synthesize failure ⇒ run status **"partial"** with ALL
  deterministic slices (1–6) intact and returned; `result.ai` left unset (or RAG-only if RAG ran);
  downstream skipped. Never "failed".
- **RAG / Index-for-Q&A stage** (stage 8, AI — the SECOND AI stage): builds the RAG index
  (**index-build only** — the retrieve/answer/cite query path is a separate later session). Owns
  `result.ai.rag` = `Rag { chunks: RagChunk[], chunkCount, embeddingModel, embeddingDim,
  droppedChunks? }`. Each `RagChunk` carries a deterministic `id` (`${fileId}#${start}-${end}`),
  real `fileId`/`startLine`/`endLine`, optional `symbolName`, `text` (uncapped), a plain
  `embedding: number[]` (serializable — no live vector object), and `tokenCount`.
  - **Chunking is deterministic + symbol-aware** (drives off `inventory.symbols` + `structure` +
    file contents — NOT a naive fixed window). Source files (role `source`): one chunk per
    non-overlapping top-level symbol span (`line..endLine`; absent endLine extends to the next
    symbol/window), with uncovered regions (module header, top-level code) swept into window
    chunks so nothing is silently dropped. Docs files (role `docs`, e.g. README) are
    window-chunked. `config`/`build`/`asset`/`test`/`other` are skipped. The role allowlist,
    `MAX_CHUNK_TOKENS` (32K — voyage-code-3's documented context), and `WINDOW_CHUNK_LINES` are
    **named constants flagged for P4 tuning**. Oversized spans are split into contiguous
    sub-chunks within the token cap.
  - **Grounding enforced by code:** chunks whose `fileId ∉ graph.nodes` or whose line range falls
    outside the file are dropped and recorded in `droppedChunks {count, fileIds}` (omitted when
    none). **No retry on grounding** (chunking is deterministic — re-running can't change it,
    unlike Synthesize). Empty-after-grounding ⇒ `throw` ⇒ AI fail ⇒ `"partial"`.
  - **Embedding** behind an injectable `EmbeddingClient` (tests mock it; fetch-based
    `createVoyageClient` / `createGeminiEmbeddingClient` are the prod adapters, selected by env).
    Voyage: `voyage-code-3`, dim 1024, 32K tokens, ≤1000 texts / ≤120K tokens per request (still the
    better *code*-retrieval option). Gemini: `gemini-embedding-001`, default dim **768**
    (`outputDimensionality`, taskType `RETRIEVAL_DOCUMENT`, re-chunked under Gemini's per-request
    cap). `input_type: "document"` (indexing side). Misses batched under the limits; transient
    failures retry (≤3) then throw ⇒ `"partial"`.
  - **Two caches via `ctx.cache`** (namespaced, Mongo-backed `llmcache` in the worker; in-memory in
    tests): (1) **Embedding cache** — content-addressed
    `embed/{provider}/{model}/{dim}/{inputType}/v1/{sha256(normalizedText)}` (provider+dim scoping
    landed with the multi-provider work; the **`{inputType}` segment landed with P18** — a `query`
    and a `document` with identical text produce different vectors and must not collide. The shared
    key lives in `@codeflow/analyzers` `rag/embedCache.ts`, used by both the RAG stage (document)
    and the query path (query)), checked before every embed; an unchanged repo costs **zero API**
    (asserted:
    mock client not called on a full hit). (2) **Chunk-plan cache** — SHA-keyed `rag/v1/{commitSha}`
    storing the grounded plan (no vectors, provider-independent), persisted **before** embedding. Resolution order for the chunk
    source: `repoPath` present → read disk; else chunk-plan cache → use it (**no-disk AI-only
    retry**: no clone, no deterministic stage, no disk — asserted); else throw.
- **Registered behind a configured embedding provider** — with no embedding key RAG does not
  register and `configured.ai` omits it (the P10 two-tier coverage partition stays correct; no new
  orchestrator coverage logic — RAG is just another `kind: "ai"` stage).
- **Multi-provider AI layer (env-selected, no lock-in).** Both AI stages are swappable behind the
  existing injectable interfaces; the provider is the ONLY thing that changes (chunking / grounding /
  stage logic untouched). Chat: `LLM_PROVIDER` (`anthropic` | `gemini`); embeddings:
  `EMBEDDING_PROVIDER` (`voyage` | `gemini`). If unset, inferred from whichever key is present; **both
  keys present + no explicit provider ⇒ a clear config error** (refuse to guess). A stage registers
  iff its SELECTED provider's key is set. A single `GEMINI_API_KEY` powers both synthesis and RAG.
  Selection lives in `@codeflow/analyzers` `providers.ts` (`resolveChatProvider` /
  `resolveEmbeddingProvider` / `createLlmClientFromEnv` / `createEmbeddingClientFromEnv`, pure given
  an env record); the worker calls them with `process.env`. Each client carries a `provider` field
  (the canonical source for the cache-key scoping above). Gemini defaults: chat `gemini-2.5-flash`
  (do NOT use the shut-down `gemini-2.0-flash`), embeddings `gemini-embedding-001` @ dim 768.
- **RAG index homogeneity (no mixing vector spaces).** The P10 cache decision now treats a cached
  `rag` slice as **uncovered** unless its `result.ai.rag.embeddingModel` + `embeddingDim` match the
  currently-selected provider/model/dim — on mismatch, RAG rebuilds (re-embeds) rather than serving
  a foreign-space index. Derived from the RAG stage's `embeddingTarget` + the cached slice's existing
  fields (no new `cacheReusable` flag). The uncovered slice is also NOT seeded on resume, so a failed
  re-embed never returns the stale slice. Synthesis needs no analogous check — its provider/model is
  in the cache key, so a switch misses and re-runs naturally.
- **Wired end-to-end:** the worker runs the 6-stage deterministic pipeline + Synthesize (when an LLM
  client is configured) + RAG (when an embedding client is configured) and streams progress over
  SSE. The cache-coverage wallet fix + both AI stages have landed.

### Ask-the-repo query path (P18) — runtime, grounded + wallet-guarded

The deferred Q&A feature: a user asks; the system retrieves from the ALREADY-BUILT `result.ai.rag`
index, answers grounded ONLY in retrieved code, and cites real file+line. A **runtime path, NOT a
pipeline stage**. Lives in `@codeflow/analyzers` `rag/`.

- **One retrieval primitive.** `retrieve` + `cosineSimilarity` were hoisted from `@codeflow/eval`
  into `@codeflow/analyzers` `rag/retrieve.ts`; eval re-exports + uses it (deleted its copy). So the
  eval's recall@k measures the SAME retrieval production runs. The embedding-space homogeneity guard
  is likewise one shared helper (`rag/homogeneity.ts` `assertEmbeddingSpace`), used by eval + query.
- **`answerQuestion`** (`rag/answer.ts`, pure, injected clients): embed the question (QUERY side) →
  `retrieve` top-k (`RAG_TOP_K`) → **honest no-answer gate** (empty retrieval or top cosine below
  `RAG_MIN_SIMILARITY` ⇒ `answered:false`, **no answer-LLM call** — never falls back to the model's
  general knowledge) → bounded prompt of **only the retrieved chunks** → temp-0 LLM → **ground
  citations by code** (mirror Synthesize: drop any cited chunkId not in the retrieved set, keep the
  grounded ones as `{fileId,startLine,endLine}`, record `droppedCitations`). Returns `RagAnswer`
  `{ answer, citations, retrievedChunkIds, answered, droppedCitations? }`.
- **Three guards (all hold):** (1) embedding-space homogeneity — the question is embedded in the
  index's model/dim or `answerQuestion` throws; (2) spend — both the query embed and the answer
  call go through the daily `BudgetHandle` with **cache-before-budget**, and the endpoint is per-IP
  rate-limited; (3) the embed cache key is now `input_type`-scoped (no query/document collision).
- **Caching:** the answer is cached `qa/v1/{provider}/{model}/{commitSha}/{sha256(question +
  retrievedChunkIds)}` (checked before the LLM ⇒ a hit costs zero LLM + never touches the budget);
  query embeddings ride the content-addressed (now `input_type`-scoped) embed cache. `RAG_TOP_K` +
  `RAG_MIN_SIMILARITY` are `@codeflow/config` constants, P7-tunable.
- **Endpoint:** `POST /api/result/:id/ask` (`routes/ask.ts`, behind an injectable `AskHandler` —
  `setAskHandlerForTests`; the production handler builds clients from env + an in-process cache/budget,
  integration-only). Per-IP rate-limited (shares the analyze store). Honest surfacing: no `ai.rag` ⇒
  200 `{ unavailable:true }` (NOT 500); budget ⇒ 200 `{ atCapacity:true }`; over rate ⇒ 429; unknown
  job ⇒ 404; empty question ⇒ 400. Non-streamed JSON (answer streaming is deferred — ledger).
- **Ask-the-repo UI** (`features/dashboard/AskRepo.tsx`, the 5th dashboard tab): question input →
  `askRepo(jobId, question)` → renders the grounded answer with a **Sources** list of citations,
  each clickable → opens that file in drill-down (reuses the selected-file context). Renders the
  honest no-answer, no-index, "at capacity", and 429 "slow down" states. Disabled on the mock-data
  path (no jobId ⇒ no endpoint). Against the real/mock endpoint.

### Eval harness (`@codeflow/eval`) — hermetic; real scored run is a P7 data task

- New package `packages/eval` (depends on `@codeflow/shared-types` + `@codeflow/analyzers`). Scores
  the pipeline's AI output against authored ground truth — the thing that proves the AI catches the
  RIGHT files, not just well-formed JSON. Built + unit-tested entirely **against a synthetic mock
  fixture**: no keys, no real run, no pipeline execution in the suite.
- **Dataset contract** (`dataset.ts`, plain serializable, `evalSchemaVersion`): `EvalDataset`
  (repoUrl + pinned `commitSha` + `embeddingModel`/`embeddingDim` + `synthesis.expectedEntryPoints`
  + `questions: RagEvalQuestion[]` with `expectedFiles` / optional `expectedLines`). Ships the schema
  + ONE clearly-marked `TEMPLATE_DATASET` (REPLACE_* placeholders) — **no fabricated ground truth**;
  `assertDatasetShape` rejects un-authored templates. The real dataset is authored against a chosen
  repo + SHA in **P7**.
- **Retrieval primitive** (`retrieve.ts`): `retrieve(chunks, queryVector, k)` — pure cosine top-k over
  `Rag.chunks`, deterministic tie-break by chunk `id`, safe for `k > chunkCount` / `k ≤ 0`. The ONLY
  new runtime-ish piece; the Q&A answer + citation + API path is **P18** (not built here).
- **Scoring** (`score.ts`, pure deterministic): synthesis `readingOrderRecall@k` (over top-k reading
  order ∪ top-k keyFiles), citation-resolution rate, droppedCitations rate (surfaced, not hidden);
  RAG per-question `recall@k` + reciprocal rank → mean recall + MRR. Per-question hits/misses
  reported, not just aggregates.
- **Runner** (`runEval.ts`): `runEval(dataset, analysisResult, embeddingClient) → EvalReport` (plain
  serializable: synthesisScores / ragScores / perQuestion[] / thresholds {passed, failures[]} /
  summary). Questions are embedded on the **query** side (`input_type: "query"`). **Homogeneity guard
  (mandatory, same trap as P12):** throws if the embedding client's model/dim OR the stored index's
  `embeddingModel`/`embeddingDim` ≠ the dataset's — cosine across spaces is meaningless, fail loud.
- **Thresholds** (`thresholds.ts`) are **named constants flagged for P7 tuning** (placeholders — can't
  pick real bars against a mock). The report computes pass/fail, but the eval is **NOT wired into CI
  gating**: CI stays hermetic + fast; the gating run needs real keys ⇒ P7.
- **CLI**: `pnpm eval <dataset.json> <result.json>` (`cli.ts`) loads a dataset + a stored
  `AnalysisResult`, builds the embedding client from env (same provider selection as the worker), and
  prints the report; exits non-zero on threshold failure. It needs a real key to embed questions, so
  it is a P7 tool — **not exercised by the hermetic suite** (tests drive `runEval` with fixtures + a
  mock client) and it never runs the real pipeline.

### P4 scale + cost guardrails — five orthogonal, additive guards (hermetic)

All five guards are independently testable and revertible; named limits live in `@codeflow/config`
as **constants flagged for P7 tuning** (you can't pick real numbers hermetically). The *measured*
large-repo run ("tested to N files in Y sec; degrades by Z") is a **P7** task — this session adds the
guards + their tests only.

- **Guard 1 — repo-size cap (Ingest).** Authoritative cap enforced POST-CLONE, BEFORE parsing:
  Ingest takes an injectable `measureRepoSize(repoPath) → { fileCount, totalBytes }`; over
  `MAX_FILES` / `MAX_BYTES` ⇒ a typed `RepoTooLargeError` ⇒ orchestrator marks the run `"failed"` +
  `pipeline.statusReason = "repo-too-large"` and skips dependents (a clean refusal, not a crash).
  The worker provides a real fs walk (`measureRepoSize.ts`, skips `.git`/symlinks; integration-only);
  tests inject a mock. When `measureRepoSize` is omitted the cap is skipped (back-compat).
- **Guard 2 — parsing concurrency (Inventory).** The per-file read+parse loop runs through a
  bounded limiter (`createLimiter`, `PARSE_CONCURRENCY`) — a tiny `p-limit` equivalent, no dep. Each
  file returns a RESULT object (never mutates shared state); results are applied in `structure.files`
  order after all settle, so symbols/loc/unparsedFiles stay deterministic regardless of completion
  order. Asserted: in-flight parses never exceed the limit.
- **Guard 3 — per-file parse timeout (Inventory).** Each file's read+parse is wrapped in
  `withTimeout(FILE_TIMEOUT_MS)`; a file that exceeds it is recorded in `inventory.unparsedFiles`
  and the run continues (skip-and-record, never hang). NOTE: this bounds ASYNC stalls; a CPU-bound
  synchronous hang (catastrophic regex backtracking) can't be preempted on one thread — worker-thread
  isolation is the P7 escalation (ledger).
- **Guard 4 — per-IP rate limit (API).** `createRateLimitMiddleware` on `POST /api/analyze` only
  (not health/results): per-IP fixed window (`RATE_WINDOW_MS`/`RATE_MAX`); over limit ⇒ **429**
  `RATE_LIMITED` + `Retry-After`. Backed by an injectable `RateLimitStore` (in-memory default, tested;
  Redis-backed store shared across instances is the prod swap — ledger). `createApp({ rateLimit })`
  lets tests inject a tiny limit + fresh store. SEPARATE concern from the budget (Guard 5).
- **Guard 5 — global daily LLM spend ceiling (the wallet guard).** `BudgetHandle` (mirrors
  `AnalysisCacheHandle`): `check(estimatedTokens) → ok`, `record(actualTokens)`, **reset per UTC day**
  (keyed on the date). Threaded via `ctx.budget`; checked at the provider-call boundary for BOTH AI
  stages (Synthesize chat + RAG embedding). **Ordering is load-bearing — CACHE BEFORE BUDGET:** the
  content/prompt (Synthesize) and embedding (RAG) caches are checked FIRST; a cache hit spends nothing
  and never touches the budget. Only on a MISS do we `check` → call → `record`. **Estimate before
  (chars/4 for chat; summed chunk `tokenCount` for embeddings), record after** — recording the same
  deterministic estimate for now (wiring the provider's real `usage.total_tokens` through the client
  interfaces is the **P7 refinement** — ledger). Over ceiling ⇒ the stage throws `BudgetExceededError`
  ⇒ graceful `"partial"` (deterministic + other AI slices intact) + `statusReason = "budget-exhausted"`
  (distinct from a plain ai-fail) so the UI can say "demo at capacity". In-memory handle for tests +
  default; Mongo-backed (`createMongoBudgetHandle`, one doc per UTC day) wired in the worker.
- **statusReason plumbing.** `PipelineRunSummary.statusReason?: PipelineStatusReason`
  (`"repo-too-large" | "budget-exhausted"`) is set by the orchestrator from a thrown
  `PipelineReasonError`'s `reason`; the worker surfaces it onto the job (`runStatusReason`,
  added to the job schema + `JobProgress`). Distinct, machine-readable cause vs the human `warnings[]`.

### Packages / legacy

- `@codeflow/analyzers`: now hosts the pipeline orchestrator + Ingest stage (mock factory and
  registry stub were removed in the cleanup pass).
- `@codeflow/exports`: placeholder exporter removed (deferred, PLAN §2); TODO left in place.
- `@codeflow/graph`: `serializeGraphForUI(graph, { maxNodes, maxLinks })` gained optional render
  caps; `summary` is always computed on the full graph.
- **Legacy `index.html`** (~6.5k lines) quarantined to [legacy/index.html](legacy/index.html).
  Not migrated, not deleted. Its deterministic analyzer logic will be **extracted later** in an
  explicit migration phase. The legacy root tests (`tests/*.mjs`) and the `card/` action were
  repointed to the new location so they still resolve it.

### Ship-prep — Dockerfiles + CI (P6; code/config only, no infra)

- **Three service Dockerfiles** (pnpm-workspace-aware, multi-stage; build context = repo root):
  - `apps/api/Dockerfile` + `apps/worker/Dockerfile` — build stage `pnpm install --frozen-lockfile`
    + `pnpm -r build`, then **`pnpm deploy --prod /prod`** (self-contained, prod-pruned runtime
    folder with the internal `@codeflow/*` deps copied in). Runtime: `node:20-slim`, **non-root**
    (`codeflow` uid 1001), built output only. API `EXPOSE 4000` + a `/health` `HEALTHCHECK`
    (`node -e fetch(.../health)`); worker has **no port** and `apt-get install git` (it
    `spawn("git")` to shallow-clone). All env injected at RUN, **never baked**.
  - `apps/web/Dockerfile` — vite build → `nginx:1.27-alpine` static serve (SPA fallback). **Runtime
    API URL:** `apps/web/docker/40-codeflow-config.sh` (an nginx `/docker-entrypoint.d/` hook)
    rewrites `/config.js` from `$API_BASE_URL` at container start, so ONE image works everywhere.
    `apiClient` reads `window.__CODEFLOW_CONFIG__.apiBaseUrl` → `VITE_API_BASE_URL` → localhost; a
    default `public/config.js` ships in the build (dev/jsdom fall back; the hermetic suite is
    unchanged). `nginx.conf` marks `/config.js` `no-store`.
- `.dockerignore` (fresh in-image install), `.env.example` (names only — the current runtime
  contract), `.gitignore !.env.example`, `.gitattributes` (LF on `*.sh`/`Dockerfile`/`nginx.conf` so
  Linux containers don't choke on `\r`).
- **CI** (`.github/workflows/ci.yml`, push + PR): `gate` job — pin pnpm 9.15.4 + Node 20 (pnpm store
  cached) → `pnpm install --frozen-lockfile` → `pnpm -r typecheck` → `pnpm -r lint` → **`pnpm test`
  (serial `-r --workspace-concurrency=1`** — NOT the parallel `pnpm -r test`, which can OOM) →
  `pnpm -r build` → `node --test tests/*.mjs`. Optional `docker-build` job builds all three images
  (**no push, no secrets**) to validate the Dockerfiles. **Hard rule: no secrets, no Mongo/Redis
  service containers** — the suite is hermetic. The real scored eval + the cross-process SSE/BullMQ
  wire smoke stay OUT of CI (P7, out-of-band).
- **Honest boundary:** the in-session Docker daemon wasn't running, so the IMAGE builds are proven
  by the CI `docker-build` job (GitHub's Docker-enabled runners) / P7 — not this session. Every CI
  GATE command (typecheck/lint/serial-test/build/legacy) was run locally and is green.

### V3-P2 — retrieval (branch `v3/p2-retrieval`)

> Full detail, including the reranker dependency probe and every judgment call:
> **[PHASE_LOG.md](PHASE_LOG.md)** (`2026-08-31 — V3-P2`).

- **`@codeflow/retrieval` (new, 155 tests).** Owns `VectorStore`, `ChunkTextStore`, `Reranker`, the
  embedding-space homogeneity guard and the cosine primitive. Depends only on `shared-types` +
  `config`; **sits BELOW `@codeflow/analyzers`**, which is why `cosineSimilarity`, `retrieve` and
  `assertEmbeddingSpace` moved DOWN into it — the stores and MMR need them, and keeping them in
  analyzers would have made the dependency a cycle. Analyzers re-exports all three, so there is
  still exactly ONE definition of each and every existing import path resolves.
- **The index left the document (ledger #8).** A 1024-dim vector is ~8KB of JSON per chunk, so a
  mid-sized repo exceeded Mongo's 16MB BSON limit and every read of an analysis dragged the whole
  index across the wire. `Rag` is now metadata + a `store` reference; a test walks the persisted
  slice AND `JSON.stringify`s it to prove no vector survives. An index with no `store` is PRE-P2 —
  unreadable, not empty — and is refused with a rebuild instruction, because answering from zero
  chunks would look exactly like an honest refusal.
- **In-memory vs prod, deliberately.** The in-memory pair is not a stub: it is what the suite and
  the eval run against, and it is an EXACT cosine scan, so a ranking difference against pgvector is
  attributable to ANN recall rather than to different maths. pgvector puts **the dimension in the
  table name** (`codeflow_vectors_1024`), because `vector(n)` is fixed-width and that makes Postgres
  itself enforce homogeneity. Reached through an injected `SqlClientLike`, so the suite asserts the
  real emitted SQL against a recording fake — no container, no port, no cleanup.
- **AST-enriched embeddings.** `embedTextFor` prepends path + path-words, language, scope chain,
  symbol, signature and docstring to what is EMBEDDED, never to what is STORED. `deriveEnrichment`
  is a POST-PASS over the planned ranges, so V3-P1's interval-cover is untouched and chunk ids
  cannot move — the task's acceptance condition, held by construction. `InventorySymbol` gained the
  `signature` the parser has produced since V3-P1 and Inventory was discarding. Measured
  hermetically: **recall@3 0.500 → 1.000, MRR +0.333, 3 questions won, 0 lost** — with a
  bag-of-words embedder, so it establishes the mechanism and the direction, not the magnitude.
- **Hybrid query path:** BM25 (deterministic, code-aware tokenizer, IDF floored at zero) fused with
  the vector arm by **RRF over RANKS** (a cosine and a BM25 score are not comparable quantities),
  then a reranker, then MMR for diversity. The **refusal floor is unchanged** — it reads the vector
  arm's real cosine BEFORE any rerank, and a test asserts every returned chunk's fused score is
  below the floor that admitted it. A reranker failure degrades to the fused order and RECORDS it.
- **No cross-encoder dependency, on probe evidence.** `onnxruntime-node` installs at **211 MB** with
  a binary-downloading postinstall; transformers.js adds `sharp`; fastembed is native NAPI;
  `onnxruntime-web` is WASM-clean but needs a tokenizer that is itself NAPI. So
  `createLexicalOverlapReranker` ships (keyless, in-process, zero-dep, and flagged
  `kind: "deterministic"` in the data so no report mistakes it for a cross-encoder), and
  `createCrossEncoderReranker` is already tested behind an injected `CrossEncoderSession`.
- **The synthetic-data flywheel.** `@codeflow/arena` generates guaranteed-correct Q&A from the code
  property graph — **labels from the oracle, never from a model** — with graph-shaped hard negatives
  (reverse-direction imports, upstream dependencies, same-community non-callers) and GENERATED
  negative controls. The oracle run as the agent over its own set scores 1.0 on every task, which is
  the flywheel's self-check. Generated sets are deliberately NOT written into
  `packages/eval/datasets/`: that directory's value is that a human stands behind every question.
- **Dev infra:** `pgvector/pgvector:pg16` added to `docker-compose.yml` (dev-only), `POSTGRES_URL`
  documented for both processes. UNSET is a supported single-container mode; configured-but-
  unreachable is reported as a degradation and logged at startup by the worker and the API.

### V3-CLEANUP — dead code + orphan files (branch `v3/cleanup-deadcode`)

> Full audit + every verdict with its evidence: **[CLEANUP_MANIFEST.md](CLEANUP_MANIFEST.md)**
> (committed before any deletion, so the reasoning is reviewable separately from the diffs).

- **Method, not vibes.** An import-graph orphan sweep over all 220 tracked `.ts`/`.tsx` files —
  counting a reference from a test, a `package.json` script, a tsconfig path, a compose file,
  a Dockerfile or a CI workflow as "referenced" — plus `tsc --noUnusedLocals --noUnusedParameters`
  per package run as a REPORT (the flags were not committed), plus a targeted grep per candidate.
- **Removed** (6 commits, full gate after each, none reverted): `packages/exports` (`export {};`,
  zero importers) + its tsconfig paths entry · `apps/card-action` (placeholder, zero references,
  and `V3_PLAN` §5 redirects that work to `apps/mcp`) · `PRReportModel` + `ShareModel` (never
  imported ⇒ their collections were never read or written) · six unreferenced web files, two of them
  placeholders superseded by shipped work (`GraphLegend`/`GraphToolbar` vs the real 2D graph's own
  legend and controls) · 71 lines of CSS orphaned by those removals plus the last ledger-#15
  remnants · the `Citation`/`ProjectSummary` types V3-P0 orphaned · 11 dead symbols.
- **Two of the removals were my own V3-P0 leftovers**: the `Citation`/`ProjectSummary` types (orphaned
  when `AiAnalysis.projectSummary` went) and `llmBudgetSchema`/`LlmBudgetModel` (orphaned when the
  budget moved to Redis). Worth naming — a phase that removes hollowness can leave its own behind.
- **Kept, with the reason recorded so it is not re-litigated.** `card/` is a **published GitHub
  Action** (`action.yml` + a documented external-workflow consumer) whose `lib/analyzer.js` reads
  `legacy/index.html` at runtime — an external consumer the hermetic suite cannot see, so deleting it
  would be an external break. `legacy/index.html` is load-bearing twice (4 legacy tests parse it, and
  `card/` reads it). **`docker-compose.yml` is not a duplicate** of `docker-compose.app.yml` — it is
  dev-infra only (mongo + redis), which is what `pnpm dev:api`/`dev:worker` and the deferred wire
  smoke need. `mockAnalysis.ts` backs 8 test files and a live demo button. `apps/local-cli` is
  referenced by the root `dev:local` script. The commented-out `require` in the parity corpus is a
  deliberate fixture proving the regex parser hallucinates imports from comments.
- **Delta:** tracked files **331 → 318**; **−282/+17** lines (net −265); `styles.css` 1278 → 1207;
  two fewer pnpm workspace packages (so two fewer invocations per `pnpm -r` run); 1.96 MB of
  already-gitignored working-tree junk (`tmp/`, `temp/`, `codeflow.zip`) cleared off disk with zero
  repo change. `tsc --noUnusedLocals --noUnusedParameters` now reports **zero** unused locals or
  parameters repo-wide (was 11).
- **Nothing broke.** Test counts are identical before and after — see Verification below.

### V3-P0 — Foundations + Arena (branch `v3/p0-backfill-foundations-arena`)

> Ran **AFTER** V3-P1, out of plan order and by design: P1 did not depend on anything P0 builds, so
> it shipped first. The only cost was P1's eval acceptance, which had no golden set to measure
> against — paid back here. Branched off `v3/p1-treesitter-cpg`.

**Cost is MEASURED now, not estimated.**
- **One token utility** (`analyzers/src/util/tokens.ts`) replaces three identical
  `Math.ceil(text.length/4)` copies. It draws the line that mattered: `estimateTokens` is ADMISSION
  CONTROL only (you must guess before calling) and drives the deterministic chunk plan; `TokenUsage`
  is the real cost read back afterwards, and the only thing a paid path gives `budget.record()`. The
  4-chars/token rate is unchanged on purpose — it moves RAG chunk boundaries, so tuning it would
  change every embedding. Grep confirms no `length / 4` anywhere else.
- **No local tokenizer, deliberately.** This talks to Anthropic, Gemini and Voyage, whose
  vocabularies differ, so one local tokenizer is precisely *wrong* for two of the three. The provider
  bills us and reports what it billed.
- **Provider usage read-back** (resolves ledger 14(b)): `LlmClient.complete` → `{text, usage}`,
  `EmbeddingClient.embed` → `{vectors, usage}`; all four fetch adapters read the real counters
  (Anthropic input/output + cache read/creation, Gemini `usageMetadata`, Voyage `total_tokens`),
  parsed defensively so a missing counter cannot book 0 or NaN against the wallet.
  `TokenUsage.measured` is the honest half — **the Gemini batch-embed endpoint reports no usage**, so
  that one path is an estimate, says so, and is logged.
- **ONE shared Redis budget** (resolves the #9/14 split): the worker counted in Mongo and the API in
  process memory, so "the global daily ceiling" was two ceilings blind to each other. Both now
  decrement one Redis counter per (UTC day, billing unit) — per-unit because chat and embedding
  tokens are priced differently and exhaust independently. `check` **fails OPEN** on a Redis error
  (explicit, logged): a blip taking the AI surface down is worse than briefly overspending a margin.
  The Mongo handle was DELETED rather than kept as a second implementation of one counter.
  `@codeflow/analyzers` stays dependency-free — it declares `BudgetRedisLike`, the apps inject
  `ioredis`.
- **Prompt caching**: `LlmCompletionRequest.cachePrefix` → an Anthropic `cache_control` breakpoint /
  a Gemini leading `systemInstruction`. A hit is READ BACK as `cacheReadTokens`, never assumed. Only
  SYSTEM_PROMPT is marked, because the per-repo facts are already covered by the SHA-keyed completion
  cache — zero tokens beats a discount.

**Degradation is visible, and the prod fallbacks are real stores.**
- **Redis `RateLimitStore`** (resolves 14(c)) — the prod swap the interface has promised since Guard 4;
  the limit now holds across replicas and survives a restart. Window derived from
  `floor(now/windowMs)`, so INCR+EXPIRE stays atomic with no Lua. Also fails open.
- **New `RunMode`** ("full" | "deterministic-only") + typed `DegradationNotice[]`, on BOTH the job and
  the RESULT so the scope survives a reload and a cache hit. A no-key run legitimately reports
  `runStatus: "completed"` — every stage that existed ran — and `runMode` is what says it was not a
  full analysis. Deliberately NOT a value on `AnalysisMode` ("public_hosted"): access mode and
  delivered scope are different axes.
- **The silent Mongo fallback is surfaced.** The API falls back to per-process in-memory Maps when
  Mongo is down; that stays (it keeps the service answering) but is now reported as a
  `mongo-unavailable` notice naming MONGO_URI, computed at READ time because it is a property of the
  process right now, not of the job record.
- **Web**: the existing honest banner is unchanged; `uncoveredDegradations` renders only what the
  banner does not already explain, so a dead database gets its own notice while missing keys and
  budget exhaustion are not said twice.
- Kept from the Aug-28 partial (not redone): `skippedStages`, the cache-hit-safe `skippedAiStages()`,
  the env-var-naming warnings, the `"skipped"` visual bucket.

**No producerless slices.** Opposite verdicts, decided by whether a consumer exists:
- **`issues` is now PRODUCED** (`pipeline/issues.ts`, derived from Analyze's metrics at assembly —
  the same no-stage-owns-it pattern as `summary`). It was read in four places by the web's
  `analysisNormalizer`, so an always-empty list was rendering as a finding of "no problems". Cycles
  by length, structural hubs as a SHARE of the repo (and only once the repo is big enough for a share
  to mean anything), coupling by absolute degree, and a mostly-disconnected graph collapsed into ONE
  dependency issue. **No `category: "security"` issue is ever emitted** — no security analysis is
  performed, so `summary.securityIssues` is a real count that is structurally always 0.
- **`aiProjectSummary` was REMOVED** from the type: no producer, no consumer, and `Synthesis.summary`
  already answers "what is this project". A declared-but-unwritten field is worse than an absent one.
  Reinstate it *with* its producer — the intent is recorded on `AiAnalysis`.
- `summary` already had its producer from Aug 28 (`deriveSummary` + `scoreHealth`); untouched.

**The eval grades the ANSWER now, and the golden set is real.**
- **Answer-path scoring**: `citationValidity` (does each citation's file+line span sit inside a chunk
  the answer actually retrieved — an independent check that production grounding held),
  `citationRelevance` (cited real code, but the RIGHT real code?), and refusals split JUSTIFIED vs
  UNJUSTIFIED and counted separately, because an honest refusal and a real miss are different
  outcomes that one "answer rate" would hide.
- **Calibration-gated judge**: `calibrateJudge` reports Cohen's **kappa**, not raw agreement — with
  19/20 labels "faithful", a judge that always says faithful scores 95% while carrying zero
  information, and kappa scores it 0. `judgeIsGateable` needs sample size AND kappa AND a
  confidence-interval lower bound. `runEval` reports faithfulness always and **refuses to fail a
  threshold on an uncalibrated judge**. No human labels ship yet, so it is advisory by construction.
- **Real golden set**: `datasets/chalk.json` (JS, 8q) + `datasets/requests.json` (Python, 10q), 14
  with line-range truth. Both repos were **cloned at the pinned SHA and read** — every expected file
  and line range verified against the real file, nothing recalled. Each records PROVENANCE, including
  that the numbers measure the V3-P1 tree-sitter pipeline and are NOT comparable against a
  pre-V3-P1 regex-parsed run.
- Both carry a **negative control** (a question the repo cannot answer), which exposed a real bug:
  `aggregateRag` would have scored a zero-target question as recall 0, penalising the exact refusal
  behaviour the control tests. Negative controls are now excluded from recall/MRR (and counted) and
  scored on the answer path instead.
- **`assertDatasetShape` is real runtime validation** at an untrusted file boundary: full-40-hex
  commit pinning, schema version, duplicate ids, POSIX paths, non-inverted 1-based ranges. Each check
  exists because getting it wrong yields a silently WRONG SCORE, not a crash.
- **CI split**: `ci.yml` gains a keyless `eval check` (validation + determinism + both parser
  families) beside P1's parity step; the scored run moved to a manual-dispatch `eval-scored.yml` with
  an approval environment, a concurrency lock, and `fail-on-threshold` defaulting to **false** —
  thresholds are still placeholders and gating on uncalibrated numbers is what this phase prevents.

**New package `@codeflow/arena` — the verifier / environment layer (gates Phase 4).**
- `TaskSpec` / `Sandbox` / `AgentHarness` / `Verifier` / `Reward` as typed interfaces + a contract
  test (repo convention; no zod, and no runtime validation — an in-process sandbox built from an
  already-validated result is not an untrusted boundary).
- A `Sandbox` is a FROZEN result at a pinned SHA, read-only: an agent must not change the world it is
  graded in. Loading is injected so production reuses the existing SHA-keyed cache; null means "not
  cached" (never "analyze on demand" — that would make grading cost money and vary by cache state);
  a SHA mismatch is REFUSED rather than silently compared.
- **Graph oracle — exact, deterministic, zero LLM calls**: imports-of, who-calls, blast-radius,
  entry-points, cycle-through. `who-calls` is only possible because of V3-P1's `graph.cpgEdges`;
  before the CPG the only honest answer was "we know who imports it", and the tests pin the
  distinction with a file that is imported but never called through. `blast-radius` reuses
  `@codeflow/graph`'s own traversal so oracle and product cannot drift on "affected".
- The oracle also implements `AgentHarness`, making it **self-checkable**: run it as the agent, grade
  it with itself, 1.0 on every kind is the minimum bar. If that round trip fails, derivation and
  comparison have drifted and every Arena score is suspect.
- **The three grounding passes** are wrapped as reusable verifiers so the eval and the Arena share one
  implementation. They stay enforced in production where they belong — grounding is enforced at the
  point of production, not merely measured after.
- `runArenaTask` requires EVERY applicable verifier to pass, not the mean to clear a bar: a correct
  answer citing a nonexistent file is not 80% correct, it is ungrounded. No verifier ran ⇒ NOT a pass.

**Still hermetic.** No test touches Redis, Mongo, a provider, or the network. The Redis stores are
driven by injected fakes; in-memory remains the default everywhere.

### V3-P1 — tree-sitter CPG + communities (branch `v3/p1-treesitter-cpg`)

> ⚠️ **Entry gate was NOT satisfied and this is unresolved.** V3 Phase 0 is not green:
> `packages/eval/datasets/` is EMPTY (no golden set, §0.4), `packages/arena` does not exist (§0.5),
> `analyzers/src/util/tokens.ts` does not exist (§0.1). The Aug-28 commits on `phase1-rebuild` cover
> parts of §0.2/§0.3 only. Phase 1 shipped in full anyway (its work is independent), but the
> **scored-eval "retrieval ≥ Phase 0 baseline" comparison could not be run** and is OWED —
> ledger #17. The parser accuracy claim below rests on a different, hermetic measurement instead.

- **Parsing is tree-sitter now, with the regex parsers as a per-language FALLBACK.**
  `@codeflow/parsers/src/treesitter/` — `runtime.ts` (wasm load), `ast.ts`, `jsLike.ts`, `python.ts`,
  `parseTreeSitter.ts`, `cpg.ts`. Dep: **`web-tree-sitter` + `@vscode/tree-sitter-wasm`** — chosen
  because the official grammar packages carry `"install": "node-gyp-build"` (a native compile in
  `node:20-slim`) while this one is pure wasm assets with no install script, and because
  `tree-sitter-wasms@0.1.13`'s ABI-14 grammars do not load under web-tree-sitter 0.26 (probed).
  Grammars: javascript / typescript / tsx / python; `.jsx` uses the JavaScript grammar (it parses JSX
  natively). The wasm locator is **injectable** and `node:module` is imported lazily, so the same code
  runs in a browser — local-first groundwork at no cost.
- **`ParserAdapter` is unchanged.** `parseFile` stays SYNCHRONOUS; only grammar loading is async
  (`initTreeSitter()`, idempotent, shared). Inventory + Connect `await registry.ready()` before their
  fan-out. Inventory/Connect input and output shapes did not move.
- **Coverage never regresses, and degradation is visible.** Falls back to regex when: no grammar for
  the language, the grammar failed to load, or the file exceeds `TREE_SITTER_MAX_BYTES` (new
  `@codeflow/config` guard, 2 MB — a **byte** ceiling, never a clock, because a time-based bail-out
  would make the deterministic spine non-deterministic). `ParsedFile.parserVersion` reports the engine
  (`treesitter-v1` / `parser-v1`).
- **Parity-or-better is MEASURED, hermetically** — new `@codeflow/eval/src/parity/` harness scores BOTH
  engines against **6 authored ground-truth cases**. Micro-averaged: symbols regex P 88.9% / R 59.3% →
  tree-sitter **P 100% / R 100%**; imports regex P 94.7% / R 90.0% → tree-sitter **P 100% / R 100%**.
  Real, hand-confirmed regex gaps: multi-line imports, `export default function X`,
  `export const X: T = () => …`, `async def f(...) -> T:`, class methods (regex found **none** for
  JS/TS), enums, top-level consts — plus two *fabricated* edges from commented-out imports. Runs with
  **no keys** (`pnpm --filter @codeflow/eval run parity`) and is a **CI step**. Note: the harness's
  `coreSymbols` dimension is a **recall floor only** — its truth set is partial by design, so its
  precision is meaningless and explicitly not gated (`PARITY_GATES`).
- **Deliberately better output** (accepted, covered by the cache bump): symbols carry a real `lineEnd`
  (tightens RAG chunk spans — the stage already honoured `endLine`), class methods are emitted, and
  top-level plain consts become `variable` symbols. `ANALYZER_VERSION` **1.0.0 → 1.1.0** because that
  changes `symbolCount` → the declared `complexity` proxy, so cached analyses must miss.
- **Connect builds a CODE PROPERTY GRAPH** from one tree-sitter pass per source file
  (`extractCpgFacts`), replacing `registry.parseFile` + its own re-export regex. New on the
  Connect-owned `graph` slice: **`cpgEdges`** (call / extends / implements, aggregated per
  `(from, to, kind, symbol)` with an occurrence `count` + first line), **`routes`** (Express / Flask /
  FastAPI), **`cpg`** (provenance: `treeSitterFiles` / `fallbackFiles` / `enriched`).
  `fileId === repo-relative POSIX path`; both new lists are uncapped and deterministically sorted.
- **`cpgEdges` is a SEPARATE list from `edges`, on purpose.** `metrics.perFile.fanIn`/`fanOut` are
  contractually "files that directly import this one", so folding call edges into `graph.edges` would
  silently redefine every existing metric and every UI reading them. `edges` keeps its exact old
  meaning; callers that want the richer graph opt in via the new `buildCodePropertyGraph`
  (`buildImportGraph` is the dependency-only view Analyze still uses). `apps/web` needed **no change**.
- **Honest limits, written into the types.** A `cpgEdge` resolves its target through the file's OWN
  imports, so it always *refines* a relationship the import graph already has — it never invents a
  dependency between two files with no import between them; what it adds is **strength and kind**,
  which is what clustering consumes. Routes are recorded only for a string-literal path starting with
  `/`, and labelled `express` only when the receiver is route-shaped, so `cache.get('/tmp/x')` is
  recorded as `unknown` rather than claimed as a route. A file with no grammar still yields its imports;
  `graph.cpg` counts it as un-enriched instead of letting it look call-free.
- **Community detection (Louvain) — `metrics.clusters`, the ONE canonical field.**
  `@codeflow/graph/communities.ts` (local moving + aggregation, weighted, undirected projection);
  `RepoClusters` carries algorithm, seed, resolution, **modularity**, count, per-node assignments and
  per-cluster files/size/internal+external weight. Absent (not a faked empty partition) for a
  node-less graph.
- **DETERMINISTIC by construction — no randomness at all.** Classic Louvain shuffles the visit order
  with an RNG, which would poison the SHA-keyed cache. Instead: a **seeded** xorshift32 Fisher–Yates
  over the **sorted** node ids (default seed 1); gain ties break to the lowest community index, never
  to hash-map order; communities are relabelled **canonically** (size desc, then lowest member fileId);
  weights rounded at 1e-10. Verified byte-identical on re-run, on reversed node/edge input order, and
  on a rebuilt graph with different insertion order — mirroring the existing Analyze determinism test.
- **Clusters partition the CPG UNION** (imports + weighted calls/inheritance) because coupling for
  clustering genuinely includes calls, while `fanIn`/`fanOut` stay import-only. That asymmetry is
  deliberate, documented on both types, and directly tested. Modularity is reported as **standard,
  unscaled** Newman–Girvan Q so it stays comparable across resolution settings.
- **Every existing graph algorithm still works on the richer graph** — centrality, cycles, isolation,
  coupling, blast radius, traversal, serialization; and `TraversalOptions.includeTypes` can still
  restrict traversal to dependency edges only. Asserted directly.
- **SCIP: deliberately NOT built** (the phase spec marks it optional and non-blocking).
  `scip-typescript`/`scip-python` need a real compile of the *target* repo — i.e. installing an
  untrusted repo's dependencies — plus a protobuf decoder, and cannot be tested hermetically. A flag
  over an unimplemented interface would be dead code. Tree-sitter heuristics are the default and the
  only implementation. Ledger #18.
- **Docker is PROVEN this time** (P6's honest boundary is now closed for these images). All three
  images build. `pnpm deploy --prod` puts `@vscode/tree-sitter-wasm` in the `.pnpm` store rather than
  top-level `node_modules`, so the check was run **inside** the pruned `node:20-slim` runtime image:
  `READY: true`, `LOADED: javascript,jsx,typescript,tsx,python`, `FAILED: []`,
  `parserVersion: treesitter-v1`, class + method + import extracted correctly — **with no native
  toolchain in the image**.
- **New contract surface:** `CpgEdge`, `HttpRoute`, `HttpRouteMethod`, `CpgProvenance`, `RepoCluster`,
  `RepoClusters`; `RepoMetrics.clusters?`; `RepoGraph.cpgEdges?`/`routes?`/`cpg?`;
  `GraphEdge.weight?`; `GraphEdgeType` and `DependencyEdge.dependencyType` gain
  `call`/`extends`/`implements`. All additive.

## Verification

`pnpm -r typecheck`, `pnpm -r lint`, and `pnpm test` all pass — **742 tests** (V3-P2: 526 -> 742,
+216): shared-types 3, graph 33, parsers 28, **retrieval 155 (new package)**, **analyzers 234**,
**arena 68** (+25 synthetic flywheel), **eval 109** (+33 enrichment A/B, index sidecar, generated
datasets), **api 39**, **web 60**, worker 13 — confirmed **hermetic** (green with NO Mongo/Redis; in-memory stores + mock channel + mocked
LLM/embedding + stubbed `fetch`/`EventSource` + **mocked `react-force-graph-2d`** (canvas never
rendered in jsdom) throughout — zero real API/network calls/spend). NOTE: `pnpm -r test` (parallel)
can OOM running all suites back-to-back with the heavier web env; run serially
(`pnpm test` = `-r --workspace-concurrency=1`) or per-package — every package passes in isolation.
Legacy root tests
(`node --test tests/*.mjs`): **25/25 green** — `codeflow-repo-smoke.mjs` (a CLI utility, not a test)
now skips-with-reason + exits 0 instead of failing the default suite.

V3-P1 additions to the gate: `pnpm --filter @codeflow/eval run parity` (the hermetic parser-parity
report — **no keys**, now a CI step) is green with "tree-sitter is parity-or-better on every gated
metric"; `docker compose -f docker-compose.app.yml config --quiet` is clean; and — unlike P6 — the
Docker daemon WAS available, so all three images were actually built and the worker image was run to
confirm all five tree-sitter grammars load inside the pruned `node:20-slim` runtime with no native
toolchain. Still out of the hermetic gate (both need real keys, out-of-band): the **scored** `pnpm eval`
run and the cross-process SSE/BullMQ wire smoke.

V3-P0 additions to the gate: `pnpm --filter @codeflow/eval run check` — the keyless golden-set check
(validation + byte-identical determinism + coverage of both parser families) — is a CI step beside the
parity report. The worker + api images were rebuilt to confirm the new `ioredis` dependency did not
break the `node:20-slim` runtime. The **scored** eval now has its own manual-dispatch workflow
(`.github/workflows/eval-scored.yml`) with an approval environment and a concurrency lock; it stays out
of the per-push gate because it needs real keys and spends money.

V3-CLEANUP ran the FULL gate after every single removal commit (typecheck, lint, serial test, build,
legacy `node --test`), so a reddened tree would have been caught and reverted at that commit rather
than at the end — none was. At phase end all three Docker images (worker, api, web) were rebuilt, and
the keyless `parity` + `check` CI steps and `docker compose config --quiet` are green.

V3-P2 kept the same discipline: the full gate after each of the four task commits. `tsc
--noUnusedLocals --noUnusedParameters` still reports **zero** unused locals/params repo-wide (one
appeared mid-phase — `scoreQuestion`'s `k` became unused when retrieval moved out of the scorer — and
was fixed by ENFORCING it, because a metric called recall@k must not depend on how many results the
caller happens to pass). The hermetic guarantee needed defending once during this phase: a
`createRetrievalStores` degradation test was attempting a REAL TCP connection (3.6 s per run), so the
factory gained a documented `createClient` test seam and a test that asserts the seam is used.

## Not done here (by design)

- **Deterministic pipeline (1–6) complete + Synthesize (st.7) + RAG (st.8) landed + cache-coverage
  wallet fix done + multi-provider AI + eval harness built.** The worker's persisted result is the
  deterministic slices + (when the respective clients are configured) `result.ai.synthesis` and
  `result.ai.rag`. The eval HARNESS exists (`@codeflow/eval`) but the real scored run + dataset
  authoring + threshold tuning are **P7** (ledger item 13). The unwired `processAnalysisJob`
  reference still exists but is superseded by Connect + Analyze (flagged for deletion — ledger item 4).
- **RAG is index-build ONLY.** The ask-the-repo query path (retrieve → answer → cite, using
  `input_type: "query"`) is deliberately NOT built — a separate later session (likely the P5-wired
  API endpoint). Token counting uses a documented ~4-chars/token heuristic (Voyage's tokenizer is
  not bundled) — it only drives chunk splitting + batching, never billing; flagged for P4. The
  `createVoyageClient` adapter is **integration-only** (unit tests mock the `EmbeddingClient`), so a
  real-key smoke run is the proof it works against the live API.
- The `clusters`/modules metric is intentionally absent — `@codeflow/graph` has no clustering
  algorithm; adding one (and the `clusters` field) is its own session (see deferred ledger). Analyze's
  `complexity` is a structural proxy (`loc + symbolCount + fanIn + fanOut`), **not cyclomatic** — no
  control-flow analysis (the known AST fork). `blastRadius` is exact transitive reverse-reachability:
  the obvious large-repo perf cost — a **P4 watch**, deliberately not pre-optimized and never silently
  skipping files.
- **Connect deferred / limitations:** the fileId-keyed flat projections `result.dependencies` /
  `result.symbols` / `result.entryPoints` are left empty this session (`graph.edges` is the single
  edge home; projections are trivially derivable later since `fileId===path`). The web normalizer
  still reads `result.dependencies`/`result.symbols` (P5 will repoint it to `graph`). Import edges
  are produced only for JS/TS/Python (the generic parser extracts no imports, so `.go`/`.rs`/… are
  nodes with no edges). **tsconfig/package path aliases are NOT resolved** (counted as unresolved in
  `graph.resolution`). Regex extraction + heuristic resolution is approximate — `graph.resolution`
  ({resolved, external, unresolved, externalModules, unresolvedImports}) makes the approximation
  data-backed. Connect re-parses source files for imports (Inventory didn't persist them).
- **Open follow-ups are tracked in the Deferred ledger** (below) — barrel re-export provenance,
  entry-point manifest source, the legacy smoke test, and the cache-coverage split.
- Map-structure `.gitignore` support is a pragmatic subset (root `.gitignore` only; no nested
  ignore files, no `[]` char classes; `!` negation by last-match). Role classification has
  judgment calls (config vs build; `.github/workflows` → build; `.txt` → other unless a known doc
  name). Layout is presence-based (a top-level `packages/`/`apps/` path → monorepo).
- The `FileNode[]` projection now exists: Connect produces it as `graph.nodes` (joining
  `structure.files` + `inventory.loc` + symbol counts) and `result.files` is a derived view of it.
  The fileId-keyed `SymbolNode[]`/`EntryPoint[]` projections are still deferred (see Connect
  deferred/limitations below). Inventory's symbols/entry points remain keyed by POSIX path.
- Inventory entry-point `filePath`s are recorded as declared facts: a package.json bin/main/exports
  path often points at BUILD output (e.g. `dist/index.js`, hard-ignored by Map-structure) so it may
  not join to a source file. `module` evidence is folded under `package-json-main`. Filename
  conventions are broad (any source index/main/server/app.*). No `enum` symbol detection in the
  regex parsers yet (the kind exists in the union for forward-compat).
- Orient `projectType` is a heuristic; Inventory now refines the single canonical field via
  orchestrator reconciliation, but ONLY on hard evidence (package.json `bin` ⇒ cli). Go/Python
  lib-vs-app still rely on Orient's dependency/marker signals. README is probed as a candidate-name
  set (case-insensitive `README.*` globbing needs the dir listing from Map-structure, stage 3).
- BullMQ `QueueEvents`/`updateProgress` transport is not exercised in tests (interface +
  in-memory channel are); needs a manual/integration check against real Redis.
- **#19 CLOSED (P15):** `GET /api/job/:id` now returns `runStatus` + `runStatusReason`; the web
  `streamJobEvents` client parses the real `ProgressEvent` shape; the normalizer reads from
  `graph`+`inventory`. **#20 CLOSED (P15):** SSE replays the buffered event log from Ingest before
  tailing live, so a late connection misses no stage. Remaining: the real Redis/BullMQ + Mongo
  `jobevents` SSE-wire smoke (worker writes / API reads across processes) is **P7** — the in-memory
  path is tested, the cross-process Mongo path is integration-only.
- No real health scoring, security, or architecture analyzers yet (PLAN P2/P3).
- No inline pipeline runner yet (deferred TODO in `analyze.ts`).
- Legacy analyzer logic not yet extracted from `legacy/index.html`.

## Deferred ledger (tracked, not yet actioned)

Concrete follow-ups carried across sessions. All non-blocking (the cache-coverage wallet bug — the
former blocker — is **DONE** this session).

1. **Re-export provenance (Inventory).** Barrel re-exports point at the BARREL file/line, not the
   symbol's definition. P3/RAG citations want the definition. Natural home: ride Connect's import
   resolver in a later session to map a re-exported name back to its defining file/line. Owner-decided.
2. **Entry-point manifest source (Inventory + Orient).** Inventory re-reads `package.json` because
   `orientation.manifests` carries only `{ path, ecosystem }`. Fix = extend Orient's manifest capture
   to expose bin/main/exports, then point Inventory at the owned fact. Its own session.
3. **`clusters`/modules metric. RESOLVED (V3-P1).** `@codeflow/graph/communities.ts` implements
   **Louvain** (local moving + aggregation, weighted, undirected projection) and Analyze surfaces the
   partition on the single canonical field `RepoMetrics.clusters` (`RepoClusters`: algorithm, seed,
   resolution, standard Newman-Girvan modularity, count, per-node assignments, per-cluster
   files/size/internal+external weight). **Deterministic by construction** - no RNG anywhere: seeded
   xorshift32 permutation of the SORTED node ids, ties to the lowest community index, canonical
   relabelling by (size desc, lowest member fileId), weights rounded at 1e-10; verified byte-identical
   across re-runs and input orderings. Partitions the CPG **union** (imports + weighted
   call/inheritance edges) while `fanIn`/`fanOut` stay import-only - a documented, tested asymmetry.
4. **Delete the unwired `analysisProcessor.ts` reference. RESOLVED — it was already gone
   (confirmed V3-CLEANUP).** The file and its test do NOT exist in this tree; `apps/worker/src/
   processors/` holds only `pipelineJobProcessor.ts` + its test, and `git log --all` shows
   `e46f859 chore: remove unwired analysisProcessor reference (ledger #4)`. This entry had simply
   gone stale — the work happened, the ledger was never updated. Nothing to delete.
5. **Real Anthropic adapter is integration-only.** `createAnthropicClient` (fetch-based, no SDK) is
   not unit-tested (tests mock the `LlmClient`); needs a manual/integration check with a real key.
   Token streaming to the UI is a separate P5 question. An **end-to-end smoke run** (real repo →
   full pipeline incl. AI) is a good candidate now that the wallet fix has landed.
6. **RAG (st.8) AI-only-retry needs file access — forward flag. ✅ RESOLVED.** RAG's resume reads the
   grounded chunk plan from the SHA-keyed chunk-plan cache (`rag/v1/{commitSha}`) when `ctx.repoPath`
   is absent, so a no-clone AI-only retry invokes no cloner and no deterministic stage (asserted). If
   neither working tree nor cached plan exists, RAG throws (the orchestrator's post-Ingest fallback
   legitimately clones to recover on the branch/unknown-SHA path).
7. **Synthesis prompt-selection sizes are fixed constants (P4 tuning).** The bounded prompt view uses
   top-30 keyFiles / top-10 impact / top-15 cycles / 1200-char README head. Revisit these against
   real large repos for cost/quality in P4 (they cap the LLM INPUT only; stored slices stay uncapped).
8. **Result-slice vector size vs Mongo 16MB BSON limit. ✅ RESOLVED (V3-P2).** Vectors and chunk
   text are OUT of `result.ai.rag.chunks[]` and in `@codeflow/retrieval`'s stores (pgvector for
   vectors, a keyed Postgres table for text), joined back by the unchanged chunk id. `Rag` keeps only
   the metadata a citation needs, so the slice now grows with the chunk COUNT and no longer with the
   embedding dimension. Asserted structurally, not assumed: a test walks every persisted chunk and
   also `JSON.stringify`s the slice, because a round trip through JSON is what persistence does.
9. **Ask-the-repo query path. ✅ RESOLVED (P18); the budget split RESOLVED in V3-P0.** The Q&A
   path's daily budget now shares ONE Redis counter with the worker (it was per-API-process), so the
   global ceiling is finally global. The answer CACHE is still per-API-process — see ledger #21. `answerQuestion` (retrieve → answer → cite,
   `input_type:"query"`) + `POST /api/result/:id/ask` + the Ask-the-repo UI. Grounded, honest
   no-answer, embedding-space homogeneity + cache-before-budget + per-IP rate limit. `retrieve`
   hoisted to one shared primitive; embed cache key now `input_type`-scoped. Remaining sub-items:
   **answer streaming** (token-by-token to the UI) is deferred — non-streamed JSON for now; the
   query-path **answer cache + budget are per-API-process in-memory** (sharing the worker's
   Mongo/Redis handles is a P7 wiring task); the production `AskHandler` (env-built clients) is
   integration-only.
10. **Chunk-size / role-allowlist / `MAX_CHUNK_TOKENS` + token-estimate tuning (P4).** The role
    allowlist (`source`/`docs`), `MAX_CHUNK_TOKENS` (32K), `WINDOW_CHUNK_LINES`, batch limits, and the
    ~4-chars/token estimate are named constants. Validate on a genuinely large repo and record
    measured behavior (retrieval quality likely wants smaller chunks than the model's max input).
11. **Re-export provenance also applies to chunk citations** (extends ledger item 1): a barrel
    re-export symbol's chunk points at the barrel line, not the definition.
12. **Gemini adapters are integration-only** (extends ledger item 5). `createGeminiClient` /
    `createGeminiEmbeddingClient` are fetch-based and unit-tested only against a stubbed `fetch`
    (request/response shape) — a real-key smoke run against the live Generative Language API is the
    proof they work end-to-end. Same status as the Anthropic/Voyage adapters.
13. **Eval is built but NOT scored / NOT in CI gating — P7 data task.** `@codeflow/eval` is hermetic
    (fixture + mock client). The REAL work is P7: author a real `EvalDataset` against a chosen repo +
    pinned SHA, run the actual pipeline to produce an `AnalysisResult` + RAG index, run `pnpm eval`
    with real keys, then TUNE the placeholder thresholds (`EVAL_THRESHOLDS`) from the measured scores.
    Only after that should a gating decision be made — and even then CI must stay hermetic (the
    scored run needs keys + costs money), so any gate runs out-of-band, not in the per-push CI.
14. **P4 guardrails: (b) and (c) RESOLVED (V3-P0); (a), (d), (e) still open.** (b) **RESOLVED** —
    `LlmClient.complete` / `EmbeddingClient.embed` now return provider `usage`, and the budget records
    the REAL token count (with `measured: false` flagging the one path — Gemini batch-embed — that
    reports nothing). (c) **RESOLVED** — `createRedisRateLimitStore` is wired as the prod store in
    `apps/api/src/index.ts`; in-memory stays the hermetic default. The rest of the original item
    stands: (a) All `@codeflow/config`
    limits (`MAX_FILES`/`MAX_BYTES`/`PARSE_CONCURRENCY`/`FILE_TIMEOUT_MS`/`RATE_*`/`DAILY_LLM_BUDGET`)
    are placeholders — tune them from the measured large-repo run ("tested to N files in Y sec;
    degrades by Z"). (b) Guard 5 records the deterministic ESTIMATE; wiring the provider's real
    `usage.total_tokens` needs widening `LlmClient.complete`/`EmbeddingClient.embed` to return usage
    (touches all 4 adapters + mocks) — deferred. (c) Guard 4's prod store should be Redis (shared
    across API instances); only the in-memory store is wired/tested. (d) Guard 3 bounds async stalls
    only; CPU-bound sync parse hangs need worker-thread isolation. (e) `measureRepoSize` (fs walk) +
    `createMongoBudgetHandle` are integration-only (not in the hermetic suite).
15. **Legacy P5-era mock panels. ✅ RESOLVED (V3-CLEANUP).** All 11 components and the
    `selectedPanel`/`panelComponents` machinery plus the `SelectedPanel`/`FileDetailTab` types were
    already absent from this tree (grep for every name returns zero hits). What genuinely survived was
    their orphaned CSS — `.dashboard-layout` (+ `.dashboard-main`/`.dashboard-side` and the 1100px
    media-query override) and the `.file-drawer`/`.health-panel` sticky rules — removed in
    V3-CLEANUP. Two superseded *graph* placeholders the entry did not name (`GraphLegend`,
    `GraphToolbar`) were found by the orphan sweep and removed in the same pass.
16. **Tree-sitter grammar coverage is JS/TS/JSX/TSX/Python only (V3-P1).** Every other language (Go,
    Rust, Java, Ruby, PHP, C#, C/C++, …) falls through to the regex/generic engine, so those files get
    no symbols and **no CPG enrichment** — they contribute graph nodes and (for the regex-covered
    syntaxes) imports, nothing more. `graph.cpg.fallbackFiles` counts them honestly rather than letting
    them look call-free. `@vscode/tree-sitter-wasm` already ships bash/c-sharp/cpp/css/go/java/php/
    powershell/ruby/rust grammars, so widening is mostly a mapping table plus per-language extractors —
    the extractors are the real work, not the wasm.
17. **The scored-eval comparison is still OWED (V3-P1) — but the dataset now EXISTS (V3-P0).**
    Phase 1's stated acceptance was a retrieval-metric comparison against a golden set that did not
    exist. V3-P0 authored it: `packages/eval/datasets/chalk.json` + `requests.json`, cloned and read at
    pinned SHAs, CI-validated for shape/pinning/determinism. What remains is the SCORED RUN itself,
    which needs the owner's key and spends money — run
    `.github/workflows/eval-scored.yml` (or `pnpm --filter @codeflow/eval run eval:scored` locally)
    after producing an `AnalysisResult` per dataset. Note the datasets measure the V3-P1 tree-sitter
    pipeline, so a true before/after against the regex parser would need a pinned re-run of the old
    analyzer — the parser-parity harness already covers that comparison directly. What WAS measured instead is parser accuracy against 6 authored
    ground-truth cases (hermetic, keyless, in CI) — a direct measurement of the thing that changed, but
    NOT the retrieval claim. To close: do V3 §0.4 (author real datasets against pinned SHAs), then run
    the scored eval with a real key on the same SHA before and after V3-P1. Blocked on Phase 0 + a key.
18. **SCIP indexer deferred (V3-P1, task explicitly optional/non-blocking).** Compiler-accurate
    cross-file references would remove the CPG's main limitation (call/inheritance targets currently
    resolve through the file's own imports, so a cpgEdge can only refine an existing import edge, never
    discover an unimported dependency). Not built because: `scip-typescript`/`scip-python` require a
    real compile of the TARGET repo — i.e. installing an arbitrary public repo's dependencies, a
    security and wall-clock problem for a hosted analyzer; consuming the index needs a protobuf decoder
    (new heavy dep); and it cannot be tested hermetically without large binary fixtures. A flag over an
    unimplemented interface would be dead code, so none was added. Tree-sitter heuristics remain the
    default and only implementation.
19. **The zod invariant. ✅ RESOLVED (V3-P0) — by AMENDING it, not by adopting zod.** The rule is now:
    typed interfaces + contract tests are the convention, and RUNTIME validation is added only at
    untrusted external boundaries (API request bodies, parsed LLM JSON, loaded dataset files). V3-P0
    followed it: `assertDatasetShape` became real runtime validation at the dataset-file boundary, while
    `@codeflow/arena` ships typed interfaces plus a contract test and no zod.
20. **`cpgEdges` + `routes` add to the stored analysis document (V3-P1) — same 16MB BSON pressure as
    ledger #8.** Aggregating CPG edges per `(from, to, kind, symbol)` instead of per call site bounds
    the growth by distinct symbols rather than call sites, which is the difference between thousands
    and tens of thousands of edges on a big file — but it is still growth in the same document that
    ledger #8 already flags for the inline RAG vectors. Measure both together on a genuinely large
    repo; the Phase 2 move of embeddings out of `analyses` is the natural time to decide whether the
    graph slice needs externalizing too.
    **STATUS REPORTED, deliberately NOT resolved (V3-P2).** P2 removed the LARGE contributor —
    the inline vectors (ledger #8) — which changes the arithmetic substantially: the document no
    longer grows with the embedding dimension at all. What remains is the graph slice's own growth,
    which is still UNMEASURED on a genuinely large repo, and externalising it on a guess would be
    building without evidence. The decision point is the first big-repo end-to-end run (see the
    deferred-manual list in PHASE_LOG).
21. **The Q&A ANSWER CACHE is still per-API-process (V3-P0).** V3-P0 fixed the wallet half of the old
    #9/14 split — the daily budget is now one shared Redis counter — but `ragQaService` still keeps its
    answer cache in a process-local Map. Consequence: two API replicas each pay for the same repeated
    question once, and a restart forgets every answer. Not a correctness or spend-ceiling problem
    (cache-before-budget still holds, and the ceiling is shared), just wasted spend. Natural fix: move
    the answer cache onto the same Redis connection `redisClient.ts` already provides.
22. **Gemini's batch-embed endpoint reports no usage, so that path is an honest ESTIMATE (V3-P0).**
    `createGeminiEmbeddingClient` returns `TokenUsage.measured: false` and the RAG stage logs it. Every
    other paid path (Anthropic chat, Gemini chat, Voyage embeddings) is genuinely measured. The client
    already reads `usageMetadata` opportunistically, so this becomes measured for free the day Google
    starts sending it — until then the "cost is measured" claim has exactly one documented exception,
    which is visible in the budget ledger rather than hidden.
23. **No human judge labels exist, so faithfulness CANNOT gate (V3-P0).** `judgeIsGateable` requires
    >= 20 labels, kappa >= 0.6, and an agreement CI lower bound >= 0.7. Nothing ships those labels, so
    the judge is advisory by construction: `runEval` reports faithfulness and refuses to fail a
    threshold on it. To promote it: hand-label >= 20 (answer, chunks) pairs as faithful/not, pass them
    as `judgeLabels`, and read the reported kappa before trusting the gate. Deliberately NOT a
    placeholder-labels shortcut — a judge calibrated against invented labels is worse than an
    uncalibrated one, because it looks trustworthy.
24. **`EVAL_THRESHOLDS` are PLACEHOLDERS pending the scored run (V3-P0).** Every value — including the
    three new answer-path thresholds (`minCitationValidity`, `maxUnjustifiedRefusals`,
    `minJudgeFaithfulness`) — is plausible, not measured. `eval-scored.yml` therefore defaults
    `fail-on-threshold` to FALSE: it publishes the numbers so the thresholds can be calibrated FROM
    them. Flip it once they are real. (`minCitationValidity` is the one that could defensibly go to
    1.0 after measurement: a citation that does not resolve to a retrieved chunk is a fabricated
    reference, not a near miss.)
25. **The Redis-backed stores are integration-only (V3-P0).** `createRedisBudgetHandle`,
    `createRedisRateLimitStore` and `apps/api/src/queues/redisClient.ts` are unit-tested against
    INJECTED FAKES (which is what keeps the suite hermetic) and have never run against a real Redis.
    The fakes cover the semantics that matter — shared counters, per-day/per-unit keys, TTLs, atomic
    INCR, fail-open on error, corrupt values — but not connection handling, `enableOfflineQueue: false`
    behaviour, or ioredis's reconnect story. Same status as the Anthropic/Gemini/Voyage adapters
    (ledger #5, #12): a real-service smoke run is the proof. Related: the worker now REQUIRES Redis for
    the budget (it already required it for BullMQ), so there is no fallback path there to test.
