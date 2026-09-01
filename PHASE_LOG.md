# CodeFlow — Phase Log

> Append-only record of what actually executed each session. Intent lives in [PLAN.md](PLAN.md);
> live status in [CURRENT_STATE.md](CURRENT_STATE.md).

## 2026-05-30 — Cleanup pass (prerequisite for PLAN P1)

Branch: `codeflow-cleanup` (off the Phase 6–10 baseline checkpoint `3aa1839`). Cleanup only —
no new features.

**Mock scoring removed**
- Deleted `packages/analyzers/src/mock/mockAnalysisFactory.ts` (`createMockAnalysisResult`,
  hardcoded `healthScore: 82` / `healthGrade: "B"` / `securityIssues: 2` /
  `architectureViolations: 3` and the literal `issues[]`).
- Removed the empty analyzer-registry stub (`{ analyzers: [] }`) from
  `packages/analyzers/src/index.ts`; left a P1-orchestrator TODO.
- Rewrote `apps/worker/.../analysisProcessor.ts` to assemble a real `AnalysisResult` from parsed
  data, with graph-derived metrics and no fabricated values (health unscored → `null`,
  `issues: []`).

**Truncation caps split to render-only**
- Removed the `files 50 / symbols 250 / dependencies 500` caps from the analysis path. The graph
  and all of its metrics now compute on the FULL parsed dataset.
- Added separate UI render caps (env-overridable) applied only to the serialized result + graph
  for the frontend; they never feed back into computed metrics.
- `serializeGraphForUI` gained optional `{ maxNodes, maxLinks }`; `summary` stays full.

**API fails honestly**
- Deleted `runImmediateMockFallback` in `analyze.ts`; queue-unavailable now marks the job failed
  and returns 503 `QUEUE_UNAVAILABLE` (no fake Mongo save). Left a TODO for a future real inline
  runner.
- Deleted the `results.ts` branch that fabricated a result when a completed job had no
  `analysisId`; it now returns a real error.
- Deleted dead `apps/api/src/services/mockAnalysisFactory.ts` and `mockJobStore.ts`, and their
  unused `AnalyzeJob` / `MockJobProgress` / `MockAnalysisResult` types.

**Frontend scope → public-hosted only**
- Collapsed `AnalysisMode` to `"public_hosted"`; removed `ModeSelector` + `PrivateLocalModeGuide`
  and the mode branching in `RepoInput`, `RepositorySummary`, `mockAnalysis`, and the store
  (`setAnalysisMode` removed). Updated the Mongo `mode` enums.
- Kept `apps/web/src/lib/mockAnalysis.ts` + the public-preview render path as PLAN P5
  scaffolding; marked with `// MOCK — replaced in P5`.

**Exports / legacy quarantined**
- Removed the `exportAnalysisAsJsonPlaceholder` from `@codeflow/exports`; TODO left (deferred).
- Moved `index.html` → `legacy/index.html` (`git mv`). Repointed the legacy root tests
  (`tests/*.mjs`) and made the `card/` action tolerant of both locations.

**Verification:** `pnpm -r typecheck` / `lint` / `test` all green (web 4, graph 16, parsers 10,
api 15, worker 11). Legacy `node --test tests/*.mjs` green against `legacy/index.html`.

**Tests changed:** rewrote `apps/api/src/app.test.ts` to assert the honest queue/503 + seeded
cache behavior instead of the mock fallback; removed the two `private_local` cases from
`apps/web/src/App.test.tsx`; renamed the worker test (now asserts real graph values, unchanged
assertions).

## 2026-05-31 — P1: pipeline orchestrator + Ingest stage

One job: build the sequential orchestrator and wire the single Ingest stage end-to-end. No other
stage; worker/API untouched (next session).

**Contract change (approved):** `PipelineContext.repoPath`/`commitSha` are now optional — Ingest
resolves them; the orchestrator populates ctx before stages 2+. Conformance test updated to prove
a pre-Ingest context is valid without them.

**Orchestrator** (`packages/analyzers/src/pipeline/orchestrator.ts`, `runPipeline`):
- Runs stages in declared order; exposes accumulated slices to each stage via `ctx.prior`.
- Assembles `AnalysisResult` by **per-key slice assignment** (`result[key] = partial[key]`) —
  no deep-merge; `ai*` slice keys nest under `result.ai`; required deterministic fields not yet
  produced get honest empty defaults.
- Emits **one authoritative ProgressEvent per stage** (orchestrator owns
  `stageIndex`/`stageCount`/`progress`/`status`/timing; stage contributes `detail`/`preview`).
- Error contract: deterministic fail → `"failed"` + dependents skipped + partial result + warning;
  AI fail → `"partial"`, deterministic result intact, `ai` unset + warning; abort → remaining
  stages skipped + warning. Returns `{ result, cached }`.

**Ingest stage** (`packages/analyzers/src/stages/ingest.ts`, `createIngestStage`):
- Validates + shallow-clones + resolves the real commit SHA behind a `RepoCloner` interface;
  writes `repoPath`/`commitSha` into ctx; checks the analysis cache behind a
  `CachedAnalysisLookup` interface. Owns no slice (`owns: []`, `partial: {}`).
- Cache hit throws `CacheHitShortCircuit`; the orchestrator catches it (control flow, not an
  error) and returns the cached result, skipping the rest.

**Tests** (`packages/analyzers/src/__tests__`, faked clone/cache — no network): orchestrator
ordering + per-key assembly, the three error paths (det-fail / ai-fail / abort), Ingest SHA
resolution + ctx population + cache-hit short-circuit + clone-failure. 9 analyzers tests.

**Verification:** workspace `typecheck` / `lint` / `test` all green (shared-types 3, web 4,
analyzers 9, graph 16, parsers 10, api 15, worker 11).

**Flagged for review:** (1) cache-hit short-circuit uses a thrown `CacheHitShortCircuit` sentinel
because the `{partial,event}` stage contract can't express whole-run early-exit; (2) abort maps to
run status `"partial"` (the enum has no dedicated `"aborted"`); (3) stages can't know
`stageIndex`/`stageCount`, so the orchestrator is the source of truth for the emitted event and the
stage-returned event only contributes `detail`/`preview`.

## 2026-05-31 (b) — P1: worker/API wired to orchestrator + SSE

Two approved contract tweaks, then the worker/API wiring. Two commits.

**Tweaks (commit 1ac9906):**
- Cache read moved from Ingest into the orchestrator (`runPipeline` gains a `cacheLookup`; checks
  once `ctx.commitSha` is set; hit → `{ result, cached: true }` + skip rest). Deleted the
  `CacheHitShortCircuit` sentinel + the instanceof catch (no exception-as-control-flow). Ingest is
  now pure (clone + resolve SHA only).
- Added `"aborted"` to `PipelineRunSummary.status` (new `PipelineRunStatus`); abort with no
  deterministic failure → `"aborted"` (was `"partial"`).

**Cross-process progress channel:** new contracts in shared-types (`ProgressMessage`,
`ProgressPublisher`, `ProgressSubscriber`). Production transport = BullMQ `job.updateProgress`
(worker) → `QueueEvents` `"progress"` listener filtered by jobId (API). No new dependency. Tests
use an in-memory channel implementing the same interfaces.

**Worker:** `runAnalysisJob` runs `runPipeline([ingest])` (Ingest only → minimal result),
publishes each ProgressEvent + a terminal done(status), persists on cache miss (completed/partial)
keyed on the resolved SHA, skips save on hit, does not persist failed/aborted, surfaces `runStatus`
on the job. Real `RepoCloner` (`gitRepoCloner`) wraps the existing clone/SHA helpers; working tree
cleaned up after. The BullMQ worker entrypoint now calls this. The legacy `processAnalysisJob`
(parse → graph → metrics) is kept **unwired** as the reference for stages 2–6.

**API:** `GET /api/job/:id/events` rewritten to stream `progress` events + a terminal `done` event
via a `ProgressSubscriber` (extracted `streamProgress(res, jobId, subscriber)` helper; fixed a TDZ
bug where a synchronous subscriber's terminal event ran `close()` before `unsubscribe` was
assigned). 404-before-SSE preserved. `POST /api/analyze` 503-on-Redis-down unchanged.

**Tests:** worker — cache miss persists + streams events + done; cache hit skips save; clone
failure → failed + not persisted + done(failed). API — `streamProgress` framing (fake sink, since
superagent reports "aborted" on event-streams); 404-before-SSE. Orchestrator — cache hit/miss via
`cacheLookup`, abort → `"aborted"`. Workspace green: shared-types 3, web 4, analyzers 10, graph 16,
parsers 10, api 17, worker 14.

**Flagged:** (1) worker now produces a **minimal** result (Ingest only) — deliberate regression
until stages 2–6 reimplement parse/graph; `processAnalysisJob` retained unwired. (2) BullMQ
transport not exercised in tests (interface + in-memory only) — needs a real-Redis check. (3) real
transport doesn't replay → late SSE subscribers miss earlier events. (4) `/api/job/:id` doesn't yet
surface `runStatus`; web `streamJobEvents` expects the old SSE shape (web untouched).

## 2026-05-31 (c) — P1: producedBy cache stamp + Orient stage (stage 2)

Do-first tweak, then the Orient stage. Two commits.

**Tweak (commit 3e92108):** orchestrator stamps each `AnalysisResult` with
`producedBy: PipelineStageId[]` (completed stages, sorted). Cache READ now serves a HIT only when
`producedBy` **covers** the configured pipeline (superset test) — smaller/older or unstamped
(legacy) records miss → real re-run. Chose an explicit list over a hash because the rule is
coverage, not equality. Persisted automatically (result stored as Mixed). Tests: covering hit;
smaller-pipeline + unstamped → miss + re-run + fresh stamp.

**Orient stage (commit <this>):** stage 2, deterministic, owns the `orientation` slice.
- Contract: extended `RepoOrientation` — `manifests: DetectedManifest[]` (path + ecosystem),
  `projectType: ProjectType` (enum), added `readme: ReadmeCapture | null` (FULL raw text, a fact
  for P3). New `ProjectType`/`PackageEcosystem`/`DetectedManifest`/`ReadmeCapture` types.
- Detection from ROOT manifests + README only (behind a `readFile` interface — no tree walk, no
  source parse). Languages from which manifests exist (+ `typescript` dep → TypeScript);
  frameworks from a curated keyword scan (JSON manifests parsed for deps; others substring-scanned,
  regex/token style per PLAN §9); `projectType` heuristic monorepo > cli > library > application,
  unknown when no manifest. README probed as a candidate-name set. **No LLM** (AI 3-liner → P3).
- Manifests recognised: package.json, requirements.txt, pyproject.toml, **setup.py** (added),
  go.mod, Cargo.toml, pom.xml, build.gradle, **build.gradle.kts** (added), Gemfile, composer.json;
  pnpm-workspace.yaml / lerna.json probed as monorepo signals (not listed as manifests).
- Wired into the worker pipeline: `runPipeline([ingest, orient])` with `readRepoFile` (fs reader,
  ENOENT→null). The worker cache-hit fixture bumped to `producedBy: ["ingest","orient"]`.
- Tests (faked readFile): JS monorepo (workspaces+TS+React → monorepo), Python lib (setup.py
  find_packages → library, Flask), Go CLI (cobra → cli), npm library, empty repo (empty-but-valid,
  no throw), full-README capture (50k chars, untruncated), malformed package.json (still counted),
  missing repoPath → throws. Workspace green: shared-types 3, web 4, analyzers 20, graph 16,
  parsers 10, api 17, worker 14.

**Flagged judgment calls:** `projectType` is heuristic, not a fact. Go CLI vs app/lib can't be told
from go.mod alone, so it leans on a cobra/urfave-cli dependency signal; Python lib leans on
`find_packages`/`packages=`. True entry-point classification is Inventory (stage 4). README
case-insensitive matching is approximated by a candidate-name probe (real globbing needs the dir
listing from Map-structure, stage 3). build.gradle is reported as Java (could be Kotlin).

## 2026-06-01 — P1: Map-structure stage (stage 3)

One job: the deterministic Map-structure stage — the first stage that discovers the full tree.
No LLM. Single commit.

**Contract (structure slice):** redefined `RepoStructure` to `{ layout: RepoLayout, files:
RepoFile[], fileCount }`; new `RepoFile = { path, ext, role, language, sizeBytes }` keyed by
`path`; `FileRole` `"unknown"`→`"other"` (prompt enum); `RepoLayout =
monorepo|src-rooted|app-rooted|flat`. Removed the now-unused `ClassifiedFile`.

**Stage** (`packages/analyzers/src/stages/mapStructure.ts`, owns `structure`):
- Walks the tree behind a `readDir(repoPath, relativeDir) → WalkEntry[]` interface (stage owns
  recursion + ignores; tests fake it — no real fs). Ignores = HARD_IGNORE_DIRS (node_modules/.git/
  dist/build/vendor/.venv/caches/…) + a pragmatic-subset `.gitignore` matcher (comments/blanks,
  `!` negation last-match, trailing-slash dir-only, leading/embedded-slash anchoring, `*`/`**`/`?`).
- Classifies role ordered test > docs > build > config > asset > source > other (first match wins,
  so `*.test.ts` is test and a CI yml is build); records ext + language-by-extension + sizeBytes.
- Detects layout (presence-based: a `packages/`|`apps/` path → monorepo; else top-level `src`/`app`
  → src/app-rooted; else flat). Layout is the owned fact: on disagreement with Orient's
  `projectType` it logs and does NOT overwrite (reconciled when Inventory lands).
- File list is COMPLETE/uncapped (load-bearing — feeds the graph later). Deterministic sort by path.
- Throws if `ctx.repoPath` is unset (Ingest must run first).

**Wiring:** exported from analyzers; worker pipeline now `[ingest, orient, map-structure]` with an
fs `readRepoDir` walker (skips symlinks). Worker cache-hit fixture bumped to
`producedBy: ["ingest","orient","map-structure"]`; worker test deps gain a `readDir`.

**Tests** (faked tree, no fs): role classification across source/test/config/docs/build/asset/other
+ ext/language/sizeBytes; hard-ignore-set + `.gitignore` (glob/dir/negation) exclusion; layout
(monorepo/src/app/flat) + no-overwrite-on-disagreement; 1000-file uncapped list; empty repo; missing
repoPath throws. Workspace green: shared-types 3, web 4, analyzers 32, graph 16, parsers 10, api 17,
worker 14.

**Flagged:** (1) file list keyed by `path` (POSIX, unique); Map-structure owns only `structure`
(not `files: FileNode[]`) — deferring the graph-node projection + LOC to Connect/Inventory so one
stage owns `files`. (2) `.gitignore` is a subset (root only, no nested files / `[]` classes).
(3) role config-vs-build and `.txt`→other are genuine judgment calls; `.github/workflows`→build.
(4) layout monorepo detection is presence-based (top-level `packages/`/`apps/` path).

## 2026-06-03 — P2: Inventory stage (stage 4)

One job: the deterministic Inventory stage — parses source into symbols + detects entry
points. No graph (Connect, stage 5), no AST dep (regex/token parsers). Single commit.

**Contract (new `inventory` slice):** added `Inventory = { symbols: InventorySymbol[];
entryPoints: InventoryEntryPoint[]; symbolCount; loc: Record<posix,number>;
projectTypeSignal?; unparsedFiles? }`. `InventorySymbol = { name, kind, filePath (repo-
relative POSIX), line (1-based), endLine?, exported, language }` with `SymbolKind =
function|class|method|interface|type|enum|variable|export`. `InventoryEntryPoint = {
filePath, kind: main|index|server|app|cli-bin, evidence: package-json-bin|-main|-exports|
filename-convention|framework }`. Keyed by **POSIX filePath** (NOT fileId) — Inventory has
no FileNode ids yet. New types are PREFIXED (`InventorySymbol`/`InventoryEntryPoint`) to
avoid shadowing the JS `Symbol` global and colliding with the legacy fileId-keyed
`EntryPoint`. `AnalysisResultSlices`/`AnalysisResult` gained `inventory`; the legacy
`files`/`symbols`/`entryPoints` slice-ownership comments moved to **Connect** (it does the
single join into fileId-keyed projections).

**Stage** (`packages/analyzers/src/stages/inventory.ts`, owns `inventory`):
- Drives off `ctx.prior.structure.files` (role==='source'), reads contents behind the same
  `readFile` interface Orient/Map-structure use, parses via `@codeflow/parsers`
  `registry.parseFile` (regex/token — no AST dep, the known later fork). Joins strictly by
  repo-relative POSIX path.
- Symbols built from the parser's `symbols` (declarations) + `exports` (public surface):
  an export on an in-file name FLIPS that symbol's `exported` flag; an export of a name not
  declared in-file (barrel/re-export) becomes its own symbol. No duplicate-name noise.
  Kind normalization: component/hook→function; TS `unknown` (interface/type) recovered from
  the captured signature line; export-only unknowns→`export`.
- Entry points: package.json `bin`⇒cli-bin (string or object), `main`/`module`⇒main,
  `exports`⇒main (string + nested conditional-exports walked); filename conventions
  index/main/server/app.*; cheap framework conventions (manage.py⇒cli-bin, wsgi/asgi.py⇒
  server, __main__.py⇒main). Evidence recorded on each; deduped on (path,kind,evidence).
- Real LOC captured into `inventory.loc` (the ONE place LOC is produced — Connect joins it
  into FileNode[].lines later; Inventory does NOT write structure.files / FileNode[]).
- **UNCAPPED** symbol list (load-bearing — never truncated; caps are UI-only).
- Single-file failure (parse throw OR unreadable/null) → recorded in `unparsedFiles`,
  skipped, run continues. Throws only if repoPath or the structure slice is missing.

**Reconciliation (orchestrator-owned):** Inventory emits a hard-evidence verdict
(`projectTypeSignal`, ONLY on a package.json `bin` ⇒ cli) inside its OWN slice — it never
reaches into orientation. The orchestrator runs an explicit `reconcileProjectType` step
after the stage loop that writes the SINGLE canonical `orientation.projectType` (Inventory
wins on hard evidence, else Orient's heuristic stands). Same deferral pattern Map-structure
uses for layout. No second competing projectType field.

**Wiring:** exported from analyzers; worker pipeline now `[ingest, orient, map-structure,
inventory]` (reuses the existing `readFile` dep). `inventory` joins the `producedBy` stamp;
worker cache-hit fixture bumped to `[ingest, orient, map-structure, inventory]`. Added
`@codeflow/parsers` as an analyzers dependency (+ tsconfig path to its dist).

**Tests** (faked readFile + in-memory structure): symbol extraction TS (func/class/arrow/
interface/type, exported flag, line) + Python (func/class/method) + JS (export-surface flag);
real LOC; source-role-only parsing; POSIX join (symbol.filePath ∈ structure.files); entry
points bin⇒cli-bin / main / exports / filename / framework with evidence; string-form bin;
projectTypeSignal only on bin; uncapped 500-symbol fixture; bad-file + unreadable-file skip
with the run still succeeding; missing structure/repoPath throw. Reconciliation (orchestrator
suite): bin+Orient=library⇒cli; no signal⇒library preserved; asserts exactly ONE projectType
field (orientation owns it, inventory exposes only a signal). Workspace green: shared-types 3,
web 4, analyzers 47, graph 16, parsers 10, api 17, worker 14.

**Flagged judgment calls:** (1) `inventory` is a NEW slice keyed by POSIX path; the legacy
fileId-keyed `files`/`symbols`/`entryPoints` projections are deferred to Connect (one join of
structure.files + inventory.loc + graph). (2) bin/main/exports paths often point at BUILD
output (dist/, hard-ignored by Map-structure) so an entry point's filePath may not join to a
source file — it's recorded as the declared fact regardless. (3) `module` evidence folded
under `package-json-main` (the evidence enum has no module variant). (4) filename-convention
entries are broad (any source index/main/server/app.*) — facts, uncapped; ranking is a UI
concern. (5) hard evidence for reconciliation is package-json-bin ONLY (framework manage.py
is cli-bin but deliberately does NOT flip projectType). (6) no `enum` detection in the
parsers today — the kind exists in the union for forward-compat.

## 2026-06-03 — P2: Connect stage (stage 5)

One job: the deterministic Connect stage — builds the dependency-graph STRUCTURE from
real imports and produces the single FileNode[] projection. NO metrics (Analyze's job).
First feed of @codeflow/graph. Single commit.

**Pre-flight (3 carried-over Inventory items, gates not a second job):**
- (i) `inventory.loc` scope CONFIRMED source-only (Inventory's loop filters role==='source').
  Decision: Connect's FileNode.lines = `inventory.loc[path] ?? 0`; non-source nodes report 0
  (LOC is a source-code metric — Inventory measures source only). Recorded in CURRENT_STATE.
- (ii) Barrel re-export provenance — GAP confirmed + FLAGGED (own follow-up): Inventory makes a
  barrel re-export its own symbol at the BARREL file/line, not the definition. P3 RAG citation
  needs the definition; recovering it needs import-resolution-to-definition (> small fix). Not
  fixed here.
- (iii) Entry-point manifest source — Inventory re-reads package.json; `orientation.manifests`
  is only `{ path, ecosystem }` (no bin/main/exports). "Switch to the owned fact" needs Orient
  to expose manifest fields first (> one-liner). FLAGGED as its own session. Not fixed here.

**Contract (new `graph` slice = RepoGraph):** `fileId === repo-relative POSIX path` (no opaque
ids — verified @codeflow/graph buildNodes uses file.id directly; no translation map). New
`RepoDependencyEdge = { from, to, kind: import|require|dynamic|reexport, specifier }`;
`GraphResolution = { resolved, external, unresolved, externalModules[], unresolvedImports[] }`;
`RepoGraph = { nodes: FileNode[], edges: RepoDependencyEdge[], resolution }`. `AnalysisResult.graph`
RETYPED `SerializedDependencyGraph → RepoGraph` (structure only, no metrics); the old serialized
shape (with `summary` metrics) stays as the UI-serialization output type for Analyze/P5. `FileNode`
gained `symbolCount?`. `result.files` is now a DERIVED view of `graph.nodes` at assembly (single
FileNode[] home). The fileId-keyed flat projections (symbols/entryPoints/dependencies) are deferred
(trivial later since fileId===path).

**Stage** (`packages/analyzers/src/stages/connect.ts`, owns `graph`):
- One FileNode per `structure.files` entry: id=path, name=basename, layer=role, language, lines=
  loc??0, symbolCount (from inventory.symbols grouped by filePath).
- Import extraction via `@codeflow/parsers` `registry.parseFile().imports` (import/require/dynamic/
  python) + a Connect-local regex pass for `export … from` re-exports (the parser only does `import`).
- Resolution is Connect's OWN pass against the discovered `structure.files` POSIX set (NOT fs
  statSync — deterministic/testable): relative `./`/`../` + ext (.ts/.tsx/.js/.jsx/.mjs/.cjs) +
  `index.*`; Python `.mod`/`.pkg` → `.py`/`__init__.py`. tsconfig/package path ALIASES out of scope
  (counted as unresolved) — recorded in `resolution`.
- Bare/package/`node:` specifiers → external (tallied in resolution.externalModules, NEVER nodes);
  unresolvable relative imports → resolution.unresolvedImports (never a crash). resolved edges →
  graph.edges (deduped on from|to|kind|specifier).
- Feeds `@codeflow/graph` `buildDependencyGraph(nodes, richDeps)` to construct + validate (warnings
  surfaced); STORES plain data only (no live graph object). NO metrics computed.
- Node + edge lists COMPLETE/uncapped. Throws only if repoPath or structure is missing.

**Wiring:** exported from analyzers; worker pipeline now `[ingest, orient, map-structure, inventory,
connect]`; `connect` joins the producedBy stamp; cache-hit fixture bumped. Added `@codeflow/graph`
as an analyzers dependency (+ tsconfig path). Unwired reference `analysisProcessor.ts` no longer
assigns the UI graph to `.graph` (now the structure slice) — its metrics path is untouched; its
test's `graph:` assertion dropped (metrics assertion kept).

**Tests** (faked readFile + in-memory structure/inventory): relative resolution by extension + by
index + parent (../); require/dynamic/reexport kinds; Python module + `__init__` resolution; bare
import → external + tallied, not a node; unresolvable relative → recorded, stage still succeeds;
FileNode join (one node per file, loc + symbolCount + role/language, non-source loc=0); fileId===path
+ every edge endpoint is a node + POSIX keys line up; NO metrics field on slice/nodes; uncapped
400-node/399-edge fixture; unreadable source → node but no edges; missing structure/repoPath throw.
Workspace green: shared-types 3, web 4, analyzers 61, graph 16, parsers 10, api 17, worker 14.

**Flagged judgment calls:** (1) only JS/TS/Py get import edges (generic parser extracts none) —
.go/.rs/etc. contribute nodes but no edges. (2) tsconfig/package path aliases unresolved (counted,
not resolved). (3) regex extraction + heuristic resolution is approximate — resolution stats make it
data-backed. (4) Connect re-parses source files for imports (Inventory didn't store them) — accepted
double-parse. (5) result.dependencies / symbols / entryPoints flat projections left empty this
session (graph.edges is the single edge home; projections deferred). (6) `RepoDependencyEdge` is a
NEW type distinct from the legacy rich `DependencyEdge` (kept for parsers/@codeflow/graph input).

## 2026-06-03 — P2: Analyze stage (stage 6) — deterministic pipeline COMPLETE

One job: the deterministic Analyze stage — graph METRICS as numbers from Connect's RepoGraph.
Last deterministic stage; the pipeline's deterministic half is now complete. Single commit.

**Pre-flight (algorithm availability in @codeflow/graph):** centrality (`computeCentrality`),
cycles (`findCircularDependencies`), blast radius (`getTransitiveDependents`/`getBlastRadius`),
coupling fan-in/out (`detectHighCouplingFiles` + degrees) all PRESENT. **clusters/modules MISSING**
— flagged + OMITTED this session (implementing a clustering algorithm is its own session; no
empty-array placeholder pretending coverage).

**Contract (metrics slice retyped → RepoMetrics):** the flat-bag stub
`metrics: Record<string,number|string|string[]>` was retyped to structured `RepoMetrics`
(analyze-owned). `FileMetrics = { fileId (===POSIX path), centrality, fanIn, fanOut, blastRadius,
complexity }`; `RepoMetrics = { perFile: FileMetrics[] (sorted by fileId), keyFiles: string[]
(FULL centrality ranking), hotspots: string[] (FULL complexity ranking), cycles: {files:[]}[],
summary: { fileCount, edgeCount, cycleCount, isolatedFileCount, maxBlastRadius } }`.
**complexity is a declared STRUCTURAL PROXY** (NOT cyclomatic — no AST/control-flow):
`complexity = loc + symbolCount + fanIn + fanOut`. Metrics are NEVER written onto graph.nodes
(Connect owns `graph`; FileNode stays metrics-free).

**Stage** (`packages/analyzers/src/stages/analyze.ts`, owns `metrics`):
- Rebuilds the live @codeflow/graph object from Connect's plain RepoGraph (nodes + edges→rich
  DependencyEdge) via `buildDependencyGraph`, then runs the EXISTING algorithms (no reimpl).
- centrality = degree (fanIn+fanOut); blastRadius = transitive dependents (reverse reachability,
  not just direct); cycles from findCircularDependencies (each rotation-normalized), cycle LIST
  sorted deterministically; isolatedFileCount from detectIsolatedFiles.
- DETERMINISM (load-bearing for SHA cache + P3 eval): identical graph ⇒ identical numbers AND
  ordering — perFile sorted by fileId, all rankings tie-broken by fileId, cycles sorted by joined
  fileIds. Verified by a run-twice byte-identical test.
- UNCAPPED: keyFiles/hotspots/perFile/cycles are FULL (top-N is a P5 render concern only).
- Degenerate graphs (edgeless/empty) don't crash → sane zeros, no divide-by-zero.
- NO AI / NO prose / no result.ai.* — numbers only (Synthesize, st.7, is the AI step).

**Wiring:** exported from analyzers; worker pipeline now `[ingest, orient, map-structure,
inventory, connect, analyze]` (full deterministic pipeline); `analyze` joins the producedBy stamp;
cache-hit fixture bumped. Orchestrator default metrics → honest empty RepoMetrics. Retype fallout
fixed: contract-test envelope, graph fixtures, api app.test, web App.test mock (all `metrics: {}` /
flat → valid RepoMetrics), web normalizer drops the redundant `metrics.languages` fallback (uses
`summary.languages`), unused `stringArrayMetric`/`formatRepo` helpers removed; unwired reference
`analysisProcessor.ts` now fills only `metrics.summary` counts (its test asserts `summary.fileCount/
edgeCount`).

**Tests** (in-memory RepoGraph): centrality ranking + ties by fileId; fanIn/fanOut hand-counted;
cycle detected / acyclic none; blastRadius transitive (A→B→C ⇒ C affects A); complexity proxy
formula exact; determinism (run-twice byte-identical, perFile sorted); uncapped 300-node fixture;
edgeless + empty degenerate; no-prose/no-ai boundary; every perFile.fileId ∈ graph.nodes; missing
graph throws. Workspace green: shared-types 3, web 4, analyzers 75, graph 16, parsers 10, api 17,
worker 14.

**Deferred ledger (recorded, NOT actioned this session):** (ii) re-export provenance (barrel →
definition; ride Connect's resolver later); (iii) entry-point manifest source (extend Orient's
manifest capture, then point Inventory at the owned fact — own session); codeflow-repo-smoke.mjs
(needs skip-with-reason / `live` gate BEFORE P6 CI); cache-coverage split (producedBy coverage test
should count DETERMINISTIC stages only — actionable when Synthesize lands). See CURRENT_STATE.

**Flagged:** clusters/modules omitted (no algorithm in @codeflow/graph). complexity is a structural
proxy, not cyclomatic. blastRadius is exact transitive reverse-reachability — the obvious large-repo
perf cost (P4 watch; NOT pre-optimized, NOT silently skipping files).

## 2026-06-03 — P2/P3: Synthesize stage (stage 7) — FIRST AI STAGE

One job: the Synthesize AI stage — a grounded "where do I start" onboarding narrative +
ranked reading order from the deterministic facts (stages 2–6). LLM mocked in all tests;
no real API calls. Single commit.

**Contract (result.ai.synthesis, realigned):** replaced the stub `SynthesisOutput`/
`ReadingOrderItem` with `Synthesis { summary, readingOrder: ReadingStep[], keyConcepts?,
droppedCitations? }` and `ReadingStep { fileId (=== POSIX path, MUST exist in graph.nodes),
order, reason }`. Citations key on fileId so grounding is checkable by string equality.
`AiAnalysis.synthesis` + `AnalysisResultSlices.aiSynthesis` retyped to `Synthesis`. Owns
`aiSynthesis` ONLY (nests under result.ai.synthesis; deterministic slices stay top-level).

**Three load-bearing decisions (all confirmed as recommended):**
- (a) GROUNDING: deterministic post-validation drops reading steps whose fileId ∉ graph.nodes,
  keeps the grounded ones, renumbers `order`, records `droppedCitations`. Empty-after-grounding
  ⇒ schema failure ⇒ retry. Grounding is enforced by CODE, never trusted from the model.
- (b) CONTEXT BUDGET: stored slices stay uncapped; the LLM PROMPT is a bounded VIEW assembled
  read-only from orientation (type/langs/frameworks + README head ~1200 chars) + layout +
  metrics.summary + top-30 keyFiles (with FileMetrics) + all entryPoints + top-10 by blastRadius
  + top-15 cycles. The full symbol/node list is NEVER fed (asserted by test).
- (c) LLM-OUTPUT CACHE (wallet defense, required): uses the `AnalysisCacheHandle` (ctx.cache);
  key = `synthesis/v1/{commitSha}/{sha256(assembledPrompt)}`; checked BEFORE every call; only
  valid+grounded completions are cached; temperature 0 for stable per-SHA output. A Mongo-backed
  handle (`createMongoCacheHandle`, new `llmcache` collection) is wired in the worker so re-runs
  skip the paid API; tests inject an in-memory handle. SEPARATE from the producedBy result-cache.

**Stage** (`packages/analyzers/src/stages/synthesize.ts`, kind "ai", owns `aiSynthesis`):
- LLM behind an injectable `LlmClient` interface (`packages/analyzers/src/llm/llmClient.ts`);
  a minimal `fetch`-based `createAnthropicClient` (no SDK dep, model+key from env) is the
  production adapter — NOT unit-tested (tests always mock). Prompt instructs JSON-only; output
  is fence-stripped, JSON-parsed, hand-rolled-schema-validated (no zod dep), then ground-checked.
- Retry up to maxAttempts (default 3) on malformed-JSON / schema-miss / empty-after-grounding /
  thrown client; exhausted ⇒ stage THROWS ⇒ orchestrator marks AI failure ⇒ run "partial",
  deterministic slices intact. No token streaming (P5 question); normal stage ProgressEvent only.

**Wiring:** worker pipeline becomes `[…, analyze, synthesize]` but Synthesize is registered ONLY
when an LLM client is configured (`ANTHROPIC_API_KEY` present, `SYNTHESIS_MODEL` default
claude-opus-4-8) — no key ⇒ deterministic-only. `synthesize` joins producedBy when it runs.
Worker passes the Mongo cache as `runPipeline({ cache })`. Realign fallout: 3 contract/orchestrator
test stubs updated (narrative→summary).

**Tests** (LLM mocked): valid completion parsed; fence-stripping; malformed/missing-field retried
then throws (3 calls); grounding drops invalid + keeps valid + records dropped count + renumbers;
all-ungrounded retried→throws; AI error contract via runPipeline (client throws ⇒ "partial",
graph/metrics intact, ai unset); cache (same SHA+prompt ⇒ client called ONCE; different SHA ⇒ 2
calls); context budget (deep sentinel symbol absent from prompt, top key file present, uncapped
slices unmutated); writes only aiSynthesis; missing graph throws. Workspace green: shared-types 3,
web 4, analyzers 87, graph 16, parsers 10, api 17, worker 14.

**WALLET BUG — ACTIVATED, recorded NEXT-SESSION-BLOCKING (not fixed here):** landing an AI stage
makes the producedBy cache-coverage bug a money/compute bug — a repo whose synthesis fails omits
`synthesize` from producedBy ⇒ result-cache miss ⇒ full re-analyze on every view. The LLM-output
cache defuses the API-SPEND dimension (re-runs hit the completion cache). The coverage split
(coverage tested against DETERMINISTIC stages only; AI absence ⇒ AI-only retry, not full
re-analyze) MUST be the very next session and precede any real deploy/sustained spend.

**Flagged:** the real Anthropic adapter is integration-only (untested, gated on env key).
Grounding only checks reading-step fileIds (the summary is prose; keyConcepts are plain strings).

## 2026-06-03 — Bounded cleanup (pre-flight before the cache-coverage fix)

Tidies only, committed separately from the fix. Audit-first; almost everything turned out live.

**1) Dead mock-era scaffolding audit (report):**
- `apps/worker/src/processors/analysisProcessor.ts` (415 lines) + its test (207) — PRODUCTION-DEAD
  (the worker runs `runAnalysisJob`; nothing imports `processAnalysisJob` except its own test),
  superseded by Connect (graph) + Analyze (metrics). NOT deleted: >600 lines with a live test
  exceeds "a few lines" → **flagged as its own deletion session** (recorded in CURRENT_STATE ledger).
- `apps/web/src/lib/mockAnalysis.ts` — LIVE (web `appStore` + 8 feature panels render off it; P5
  replaces it). Left as-is.
- Legacy fileId-keyed types `DependencyEdge`/`FileNode`/`SymbolNode`/`EntryPoint` — all LIVE
  (parsers, `@codeflow/graph` build input, Connect/Analyze feed, web normalizer, `AnalysisResult`
  fields). Left as-is. Net: zero deletions, findings recorded.

**2) `tests/codeflow-repo-smoke.mjs` honest-green:** it is a CLI utility (`<repo-dir>...` args,
previously `process.exit(2)` on none), not a unit test — swept up by `node --test tests/*.mjs` and
red on every clean tree. Changed the no-args branch to **skip-with-reason + `exit 0`** (no clone
faked). Legacy root suite now 25/25 pass, 0 fail.

**3) Stray/temp files:** none. No tracked `dist/`/`coverage/`/`*.log`/editor junk, no empty tracked
files; `.gitignore` already covers them.

**4) Hermetic gate:** `pnpm -r typecheck && lint && test` green with NO Mongo/Redis running — no
hidden live-service dependency (in-memory cache handle + mocked LLM throughout). Confirmed hermetic.

## 2026-06-03 — Cache-coverage split (the wallet fix) — NEXT-SESSION-BLOCKING cleared

The orchestrator-only fix that stops AI-only failures from triggering a full re-analyze on every
view. No pipeline/stage changes; no new service; suite stays hermetic. Committed AFTER the bounded
cleanup (two commits).

**Two-tier coverage (decideCacheAction).** producedBy stays an honest sorted list; only the
INTERPRETATION changed. Partition the configured stages by their first-class `kind`:
`detCovered = configured.deterministic ⊆ producedBy`, `aiCovered = configured.ai ⊆ producedBy`.
Decision: det+ai → FULL HIT (return cached, run nothing); det&&!ai → AI-ONLY RETRY (seed from cache,
run only uncovered AI stages); !det → FULL MISS. Empty configured.ai ⇒ aiCovered trivially true ⇒
deterministic-only hit. Replaced the old all-or-nothing `coversRequiredStages`.

**Where it runs.** The cloner resolves the SHA only by cloning, so the decision runs **pre-Ingest**
keyed on `input.requestedCommitSha` (the wallet win: a full hit / AI-retry pays NO clone), with a
**post-Ingest fallback** by the resolved SHA for the branch/unknown-SHA first analysis. One shared
helper used in both places.

**AI-only retry resume.** `seedSlicesFromResult` hydrates the slice accumulator from the cached
result's deterministic (+ covered-AI) slices; the SINGLE run loop skips covered stages (records them
`completed` so the re-stamp is honest) and runs only the uncovered AI stages off `ctx.prior`. No
parallel pipeline. General by design (runs whatever AI is uncovered) — NOT hardcoded to "AI needs no
disk"; `ctx.repoPath` stays unset on a no-clone retry (Synthesize needs none; RAG forward-flagged).

**AI-partial persistence (reverses a P1 line).** Confirmed it already falls out of the status logic:
a deterministic failure ⇒ `"failed"` ⇒ worker does NOT persist (not reusable); an AI failure ⇒
`"partial"` (all deterministic done) ⇒ worker persists with det-only producedBy ⇒ reused as an
AI-retry next view. Reusability keys on DETERMINISTIC completeness; the fix is purely the READ side
(no save-path change). Added a comment + tests.

**Two caches compose.** An AI-only retry with an identical assembled prompt hits the LLM-output cache
(zero API $); a retry after a genuine synthesis failure (no cached completion) makes a real call.
Tested.

**Tests** (in-memory cache handle, LLM mocked) — new `cacheCoverage.test.ts` (8): full hit (no
clone/no stage/no LLM); AI-only retry (only synthesize runs, clone+connect+analyze NOT invoked,
det slices are the cached ones, producedBy re-stamped with synthesize); full miss; det-incomplete
not reusable; no-AI deployment (empty-AI full hit); AI-partial persisted → second view → AI-only
retry; backfill (det-only cache + AI now configured); LLM-cache compose. Updated `ingest.test.ts`
cache-hit test to assert the new no-clone pre-ingest hit. Workspace green: shared-types 3, web 4,
analyzers 95, graph 16, parsers 10, api 17, worker 14.

**Ledger:** cache-coverage CLEARED. Carried: re-export provenance, entry-point manifest source,
clusters algorithm, delete the unwired analysisProcessor.ts (415+207 lines, too big for a fold-in),
real Anthropic adapter is integration-only / end-to-end smoke-run candidate, RAG AI-only-retry needs
file access (forward flag), synthesis prompt-selection sizes for P4 tuning.

## 2026-06-10 — P3: RAG / Q&A index (stage 8) — SECOND AI STAGE

Branch: `codeflow-cleanup`. Index-build ONLY — the ask-the-repo query path (retrieve → answer →
cite) is a deliberately-separate later session. Modeled on Synthesize (`796a423`): nests under
`result.ai.*`, ai-fail ⇒ `"partial"` with deterministic + synthesis slices intact, grounding
enforced by code.

**Contract (realized a placeholder, no second parallel field).** The pre-existing scaffolding
(`index-qa` stage id, `QaIndex`, `aiQaIndex`, `AiAnalysis.qaIndex`) was a placeholder for exactly
this stage. Per the project's one-canonical-representation rule, it was REPLACED (not duplicated):
stage id `index-qa` → `rag`; new `RagChunk` + `Rag` interfaces; slice key `aiQaIndex` → `aiRag`;
`AiAnalysis.qaIndex` → `AiAnalysis.rag`. Updated the orchestrator (`seedSlicesFromResult` /
`buildAi`) and the shared-types contract test accordingly. `Rag = { chunks: RagChunk[], chunkCount,
embeddingModel, embeddingDim, droppedChunks? }`; `RagChunk = { id, fileId, startLine, endLine,
symbolName?, text, embedding: number[], tokenCount }`. Vectors are plain serializable arrays.

**Chunking (deterministic, symbol-aware).** Drives off `inventory.symbols` + `structure` + file
contents (NOT a naive fixed window). Source files: select non-overlapping top-level symbol spans
(`line..endLine`; absent endLine extends to the next symbol/window via a classic interval cover),
sweep uncovered regions (module header / top-level code) into window chunks so nothing is silently
dropped. Docs files: window-chunked. Roles `config`/`build`/`asset`/`test`/`other` skipped. Oversized
spans split into contiguous sub-chunks within the token cap. Role allowlist, `MAX_CHUNK_TOKENS`
(32K — voyage-code-3 documented context), `WINDOW_CHUNK_LINES`, and the ~4-chars/token estimate are
NAMED CONSTANTS flagged for P4 tuning.

**Grounding (code-enforced, never trusted).** Drop chunks whose `fileId ∉ graph.nodes` or whose line
range falls outside the file; record `droppedChunks {count, fileIds}` (omitted when none — absent ≠
empty). NO retry on grounding (chunking is deterministic — contrast Synthesize, whose nondeterministic
LLM justifies a retry). Empty-after-grounding ⇒ `throw` ⇒ ai-fail ⇒ `"partial"`.

**Embedding client (mirrors LlmClient).** Injectable `EmbeddingClient`; `createVoyageClient` is the
fetch-based prod adapter (NO SDK). Confirmed against current Voyage docs (June 2026):
`voyage-code-3`, dim 1024, 32K max input tokens, ≤1000 texts / ≤120K tokens per request,
`POST /v1/embeddings` Bearer-auth → `{ data: [{embedding, index}], usage }`, `input_type:
"document"` on the indexing side. Misses batched under those limits; transient failures retry (≤3)
then throw ⇒ `"partial"`. Tests ALWAYS inject a deterministic mock (stable hash → fixed-length
vector) — zero real API calls.

**Two caches (via `ctx.cache`, namespaced; Mongo `llmcache` in the worker, in-memory in tests).**
(1) Embedding cache — content-addressed `embed/{model}/v1/{sha256(normalizedChunkText)}`, checked
before every embed; an unchanged repo costs ZERO API (asserted: mock not called on a full hit). The
`v1` prefix is a manual bust; model is in the key so switching models re-embeds. (2) Chunk-plan
cache — SHA-keyed `rag/v1/{commitSha}` storing the GROUNDED plan (no vectors), persisted BEFORE
embedding so it survives a mid-embed failure. Resolution order: `repoPath` present → read disk; else
chunk-plan cache → use it (no disk); else throw. This makes a **pinned-SHA AI-only retry invoke no
cloner and no deterministic stage** — the ledger's "design RAG's retry deliberately" requirement.

**Worker wiring.** RAG registers as stage 8 ONLY when `VOYAGE_API_KEY` is set; with no key it does
not register and `configured.ai` omits it (so an ANTHROPIC-only setup runs Synthesize but not RAG
and the P10 two-tier partition stays correct). NO new orchestrator coverage logic — RAG is just
another `kind: "ai"` stage. Reuses the existing `readFile` abstraction (disk path) and the shared
cache handle. `createVoyageClient({ apiKey: VOYAGE_API_KEY, model: VOYAGE_MODEL || "voyage-code-3" })`.

**Tests** (hermetic — mocked embedding client, in-memory cache, no real API/Mongo/Redis). New
`rag.test.ts` (13): symbol-aligned chunking + window fallback + docs window-chunking + skipped roles;
chunk text matches the cited range + carries a vector; oversized-symbol split tiles the range within
the cap; grounding drops a non-node fileId into `droppedChunks`; empty-after-grounding throws;
embedding-cache full hit ⇒ zero API; embedding-API failure ⇒ retry ×3 ⇒ throw; determinism (run
twice ⇒ byte-identical `Rag`); plain-serializable round-trip; no-disk retry (cached plan, repoPath
absent ⇒ no disk) + throw-when-neither; via orchestrator: ai-fail ⇒ `"partial"` with det+synthesis
intact, and no-clone AI-only retry (no clone, no deterministic stage, no disk; `producedBy` re-stamps
with `rag`). Workspace green: shared-types 3, web 4, analyzers 108, graph 16, parsers 10, api 17,
worker 14.

**Ledger:** RAG AI-only-retry forward-flag CLEARED. New carries: result-slice vector size vs Mongo
16MB BSON limit (P4 — externalize vectors); ask-the-repo query path (own session); chunk-size /
role-allowlist / `MAX_CHUNK_TOKENS` / token-estimate tuning (P4); re-export provenance extends to
chunk citations; `createVoyageClient` is integration-only (real-key smoke run pending). Next session
is the **eval set** (its own session — do not fold into RAG).

## 2026-06-10 (b) — P3: Multi-provider AI layer (add Gemini) + cache-key/homogeneity fixes

Branch: `codeflow-cleanup`. Make both AI providers swappable behind the EXISTING injectable
interfaces — no vendor lock-in, no new manual setup (every adapter mocked in tests, zero real
calls). Chunking / grounding / stage logic untouched; the provider is the only thing that varies.

**Gemini adapters (fetch-based, no SDK).** `createGeminiClient` (LlmClient) →
`POST .../v1beta/models/{model}:generateContent`, header `x-goog-api-key`, body
`{ contents:[{parts:[{text}]}], systemInstruction?, generationConfig:{ temperature:0,
responseMimeType:"application/json" } }`, text at `candidates[0].content.parts[].text`; default model
`gemini-2.5-flash` (NOT the shut-down 2.0-flash). `createGeminiEmbeddingClient` (EmbeddingClient) →
`:batchEmbedContents`, body `{ requests:[{ model:"models/{m}", content:{parts:[{text}]}, taskType:
"RETRIEVAL_DOCUMENT", outputDimensionality:{dim} }] }`, vectors at `embeddings[].values`; default
`gemini-embedding-001` @ dim **768** (recommended — ~0.26% quality loss vs 3072, 4× smaller, eases
the BSON-size ledger item), re-chunks under Gemini's per-request cap (100). temp 0 + json mime keeps
the assembled-prompt → output path deterministic (the fence-strip→parse→validate→ground pipeline is
unchanged). Anthropic/Voyage adapters unchanged (Voyage still the better code-retrieval option).

**Provider field (canonical source for cache scoping).** Added `readonly provider` to both client
interfaces (`LlmProvider` = anthropic|gemini, `EmbeddingProvider` = voyage|gemini) and set it in
every adapter + test mock. No translation map — the client IS the source of its provider/model/dim.

**Env selection (`providers.ts`, pure given an env record).** `resolveChatProvider` /
`resolveEmbeddingProvider`: explicit `LLM_PROVIDER` / `EMBEDDING_PROVIDER` wins (validated); else
infer from the single present key; **both keys + no explicit provider ⇒ throw a clear config error**.
`createLlmClientFromEnv` / `createEmbeddingClientFromEnv` build the selected client, or undefined when
the selected provider's key is absent (⇒ that AI stage simply isn't registered). A single
`GEMINI_API_KEY` powers both synthesis and RAG. Worker `index.ts` now calls these with `process.env`
instead of hardcoding Anthropic/Voyage.

**Cache-key fixes (mandatory once providers are swappable).** (1) Synthesis key bumped **v1→v2**:
`synthesis/v2/{provider}/{model}/{commitSha}/{sha256(prompt)}` — previously lacked provider/model, so
switching providers served a completion from the wrong model (poisoning); now a switch misses + re-runs.
(2) Embedding key now `embed/{provider}/{model}/{dim}/v1/{sha256(text)}` — 768-d vs 1024-d (or two
providers') vectors are different spaces and must not collide on the same content hash.

**Index homogeneity (no mixing vector spaces).** New `StageEmbeddingTarget` (shared-types): the RAG
stage exposes `embeddingTarget = { model, dim }` (from its client). In the P10 `decideCacheAction`, a
new `aiStageReusable` helper treats `rag` as covered only if `have.has("rag")` AND cached
`result.ai.rag.embeddingModel`+`embeddingDim` == the selected target; on mismatch ⇒ uncovered ⇒
ai-retry re-embeds. `coveredStageIdSet` uses the same helper, and `seedSlicesFromResult` now gates AI
slices on coverage (computed BEFORE seeding) so a mismatched/uncovered RAG slice is NOT hydrated — a
failed re-embed never returns the stale foreign-space slice. Derived from existing fields — no new
`cacheReusable` flag (one-canonical-field rule). Synthesis needs no analogous check (provider/model is
in its key).

**Tests** (hermetic — stubbed `fetch`, mocked clients, in-memory cache; zero real calls). New
`providers.test.ts` (19): chat + embedding selection matrices (explicit wins / infer single key /
both-set throws / invalid throws / null); `createLlmClientFromEnv`+`createEmbeddingClientFromEnv`
(gemini default model+dim, overrides, selected-but-no-key ⇒ undefined, single GEMINI_API_KEY powers
both); adapter conformance + happy-path (Anthropic/Gemini chat, Voyage/Gemini embeddings — URLs,
headers, body shape, Gemini temp-0+json-mime+systemInstruction determinism, Voyage index reorder,
Gemini >100-text re-chunking). `synthesize.test.ts` +1 (v2 provider-scoped key misses across
providers). `rag.test.ts` +3 (embedding key provider-scoped + dim-scoped; index-homogeneity rebuild
via orchestrator — cached voyage slice under a gemini selection ⇒ RAG re-embeds, no clone, no det
stage, result model/dim are the new selection). Workspace green: shared-types 3, web 4, analyzers
131, graph 16, parsers 10, api 17, worker 14.

**Ledger:** Gemini adapters are integration-only (extends the Anthropic/Voyage real-key smoke-run
item). Next session: **P13 — eval harness** (built against a mock; real scored run deferred to the
consolidated manual phase).

## 2026-06-10 (c) — P3: Eval harness (`@codeflow/eval`) — hermetic; real scored run deferred to P7

Branch: `codeflow-cleanup`. Build the harness that scores the pipeline's AI output against authored
ground truth — proves the AI catches the RIGHT files, not just well-formed JSON. Built + unit-tested
ENTIRELY against a synthetic mock fixture: no keys, no real run, no pipeline execution in the suite.
The real scored run + threshold tuning on a chosen repo is a P7 data task.

**Module location.** New package `packages/eval` (`@codeflow/eval`), depends on
`@codeflow/shared-types` + `@codeflow/analyzers`, NodeNext like the worker. Root `pnpm eval` script →
`@codeflow/eval run eval` → `tsx src/cli.ts`. `pre*` hooks build shared-types/parsers/graph/analyzers
(so tsc paths + vitest runtime resolve the dist of the deps).

**Dataset contract** (`dataset.ts`, plain serializable, `EVAL_SCHEMA_VERSION`). `EvalDataset`
{ evalSchemaVersion, repoUrl, commitSha (pinned), embeddingModel, embeddingDim, synthesis:
{ expectedEntryPoints }, questions: RagEvalQuestion[] }; `RagEvalQuestion` { id, question,
expectedFiles, expectedLines? }. Ships the schema + ONE `TEMPLATE_DATASET` (REPLACE_* placeholders) —
NO fabricated ground truth (unverified guesses are worse than none; the dataset is authored in P7).
`assertDatasetShape` rejects un-authored templates.

**Retrieval primitive** (`retrieve.ts`). `retrieve(chunks, queryVector, k)` — pure cosine top-k over
`Rag.chunks`, deterministic tie-break by chunk `id`, safe for `k > chunkCount` and `k ≤ 0`; zero-norm
vectors score 0 (no NaN). The ONLY new runtime-ish piece. The Q&A answer + citation + API path is
**P18** — deliberately not built.

**Scoring** (`score.ts`, pure deterministic). Synthesis: `readingOrderRecall@k` over (top-k reading
order ∪ top-k keyFiles), citation-resolution rate (steps ∈ graph.nodes), droppedCitations rate
(surfaced, not hidden). RAG: per-question `recall@k` (file match, or line-range overlap when
`expectedLines` authored) + reciprocal rank → mean recall + MRR. Per-question hits/misses reported,
not just aggregates.

**Runner** (`runEval.ts`). `runEval(dataset, analysisResult, embeddingClient) → EvalReport` (plain
serializable: synthesisScores / ragScores|null / perQuestion[] / thresholds {passed, failures[]} /
summary). Questions embedded on the QUERY side (`input_type: "query"`). **Homogeneity guard
(mandatory — same trap as P12):** `assertHomogeneity` throws if the embedding client's model/dim OR
the stored index's `embeddingModel`/`embeddingDim` ≠ the dataset's — cosine across spaces is
meaningless, fail loud rather than silently score garbage. Throws clearly if the graded slice
(synthesis, or rag when questions exist) is absent.

**Thresholds** (`thresholds.ts`) — `EVAL_THRESHOLDS` are NAMED CONSTANTS flagged for **P7 tuning**
(placeholders: readingOrderRecall@5 ≥ 0.6, ragRecall@5 ≥ 0.6, droppedCitations ≤ 0.1 — can't pick
real bars against a mock). The report computes pass/fail, but the eval is **NOT wired into CI
gating**: CI stays hermetic + fast; the gating run needs real keys ⇒ P7.

**CLI** (`cli.ts`). `pnpm eval <dataset.json> <result.json>` loads a dataset + a stored
`AnalysisResult`, builds the embedding client from env (the worker's provider selection), prints the
report, exits non-zero on threshold failure. Needs a real key to embed questions ⇒ a P7 tool, NOT in
the hermetic suite; never runs the real pipeline (it grades a result you already produced).

**Tests** (hermetic — mock embedding client, fixtures only, zero real calls). `retrieve.test.ts` (5):
cosine, top-k order, tie-break by id, k>count / k≤0 / empty safe. `score.test.ts` (8): synthesis
recall (full/partial/k-bounded), citation-resolution + droppedCitations, RAG file hit / rank-2 RR /
miss / expectedLines overlap-vs-disjoint, aggregate mean+MRR. `runEval.test.ts` (10): full fixture
run (synthesis + per-question RAG hits/misses, query-side embed), threshold pass + raised-bar fail,
plain-serializable round-trip, run-twice determinism, synthesis-only (no questions ⇒ ragScores null,
no embed call), homogeneity guard throws on client-dim / client-model / index-space mismatch, and
missing-slice errors. Synthetic 3-d fixture (auth/db/util basis) with authored query vectors → known
nearest neighbours. Workspace green: shared-types 3, web 4, analyzers 131, eval 23, graph 16, parsers
10, api 17, worker 14.

**Ledger:** eval built but NOT scored / NOT in CI gating — P7 authors a real dataset, runs the real
pipeline + `pnpm eval` with real keys, tunes the placeholder thresholds from measured scores; any
gate stays out-of-band (the scored run needs keys + costs money). Next session: **P14 — P4 scale
guardrails** (parsing concurrency, per-file timeouts, repo-size cap — hermetic).

## 2026-06-10 (d) — P4: scale + cost guardrails (all five, hermetic)

Branch: `codeflow-cleanup`. Add CodeFlow's resource + cost guardrails so a pathological repo or
abusive caller can't blow up the pipeline or the owner's wallet. Five orthogonal, additive,
independently-revertible guards in one feature commit; fully hermetic (in-memory stores, mocked
clients, zero real services/spend). The MEASURED large-repo run ("tested to N files in Y sec") is
P7, not this session.

**Named limits → `@codeflow/config`** (all PLACEHOLDERS flagged for P7 tuning): `MAX_FILES` /
`MAX_BYTES`, `PARSE_CONCURRENCY`, `FILE_TIMEOUT_MS`, `RATE_WINDOW_MS` / `RATE_MAX`, `DAILY_LLM_BUDGET`.
analyzers + api now depend on `@codeflow/config` (added to deps + tsconfig paths + pre* build chains).

**Guard 1 — repo-size cap (Ingest).** Authoritative cap POST-CLONE, BEFORE parsing. Ingest gains an
injectable `measureRepoSize(repoPath) → { fileCount, totalBytes }`; over `MAX_FILES`/`MAX_BYTES` ⇒ a
typed `RepoTooLargeError` ⇒ orchestrator `"failed"` + `pipeline.statusReason = "repo-too-large"`,
dependents skipped (clean refusal, not a crash). Worker wires a real fs walk (`measureRepoSize.ts`,
skips `.git`/symlinks; integration-only); omitting the dep skips the cap (back-compat).

**Guard 2 — parsing concurrency (Inventory).** Per-file read+parse runs through a bounded
`createLimiter(PARSE_CONCURRENCY)` (tiny p-limit equivalent, no dep). Each file returns a RESULT
object (no shared-state mutation); results applied in `structure.files` order after all settle ⇒
deterministic regardless of completion order. Asserted: in-flight never exceeds the limit.

**Guard 3 — per-file parse timeout (Inventory).** Each file's read+parse wrapped in
`withTimeout(FILE_TIMEOUT_MS)`; a timeout ⇒ recorded in `inventory.unparsedFiles`, run continues. A
late-finishing timed-out parse can't corrupt results (result discarded). Bounds ASYNC stalls;
CPU-bound sync hangs need worker-thread isolation (P7 ledger).

**Guard 4 — per-IP rate limit (API).** `createRateLimitMiddleware` on `POST /api/analyze` only;
per-IP fixed window (`RATE_WINDOW_MS`/`RATE_MAX`) ⇒ **429 `RATE_LIMITED`** + `Retry-After`. Injectable
`RateLimitStore` (in-memory default + tested; Redis-backed shared store is the prod swap — ledger).
`createApp({ rateLimit })` lets tests inject a tiny limit + fresh store. New `RATE_LIMITED` error code.

**Guard 5 — global daily LLM spend ceiling (the wallet guard).** New `BudgetHandle` (mirrors
`AnalysisCacheHandle`): `check(estimatedTokens) → ok`, `record(actualTokens)`, reset per UTC day
(keyed on date). Threaded via `ctx.budget`; checked at the provider-call boundary for BOTH AI stages.
**CACHE BEFORE BUDGET (load-bearing):** the Synthesize completion cache + the RAG embedding cache are
checked FIRST — a hit spends nothing and never touches the budget; only on a MISS do we check → call →
record. Estimate before (chars/4 chat; summed chunk tokenCount embeddings), record after. Per the
session fork decision, `record` uses the deterministic ESTIMATE for now — wiring the provider's real
`usage.total_tokens` (widening `LlmClient.complete`/`EmbeddingClient.embed` to return usage; touches
all 4 adapters + mocks) is the P7 refinement (ledger). Over ceiling ⇒ `BudgetExceededError` ⇒ graceful
`"partial"` (deterministic + other AI slices intact) + `statusReason = "budget-exhausted"` (distinct
from a plain ai-fail), no provider call. In-memory handle (default/tests) + Mongo-backed
`createMongoBudgetHandle` (one doc per UTC day) wired in the worker. SEPARATE from Guard 4.

**statusReason plumbing.** `PipelineRunSummary.statusReason?: PipelineStatusReason`
(`"repo-too-large" | "budget-exhausted"`), set by the orchestrator from a thrown `PipelineReasonError`
(`statusReasonOf`); worker surfaces it onto the job (`runStatusReason`, added to `JobProgress`,
`WorkerJobPatch`, and the Mongo job schema). Machine-readable cause vs the human `warnings[]`.

**Tests** (hermetic — in-memory stores, mocked clients, zero real calls/spend). New
`analyzers/guards.test.ts` (9): size cap over files/bytes ⇒ failed + repo-too-large + dependents
skipped, within-cap ok; concurrency never exceeds the limit; slow file ⇒ unparsed + run completes;
limiter + withTimeout primitives; budget check/record + UTC-day reset. `synthesize.test.ts` +3 (cache
hit spends 0; miss checks+records; over-ceiling ⇒ partial + budget-exhausted via orchestrator).
`rag.test.ts` +3 (full embedding-cache hit spends 0; miss checks+records; over-ceiling ⇒ throws
without embedding). `api/app.test.ts` +1 (3rd request from one IP ⇒ 429 RATE_LIMITED + Retry-After).
Workspace green: shared-types 3, web 4, analyzers 146, eval 23, graph 16, parsers 10, api 18, worker 14.

**Ledger:** P4 real values + the measured large-repo run + Guard 5 real-usage wiring + Guard 4 Redis
store + Guard 3 worker-thread isolation + the integration-only fs/Mongo helpers are all P7. Next
session: **P5 — live pipeline panel + SSE replay + the #19 SSE/runStatus leftovers** (frontend,
against mock data).

## 2026-06-10 (e) — P5: live pipeline panel + SSE replay (#20) + REST terminal state (#19)

Branch: `codeflow-cleanup`. The live, replayable pipeline stream — the USP centerpiece — built
against MOCK data: SSE replay buffer + stores injectable, in-memory in tests, no Redis/Mongo/live
services in the suite (real-wire smoke is P7). Not the dashboard (P16); not Ask-the-repo (later).

**Part A — wire correctness.**
- **SSE replay (#20).** New `EventLogStore` contract (shared-types): append-only per-job log of
  ProgressMessages. The worker appends every emitted message (each per-stage ProgressEvent + the
  terminal done) via `pipelineJobProcessor`. `streamProgress` now REPLAYS the buffered log in order,
  then TAILS live: it subscribes FIRST (queuing live messages so nothing emitted during the read is
  lost), replays the log, drains the queue, then continues live — deduping the replay/live boundary
  on the monotonic `stageIndex` (one authoritative event per stage, P1 contract) + the terminal
  `done`. A late connection sees every stage exactly once, from Ingest. With no `EventLogStore` it
  falls back to the original live-only stream (back-compat). In-memory store (`createInMemoryEventLogStore`,
  test default + single-process fallback) + Mongo-backed (`jobevents`, seq-ordered) for prod — the
  worker writes, the API reads the same collection. `getEventLogStore()` + `setEventLogStoreForTests()`.
- **REST terminal state (#19).** `GET /api/job/:id` returns `runStatus` + `runStatusReason` (the P14
  fields): added to the API JobModel schema, `AnalysisJobRecord`, `CreateAnalysisJobInput`,
  `updateAnalysisJob` patch, and `getAnalysisJobProgress`. SSE is for live watching; REST answers
  "what happened" on a reconnect after completion.

**Part B — web consumption + the panel.**
- **`streamJobEvents` (#19)** rewritten to parse the REAL `ProgressEvent` shape per stage
  (`onStageEvent`) + the terminal `{ jobId, status }` frame (`onDone`), replacing the stale
  `ApiJobProgress` shape. `ApiJobProgress` gained `runStatus`/`runStatusReason`.
- **Normalizer (#19)** derives from `graph` + `inventory` (the empty `dependencies`/`symbols`/
  `entryPoints` projections are intentionally ignored): per-file imports from `graph.edges`,
  functions/exports from `inventory.symbols`, entry points from `inventory.entryPoints`, languages
  from node languages.
- **`mockAnalysis.ts` replaced** with current shapes: `mockAnalysisResult()` (faithful AnalysisResult
  with graph/inventory/metrics/ai.synthesis; a PARTIAL run with `pipeline.statusReason="budget-exhausted"`),
  `mockProgressEvents()` (8-stage sequence), `mockPipelineState()` (derived, partial+reason).
- **Live pipeline panel** (`PipelinePanel.tsx`, the centerpiece — NOT a default stepper): a
  horizontal "reactor rail" of the 8 stages (CSS connector `--fill` advances as stages settle; the
  running node pulses + spins) above a chain-of-thought FEED that appends one entry per reported
  stage. Each entry renders `detail` + a GENERIC preview slot (`Object.entries(preview)` → chips,
  no per-stage hardcoding). Honest terminal banner keyed on `runStatusReason` ("Demo at capacity",
  "Repository too large", "Partial analysis", …). Status via SVG glyph + word (not color alone);
  `prefers-reduced-motion` disables motion. Replaced `AnalysisProgress` (deleted). Pipeline state +
  reducer in `lib/pipeline.ts` (seed-8-pending / upsert-by-stageIndex / terminal); wired through the
  store; `PublicRepoInput` drives it via SSE with a polling fallback (jsdom has no EventSource).

**Tests** (hermetic — in-memory stores + mock channel + stubbed fetch/EventSource, mock data, no
live services). API +3: SSE replay (late connect replays 1–5 then tails 6–8+done, dedupes a
duplicate stage 5, no gaps); finished-run replay (full log + terminal, no live); `GET /api/job/:id`
returns runStatus+runStatusReason. Web +9: pipeline reducer (seed/upsert-dedupe/terminal); normalizer
(imports from edges, functions/exports from inventory, graph counts); `streamJobEvents` (fake
EventSource parses ProgressEvent + done; null without EventSource); PipelinePanel (8 stages from
Ingest, generic preview incl. an arbitrary key, partial+budget-exhausted banner, failed stage shown).
Removed the AnalysisProgress test. Workspace green: shared-types 3, web 13, analyzers 146, eval 23,
graph 16, parsers 10, api 21, worker 14.

**Ledger:** #19 + #20 CLOSED. Remaining P7: the real Redis/BullMQ + Mongo `jobevents` SSE-wire smoke
(cross-process worker-write / API-read) — only the in-memory path is hermetically tested; the
Mongo `EventLogStore` is integration-only. Next session: **P16 — dashboard** (Start Here / Structure
map / 2D dependency graph / file drill-down — frontend, against mock).

## 2026-06-10 (f) — P5: dashboard — Start Here / Structure / Drill-down (frontend, against mock)

Branch: `codeflow-cleanup`. The three data-READ dashboard views + the tabbed shell that holds them
and the P15 pipeline panel. Built against MOCK data, hermetic, no live services. NOT the 2D graph
(P17 — placeholder slot) and NOT Ask-the-repo (later). Visually consistent with the P15 panel (same
dark/green language, `.card`/`.badge`/chips, glyphs-not-emoji).

**Read model.** `lib/dashboard.ts` `buildDashboard(result) → DashboardModel`, derived ONCE per the
P15 rules: imports/importers from `graph.edges` (grounded — every neighbour resolves to a real
node), symbols from `inventory.symbols`, entry points from `inventory.entryPoints`, metrics from
`metrics.perFile`, roles from `structure.files`. The views READ this; they never re-derive. The
model keeps FULL lists — render caps are render-only.

**Store.** Holds `dashboard: DashboardModel | null` (built in `loadAnalysisResult` +
`loadMockAnalysis`); selected-file context via the existing `selectedFileId`/`selectFile`.

**View 1 — Start Here** (`StartHere.tsx`): renders `ai.synthesis` (summary + ranked reading path +
key concepts) when present; on a partial / `budget-exhausted` run (synthesis absent) degrades
HONESTLY to `metrics.keyFiles` as the reading path + an "AI summary unavailable — demo at capacity"
note — never a blank panel. Reading steps open the file in drill-down.

**View 2 — Structure map** (`StructureMap.tsx`): `structure.layout` badge + file-role counts + the
file list sorted by path with directory headers, **capped to 20 rows with "Show all (N)"** (the
underlying model list is never truncated). Files open drill-down.

**View 3 — File drill-down** (`FileDrilldown.tsx`): per-file `centrality`/`fanIn`/`fanOut`/
`blastRadius` + LOC/symbolCount; **`complexity` as a RELATIVE rank + bar** ("rank #k of N") with an
explicit "structural proxy (loc + symbols + fan-in/out) — not cyclomatic" note (never a bare
absolute — the raw score is not surfaced); symbols list; imports + importers as grounded, clickable
neighbours → drill-down.

**Shell + wiring.** `DashboardShell.tsx` — repo header + `Tabs` (Start here / Structure / Graph
placeholder / Drill-down) + the selected-file context; opening a file from any view switches to
Drill-down. The 2D graph is a placeholder slot (P17). `AppShell` now renders `<DashboardShell/>` when
analysis is loaded (replacing the legacy `dashboard-layout`); `mockAnalysis.ts` gained a `structure`
slice + `mockBigResult(n)` (render-cap fixture). The legacy P5-era mock panels are no longer rendered
(superseded — ledger #15).

**Tests** (hermetic — mock data, no live services). Web +13: `dashboard.test.ts` (buildDashboard —
imports/importers from edges, symbols, complexity rank/relative, structure layout/roles/dirs,
synthesis Start Here, partial fallback note + key-files path, grounded neighbours);
`DashboardShell.test.tsx` (opens on Start Here; reading step → drill-down; structure file →
drill-down; neighbour → drill-down; complexity shown as relative rank + proxy note, NOT a raw
absolute; partial fallback note; render-cap shows 20 then 30 via "Show all", model list intact at
30). Updated `App.test` (new shell heading + dashboard assertions). Workspace green: web 26,
analyzers 146, api 21, eval 23, graph 16, parsers 10, worker 14, shared-types 3.

**Ledger:** added #15 — the legacy P5-era mock panels are dead code (delete in a focused cleanup).
Next session: **P17 — 2D force-directed dependency graph** (the interactive viz, its own session —
frontend, against mock).

## 2026-06-10 (g) — P5: 2D force-directed dependency graph (interactive viz, against mock)

Branch: `codeflow-cleanup`. Turned the P16 Graph placeholder into the interactive 2D dependency
graph. Reads the normalized graph model — NO new analysis. Against MOCK data, hermetic, no live
services. Integrates with the dashboard selected-file context. Consistent with the P15/P16 design.

**Approach.** Canvas + force sim (SVG doesn't scale past ~1–2k nodes). Added `react-force-graph-2d`
(canvas force-graph, bundled types). The graph is an ENHANCEMENT, not the only path — the same data
is reachable via Structure + Drill-down (canvas isn't screen-readable; noted in the UI legend +
CURRENT_STATE).

**Grounded read-model.** `lib/graphModel.ts` `buildGraphModel(result) → GraphModel`: nodes from
`graph.nodes` (REAL files only — externals tallied-not-nodes per Connect, never invented); per node
`role`/`centrality`/`loc`/`inCycle` (from `metrics.cycles`)/size hint; links from `graph.edges` with
**both endpoints grounded** (dangling dropped — reused guard); `kind` + edge-in-cycle flag.
Unresolved + external imports surfaced as honest COUNTS, not faked edges. The model is the FULL
graph; never truncated.

**Render-cap + focus (pure, `lib/graphView.ts`).** `backboneView(model, N)` = top-N by centrality +
induced edges + honest "N of M"; `focusView(model, id, k)` = k-hop undirected neighbourhood + induced
edges; `fullView` = "Show all". The caps (`GRAPH_BACKBONE_NODES`=80, `GRAPH_FOCUS_HOPS`=1,
`GRAPH_PERF_WARN_NODES`=600) are `@codeflow/config` constants, P7-tunable.

**Component (`features/graph/DependencyGraph.tsx`).** Renders `react-force-graph-2d` over the
selected view: node size by centrality, color by role, cycle nodes/edges highlighted, directed-arrow
links. Node click → focus its k-hop neighbourhood AND `onSelectNode(id)` (sets the dashboard
selected-file; stays on the graph). "Show all" raises the cap (perf warning past the threshold) —
never drops model data; "Open in drill-down" / "Clear focus" controls; legend + "N of M" +
unresolved/external counts. `prefers-reduced-motion` → warmupTicks + cooldownTicks 0 (settle fast,
no endless animation); jsdom-safe (matchMedia / ResizeObserver guarded). Empty/degenerate graph →
graceful empty state, no crash. Wired into the DashboardShell Graph tab; the store holds
`graph: GraphModel` built alongside `dashboard`.

**Tests** (hermetic — canvas doesn't render in jsdom, so test data + handlers, NOT pixels; mock
`react-force-graph-2d`). Web +15: `graphModel.test.ts` (grounded nodes/links, dangling dropped,
externals-not-nodes, cycle flags, honest unresolved/external counts); `graphView.test.ts`
(top-N backbone + induced edges + N-of-M, k-hop focus 1/2-hop + unknown-id, full, empty);
`DependencyGraph.test.tsx` (backbone data + "N of M" passed to the mocked force-graph, node-click →
onSelectNode, "Show all" raises cap without dropping the 100-node model, focus k-hop, degenerate →
empty state, no force-graph). Workspace green per-package: web 41, analyzers 146, api 21, eval 23,
worker 14, parsers 10, graph 16, shared-types 3. (`pnpm -r test` parallel can OOM with the heavier
web env back-to-back — run serially or per-package; all pass in isolation.)

**Ledger:** #15 dead-panel cleanup stays a SEPARATE commit (not folded in). Next session: **P18 — RAG
query path** (retrieve → answer → cite endpoint + Ask-the-repo UI — the deferred Q&A feature, against
mock).

## 2026-06-10 (h) — P5: RAG query path (retrieve → answer → cite) + Ask-the-repo UI

Branch: `codeflow-cleanup`. The ask-the-repo runtime feature deferred out of P11 — a RUNTIME path,
not a pipeline stage. Grounded answers from the already-built index, cited to real file+line. Against
mock, hermetic, zero real calls/spend. Two commits: core+endpoint, then UI.

**Retrieval hoist (one canonical primitive).** Moved `retrieve` + `cosineSimilarity` from
`@codeflow/eval` into `@codeflow/analyzers` `rag/retrieve.ts`; eval re-exports + uses it (deleted its
copy; moved its test to analyzers). Production + eval now share ONE retrieval, so the eval's recall@k
measures production behaviour. The embedding-space homogeneity guard is likewise one shared helper
(`rag/homogeneity.ts` `assertEmbeddingSpace`) used by eval + the query path.

**`input_type`-scoped embed cache key.** New shared `rag/embedCache.ts` `embedCacheKey(provider,
model, dim, inputType, text)` = `embed/{provider}/{model}/{dim}/{inputType}/v1/{sha256(text)}` — a
query and a document with identical text no longer collide. The RAG stage (document side) was
refactored onto it (its local key/normalize/sha256 removed); the query path uses the "query" segment.
Document-side keys change ⇒ a one-time re-embed on the next real run (indexes are rebuilt for real in
P7).

**`answerQuestion`** (`rag/answer.ts`, pure, injected clients): embed the question (query side, via
the embed cache) → `retrieve` top-k → **honest no-answer gate** (empty or top cosine <
`RAG_MIN_SIMILARITY` ⇒ `answered:false`, NO answer-LLM call — never fabricates) → bounded prompt of
ONLY the retrieved chunks → temp-0 LLM → **ground citations by code** (drop cited chunkIds not in the
retrieved set, keep grounded ones as `{fileId,startLine,endLine}`, record `droppedCitations`).
Caching: qa answer cache `qa/v1/{provider}/{model}/{commitSha}/{sha256(question+retrievedChunkIds)}`
(cache-before-budget: a hit costs zero LLM + no budget); both the query embed and the answer call go
through the daily budget. `RAG_TOP_K` + `RAG_MIN_SIMILARITY` are P7-tunable `@codeflow/config`
constants.

**Endpoint** `POST /api/result/:id/ask` (`routes/ask.ts`): loads the result + `ai.rag`, calls an
injectable `AskHandler` (`setAskHandlerForTests`; production builds clients from env + an in-process
cache/budget, integration-only). Per-IP rate-limited (shares the analyze store). Honest surfacing:
no index ⇒ 200 `{unavailable}` (not 500), budget ⇒ 200 `{atCapacity}`, over rate ⇒ 429, unknown job
⇒ 404, empty question ⇒ 400. Non-streamed JSON.

**Ask-the-repo UI** (`AskRepo.tsx`, the 5th dashboard tab): question → `askRepo(jobId, question)` →
grounded answer + a Sources list of clickable citations → drill-down (reuses the selected-file
context). Renders no-answer / no-index / at-capacity / 429 honestly; disabled on the mock-data path
(no jobId).

**Tests** (hermetic — mock chat+embedding clients, in-memory cache/budget, mock endpoint; zero real
calls). analyzers +14: retrieve (hoisted) + answerQuestion (prompt isolation/no-leakage, grounding
drop+record, no-answer below floor / empty index / LLM-refusal with NO LLM call, homogeneity throw,
cache-before-budget hit=zero-LLM+no-budget / miss=check→record / over-budget throw, embed-key
query≠document). api +5 (grounded answer, 'Q&A unavailable' not 500, at-capacity, 400/404, 429). web
+6 (AskRepo: answer+clickable citations→drill-down, no-answer, at-capacity, 429, unavailable,
mock-path disabled). Eval still green (18) on the hoisted retrieve. Per-package: analyzers 160,
eval 18, api 26, web 47, worker 14, graph 16, parsers 10, shared-types 3.

**Ledger:** #9 (query path) CLOSED. Deferred: answer streaming (token-by-token); the query-path
answer cache + budget are per-API-process in-memory (share the worker's Mongo/Redis handles in P7);
production `AskHandler` is integration-only. Next session: **P19 — Dockerfiles + CI** (CI on mocks,
no secrets).

## 2026-06-10 (i) — P6: ship-prep — service Dockerfiles + GitHub Actions CI (no secrets, no infra)

Branch: `codeflow-cleanup`. Make CodeFlow shippable: three service Dockerfiles + a CI that runs the
HERMETIC suite on every push/PR — no secrets, no live services, no deploy (that's P7). Two commits:
Dockerfiles, then CI.

**Dockerfiles (Part A).** pnpm-workspace-aware multi-stage, build context = repo root.
- api + worker: build stage `pnpm install --frozen-lockfile` + `pnpm -r build`, then
  `pnpm --filter=<app> deploy --prod /prod` (self-contained, prod-pruned folder with the internal
  `@codeflow/*` deps copied in — the pnpm-native resolution). Runtime `node:20-slim`, non-root user,
  built output only. API `EXPOSE 4000` + `/health` `HEALTHCHECK`; worker no port + `git` installed
  (it `spawn("git")` to clone). Env injected at RUN, never baked.
- web: vite build → `nginx:1.27-alpine` (SPA fallback). RUNTIME API URL — an entrypoint
  (`apps/web/docker/40-codeflow-config.sh`, an nginx `/docker-entrypoint.d/` hook) rewrites
  `/config.js` from `$API_BASE_URL` on start, so ONE image works across environments. `apiClient`
  reads `window.__CODEFLOW_CONFIG__.apiBaseUrl` (→ VITE → localhost fallback); a default
  `public/config.js` ships in the build (dev/jsdom fall back; hermetic suite unchanged).
- `.dockerignore`, `.env.example` (names only — current runtime contract), `.gitignore`
  `!.env.example`, `.gitattributes` (LF on `*.sh`/`Dockerfile`/`nginx.conf`).

**CI (Part B).** `.github/workflows/ci.yml`, push + PR. `gate` job: pin pnpm 9.15.4 + Node 20
(store cached) → install → `pnpm -r typecheck` → `pnpm -r lint` → **`pnpm test` (serial,
`-r --workspace-concurrency=1`** — NOT the parallel `pnpm -r test`, per the documented OOM note) →
`pnpm -r build` → `node --test tests/*.mjs`. Optional `docker-build` job builds all three images
(no push, no secrets). Hard rule: no secrets, no Mongo/Redis service containers. Real scored eval +
cross-process SSE/BullMQ wire smoke stay out of CI (P7).

**Verification.** Every CI GATE command run locally + green: typecheck/lint clean, `pnpm test`
(serial) green — shared-types 3, web 47, graph 16, parsers 10, analyzers 160, api 26, worker 14,
eval 18; `pnpm -r build` green (incl. the web vite bundle + `dist/config.js`); legacy `node --test
tests/*.mjs` 25/25. The only app-code touch was `apiClient`'s runtime-config read (suite unchanged).
Honest boundary: the in-session Docker daemon was NOT running, so the IMAGE builds are proven by the
CI `docker-build` job / P7, not this session (the entrypoint `.sh` was `sh -n` syntax-checked + is
stored LF).

**Before P7 (still pending, deliberately NOT folded into P19):** the dead-code cleanup — ledger #4
(delete unwired `analysisProcessor.ts` + test) and #15 (dead P5-era mock panels) — and the
still-uncommitted `PLAN.md` edit. Clean tree + presentable repo for the P7 README pass.

Next: **P7 — Go-live** (keys, local Mongo/Redis, real scored eval + threshold tuning, first big-repo
end-to-end run + measured limits, BullMQ/SSE wire smoke, deploy with managed Redis + Mongo Atlas,
live link, README).

## 2026-08-30 — V3-P1: tree-sitter CPG + community detection (branch `v3/p1-treesitter-cpg`)

Replaces regex/line-scanning parsing with a tree-sitter **code property graph** and adds deterministic
**community detection** — the accuracy foundation and the parallelization unit later phases build on.
Branch cut off `phase1-rebuild` (see the ENTRY GATE note below). Four commits: the plan docs, then one
per task.

**ENTRY GATE WAS NOT SATISFIED — flagged, not silently worked around.** V3 Phase 0 is *not* green.
Verified before starting: `packages/eval/datasets/` is EMPTY (no golden set — §0.4), `packages/arena`
does not exist (§0.5), `analyzers/src/util/tokens.ts` does not exist (§0.1), and neither PHASE_LOG nor
CURRENT_STATE has any V3 entry. The three Aug-28 commits on `phase1-rebuild` cover *parts* of §0.2/§0.3
(summary producer, surfacing unconfigured AI stages, dropping `mock-v1`) but §0.1/§0.4/§0.5 were never
done. Consequence for THIS phase: the golden set Phase 1 was supposed to measure "parity-or-better"
against **does not exist**, so the retrieval-metric comparison could not be run. Rather than block a
phase whose actual work is independent of it, Phase 1 shipped in full and the acceptance measurement
was replaced with a *stronger-for-this-purpose*, hermetic substitute (see "Measured parity" below).
The scored-eval baseline comparison remains OWED and is carried as ledger #17.

**Task 1 — tree-sitter in `@codeflow/parsers`.** New `src/treesitter/`: `runtime.ts` (wasm loading),
`ast.ts` (node helpers), `jsLike.ts` + `python.ts` (extractors), `parseTreeSitter.ts` (the sync
`ParsedFile` producer + the adapter wrapper).

*Dep choice — `web-tree-sitter@0.26.13` + `@vscode/tree-sitter-wasm@0.3.1`, and WHY.* Two candidates
were probed, not assumed. (a) `tree-sitter-wasms@0.1.13` — installed first, **rejected**: its grammars
are built with `tree-sitter-cli ^0.20.8` (ABI 14 under the old emscripten link format) and every one
of them fails to load under web-tree-sitter 0.26 (empty-message dlopen failure; probed directly).
(b) The official grammar packages (`tree-sitter-javascript@0.25`, `tree-sitter-typescript@0.23.2`,
`tree-sitter-python@0.25`) *do* each ship a prebuilt `.wasm`, but all three carry
`"install": "node-gyp-build"` + `node-addon-api` — i.e. a **native compile in `node:20-slim`**, which
is exactly what had to be avoided. **Chosen:** `@vscode/tree-sitter-wasm` — no install script, no
gypfile, pure wasm assets, ships exactly the four grammars needed (javascript / typescript / tsx /
python), built with `tree-sitter-cli ^0.25.10`. Probed: all four load, ABI 14–15, zero parse errors.
`.jsx` maps onto the JavaScript grammar (tree-sitter-javascript parses JSX natively — there is no
separate jsx grammar to ship). The same wasm runs in a browser because the locator is injectable
(`initTreeSitter({ locateWasm })`), and `node:module` is imported *lazily* inside the default Node
locator so the module stays importable in a browser bundle — the local-first groundwork, at no cost now.

*`ParserAdapter` is unchanged, deliberately.* `parseFile` stays **synchronous**; only grammar loading
is async, via an idempotent `initTreeSitter()` that concurrent/repeat callers share. Inventory and
Connect each `await registry.ready()` before their fan-out. Nothing about the Inventory/Connect input
or output shape moved.

*Coverage never regresses.* Three independent fallbacks to the regex engine: no grammar for the
language, a grammar that failed to load, or a file over `TREE_SITTER_MAX_BYTES` (new
`@codeflow/config` guard, 2 MB). The size guard is a **byte ceiling, never a clock** — a time-based
bail-out would make the deterministic spine non-deterministic (the same file could parse on one run
and fall back on the next). `ParsedFile.parserVersion` now reports which engine ran
(`treesitter-v1` / `parser-v1`), so a silent fallback is always visible in the output.

*Measured parity — the substitute acceptance gate.* New hermetic harness in `@codeflow/eval`
(`src/parity/`): 6 **authored** ground-truth cases (JS CommonJS service, JSX dashboard, TS domain
model, TSX form, Python service, Flask app), each carrying a human list of what the file really
declares and imports. Both engines are scored against it. Micro-averaged over the corpus:

| dimension | regex (baseline) | tree-sitter |
|---|---|---|
| symbols  | P 88.9%  R 59.3% | **P 100%  R 100%** |
| imports  | P 94.7%  R 90.0% | **P 100%  R 100%** |

Every regex gap was confirmed by hand rather than assumed: multi-line `import { … } from`,
`export default function Dashboard`, `export const X: React.FC<Props> = () => …`,
`async def place(self, o: Order) -> M:` (the `) -> M:` return annotation breaks its `)\s*:` anchor),
class methods (regex produced **none** for JS/TS), enums, top-level consts — plus two *false
positives* it fabricated into graph edges: a commented-out `import('./x')` and a commented-out
`require('./y')`. Judgment call flagged: the harness's `coreSymbols` dimension is a **recall floor
only**. Its truth set is deliberately partial (just the constructs the regex parser targeted), so an
engine that correctly finds a class method scores it as "spurious" — precision and F1 there are
meaningless and are explicitly NOT gated (`PARITY_GATES`, documented in code + asserted by a test).
The first run flagged a `coreSymbols.precision` "regression" for exactly this reason; the gate was
made principled rather than the number massaged.

*Deliberate improvements that change output (accepted, documented).* Symbols now carry a real
`lineEnd` (the RAG stage already handles `endLine` when present, so chunk spans get tighter);
class/`method_signature` members are emitted as `method`; top-level plain `const`/`let` become
`variable` symbols. These raise `inventory.symbolCount`, which feeds the declared `complexity` proxy —
hence the cache bump below. TS interfaces/types/enums keep the existing `kind: "unknown"` + signature
protocol so Inventory's `inferKindFromSignature` is untouched.

`ANALYZER_VERSION` **1.0.0 → 1.1.0** — deterministic output changed, so previously-cached analyses are
wrong and must miss.

**Task 2 — the code property graph in Connect.** Connect now takes ONE tree-sitter pass per source
file (`extractCpgFacts`, new in `@codeflow/parsers`) instead of `registry.parseFile` plus its own
re-export regex, and produces three new things on the Connect-owned `graph` slice:
`cpgEdges` (call / extends / implements), `routes` (Express / Flask / FastAPI), and `cpg`
(provenance: `treeSitterFiles` / `fallbackFiles` / `enriched`).

*The load-bearing design decision: `cpgEdges` is a SEPARATE list, not more entries in `edges`.*
`metrics.perFile.fanIn`/`fanOut` are contractually "files that directly import this one". Folding call
edges into `graph.edges` would silently redefine every existing metric and every UI reading them —
so `edges` keeps its exact old meaning and semantics, and anything that wants the richer graph opts in
through the new `buildCodePropertyGraph`. `buildImportGraph` is the dependency-only view Analyze keeps
using. `fileId === repo-relative POSIX path` throughout; both new lists are uncapped and
deterministically sorted.

*Honest limits, written into the types rather than glossed.* (1) Call/inheritance targets resolve
through the file's OWN imports, so a `cpgEdge` always *refines* a relationship the import graph already
has — it never invents a dependency between two files with no import between them. What it adds is
**strength and kind**, which is precisely what community detection consumes. Compiler-exact
cross-file references need an indexer (see Task 4). (2) Edges are aggregated per
`(from, to, kind, symbol)` with an occurrence `count` + first line, NOT stored one-per-call-site: the
list stays COMPLETE (bounded by distinct symbols, never sampled) instead of putting tens of thousands
of near-identical edges in a cached document. (3) Routes are recorded only when the path is a string
literal starting with `/`, and labelled `express` only when the receiver is route-shaped — so
`cache.get('/tmp/x')` is recorded as `unknown`, never claimed as an HTTP route. (4) A file whose
language has no grammar still gets its imports via the regex fallback; only the enrichment is lost,
and `graph.cpg` counts it as un-enriched rather than letting it look genuinely call-free.

*Contract changes.* `GraphEdgeType` and `DependencyEdge.dependencyType` gain
`call` / `extends` / `implements`; `GraphEdge` gains optional `weight` (1 for a dependency edge, the
call count for a CPG edge) so weighted modularity has something to read; `RepoGraph` gains optional
`cpgEdges` / `routes` / `cpg`; new `CpgEdge`, `HttpRoute`, `HttpRouteMethod`, `CpgProvenance`. All
additive — `apps/web` reads `RepoDependencyEdge` and needed no change (0 web test changes).

**Task 3 — community detection (resolves ledger #3).** `@codeflow/graph/communities.ts` implements
**Louvain** (local moving + aggregation, weighted, undirected projection) and Analyze surfaces the
partition on the one canonical field **`metrics.clusters`** (`RepoClusters`: algorithm, seed,
resolution, modularity, count, per-node assignments, per-cluster files/size/internal+external weight).
Absent — not a faked empty partition — for a node-less graph.

*Determinism, which is the whole difficulty.* Classic Louvain shuffles the node visit order with a real
RNG; that would make the partition differ run to run and poison the SHA-keyed cache exactly the way
non-deterministic ordering would. So there is **no randomness at all**: the visit order is a *seeded*
xorshift32 Fisher–Yates over the **sorted** node ids (default seed 1); gain ties break to the lowest
community index, never to hash-map iteration order; communities are relabelled **canonically** (size
descending, then lowest member fileId) so ids do not depend on any internal ordering; cluster weights
are rounded at 1e-10 to shed float dust. Verified byte-identical on a re-run **and** against reversed
node/edge input order and a rebuilt graph with different insertion order.

*Which graph it partitions, and why that differs from the degree metrics.* Clustering runs on the CPG
**union** (imports + weighted call/inheritance), because coupling for the purpose of clustering
genuinely includes calls and "A calls 40 symbols in B" should outweigh "A imports a type from B". The
degree metrics stay import-only. That asymmetry is deliberate, documented on both types, and directly
tested (a file importing two clusters equally is placed by its call weight, while its `fanIn`/`fanOut`
stay 0). Modularity is reported as **standard, unscaled** Newman–Girvan Q — not resolution-scaled — so
the number stays comparable across runs with different resolution settings.

`buildCodePropertyGraph` was proven to keep **every** existing algorithm working: centrality, cycles,
isolation, coupling, blast radius, traversal and serialization all run on the richer graph, and
`TraversalOptions.includeTypes` can still restrict traversal to dependency edges only.

**Task 4 — SCIP: deliberately NOT built (optional, non-blocking by the phase spec).** Assessed and
declined rather than half-shipped. `scip-typescript` / `scip-python` require a real compile of the
*target* repo, which for a hosted analyzer of arbitrary public repos means installing an untrusted
repo's dependencies (a security and wall-clock problem, not just an engineering one); consuming the
output needs a protobuf decoder (a new heavy dep); and none of it can be tested hermetically without
large binary fixtures. Shipping a flag plus an unimplemented interface would be dead code, which this
repo tracks as ledger debt (see #4, #15) rather than pretends is progress. Tree-sitter heuristics
remain the default and the only implementation. Carried as ledger #18 with the reasoning.

**Docker — actually proven this time.** The P6 entry noted image builds were unproven in-session
because the daemon was down. It was up this session, so: all three images build, and the wasm question
was verified end-to-end rather than reasoned about. `pnpm deploy --prod` does not place
`@vscode/tree-sitter-wasm` at top-level `node_modules` (it lands in the `.pnpm` store, reached by
symlink) — so the check that matters was run *inside* the pruned `node:20-slim` runtime image:
all five languages load (`READY: true`, `LOADED: javascript,jsx,typescript,tsx,python`, `FAILED: []`),
`parserVersion` is `treesitter-v1`, and a class + method + import extract correctly. **No native
toolchain in the image.**

**Verification — all gates green.** `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` (serial),
`pnpm -r build`, `node --test tests/*.mjs` (25/25), `docker compose -f docker-compose.app.yml config
--quiet`, all three `docker build`s, and the new hermetic `pnpm --filter @codeflow/eval run parity`
(added as a CI step — it needs no keys, unlike the scored eval).

Per-package tests — **308 → 380 (+72)**: graph **16 → 33** (+17), parsers **10 → 28** (+18),
analyzers **170 → 198** (+28: inventory +4, new `connectCpg.test.ts` +17, analyze +7), eval
**18 → 27** (+9). Unchanged: web 51, api 27, worker 13, shared-types 3. Legacy 25/25.
Three existing tests were updated (not weakened) to the new-and-better expected outputs: the
graph-slice key set (now includes `cpgEdges`/`routes`/`cpg`, keeping its "no metrics on the slice"
intent and gaining an assertion that `clusters` is NOT there), the metrics key set (now includes
`clusters`), and one parity-harness gate.

**Judgment calls flagged.** (1) Proceeded past a failed entry gate — argued above; the owed
measurement is ledger #17. (2) `coreSymbols` precision is not gated (partial truth set) — the
alternative was a meaningless number. (3) Symbol-set widening (methods, top-level consts, `lineEnd`)
changes `symbolCount` → `complexity`; accepted as the "better" half of parity-or-better, covered by the
`ANALYZER_VERSION` bump. (4) Clusters partition the CPG union while `fanIn`/`fanOut` stay import-only;
documented on both types rather than quietly unified. (5) The §1 invariant says every new boundary gets
a **zod contract**, but there is no zod anywhere in this repo (0 imports) — the established convention
is typed interfaces + `pipeline.contract.test.ts`. Followed the existing convention; introducing zod is
its own change, carried as ledger #19. (6) `V3_PLAN.md` + `CODEBASE_SNAPSHOT.md` were untracked; they
were committed first so the branch started from a clean tree. (7) The `shared-types` edits for tasks 2
and 3 live in one file, so `RepoClusters` landed in the task-2 commit — cosmetic only.

**Ledger:** **#3 RESOLVED** — Louvain community detection is implemented in `@codeflow/graph` and
surfaced as `metrics.clusters`. New carries: **#16** grammar coverage is JS/TS/JSX/TSX/Python only (Go,
Rust, Java, Ruby, PHP, C#, C/C++ all fall back to the regex/generic engine, so they get no symbols and
no CPG enrichment — `@vscode/tree-sitter-wasm` ships several of those grammars already, so widening is
mostly a mapping table). **#17** the scored-eval parity comparison against a Phase 0 baseline is still
OWED, and blocked on Phase 0 §0.4 (the golden set) plus a real key. **#18** SCIP deferred (reasoning
above). **#19** the zod-contract invariant is unmet repo-wide, not just here. **#20** `cpgEdges` +
`routes` add to the stored analysis document — same 16MB BSON pressure as ledger #8; the symbol-level
aggregation bounds it, but it should be measured on a large repo alongside #8. Also note ledger #14(b)
(real provider usage instead of the estimate) and §0.1 of the V3 plan remain undone.

Next session: **V3 Phase 2 — retrieval** (real vector store + AST-aware chunks + hybrid/rerank), which
needs infra (vector store + object storage) to be stood up first. Phase 0's §0.1/§0.4/§0.5 gaps
(cost control plane, golden set, Arena) are still open and gate the Phase 1 eval claim.

## 2026-08-30 — V3-P0 (BACKFILL): Foundations + Arena (branch `v3/p0-backfill-foundations-arena`)

Phase 0 ran **AFTER** Phase 1 — out of plan order, deliberately. P1 (tree-sitter CPG + communities)
did not depend on anything P0 builds, so it shipped first; the only thing that cost was P1's eval
acceptance, which had no golden set to measure against and was carried as ledger #17. This session
pays that back and builds the rest of the foundation. Branched off `v3/p1-treesitter-cpg` so it
builds ON the shipped tree-sitter work rather than diverging from it. Five commits, one per task.

**AUDIT FIRST (§0.2/§0.3 were partially done on Aug 28 — kept and finished, not redone).**

*§0.3 — `summary` already had a real producer.* Commit `0ae0821` added `pipeline/summary.ts`
(`deriveSummary` + `scoreHealth`), wired at assembly, with a 208-line test: `result.summary` derives
files / functions / connections / languages / circularDependencies / healthScore from graph +
inventory + metrics. Untouched. What was left was the plan's other half — `issues` and
`aiProjectSummary`, both producerless.

*§0.2 — the worst version of the trap was already gone.* Commit `fc3cfdf` had already killed
"stages 7–8 sit at pending forever behind a run reporting completed": `skippedStages` on
`JobProgress`, the worker's cache-hit-safe `skippedAiStages()`, env-var-naming notes appended to
`result.warnings`, a `"skipped"` visual bucket in `PipelinePanel`, and honest banner copy. All kept.
The gaps were (a) no machine-readable "this run was deterministic-only" — the UI had to infer
capability from `runStatus`, which does not carry it, and (b) the Mongo fallback was **completely
silent**. Also confirmed absent: a Redis `RateLimitStore` (interface + in-memory only), any usage
read-back, prompt caching, and `packages/arena`.

**Task 0.1 — cost as a control plane.** Four changes, all serving "no `Math.ceil(text.length/4)` on
any paid path".

*One token utility* (`analyzers/src/util/tokens.ts`). Deleted the three identical `estimateTokens`
copies (synthesize.ts, rag.ts, rag/answer.ts). The module draws the line that mattered:
`estimateTokens` is ADMISSION CONTROL only (you must guess a call's size before making it) and also
drives the deterministic chunk plan; `TokenUsage` is the real cost read back after the call and the
only thing a paid path hands `budget.record()`. The 4-chars/token rate is deliberately **unchanged** —
`estimateTokens` moves RAG chunk boundaries, so tuning it would change every embedding and invalidate
the index; that is a measured decision, not a refactor. **Judgment call:** did NOT add a local BPE
tokenizer. This talks to Anthropic, Gemini and Voyage, whose vocabularies differ, so any single local
tokenizer is precisely *wrong* for at least two of the three — and the provider bills us and reports
what it billed. Grep confirms no `length / 4` outside the one utility.

*Usage read-back (resolves ledger 14(b)).* `LlmClient.complete` now returns `{text, usage}` and
`EmbeddingClient.embed` returns `{vectors, usage}`. All four fetch adapters read the real counters:
Anthropic `input_tokens`/`output_tokens` + `cache_read`/`cache_creation`, Gemini
`usageMetadata.promptTokenCount`/`candidatesTokenCount`/`cachedContentTokenCount`, Voyage
`usage.total_tokens`. Parsed defensively (`usageNumber`) so a missing or string counter cannot record
0 or NaN against the wallet. `TokenUsage.measured` is the honest half: **the Gemini batch-embed
endpoint reports no usage today**, so that path is an ESTIMATE, says so, and the caller logs it —
rather than being indistinguishable from a provider number.

*Shared Redis budget (resolves the #9/14 split).* The worker counted in Mongo and the API counted in
process memory, so "the global daily ceiling" was two ceilings that could not see each other's spend.
Both now decrement one Redis counter keyed per (UTC day, billing unit) — per-unit because chat and
embedding tokens are priced differently and exhaust independently. `check` **fails OPEN** on a Redis
error with the error retrievable: a cache blip taking the whole AI surface down is worse than briefly
overspending a margin, and the choice is explicit rather than accidental. The Mongo handle was
**deleted** rather than left as a second persistent implementation of one counter.
`@codeflow/analyzers` stays dependency-free — it declares a minimal `BudgetRedisLike` and the apps
inject their own `ioredis`.

*Redis rate limit (resolves ledger 14(c)).* `createRedisRateLimitStore` is the prod swap the
interface's comment has promised since Guard 4 landed; the limit now holds across replicas and
survives a restart. The window is derived arithmetically from `floor(now/windowMs)`, which keeps
INCR+EXPIRE atomic with no Lua. Also fails open.

*Prompt caching.* `LlmCompletionRequest.cachePrefix`; Anthropic gets an explicit `cache_control`
breakpoint on a two-block system field, Gemini gets the prefix leading `systemInstruction` (it caches
implicitly on a byte-identical prefix). A hit is READ BACK as `cacheReadTokens`, never assumed. Only
SYSTEM_PROMPT is marked, and the code says why: the per-repo facts are already covered by the
SHA-keyed completion cache, which is strictly cheaper than a provider cache hit (zero tokens vs
discounted ones). Narrower than it looks, on purpose.

**Task 0.2 — kill the in-process fallbacks (prod), keep tests hermetic.** New `RunMode`
("full" | "deterministic-only") + `DegradationNotice[]` with typed `DegradationReason`s, computed by
the worker's `classifyRun` and written to BOTH the job record and the RESULT, so the scope survives a
reload and a later cache hit. **Judgment call:** deliberately NOT a value on `AnalysisMode`
("public_hosted") — access mode and delivered scope are different axes, and overloading one makes
both unreadable. `budget-exhausted` is a degradation reason too, because it produces the same
user-visible shape (AI slices missing) from a different cause, and a banner that cannot tell them
apart cannot tell the user what to do.

New `apps/api/src/services/persistenceHealth.ts` surfaces `mongo-unavailable` naming MONGO_URI,
merged into the job-progress projection at READ time — it is a property of the process right now, not
of the job record, so a stored flag would go stale the moment Mongo came back. The web plumbs
`runMode`/`degradations` through to `PipelineState`; the existing terminal banner is unchanged and a
new `uncoveredDegradations` filter renders only what the banner does not already explain, so missing
keys and budget exhaustion are not said twice while a dead database gets its own notice.

**Task 0.3 — producerless slices.** Opposite verdicts, because the deciding question is whether
anything CONSUMES them. `issues` — **PRODUCED**: it was read in four places by
`apps/web/src/lib/analysisNormalizer.ts`, so an always-empty list was rendering as a finding of "no
problems", and removing it would have meant ripping out working UI to hide a missing producer. New
`pipeline/issues.ts` derives it from Analyze's metrics at assembly (same no-stage-owns-it pattern as
`summary`): cycles by length, structural hubs as a SHARE of the repo and only once the repo is big
enough for a share to mean anything, high coupling by absolute degree, and a mostly-disconnected
graph collapsed into ONE dependency issue. **Deliberately no `category: "security"` issues, ever** —
no security analysis is performed, so `summary.securityIssues` is now a real count that is
structurally always 0, which is the honest answer. `aiProjectSummary` — **REMOVED**: no producer, no
consumer, and `Synthesis.summary` already answers "what is this project" from the full fact set. A
declared-but-unwritten field is worse than an absent one, because consumers cannot tell the
difference; the intent to reinstate it *with* a producer is recorded on `AiAnalysis`. The
shared-types contract test used `aiProjectSummary` as its multi-slice-ownership example and was
re-pointed at a real multi-key stage (Connect owning `graph` + `entryPoints`).

**Task 0.4 — eval-driven development (closes the dataset half of #17).** Answer-path scoring
(`answerScore.ts`): the eval graded the INDEX only, so recall@k said the right chunks were *found*
and nothing about whether the answer was grounded. Three new measures, two decided by code with no
model: `citationValidity` (does each citation's file+line span sit inside a chunk the answer actually
retrieved — an independent check that production grounding held), `citationRelevance` (cited real
code, but the RIGHT real code?), and refusals split into JUSTIFIED vs UNJUSTIFIED, counted separately
because an honest refusal and a real miss are different outcomes and one "answer rate" hides both.

*Calibrated judge* (`judge.ts`). Faithfulness is the one measure string matching cannot decide, so it
goes to an LLM judge — and the module's job is making sure that judge cannot quietly become the
quality bar. `calibrateJudge` reports Cohen's **kappa**, not just raw agreement: with 19 of 20 labels
"faithful", a judge that always says faithful scores 95% agreement while carrying zero information,
and kappa scores it 0 (directly tested). `judgeIsGateable` requires sample size AND kappa AND a
confidence-interval lower bound. `runEval` reports judge scores always and **refuses to fail a
threshold on an uncalibrated one** — tested with a judge scoring 0 that still cannot fail the build.

*Real golden set.* `datasets/chalk.json` (JS, 8q) and `datasets/requests.json` (Python, 10q), 14 with
line-range truth. Both repos were **cloned at the pinned SHA and read** — every expectedFile and
every line range verified against the actual file, nothing recalled. chalk exercises the JS grammar
plus the subpath-imports case our resolver deliberately leaves unresolved; requests exercises Python
with real mixins and inheritance, i.e. V3-P1's CPG edges. Each dataset records PROVENANCE, including
that these numbers measure the V3-P1 tree-sitter pipeline and are **not** comparable against a
pre-V3-P1 regex-parsed run.

Both include a **negative control** — a question the repo cannot answer — and that exposed a real
scoring bug: `aggregateRag` would have scored a zero-target question as recall 0, penalising exactly
the refusal behaviour the control tests. Negative controls are now excluded from recall/MRR (and
counted, so their presence stays visible) and genuinely scored on the answer path.

*Validation.* `assertDatasetShape` is now real runtime validation at an untrusted file boundary (per
the amended contract rule): full-40-hex commit pinning, schema version, duplicate ids, POSIX-relative
paths, non-inverted 1-based ranges. Every check exists because getting it wrong yields a silently
WRONG SCORE rather than a crash — an impossible line range can never be hit, so it reads as a
permanent retrieval failure instead of the authoring mistake it is.

*CI split.* `ci.yml` gains a keyless `eval check` step (validation + determinism + coverage of both
parser families) beside P1's parity step. The scored run moved to a separate manual-dispatch
`eval-scored.yml` with an approval environment, a concurrency lock (two concurrent runs double the
spend for no extra information), and `fail-on-threshold` defaulting to **false** — the thresholds are
still placeholders and gating on uncalibrated numbers is what this phase exists to stop.
`EVAL_THRESHOLDS` gained the answer-path values, all marked PLACEHOLDER with a TODO naming what
calibrates them.

**Task 0.5 — Arena skeleton (`@codeflow/arena`).** `TaskSpec` / `Sandbox` / `AgentHarness` /
`Verifier` / `Reward` as typed interfaces + a contract test (repo convention; no zod, and no runtime
validation — a sandbox built in-process from an already-validated result is not an untrusted
boundary). A `Sandbox` is a frozen result at a pinned SHA exposing only reads; loading is injected so
production reuses the existing SHA-keyed cache, a null means "not cached" rather than "analyze on
demand", and a SHA mismatch is refused rather than silently compared.

The **graph oracle** answers five kinds exactly with zero LLM calls: imports-of, who-calls,
blast-radius, entry-points, cycle-through. `who-calls` is only possible because of V3-P1 — before the
CPG there were no call edges, so the only honest answer was "we know who imports it"; the tests pin
the distinction with a file that is imported but never called through. `blast-radius` reuses
`@codeflow/graph`'s own traversal so the oracle and the product cannot drift on what "affected"
means. The oracle also implements `AgentHarness`, which makes it **self-checkable**: run it as the
agent, grade it with itself, 1.0 on every kind is the minimum bar — if that round trip ever fails,
derivation and comparison have drifted and every Arena score is suspect.

The **three grounding passes** are wrapped as reusable verifiers. They stay enforced in production
where they belong (grounding must be enforced at the point of production, not merely measured after);
what was missing was a way for the eval and the Arena to apply the same rule without a fourth copy
drifting. `runArenaTask` requires EVERY applicable verifier to pass, not the mean to clear a bar: a
correct answer citing a file that does not exist is not 80% correct, it is ungrounded. No verifier ran
⇒ NOT a pass; silence is not success.

**Contract / type changes.** `TokenUsage`, `BudgetUnit`; `BudgetHandle.check/record` take a unit and
`record` accepts a `TokenUsage`; `LlmCompletionResult`, `EmbeddingResult`,
`LlmCompletionRequest.cachePrefix`; `RunMode`, `DegradationReason`, `DegradationNotice`;
`AnalysisResult.runMode?`/`degradations?` and the same on `JobProgress`; `DatasetProvenance` +
`EvalDataset.provenance?`; `PerQuestionResult.negativeControl`, `RagScores.negativeControlCount`;
`EvalThresholds` + 3 answer-path fields; `AiAnalysis.projectSummary` and the `aiProjectSummary` slice
key **removed**. New deps: `ioredis` (apps/api, apps/worker — explicit, not BullMQ's transitive),
`@codeflow/config` (packages/eval), and the new `@codeflow/arena` package.

**Verification — all gates green.** `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` (serial),
`pnpm -r build`, `node --test tests/*.mjs` (25/25), the keyless `pnpm --filter @codeflow/eval run
parity` and `run check`, `docker compose config --quiet`, and the worker + api images rebuilt to
confirm the `ioredis` addition did not break the `node:20-slim` runtime.

Per-package tests — **380 → 526 (+146)**: analyzers **231** (+33), eval **76** (+49),
**arena 43 (new package)**, api **39** (+12), web **60** (+9), worker 13 (unchanged count, +4
assertions inside existing tests), graph 33, parsers 28, shared-types 3. Legacy 25/25. Everything
stayed hermetic: no test touches Redis, Mongo, a provider, or the network — the Redis stores are
driven by injected fakes and in-memory remains the default everywhere.

**Judgment calls flagged.** (1) No local tokenizer — argued above; provider usage is authoritative
and a single local vocabulary would be wrong for two of three providers. (2) Both Redis stores FAIL
OPEN; explicit, logged, and defended in comments rather than being a silent default. (3) `runMode` is
a new field, not a new `AnalysisMode` value. (4) `issues` produced, `aiProjectSummary` removed —
opposite verdicts on the same class of problem, decided by whether a consumer exists. (5) No
`category: "security"` issue is ever emitted. (6) The scored-eval runner grades a result you already
produced rather than cloning and analyzing itself: the cloner/queue/provider wiring lives in
apps/worker and the run needs the owner's key, so duplicating that machinery in `@codeflow/eval`
would be worse than an explicit input contract — it fails with the exact instruction. (7) The judge
ships with **no** human labels, so it is advisory by construction; authoring labels is what promotes
it to a gate.

**Ledger.** **RESOLVED: 14(b)** (real provider usage replaces the estimate), **14(c)** (Redis
rate-limit store), **#9's remaining sub-item** (the Q&A budget is now shared with the worker — the
answer CACHE is still per-API-process, carried below), **#19** (the zod invariant was amended, and
this phase followed it: typed interfaces + contract tests, with runtime validation only at untrusted
boundaries — the dataset loader). **#17 PARTIALLY resolved**: the golden set now exists and is
CI-validated; the SCORED comparison is still owed and is a manual step (needs the owner's key). New
carries: **#21** the Q&A answer cache is still per-API-process (only the budget is shared); **#22** the
Gemini batch-embed endpoint reports no usage, so that one path is an honest estimate flagged
`measured: false` — revisit if Google adds `usageMetadata`; **#23** no human judge labels exist yet,
so faithfulness cannot gate; **#24** `EVAL_THRESHOLDS` are placeholders pending the scored run;
**#25** the Redis budget/rate-limit stores and `redisClient.ts` are integration-only (hermetically
tested against fakes, never against a real server).

Next session: **V3 Phase 2 — retrieval** (real vector store + AST-aware chunks + hybrid/rerank).
It needs infra stood up first (vector store + object storage); Phase 0 and Phase 1 are now both
complete, so Phase 2's entry gate is satisfied on the code side.

## 2026-08-30 — V3-CLEANUP: dead-code + orphan-file removal (evidence-based) (branch `v3/cleanup-deadcode`)

No new features. A leaner tree, arrived at by proof rather than by eye: every deletion carries a
grep/import-graph receipt, every survivor carries a written reason so the next pass does not
re-litigate it. The audit landed as `CLEANUP_MANIFEST.md` **before** any file was touched, so the
verdicts are reviewable independently of the diffs that act on them. Seven commits: the manifest,
then six removals, with the full gate after every one.

**Method.** (1) An import-graph orphan sweep over all 220 tracked `.ts`/`.tsx` files, matching each
file's module specifier against every tracked `.ts/.tsx/.js/.mjs/.cjs/.json/.yml/.sh/.bat/.html`
file plus Dockerfiles — so a reference from a test, a `package.json` script, a tsconfig path, a
compose file or a CI workflow counts as "referenced". (2) `tsc --noUnusedLocals
--noUnusedParameters` per package, run as a REPORT (the flags were deliberately not committed).
(3) A targeted grep per candidate named in the brief.

**THREE OF THE BRIEF'S PREMISES WERE WRONG, and that is the most useful finding.**
- `apps/worker/src/processors/analysisProcessor.ts` + its test (ledger #4, "~415+207 LOC") **do not
  exist in this tree.** The directory holds only `pipelineJobProcessor.ts` + its test; `git log --all`
  shows `e46f859 chore: remove unwired analysisProcessor reference (ledger #4)` on another branch.
  Ledger #4 was satisfied long ago and the ledger entry was stale.
- **None of the 11 ledger-#15 P5-era panels exist** — grep for all of them plus `selectedPanel` /
  `panelComponents` / `SelectedPanel` / `FileDetailTab` across `apps/web/src` returns zero hits. Only
  orphaned CSS survived (`.dashboard-layout`, `.file-drawer`, `.health-panel`), removed here.
- `card/examples/*.svg` are **not** "10 zero-byte files" — they are 1.7–12.3 KB real rendered SVGs,
  and the repo contains **zero** zero-byte tracked files. The premise for deleting them was false.

**REMOVED (6 commits, gates green after each — nothing had to be reverted).**
- `packages/exports` (3 files) — `src/index.ts` was literally `export {};`. Zero importers; its only
  live reference was a `tsconfig.base.json` paths entry, removed in the same commit. It was still in
  the pnpm workspace, so every `pnpm -r` run paid a typecheck/build/test invocation for zero output.
- `apps/card-action` (3 files) — a stub returning `{status:"placeholder"}`. Zero importers, zero root
  scripts, zero CI/compose references — and its TODO ("port the legacy card action") is obsolete:
  `V3_PLAN.md` §5 redirects that work to `apps/mcp`. Isolated in its own commit because this is the
  one removal resting on a roadmap judgement rather than pure deadness.
- `PRReportModel` + `ShareModel` (41 LOC) — Mongoose models for `prReports`/`shares` that nothing
  imports, so those collections are never read or written. Reference counts made it unambiguous:
  AnalysisModel 4, JobModel 4, RepoModel 2, these two **0**. Safe by construction — Mongoose only
  registers a model on import, so an unimported one is inert.
- Six web files (60 LOC) + 71 lines of CSS. Two were self-declared placeholders superseded by shipped
  work: `GraphLegend` (invented UI/API/Data/Risk categories; the real 2D graph renders its own legend
  from actual node roles) and `GraphToolbar` (three dead buttons + a TODO for the 2D-graph migration
  that landed in P17). `ErrorState`/`LoadingState` were functional but never imported — error and
  loading surfaces are rendered inline where they are actually needed. `formatters.ts` was a 3-line
  helper with no callers. `app/routes.tsx` was a one-entry route stub; `main.tsx` renders `<App/>`
  directly and there is no router in the tree. The CSS orphaned by those components went in the same
  commit, plus the last ledger-#15 remnants. `.state-box` was deliberately KEPT — `EmptyState` uses it.
- `Citation` + `ProjectSummary` in shared-types — orphaned by **my own V3-P0 change**, which deleted
  `AiAnalysis.projectSummary` for being producerless. That left `ProjectSummary` with no field to type
  and `Citation` used only by it. Keeping them would reproduce exactly the smell V3-P0 removed; a note
  at the removal site records that they return WITH a producer if Orient grows its AI summary.
- 11 dead symbols. The substantive one is also a V3-P0 leftover: replacing the Mongo budget handle with
  the shared Redis one orphaned `llmBudgetSchema` + `LlmBudgetModel` (a model for the `llmbudget`
  collection nothing can now read or write) plus two unused imports in `workerAnalysisService.ts`. The
  rest were unused imports/params across graph, parsers, and four test files. `inventoryCtx`'s unused
  `readFile` param was removed along with both call sites that were passing an argument it ignored.

Off-repo: `tmp/`, `temp/` (10 stale May smoke logs) and `codeflow.zip` deleted from disk — **1.96 MB**
of working-tree junk. All were already gitignored (verified literal entries for `tmp/`, `temp/`,
`*.zip`, `dist/`, `coverage/`, `*.log`), so this is zero repo change and needed no `.gitignore` edit.

**KEPT, with the reason recorded** (12 entries in the manifest; the load-bearing ones):
- **`card/` — all 26 files.** A *published* GitHub Action, not internal code: `action.yml` declares a
  full documented input surface and its README documents consumption from an external workflow, so it
  has consumers the hermetic suite cannot see. It is also functional — `card/lib/analyzer.js` reads
  `legacy/index.html` and runs the analyzer in a Node `vm`. Deleting any of it is an external break.
- `legacy/index.html` — load-bearing twice: four `tests/*.mjs` parse it AND `card/` reads it at runtime.
- **`docker-compose.yml` is NOT a duplicate** of `docker-compose.app.yml`. It is dev-infra only
  (mongo:7 + redis:7-alpine, 15 lines); `.app.yml` is the full app stack and is what every documented
  path uses (`README`, `QUICKSTART`, `start.sh`, `start.bat`). Plain `docker compose up -d` picks up
  this one, which is what `pnpm dev:api`/`dev:worker` and the deferred SSE/BullMQ wire smoke need.
- `mockAnalysis.ts` — 8 test files import it AND `appStore.loadMockAnalysis` backs a live demo button.
- `apps/local-cli` — the root `dev:local` script references it, so it is not an orphan.
- `apps/web/public/config.js`, `.env.example`, `tests/fixtures/*` — runtime/fixture contracts.
- The commented-out `require` at `packages/eval/src/parity/corpus.ts:36` is a **deliberate fixture**
  proving the regex parser hallucinates an import out of a comment. Deleting it would silently weaken
  that test. (Searched for real commented-out code; there is none.)

**Delta.** Tracked files **331 → 318 (−13)**. **−282 / +17 lines** (net **−265**), excluding the
manifest and lockfile. `styles.css` 1278 → 1207. Two fewer pnpm workspace packages, so every
`pnpm -r` run does two fewer invocations. `tsc --noUnusedLocals --noUnusedParameters` now reports
**zero** unused locals/params across all 10 packages and apps (was 11).

**Verification — every gate green after every commit, and again at phase end.** Per-package tests are
**unchanged**, which is the point: nothing referenced any of this. analyzers **231** · eval **76** ·
arena **43** · web **60** · api **39** · graph **33** · parsers **28** · worker **13** ·
shared-types **3** = **526**; legacy **25/25**. Also green: `pnpm -r typecheck`, `pnpm -r lint`,
`pnpm -r build`, the keyless `parity` and `check` CI steps, `docker compose config --quiet`, and all
three Docker images rebuilt (worker, api, web).

**Judgment calls flagged.** (1) `apps/card-action` removed on a roadmap argument, isolated for easy
revert. (2) `apps/local-cli` kept purely because a root script points at it — an equally minimal stub
otherwise. (3) `.button-row` CSS is a leftover orphan NOT caused by this pass and unrelated to any
removed component; recorded in the manifest rather than deleted on a hunch. (4) `screenshot.png`
(1.0 MB) + `codeflow-social.png` (297 KB) have zero in-repo references but names strongly suggesting
GitHub repo-settings / external usage — exactly the "might break a path the suite cannot see" case, so
they were **not** deleted and are listed for the owner to call.

**Ledger:** **#4 RESOLVED** (was already done on another branch — the entry was stale; the file does
not exist here). **#15 RESOLVED** (the components were already gone; this pass removed the last CSS
remnants). No new carries — the only two items this pass generated are the owner decisions above and
the `.button-row` note, both recorded in `CLEANUP_MANIFEST.md`.

Next session: **V3 Phase 2 — retrieval** (real vector store + AST-aware chunks + hybrid/rerank),
still awaiting the vector-store / object-storage infra brief.


## 2026-08-31 — V3-P2: retrieval (real vector store + AST-enriched chunks + hybrid/rerank/MMR + the synthetic flywheel) (branch `v3/p2-retrieval`)

Four commits, one per task, full gate after each. The phase moves retrieval out of the analysis
document and turns it into a real pipeline; the biggest risk named in the brief — that this
touches persistence, the RAG stage, the Q&A path, eval and the homogeneity/cache logic at once —
was real, but the blast radius measured smaller than feared: only **6 files** referenced
`chunk.text`/`chunk.embedding`, and 12 non-`dist` files referenced `RagChunk`/`ai.rag`.

**AUDIT FIRST (verified against the live tree, not `CODEBASE_SNAPSHOT.md`).** The RAG stage was
534 lines, embedding inline and storing `text` + `embedding` per chunk **inside the Mongo
document** — the 16MB-BSON problem in ledger #8, exactly as described. Retrieval was a
brute-force cosine scan (`packages/analyzers/src/rag/retrieve.ts`, 35 lines): no BM25, no
fusion, no rerank, no MMR. `assertEmbeddingSpace` was already the one shared homogeneity guard
for eval + production. Two live-tree findings the brief did not predict: `InventorySymbol` has
`line`/`endLine` but **drops `signature`**, which `ParsedSymbol` has carried since V3-P1 — task 2
needed it; and `packages/exports/dist` + `apps/card-action/{dist,node_modules}` were stale
untracked build output left by V3-CLEANUP's `git rm` (removed).

### Task 1 — `@codeflow/retrieval`: the index leaves the document (`cce9bf1`)

A 1024-dim float array is roughly 8KB of JSON per chunk, so a mid-sized repo exceeds the 16MB
BSON limit, and every read of an analysis (the dashboard, the job poll) dragged the whole index
across the wire. The new package sits **BELOW `@codeflow/analyzers`** and depends on nothing but
`shared-types` + `config`.

- **Dependency direction was the first real design decision.** The index build (a pipeline stage
  in analyzers) and the query path must talk to the same interface, so putting the interface in
  analyzers would have made `retrieval → analyzers → retrieval` a cycle. `cosineSimilarity`,
  `retrieve` and `assertEmbeddingSpace` therefore **moved down** into retrieval — they are
  retrieval concerns — and `@codeflow/analyzers` re-exports all three, so there is still exactly
  ONE definition of each and every existing import path resolves unchanged. `retrieve` became
  generic over `{ id, embedding }` because a persisted `RagChunk` no longer carries a vector.
- **Interfaces:** `VectorStore` (`upsert`/`search`/`count`/`drop`, namespaced), `ChunkTextStore`
  (`put`/`get`/`drop`), `Reranker`, `SqlClientLike`.
- **In-memory vs prod split.** The in-memory pair is the HERMETIC DEFAULT — not a stub: it is
  what the whole suite and the eval run against, and it is an **exact** cosine scan, so a ranking
  difference against pgvector is attributable to ANN recall rather than to different maths. The
  pgvector + Postgres pair is production, reached through an injected `SqlClientLike` (the V3-P0
  `BudgetRedisLike` pattern), so the suite asserts the real emitted SQL against a recording fake
  with no container, no port and no cleanup.
- **The dimension is in the pgvector TABLE NAME** (`codeflow_vectors_1024`). `vector(n)` is
  fixed-width, so one table cannot hold two embedding spaces; giving each dimension its own table
  makes **Postgres itself** enforce homogeneity, which is stronger than an application check.
  HNSW with `vector_cosine_ops` (an L2 index would rank differently from every other code path);
  above pgvector's 2000-dim HNSW ceiling the index is skipped and an exact scan is left, rather
  than failing.
- **`createRetrievalStores` is the ONE factory both worker and API call** — same reasoning V3-P0
  used to unify the budget: two processes resolving stores independently can disagree, and here
  disagreeing means the worker writes an index the API cannot read. Degradation is ANNOUNCED
  (`mode`, `degradation`, logged at startup by both processes). "Not configured" is a supported
  single-container mode and is deliberately NOT reported as a degradation; "configured but
  unreachable" is.
- **`Rag` is now lightweight metadata + a `store` reference.** An index with no `store` is
  PRE-P2 — unreadable, not empty — so the query path throws with a rebuild instruction instead of
  answering from zero chunks, which would have looked exactly like an honest refusal.
- **Write order is text-first, then vectors**, and that is not arbitrary: the vector store is what
  a search reads, so a crash between the two writes leaves text nobody can find (harmless,
  overwritten on retry) rather than searchable hits whose text is missing.
- **Eval** now retrieves through the production `vectorRetrieve`; `scoreQuestion` became a pure
  scorer over the ranking production actually returned (before, it embedded the retrieval
  primitive itself, which would have kept the eval measuring a brute-force scan while production
  served something else). An index **sidecar** (`results/<name>.index.json`, runtime-validated)
  keeps the out-of-band scored run infra-free.
- Added `pgvector/pgvector:pg16` to the DEV `docker-compose.yml` (dev-infra only, healthchecked)
  and documented `POSTGRES_URL` in `.env.example` for BOTH processes.

**Acceptance:** no embeddings inline in Mongo — asserted structurally, not trusted: a test walks
every persisted chunk for `text`/`embedding` and additionally asserts `JSON.stringify(rag)`
contains no `"embedding"` key, because a round trip through JSON is what persistence actually
does. Hermetic tests pass via the in-memory store. The homogeneity guard holds at three levels
now: client-vs-index, client-vs-store (a misconfigured deployment, a different mistake), and
actual vector length (`assertVectorDimension` — cosine does not throw on a wrong-length vector,
it truncates to the shorter length and returns a plausible number).

### Task 2 — AST-enriched chunk embeddings (`cf1f118`)

Three failures a user hits immediately: a split symbol's later sub-chunks are body fragments with
no name in them at all; a method body never mentions its class; nothing says which file or
language it came from, though paths are dense with intent.

`embedTextFor` prepends path + path-as-words, language, scope chain, symbol, signature and
docstring to the text that gets **EMBEDDED** — and never to the text that gets **STORED**.
`RagChunk.text` stays byte-exact for its line range, because that is what a citation resolves to
and what enters an answer prompt. That separation is why this is a function over the chunk rather
than a mutation of it, and it is asserted (`enrichedText.endsWith("\n\n" + text)`).

`deriveEnrichment` runs as a **POST-PASS over the planned ranges**, deliberately: V3-P1's
interval-cover and gap-sweep code is untouched, so chunk ids (`fileId#start-end`) cannot move
even by accident — the task's stated acceptance condition, held by construction and pinned by a
test. It is passed EVERY symbol in the file, not just the top-level ones the cover selected,
because the overlaps are what make a scope chain possible. `InventorySymbol` gained `signature`
(the parser has produced it since V3-P1; Inventory was dropping it), and since a signature is
where a typed language states its types, that is how "enriched with types" is satisfied rather
than by inventing a field nothing could fill.

Two deliberate details worth recording. A **later** sub-chunk gets scope and signature but NOT
the docstring: repeating one docstring across five sub-chunks makes them near-identical to the
vector, which is the redundancy MMR then has to undo. And because the embedding cache is
content-addressed on the embedded text, enabling this **invalidates every document-side cache
entry exactly once** — correct rather than unfortunate, since the old vectors describe different
text. `PLAN_CACHE_VERSION` bumped v1 → v2 for the same reason (a v1 cached plan would produce
un-enriched chunks on the no-disk retry path: silently worse retrieval, not a crash).

**MEASURED, hermetically** (`packages/eval/src/enrichmentAb.ts`): the same chunk plan, the same
ids, indexed twice — one arm embedding the enriched text, one the raw text — scored through the
production `vectorRetrieve`.

| metric | raw | enriched | delta |
|---|---:|---:|---:|
| recall@3 | 0.500 | **1.000** | **+0.500** |
| MRR | 0.333 | **0.667** | **+0.333** |
| questions won / lost | — | — | **3 / 0** |

**What that does and does not establish, stated in the module itself:** the embedder is a
deterministic bag of words (feature hashing over the SHARED code tokenizer), so it measures the
MECHANISM and the direction, not the magnitude a real model would show. The golden-set number
needs a key and is deferred. One question (`ab4`) is reported as a **RANKING** win rather than a
recall win — the raw arm does find it, at rank 3 — because claiming a recall win there would be
claiming something that did not happen. `ab5` is a control answerable from raw bytes alone and
must not regress; nothing was lost.

**A first draft of this A/B was wrong and was fixed rather than accepted.** Three of its
assertions failed because the corpus did not create the cases the comments claimed: the
"split-symbol" chunk range started ON the method's signature line, so its raw text contained the
word the query used. Corrected the corpus (ranges 6-9 / 10-12 / 14-17, so 10-12 is the pure
body), and one question was reworded after measurement showed the toy embedder's "session"
collision with `sessionStore.ts`'s path words was what the question actually measured — the
limitation is documented at the question.

### Task 3 — hybrid + rerank + MMR (`1891823`)

    vector arm  --+
                  +-- RRF fusion -- text fetch -- reranker -- MMR -- top-k
    lexical arm --+

- **The lexical arm earns its place, asserted rather than argued.** With the vector arm narrowed
  to 2 candidates, hybrid still returns the chunk containing `parseJwtHeader` (whose vector is
  orthogonal to the query) — and in the wide-arm regime that chunk goes from **worst cosine of
  five to rank 1**. That works only because the lexical arm indexes the NAMESPACE rather than
  re-ranking arm 1's output.
- **RRF fuses RANKS, not scores.** A cosine of 0.83 and a BM25 of 11.4 are not comparable
  quantities, and normalising them invents a scale that shifts with every result set. The cost is
  stated where it matters: the fused score is ORDINAL.
- **THE REFUSAL FLOOR IS UNCHANGED**, reading the VECTOR arm's real cosine, before any rerank.
  Comparing an RRF score (~1/61) to a 0.2 floor would refuse everything; comparing a reranker
  score would compare a model-specific scale to a cosine. A test asserts every returned chunk's
  fused score is BELOW the floor that admitted it. A refusal still costs exactly one vector
  search — no lexical arm, no rerank, no LLM — and now carries the trace, which is the case you
  most want it for.
- **BM25** is deterministic and unit-tested directly: code-aware tokenizer (splits punctuation
  AND camelCase, keeps the whole identifier too, no stemming, no stopwords — `if`/`for`/`class`
  are keywords), k1=1.2/b=0.75, and **IDF floored at zero** because raw probabilistic IDF goes
  negative above 50% document frequency, which would make a document containing a common word
  rank BELOW one that does not contain it at all.
- **MMR** uses `fileId` as the redundancy key rather than pairwise cosine: the vectors are in the
  store, and a second round trip for ~40 candidates buys a correction fileId already makes in the
  right direction. Documented as the coarser mode it is; the exact vector mode exists and is
  tested.
- **A reranker failure degrades to the fused order and RECORDS it** (`trace.rerankerError`). The
  reranker itself rejects rather than falling back, precisely so that decision lives in the
  caller where the trace can carry it — otherwise "broken" is indistinguishable from "had no
  opinion". A candidate the reranker omitted is ranked last, never dropped.

**RERANKER DEPENDENCY PROBE** — same discipline V3-P1 used before adopting `web-tree-sitter`.
Every candidate was installed or inspected, and every one REJECTED:

| candidate | verdict | evidence |
|---|---|---|
| `onnxruntime-node@1.24.3` | REJECT | Installed: **211 MB**, prebuilt NAPI `.node` + `.so`/`.dll`/`.dylib` for six platforms, AND `postinstall: node ./script/install` fetching more binaries from a Nuget feed (`adm-zip` + `global-agent` deps). No node-gyp, so it clears that bar — but not a trade worth making in an image that ships nothing native at all. |
| `@huggingface/transformers@4.2.0` | REJECT | Depends on the above, plus `sharp` (native image lib, irrelevant to text reranking). |
| `fastembed@2.1.0` | REJECT | Depends on `@anush008/tokenizers`, a native Rust NAPI binding. |
| `onnxruntime-web@1.29.0` | Viable runtime, NOT adoptable | No install script, no native binaries — the WASM-clean option and exactly the `web-tree-sitter` shape. But a cross-encoder needs WordPiece/BPE and the JS tokenizers are themselves NAPI. That is a real task, not glue → named for P5. |

**So NO new dependency.** What ships is `createLexicalOverlapReranker`: keyless, in-process,
zero-dependency, deterministic, and honest about it — `kind: "deterministic"` lives in the data,
so no report can mistake it for a cross-encoder. It earns the default slot by rewarding a
candidate that literally contains the typed identifier (the same asymmetry that justifies the
BM25 arm), with symmetric union normalisation so a huge chunk cannot win on vocabulary size.
`createCrossEncoderReranker` takes an injected `CrossEncoderSession`, so the real model is a
drop-in and the adapter is ALREADY tested — batching, deterministic truncation (silent tokenizer
truncation means the model scored a prefix while the caller believed it scored the chunk), and a
**THROW** on a misaligned score array rather than silently attaching scores to the wrong
candidates.

### Task 4 — the synthetic-data flywheel (`b83be77`)

The golden set is 18 authored questions across two repositories because every one cost a human
reading code. But for a whole class of questions the answer is ALREADY A FACT in the result:
"which files import `src/db.ts`?" is a set of edges, not an opinion.

- **THE RULE: labels come from the ORACLE, never from a model.** `truthFor` derives the answer
  with the same traversals the product uses. A model-labelled synthetic set would measure how
  well retrieval agrees with a model's guesses — not what an eval is for, and worse than no eval
  because it looks like one. A test asserts every generated label EQUALS the oracle's own truth,
  and another runs **the oracle AS the agent over its own generated set**: 1.0 on every task, no
  model, no network. If that ever fails, generator and verifier have drifted and every label is
  suspect. A companion test confirms a wrong answer scores 0 — a perfect score from a grader that
  cannot fail is not a measurement.
- **Deterministic:** no RNG. Targets ordered by degree descending then fileId — degree-first
  deliberately, because a file nothing touches yields an empty answer and a set of those measures
  nothing.
- **Hard negatives, one strategy per kind, each a confusion that actually happens:** `imports-of`
  → files the target IMPORTS (the reverse direction); `blast-radius` → the target's transitive
  DEPENDENCIES (upstream, not downstream); `who-calls` → same Louvain community with no call edge;
  `cycle-through` → same community, not in a cycle; `entry-points` → the most-connected files that
  are NOT entry points. Random negatives teach nothing — any retriever separates `src/db.ts` from
  `README.md`. Every mined set is filtered against the truth set and the target, so a "negative"
  can never secretly be correct.
- **Negative controls are GENERATED, not guessed** — a question whose correct answer is a
  refusal, known with certainty. **Bounded** per kind: in most repositories most files are
  imported by nobody, so an unbounded generator would emit an almost entirely negative set whose
  recall number means nothing.
- **Generated sets are NOT written into `packages/eval/datasets/`.** That directory is the
  AUTHORED golden set and its value is that a human stands behind every question; mixing
  thousands of machine-generated ones in would destroy that guarantee and let the mechanical half
  dominate the score while the judgement half quietly stopped mattering.
  `buildSyntheticDataset` maps onto the eval's own `RagEvalQuestion` shape so ONE harness scores
  both, and it validates its own output with the same `assertDatasetShape` that guards the
  authored set. An unpinned result yields an empty SHA the loader then REJECTS — no placeholder
  papering over an unpinnable dataset.

**Verified end to end** via the new `pnpm --filter @codeflow/eval run synthetic <result.json>`:
from a **4-file fixture graph** it generated **12 questions with exact labels, 4 negative
controls and 10 hard negatives** across all five oracle kinds, and passed its own shape check.
For scale: the authored golden set is 18 questions from two real repositories.

Two fixtures were corrected, not worked around: the **eval** fixture claimed `producedBy: [...
"connect" ...]` but had **no `graph` slice**, which became load-bearing here — with no graph the
generator produced nothing and every assertion about generated questions passed trivially. A
guard test now pins that premise. The **arena** fixture gained its Louvain assignments for the
same reason (community-based hard negatives would otherwise only exercise the empty path).

### Interfaces + the in-memory / prod split (one table)

| interface | hermetic default | production | notes |
|---|---|---|---|
| `VectorStore` | `createMemoryVectorStore` (exact cosine scan) | `createPgvectorStore` (HNSW cosine, dimension in the table name) | integration-only; SQL asserted against a recording fake |
| `ChunkTextStore` | `createMemoryChunkTextStore` | `createPostgresChunkTextStore` | Postgres, not object storage: the access pattern is ~40 primary-key reads on the Q&A hot path, not 40 HTTP GETs |
| `SqlClientLike` | recording fake | `pg.Pool` via `createPostgresSqlClient` (lazy dynamic import, `'error'` listener attached) | `pg` is pure JS — no node-gyp — so it installs in `node:20-slim` |
| `Reranker` | `createLexicalOverlapReranker` / `createIdentityReranker` | `createCrossEncoderReranker` + a `CrossEncoderSession` | no session exists yet; see the probe above |
| `CrossEncoderSession` | fake in tests | — | the entire model (runtime, tokenizer, weights) behind one method |

`createRetrievalStores` also gained a documented **`createClient` test seam**, because the
degradation paths are the whole point of that factory and exercising them against the real driver
attempted a real TCP connection — 3.6 s per test, and a network call in a suite that must have
none. Caught during the run and fixed; a dedicated test now asserts the seam is used at all.

### Determinism

Every new stage is deterministic and total: `VectorStore.search`, BM25, RRF, MMR and both
rerankers all break ties on id, because RRF fuses RANKS and a wobbling tie-break upstream would
leak straight into the fused order and therefore into the eval's recall@k. Byte-identical
run-twice tests cover `hybridSearch`, the enrichment A/B, the generator and the synthetic dataset
builder.

### Docker (verified INSIDE the pruned image, as V3-P1 did for the WASM grammars)

All three images rebuilt. `pnpm deploy --prod` prunes aggressively, so "it compiles" is not the same
as "the dependency is there" — the check that matters is running the code in the image:

```
RETRIEVAL LOADED: true
memory mode: memory memory-vector-store
pg driver resolvable in the pruned image: true
pgvector store id: pgvector:codeflow_vectors_1024
enrichment: path: src auth token service
```

Cost of the one new dependency: worker **485 MB → 489 MB (+4 MB)**, api **361 → 365 MB (+4 MB)**,
web unchanged at 74.2 MB. `pg` is pure JavaScript (no `node-gyp`, no prebuilt binaries), which is the
whole reason it was acceptable where `onnxruntime-node` at 211 MB was not.

### Verification (per-package, after the phase)

`pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` (serial), `pnpm -r build`,
`node --test tests/*.mjs`, the keyless `parity` + `check` CI steps and `docker compose config`
all pass — **742 unit tests**, up from 526 (**+216**):

| package | before | after | delta |
|---|---:|---:|---:|
| **retrieval (new)** | — | **155** | +155 |
| analyzers | 231 | **234** | +3 |
| eval | 76 | **109** | +33 |
| arena | 43 | **68** | +25 |
| web | 60 | 60 | — |
| api | 39 | 39 | — |
| graph | 33 | 33 | — |
| parsers | 28 | 28 | — |
| worker | 13 | 13 | — |
| shared-types | 3 | 3 | — |
| **total** | **526** | **742** | **+216** |

Legacy `node --test`: **25/25**. `tsc --noUnusedLocals --noUnusedParameters` reports **zero**
unused locals/params across every package (one appeared during the phase — `scoreQuestion`'s `k`
became unused when retrieval moved out; it is now ENFORCED by slicing, because a metric called
recall@k must not depend on how many results the caller happened to pass).

### Judgment calls flagged

1. **No cross-encoder dependency**, on the probe evidence above. The deterministic reranker is a
   real improvement, not a placeholder, but it is not a cross-encoder and the code says so.
2. **The enrichment A/B measures the mechanism, not the magnitude.** Written at the top of the
   module and in the commit message rather than left for a reader to infer from a flattering
   number.
3. **Postgres for chunk text**, where `V3_PLAN` §Phase-2 said "object storage". The access
   pattern is a keyed lookup on the hot path, and one instance lets a re-index drop text and
   vectors together. Object storage stays right for genuinely large cold artefacts (P5).
4. **The lexical arm builds its BM25 index per query** over the namespace's text — the one place
   hybrid search does work proportional to the INDEX rather than to k. A persisted inverted index
   would be a second structure to keep in step with the vector index; bounding it by SAMPLING
   would be worse than the cost, since the lexical arm's value is finding the rare identifier and
   a sampled corpus is exactly where a rare thing goes missing. Flagged for P5 with a real
   corpus.
5. **`hybridSearch` is wired into the Q&A answer path now**, with the deterministic reranker as
   the default. The alternative — shipping it unwired — would have left the refusal-floor
   interaction untested against the real caller, which is the riskiest part of the change.

### Ledger

- **#8 RESOLVED.** Vectors are out of `result.ai.rag.chunks[]` and in a real index; the slice now
  grows with the chunk COUNT and not with the embedding dimension.
- **#20 — status reported, deliberately NOT resolved.** `cpgEdges` + `routes` still live in the
  analysis document. P2 removed the *large* contributor (vectors), which changes the arithmetic
  substantially, but the graph slice's own growth is unmeasured on a genuinely large repo and
  externalising it on a guess would be building without evidence. The natural decision point is
  the first big-repo end-to-end run, which is deferred.
- **#21 (per-process Q&A answer cache) unchanged** — untouched by this phase.


## 2026-08-31 — V3-P3: agentic Q&A + memory (branch `v3/p3-agentic-memory`)

Three commits. `/api/result/:id/ask` is now a BOUNDED multi-turn agent over exact graph tools plus
V3-P2 hybrid retrieval, with conversation memory so a follow-up resolves against prior turns.

**AUDIT FIRST — the finding that shaped the whole phase.** `LlmClient`
(`packages/analyzers/src/llm/llmClient.ts`) is a plain text-completion interface with **no native
tool-calling**, and its two adapters (Anthropic Messages, Gemini) expose tool use quite differently.
Adding native tool-calling would have meant changing that contract, both adapters and their tests,
and writing provider-specific request shaping — before a single agent existed to justify it.

So the loop is **ReAct over a completion**: one JSON action per turn, parsed and validated. It works
with both providers unchanged, is trivially mockable (the suite injects a scripted client), and puts
the parse at exactly the boundary the V3-P0 contract rule names — parsed LLM JSON. **The cost is
stated rather than hidden:** prompted tool-calling is less reliable than native, so the parser is
forgiving about fences and surrounding prose and there is a bounded retry for unparseable output.
Native tool-calling is a P5 upgrade that slots in behind the SAME `AgentTool` interface — the tools,
the router, the metering and the grounding do not change.

Two other live-tree facts: `AnalysisCacheHandle`/`BudgetHandle` were already injectable (so the
agent reuses them unchanged), and `AskHandler` was already a test seam, which is what let the whole
phase land without touching the web app.

### Task 1 — the bounded multi-turn agent (`f29dde6`, wired in `19b236c`)

New `@codeflow/agents` (V3-P4 extends the same package). Tools: `find_references`, `get_callers`,
`get_blast_radius`, `symbol_search` (all exact, from the V3-P1 CPG, free), plus `search_code` (V3-P2
hybrid) and `what_changed` (task 2's repo memory).

**RISK (a): unbounded cost/latency.** Handled in code, never in a prompt.
- `AGENT_MAX_TURNS` (6) and `AGENT_MAX_TOOL_CALLS` (10) are hard caps. **A test caught that the tool
  cap was not actually capping** — the loop stopped OFFERING tools once the budget was spent but
  still EXECUTED the calls, so `maxToolCalls: 2` produced 4 calls. That is precisely the runaway the
  cap exists to prevent, and it was a real bug, fixed by refusing the call on a forced-answer turn.
- When the tool budget runs out the agent is not cut off mid-thought: it gets one FINAL turn with the
  descriptions removed and an explicit instruction to answer from what it has, because a truncated
  loop that returns nothing has spent the whole budget for no answer. That turn is also the cheapest
  of the loop.
- **A hallucinated tool name counts against the budget.** Otherwise a model inventing names loops for
  free until the turn cap — the same runaway with extra steps. It is told what exists so it can
  recover rather than guess again.
- Observations are truncated to `AGENT_MAX_TOOL_RESULT_CHARS`, and the truncation STATES the original
  length so the model knows it saw a prefix rather than believing it saw everything.
- The daily `BudgetHandle` is checked before EVERY turn; exhaustion mid-loop keeps the turns already
  paid for rather than discarding them.

**RISK (b): regressing honest-no-answer.** Three independent guards, none of which the model can
talk past:
1. The similarity floor lives INSIDE `search_code`, with **no model-settable argument** — exposing
   one would be exposing the refusal gate as a tunable. A refusal is a fact the agent must work with,
   and the tool's text says explicitly not to guess from outside the repository.
2. **Grounding is enforced after the fact.** A chunk citation must resolve to a chunk actually
   retrieved this session; a file citation to a fileId a tool actually returned. *Existing in the
   repository is not evidence* — there is a test for exactly that.
3. **`answered: true` with no grounded evidence is DOWNGRADED to a refusal.** This is the one that
   matters: the check is on EVIDENCE, not on the model's claim, so a model that ignores every empty
   tool result and answers from pre-training cannot produce an answered response.

**Follow-ups resolve deterministically, in code.** `resolveFileArg` accepts an exact graph node, a
UNIQUE path suffix (models shorten paths), or falls back to the most recently resolved file entity —
and **REFUSES an ambiguous suffix**, because silently answering about the wrong file is worse than
not answering. It reports when it resolved from memory, or a transcript would be undebuggable. The
acceptance criterion ("what about its callers?" with no fileId argument) is covered by a test that
asserts the resolution AND that the prompt actually contained the prior turn.

Tool design rules worth recording: a tool NEVER invents a fileId (so anything cited from one is
grounded by construction); `find_references` LABELS direction, because imports-vs-imported-by is the
same confusion V3-P2's flywheel mines as a hard negative and an undirected blob would hand the model
exactly the ambiguity it is worst at; `get_callers` states its honest limit (call edges resolve
through the caller's imports) rather than presenting an approximate answer as exhaustive;
`get_blast_radius` uses `@codeflow/graph`'s own traversal, so the agent cannot drift from the product
on what "affected" means; `symbol_search` returns exact matches ALONE when there are any, because a
substring search that also surfaced 40 near-misses would bury the symbol the developer named.

A tool that THROWS is reported to the model as an error so it can try something else, and lands on
the trace — a bug, not an answer. `search_code` distinguishes an embedding-provider failure
(`error`) from "found nothing" (`empty`), because the agent must not read an outage as evidence that
the repository contains nothing relevant.

### Task 2 — `@codeflow/memory` (`0df9e1f`)

Two different things behind two interfaces, in a package depending only on `shared-types` + `config`
(no driver — production injects one, the V3-P0 pattern).

- **SESSION memory**: turns (including REFUSALS — a refusal tells the next turn what has already
  failed), retrieved-chunk history, and resolved entities most-recent-first with a re-mention MOVED
  rather than duplicated so the order encodes only recency.
- **REPO memory**: a small deterministic snapshot per commit — fileIds, `from>to` edges, symbol names
  per file, cycle keys, all sorted. Storing `AnalysisResult`s per SHA would turn a memory layer into
  a second database and re-introduce, per commit, the document-size problem V3-P2 just solved.
  Sorting is why two snapshots of the same tree are byte-identical and their diff is empty BY
  CONSTRUCTION; a cycle is keyed by its SORTED members, so the same cycle reported from a different
  starting node is not a new one. `changedFiles` compares SYMBOL SETS — the closest thing to "this
  file changed" without hashing contents, and better for "should I care?": a reformat produces
  nothing, a renamed export produces an entry. New cycles are called out separately because a cycle
  that did not exist last commit is a regression somebody introduced.
- **Everything is BOUNDED**, and not as a nicety: memory feeds the prompt, so unbounded memory is a
  context-budget bug that grows silently. `applySessionBounds` is shared by every implementation and
  applied on READ as well as write — two stores trimming differently would mean the same
  conversation behaved differently depending on whether Redis happened to be configured, which is
  the class of split V3-P0 removed from the budget.
- **A session is scoped to ONE analysis.** Appending under a different analysisId starts fresh,
  because silently mixing would let a follow-up resolve "it" to a file from another repository.
- **The Redis store FAILS SOFT and reports** — a different judgement from the budget's fail-open, for
  an analogous reason at smaller cost: a lost session means a worse answer to THIS question, which is
  recoverable and strictly better than a 500. It returns POST-append memory even when the write
  failed, because returning the pre-append state would be a lie about what memory holds.
- No clock is read anywhere (`capturedAt` is passed in), the same reason V3-P1's size guard is a byte
  ceiling rather than a timeout.

`what_changed` snapshots the CURRENT commit on the way in, so asking the question also makes this
commit a baseline for the next one — that is what makes the memory accumulate instead of needing a
separate ingestion step. It refuses an ambiguous SHA prefix and lists the commits it does know,
rather than diffing against an arbitrary baseline and producing a perfectly plausible wrong answer.

### Task 3 — context-budget hygiene (shipped with task 1, and here is why)

Task 3 IS task 1's bounds; a loop and the constraints that keep it affordable are not separately
shippable, so they landed in one commit.

- **Per-step tool curation.** A tool's `description` is prompt text, paid on EVERY turn whether the
  tool is called or not — six tools with two-line descriptions is a few hundred tokens of fixed
  overhead per call, times up to six turns, on every question. It is also a QUALITY lever: a model
  offered six tools picks worse than one offered three, because irrelevant options invite exploratory
  calls that cost a turn and return nothing.
  Rules are DETERMINISTIC — no model decides which tools a model may see, since that would be a paid
  call to save a paid call and would make the loop unreproducible. General-purpose tools are always
  candidates; trigger matches and already-used tools qualify; a tool EMPTY twice is dropped; the rest
  is capped at `AGENT_MAX_TOOLS_PER_STEP` and every omission is recorded with its reason. The
  empty-twice rule is the arguable one and is flagged as such in the code: it can in principle drop a
  tool that would have succeeded on a better-formed third call, accepted knowingly against a loop
  that burns its whole budget re-asking the same empty question.
- **Per-pillar token metering.** Broken down by pillar because a TOTAL only says the prompt grew,
  while the breakdown says WHICH of several unrelated bugs did it: memory growing is a bounds bug,
  tool descriptions growing is a routing bug, the transcript growing is an agent looping, retrieval
  growing is working as intended. The pillars SUM to the total, so nothing is unaccounted for.
  Estimated via the shared `estimateTokens`, with the reason V3-P0 gave for bundling no tokenizer —
  and `AgentTurnTrace.usage` carries the provider's authoritative cost separately. The two answer
  different questions: `usage` says what the turn cost, `context` says where the input went.

**Acceptance (per-call breakdown visible in a trace):** every `AgentTurnTrace` carries a
`ContextBreakdown`, `AgentTrace.totalContextTokens` sums them, `dominantPillar` names the largest
share, and there are tests asserting the pillars add up and that the dominant pillar is identified.

### Wiring (`19b236c`)

- Widened ADDITIVELY: `AgentAnswer` is a superset of `RagAnswer`, so the existing web app keeps
  working untouched and `sessionId`/`citedFiles`/`trace` are there for a client that wants them. Same
  for `AskHandler` — an existing test double returning a plain `RagAnswer` still satisfies it.
- **The single-shot path stays** as the fallback for an analysis with an index but NO GRAPH (a
  pre-V3-P1 cached result). The agent's advantage is exact graph lookups; with no graph its tools
  return nothing and it would burn turns discovering that. Not hedging — picking the better path for
  the data that exists.
- `sessionId` is runtime-validated (bounded length, restricted charset) because it becomes a STORE
  KEY: unbounded length is a memory-exhaustion vector and separators could collide with another
  namespace in a shared Redis. REJECTED rather than sanitised — silently rewriting would hand the
  client a session it cannot address again.
- A stateless ask creates NO session, or a shared store fills with single-turn sessions nobody can
  address.
- Session memory is Redis-backed when available, in-memory otherwise, with the fallback ANNOUNCED at
  startup. Repo memory stays in-memory deliberately, and the consequence is stated where it is felt:
  `what_changed` reports "only one commit analysed" after a restart. A shared store for it is P5
  wiring, not something to half-build here.

### Docker + a measured curation saving

The api image was rebuilt and both packages exercised INSIDE the pruned `node:20-slim` image (the
V3-P1/P2 discipline — "it compiles" is not "the dependency is there"):

```
agents loaded: true | tools: find_references,get_callers,get_blast_radius,symbol_search
memory loaded: memory-session-store / memory-repo-store
curated: get_callers | omitted: find_references:no-trigger-match, get_blast_radius:no-trigger-match,
                                symbol_search:no-trigger-match
pillars: {"instructions":100,"retrieval":1000,"memory":0,"tools":50,"transcript":0,"question":1,
          "total":1151} | dominant: {"pillar":"retrieval","share":0.869}
```

That curation line is the task-3 saving, measured rather than asserted: for "which files call
src/auth.ts?" **one of four** graph-tool descriptions is offered and three are omitted with their
reason recorded. Image cost of two new pure-TypeScript packages: api **365 MB → 366 MB (+1 MB)**.

### Verification

`pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` (serial), `pnpm -r build`, `node --test tests/*.mjs`
— all green. **881 unit tests**, up from 742 (**+139**):

| package | before | after | delta |
|---|---:|---:|---:|
| **agents (new)** | — | **91** | +91 |
| **memory (new)** | — | **45** | +45 |
| api | 39 | **42** | +3 |
| retrieval | 155 | 155 | — |
| analyzers | 234 | 234 | — |
| eval | 109 | 109 | — |
| arena | 68 | 68 | — |
| web | 60 | 60 | — |
| graph | 33 | 33 | — |
| parsers | 28 | 28 | — |
| worker | 13 | 13 | — |
| shared-types | 3 | 3 | — |
| **total** | **742** | **881** | **+139** |

Legacy `node --test`: **25/25**. `tsc --noUnusedLocals --noUnusedParameters` clean on both new
packages. **Hermetic**: the agent tests inject a SCRIPTED `LlmClient` whose entries can assert on the
prompt they received — which is what stops them being tautological, since checking that memory
reached the prompt checks the part we own, whereas checking that a mock returned what it was told to
return checks nothing.

### Judgment calls flagged

1. **Prompted tool-calling over native**, for the audit reason above. Recorded with its cost and its
   P5 upgrade path.
2. **Tasks 1 and 3 in one commit**, because task 3 is task 1's bounds.
3. **The empty-twice tool-drop rule** can lose a would-be third-call success. Accepted knowingly and
   documented at the rule.
4. **Repo memory is in-memory only**, with the user-visible consequence stated rather than papered
   over.
5. **The single-shot path was kept**, not deleted. It is the correct path for a graph-less cached
   analysis, and deleting it would have made those analyses worse to serve the tidiness of having one
   path.
6. **No new eval scenarios were added for the agent.** The multi-turn behaviour is covered by 91
   hermetic unit tests including the acceptance criteria; a scored multi-turn eval needs real keys and
   is in the deferred bucket. Adding a mock-driven "eval" would have measured the mock.

### Ledger

- **#21 (per-process Q&A answer cache) unchanged**, and now has a sibling worth naming: repo memory
  is per-process too. Both are the same P5 wiring task onto the Redis connection `redisClient.ts`
  already provides.


## 2026-08-31 — V3-P4: bounded agent fan-out + test-time compute (branch `v3/p4-agent-fanout`)

Two commits. Stage 7 becomes a fan-out of five specialist lenses over V3-P1's Louvain communities,
collected on a shared blackboard, synthesised by one supervisor — with all four of the brief's named
risks handled in code and MEASURED rather than argued.

**AUDIT FIRST.** `packages/analyzers/src/stages/synthesize.ts` is 347 lines: one prompt, a SHA-keyed
completion cache checked before any call, `estimateTokens` admission control then real-usage
recording, a 3-attempt retry on schema/grounding failure, `deriveSynthesis` enforcing
fileId-∈-graph-nodes with drop-and-count, and a throw on total failure that the orchestrator turns
into a "partial" run. That is the contract this phase had to preserve, and every clause of it now has
a test on the new path. `@codeflow/arena`'s grounding verifiers were already exact and free, which is
what made a no-model best-of-N scorer possible.

### Task 1 — orchestrator/worker fan-out (`07727f1`, wired in `e26039c`)

**Parallelism is EARNED.** Fanning five specialists over "the repo" would be five agents reading the
same files and reporting overlapping paragraphs — parallel in wall-clock and redundant in content.
The fan-out is over COMMUNITIES, which are low-coupling by construction (that is what modularity
measures), so per-community work is genuinely independent and the results genuinely compose. The five
lenses (architecture, data-flow, security, api-surface, dependency-risk) are five different
questions, not five copies of "analyse this", which is what lets a supervisor compose them.

**Never an open mesh.** Workers cannot see or address each other. Each posts STRUCTURED findings to a
blackboard; one supervisor reads a bounded selection plus deterministic graph facts.

**Specialists are given FACTS, not code.** The graph already knows the imports, calls, cycles,
symbols and routes for a community; handing those over is cheaper and more reliable than handing over
file contents for a model to re-derive — and it makes the claims checkable, because every fileId the
specialist may legitimately cite appears in that block.

#### RISK (b) — orchestrator context must not grow with worker count

The documented failure at 4+ workers, avoided structurally: findings are individually bounded and the
supervisor reads at most `SUPERVISOR_MAX_FINDINGS`, so its input is a function of the CAP and nothing
else. **Measured:**

| communities | findings on the blackboard | supervisor prompt | specialist calls |
|---:|---:|---:|---:|
| 1 | 5 | 417 tok | 5 |
| 3 | 15 | 667 tok | 15 |
| 12 | 60 | **668 tok** | 60 |
| 60 | 300 | **668 tok** | 300 |

**5× the workers and 5× the findings for the same 668-token prompt.** The selection is ROUND-ROBIN
across communities rather than a plain importance sort, and that detail is load-bearing: one
pathological community with five `high` findings would otherwise consume the entire cap, and the
supervisor would synthesise one corner of the repository while believing it had seen the whole
blackboard. Breadth first, depth second — so the cap degrades coverage gracefully instead of
catastrophically. The FULL finding list is still kept for the report and the trace; the bound applies
to the PROMPT, because losing the record would trade one problem for a worse one.

#### RISK — "parallel" that is parallel in name only

`peakConcurrency` is OBSERVED with a counter around each call, not inferred from a stopwatch: a
wall-clock comparison is flaky on a loaded machine and can pass by accident, whereas peak 5 means
five calls were genuinely in flight. The wall-clock number is reported too, because it is what a
reader wants:

```
maxConcurrency 1: 496ms, peak concurrency 1, 15 calls (15 jobs)
maxConcurrency 5: 126ms, peak concurrency 5, 15 calls (15 jobs)   → 3.9x
```

`mapWithConcurrency` is a worker POOL pulling from a shared cursor, not fixed batches — batching
idles the whole pool behind one slow call per batch, which on a provider with variable latency throws
away most of the saving. **That test was flaky in its first form and was fixed rather than loosened:**
`setTimeout(30)` against five `setTimeout(1)` calls failed on Windows, which clamps short timers, so
five "1ms" waits exceeded the 30ms one. Replaced with an explicitly-held promise, which removes
timing from the assertion entirely.

#### RISK (c) — N-times cost

Routing is deterministic and free — no model, no RNG. Four signals, each a real difficulty signal,
each CLAMPED so an outlier cannot dominate: size, coupling (external/(internal+external) edge
weight), cycles through the community, and symbol density. An edgeless community scores 0 on coupling
rather than 1, because dividing by zero and calling the result cohesion would be inventing a signal
from missing data. Weights are STATED as uncalibrated: the shape is defensible, the numbers are a
guess flagged for P5. Every route reports its dominant signal, so a decision can be argued with.

Two ceilings, because an unbounded router is an unbounded bill. `MAX_HARD_COMMUNITIES` caps the
N-times spend per run and is spent on the HARDEST communities (the plan is complexity-descending);
communities that qualified but missed the ceiling say so in their reason rather than looking easy.
`FANOUT_MAX_COMMUNITIES` caps how many are analysed at all, dropping the LEAST complex — and the
omission is reported, because a silent cap reads as "covered everything". **Measured:**

```
threshold 0.99: 0 hard, 20 calls,  0 best-of-N extra  ( 0% overhead)
threshold 0.50: 1 hard, 30 calls, 10 best-of-N extra  (33% overhead)
```

Sampling STOPS on a refusal — further samples would be paying to talk a specialist out of a correct
"nothing here". The scorer is EXACT and free (grounding 0.5, coverage 0.3, substance 0.2, with
substance capped because length is not insight): a judge per candidate on top of an N-times bill
would be unaffordable, and a scorer that varied run to run would make the winner unreproducible —
the two problems compound.

#### RISK (d) — agents must never mutate a deterministic slice

They are AI leaves. The graph, metrics and communities are computed before any agent runs and are
read-only throughout, and the only slice produced is `aiSynthesis`, which was always an AI slice.
Asserted rather than assumed: the spine is compared byte-for-byte across a fan-out, the ROUTING is
asserted identical across two runs even though the specialists are not, and the blackboard is sorted
before posting so entry order does not depend on scheduling.

### Task 2 — the per-specialist phase gate + guardrails

Four checks, all in code:

1. **Input safety** — a specialist sees only its own community's files, bounded to
   `SPECIALIST_MAX_FILES` and sorted before truncating (so which files it sees is deterministic).
   Bounded for cost, but mainly because a specialist reasoning over 400 files is reasoning over noise.
2. **Schema** — REJECTS rather than coerces. A headline coerced to `""` reaches the supervisor as an
   empty bullet that looks like a fact; a non-array `fileIds` coerced to `[]` silently turns a
   grounded finding into an ungrounded one. An absent `importance` defaults to `medium`, not `high`,
   because defaulting upward would let every finding crowd the supervisor's cap. An EMPTY findings
   array is treated as a refusal, so callers need one path rather than two.
3. **Grounding TO THE COMMUNITY** — stricter than "in the graph". A specialist on community 3 citing
   a file from community 7 has wandered outside its evidence, and accepting it would let the fan-out
   produce overlapping, unattributable claims. A finding left with NO grounded files is dropped
   entirely: an ungrounded claim is not a weaker finding, it is an unattributable one.
4. **Budget** — per specialist, so exhaustion SKIPS the remaining lenses instead of failing the run.
   Four lenses are worth more than none.

**Refusal = a first-class outcome with a reason** (the brief's "200 + reason"), never an error.
Treating "nothing to report" as failure pushes a model toward inventing findings, which is precisely
the wrong incentive for a security lens.

### Task 3 — test-time compute

Covered under RISK (c) above: routing by community complexity, N trajectories on the hard tail only,
each scored by the exact verifier, best kept. `bestScore` is recorded on the blackboard entry so a
winner is explainable, and `bestOfNExtraCalls` is reported separately from `specialistCalls` so the
extra bill is always attributable.

**On "verified quality lift measured on the eval":** what IS measured is that best-of-N picks the
better-scoring trajectory (a test constructs candidates of differing coverage and asserts the broader
one survives) and that the N-times cost is confined to the routed tail. What is NOT measured is a
quality lift on the golden set, because that needs a real model — a mock cannot be "better on its
second attempt" in any way that is not written into the mock. Deferred, and named as such rather than
faked.

### Wiring (`e26039c`) — risk (a): the Synthesize contract

All four clauses kept, each in the same shape rather than a similar-looking one, and each with a test:
grounding (dropped-and-counted, renumbered), CACHE (SHA-keyed, checked before any call, keyed on the
COMMUNITY PARTITION as well — a different partition is a different fan-out even at the same commit —
storing the OUTCOME because there is no single completion to cache, re-grounded on read, and NEVER
caching a fallback so a transient supervisor failure cannot freeze the degraded answer in for the
whole SHA), BUDGET (cache-before-budget; per-specialist checks degrade), and PARTIAL (throws only when
nothing is grounded at all — the same condition the single-shot stage threw on).

**The choice is made at RUN time, and has to be:** `metrics.clusters` does not exist until Analyze
(stage 6), but the worker assembles its stage list before the pipeline starts.
`createAdaptiveSynthesizeStage` delegates and keeps the SAME `id`/`kind`/`owns`, because a new id
would silently take stage 7 out of the orchestrator's coverage partition, cache lookup and
partial handling.

**The single-shot path is KEPT.** A cached pre-V3-P1 analysis has an index but no communities and is
still worth synthesising; deleting the older path to have "one path" would have made those analyses
worse to serve tidiness.

**OPT-IN via `FANOUT_SYNTHESIS`**, and the reason is cost SHAPE, not doubt: 5N+1 provider calls is
right for a real onboarding guide and wrong for a demo on a free tier. The worker logs which path it
will use at startup and which one ran per job.

### Docker (verified INSIDE the pruned image)

```
specialists: architecture,data-flow,security,api-surface,dependency-risk
adaptive stage: true | fanout stage: true
complexity: 0.567 | 20 file(s), coupling 0.89, 0 cycle(s), 0 symbol(s); dominant signal: size
routes: 0:hard:3 1:easy:1
```

That last line is the router doing its job in the shipped image: the 20-file, heavily-coupled
community routes HARD with 3 samples, the single-file one routes easy with 1. Worker image
**489 MB → 491 MB (+2 MB)** for the new orchestrator code — no new runtime dependency.

### Verification

`pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` (serial), `pnpm -r build`, `node --test tests/*.mjs`
— all green. **955 unit tests**, up from 881 (**+74**):

| package | before | after | delta |
|---|---:|---:|---:|
| **agents** | 91 | **164** | +73 |
| worker | 13 | **14** | +1 |
| retrieval | 155 | 155 | — |
| analyzers | 234 | 234 | — |
| eval | 109 | 109 | — |
| arena | 68 | 68 | — |
| memory | 45 | 45 | — |
| api | 42 | 42 | — |
| web | 60 | 60 | — |
| graph | 33 | 33 | — |
| parsers | 28 | 28 | — |
| shared-types | 3 | 3 | — |
| **total** | **881** | **955** | **+74** |

Legacy `node --test`: **25/25**. `tsc --noUnusedLocals --noUnusedParameters` clean. Hermetic
throughout — the fan-out tests drive a scripted `LlmClient` that can assert on the prompt it received.

### Judgment calls flagged

1. **`FANOUT_SYNTHESIS` is opt-in**, on cost shape. Enabling it by default would multiply every demo
   run's bill by roughly the community count.
2. **The single-shot path was kept**, for graph-less cached analyses. Same reasoning as V3-P3's
   fallback: keeping a path that is correct for real data beats tidiness.
3. **Routing weights are uncalibrated** and say so. The four signals are defensible; the numbers are
   a guess until a real corpus.
4. **The best-of-N scorer uses no model.** A judge per candidate would make N-times unaffordable and
   the winner unreproducible.
5. **"Verified quality lift on the eval" is deferred**, not faked — a mock cannot be better on its
   second attempt except by being told to be.
6. **The empty-community case falls back honestly** rather than fanning out over arbitrary file
   groups, which would produce the overlapping reports the community design exists to avoid.

### Ledger

No new items. The two carries this phase touches are already recorded: the routing weights and the
retrieval knobs are the same "documented default, uncalibrated" category as V3-P2's constants, all
resolved by the same deferred big-repo run.

---

## 2026-08-31 — V3-P5: marvel + reach (branch `v3/p5-marvel-reach`)

**BACKFILLED 2026-09-01.** This entry was never written when the phase shipped; it is reconstructed
from the six commits (`a49ca37` … `3748205`) and from reading the code they produced. Where the
backfill found a claim the code does not support, it says so here rather than in a footnote — those
gaps are what V3-FINAL then closed, and the next entry records the fixes.

Six commits, ~10,000 lines. The engineering-marvel layer (latency, observability) and the
distribution layer (MCP, local-first, deploy config), plus offline consolidation of the fan-out's
findings.

### Task 1 — latency (`a49ca37`)

**The measurement changed the design.** A first implementation used pure LAYER BARRIERS. The measured
layer shape is `[1,1,1,1,1,2,1]`: the deterministic chain is genuinely linear, and `rag` reads only
`{graph, structure, inventory}` — so it is ready one layer BEFORE `synthesize`, which needs `metrics`.
A layer barrier then blocks `synthesize` behind `rag` finishing, serialising the two SLOWEST stages
against each other. Exactly backwards. So stages launch by DEPENDENCY READINESS, not by layer.

The deterministic spine survives because each stage is launched with a snapshot holding every slice it
DECLARED, slices are per-key, and nothing mutates one after assignment. A test asserts byte-identical
slices across both modes, including the failure path. Per-stage timings are excluded from that
comparison — they are wall-clock facts about one execution, so a scheduler that changed nothing else
would still change them. Opt-in via `PARALLEL_STAGES`.

Also: a warm-up registry (the real cost is the tree-sitter WASM grammars — a one-time load whichever
job arrives first would otherwise pay), model routing behind `maybeRouted` (which returns the single
client UNWRAPPED when only one tier exists, so a deployment with no `FAST_MODEL` keeps byte-identical
cache keys), and a speculator with a staging layer and a real rollback.

**Measured, hermetically:** sequential 67ms → layered 38ms (**1.76×**) on the orchestration harness.
The note beside it is load-bearing: this measures ORCHESTRATOR OVERHEAD, not parsing — the hermetic
stages do no real work — so it is a bound on the scheduling win, not a claim about a real repository.

**TWO THINGS THIS TASK CLAIMED AND DID NOT DELIVER** (found by the V3-FINAL audit):
- `createSpeculator` had **zero production call sites**. The staging layer and the rollback — the part
  the module argues is the whole point — could never fire.
- `/health.warmedUp` on the API was **structurally always false**: the route read the shared registry
  and the API process registered nothing into it, and `warmedUp` is `required.length > 0 && …`. Not
  "false because cold" — incapable of ever being true. The suite asserted `false` and therefore passed
  forever while describing a broken endpoint.

### Task 2 — observability (`dd22e56`)

Not a direct OpenTelemetry dependency, and that is the design: `@opentelemetry/api` on its own is a
NO-OP (spans go nowhere without an SDK, an exporter and a collector), so it would add weight to every
consumer while changing nothing observable. Instead a `Tracer` interface with an in-memory RECORDER as
the hermetic default and OTel/Langfuse/Helicone as INJECTED adapters. The package depends on nothing.

Span ids are DETERMINISTIC (`s1`, `s2`, …), not UUIDs — a random id makes every recorded trace
unassertable. The interaction graph is DERIVED from the span tree rather than recorded separately, so
it cannot drift; nodes key on span NAME, so 60 `specialist:security` spans collapse to one node with
`calls: 60`, which is the difference between a readable fan-out and 300 flat rows. A trace with an
unended span reports `complete: false` and says so in the rendering.

**THREE THINGS THIS TASK CLAIMED AND DID NOT DELIVER** (found by the V3-FINAL audit):
- `exportersFromEnv` had **zero production call sites**. Every run built a full report and handed it to
  `deps.traceExporter`, which nothing ever supplied.
- `createVersionedBlackboard` had **zero production call sites**. The fan-out kept folding V3-P4's
  unversioned value, so "what did the supervisor see?" stayed unanswerable in production while being
  answerable in a unit test.
- **`Span.recordUsage` had zero call sites at all.** The headline claim — "cost is MEASURED, not
  estimated" — reported **$0.00 for every run**, because nothing ever fed it a number. The AI stages
  had the provider's real read-back in hand and dropped it. `RecordingTracerOptions.pricing` was
  likewise never supplied.

### Task 3 — MCP server (`39d913e`)

New `apps/mcp`. Dependency probe first, same discipline as the tree-sitter and reranker ones:
`@modelcontextprotocol/sdk@1.30.0` is 24 MB, 94 packages, pure JS, zero native binaries, zero install
scripts — adoptable, and isolated to this app.

What earns a place on the surface: an external agent already has file search and grep. What it does
not have is a code property graph, so the tools answer what grep cannot — who CALLS this, what BREAKS
if I change it, and the unusual one: is my answer actually TRUE. `verify_answer` gives an exact, free,
non-arguable verdict and REFUSES anything the graph cannot grade exactly rather than falling back to
an opinion. The tools are the SAME objects the internal agent uses, so the two cannot drift.

Scope allowlist, DEFAULT-DENY, three coarse scopes rather than one per tool (a 12-item allowlist is one
nobody reads, and the first person to hit a denial turns them all on). Unset ⇒ nothing is exposed. An
unknown scope name REFUSES TO START — a typo that silently denies is a debugging session, one that
silently permits is an incident. A denied tool is ABSENT from the list rather than present-and-refusing.

### Task 4 — local-first CLI (`6e07b59`)

Analyses a repository entirely on-device: no key, no socket, no code leaving the machine. It SHARES
the core packages — same stages, graph, chunker and grounding as the hosted path — and only the
embedder and the store differ, both behind interfaces V3-P2 built for exactly this swap.

**Two dependencies the plan named were probed and REJECTED on evidence,** with the substitutes named so
nothing reads as more than it is:
- **LanceDB** (`@lancedb/lancedb@0.37.1`): 656 MB installed, a platform-specific Rust NAPI binary, and
  it drags back `onnxruntime-node` (211 MB, already rejected in V3-P2) plus `sharp`. For a CLI whose
  selling point is running on a laptop with no toolchain, that is the opposite of the feature.
  Replaced by `createFileVectorStore` — JSON per namespace, exact cosine scan, same total order as
  pgvector. O(n) and wrong for a million chunks; correct for one repository, and inspectable with
  `cat`, which is what makes "zero egress" checkable rather than asserted.
- **int8 MiniLM**: `onnxruntime-web` is WASM-clean and would have been right, but the tokenizer it
  needs is itself NAPI. Replaced by feature-hashed bag-of-words.

Both substitutions are **OWNER-DEFERRED**, documented in the code, and re-confirmed by the V3-FINAL
audit as honestly labelled — see the STILL-REMAINING list in `VERIFICATION_REPORT.md`.

### Task 5 — deploy config (`4abd45f`)

Config only; nothing is run or deployed. Healthchecks for the worker and web, the two images without
one. A heartbeat FILE was considered and rejected: `docker` can check it but an autoscaler cannot read
it, and `pgrep node` proves only that the process exists — true of a worker wedged on a dead Redis
connection, the single most likely way it fails while looking alive. web probes nginx's OWN `/healthz`
rather than `/`, because the SPA fallback returns `index.html` for any unmatched path and would report
healthy with the entire asset directory missing.

`WORKER_CONCURRENCY` with the previous hardcoded 2 as the default. Out-of-range values are CLAMPED and
announced rather than rejected — a worker refusing to boot during a scale-out removes capacity at the
moment it is most needed. Resolved **ledger #20** (analysis-document overflow) and **#21** (the
per-process Q&A answer cache and repo memory, both now Redis-backed).

### Task 6 — offline consolidation (`3748205`)

A fan-out over 12 communities produces up to 60 findings; the supervisor reads 12 and the rest is paid
for and discarded. This consolidates all of them into a compact knowledge base before they are lost.

**Extractive, not generative,** and that is the central decision. Another LLM pass would spend money
compressing information the fan-out already paid to produce; it would make the KB NON-DETERMINISTIC,
so the same analysis yields a different KB each run and one you cannot diff, cache or trust twice; and
it would add a new place for an ungrounded claim to enter immediately after the fan-out grounded every
fileId to its own community. So: sorting, merging, de-duplicating, templating. Byte-identical for
identical input, and independent of blackboard append order — which matters because findings arrive
from concurrent specialists, so their order is a race.

Corroboration is what consolidation ADDS: when two independent lenses make the same point, that
agreement is stronger than either alone and invisible in a flat list.

**WHAT THIS TASK CLAIMED AND DID NOT DELIVER**: the knowledge base was built inside the run and then
discarded with it. Nothing persisted it, so no surface could show a user what five specialists found.
V3-FINAL added `AnalysisResult.ai.domains` as a bounded, re-grounded projection.

### Gates at the end of V3-P5

| package | tests |
|---|---:|
| agents | 201 |
| analyzers | 283 |
| arena | 68 |
| config | 0 (no test files) |
| eval | 109 |
| graph | 33 |
| memory | 62 |
| observability | 42 |
| parsers | 28 |
| retrieval | 155 |
| shared-types | 3 |
| api | 79 |
| local-cli | 17 |
| mcp | 33 |
| web | 60 |
| worker | 34 |
| **total** | **1207** |

typecheck ✅ · lint ✅ · 1207 tests ✅ · build ✅ · legacy 25/25 ✅ · compose config ✅

### Honest deviations, stated at backfill time

1. **Four modules shipped with no production call site** (`createSpeculator`, `exportersFromEnv`,
   `createVersionedBlackboard`, `Span.recordUsage`) and **one flag was structurally always false**
   (`/health.warmedUp` on the API). Each had a full test suite, which is why the gates stayed green:
   a unit test proves a module WORKS, not that anything USES it. All five are closed in V3-FINAL.
2. **The latency speedup is orchestration-only.** 1.76× on a harness whose stages do no real parse or
   clone work. A real-repository number needs `scripts/live-benchmark.mjs` against a deployed URL —
   owner-manual, and in the runbook.
3. **The MCP server has never been called by an external agent.** It is unit-tested against its own
   tool objects; a real Cursor/Claude Code session is the proof and it is manual.
4. **Local vector store and local embeddings are substitutions, not the planned implementations.**
   Owner-deferred; both need heavy downloads that would break hermeticity.
5. **`/metrics` queue depth, autoscaling and the CDN are config.** Nothing was deployed.

---

## 2026-09-01 — V3-FINAL: wire-in + frontend build + verify (branch `v3/final-build-verify`)

Nine commits. Every built-but-unwired module from V3-P5 put on a live path, the whole frontend built
from the design against real data, and a verification pass over Phases 0–5 whose findings are in
`VERIFICATION_REPORT.md`.

**THE THEME, stated once because it is the same defect eight times: a unit test proves a module
WORKS. It does not prove anything USES it.** Every gap closed below had a full, passing test suite
and a green gate. What none of them had was a call site.

### Part 1 — the four unwired modules and the always-false flag

#### `exportersFromEnv` — trace export at the composition root (`02c89fc`, P5 DoD 2d)

The recording tracer ran on every job and built a full report — per-span cost, the interaction graph,
error spans — and handed it to `deps.traceExporter`, which nothing ever supplied.

`exportersFromEnv` returning null is the RIGHT answer to "is a backend configured" — that is why it
refuses to hand back a no-op object — but a composition root still has to decide what the exporter IS
when the answer is null, and `undefined` is what shipped. So the default is now a bounded in-memory
replay buffer: no network, no key, no dependency, oldest reports dropped first with the drop COUNTED.
Langfuse/Helicone fan out beside it when their env is set, buffer first so a remote failure costs
neither. The real network send stays deferred BY CONSTRUCTION — no test sets that env and no default
provides it.

`/metrics` now reports the exporter id, `remoteConfigured`, exported/retained/dropped counts and the
last trace's cost with its `measured` flag. The test asserts 0 exported before a run and 1 after,
which is exactly the assertion the V3-P5 wiring could not pass.

#### `/health.warmedUp` — the API's real warm-up tasks (`3e14116`, P5 DoD 1e)

Structurally always false. Now three real tasks: `mongo-connection` (REQUIRED — the readiness anchor,
because `index.ts` refuses to boot without it), `shared-redis` (not required; every consumer degrades
honestly, and configured-but-unreachable records FAILED so `/health` names it), and `qa-dependencies`
(only when a provider is configured), which pre-resolves the answer cache, budget, session and repo
memory, and the `CREATE EXTENSION` / `CREATE TABLE` round trip that was previously paid INSIDE the
first `/api/result/:id/ask`. No probe requests: clients are constructed, never called.

Registration is an injected, testable module rather than three lines in `index.ts` — putting it there
would have reproduced the same bug in a new place: real behaviour no test can see. It is NOT in
`createApp()`, because the suite builds the app dozens of times and warming a process-global singleton
from a factory would make health assertions order-dependent.

The old assertion is UPDATED rather than deleted: this suite genuinely registers nothing, so `false`
there is now the honest answer, and it additionally asserts `tasks: []`, which is WHY.

#### `createVersionedBlackboard` — replay on the live fan-out (`7c0527a`, P5 DoD 2e)

The running state now LIVES in the append-only log. `post()` still computes the next immutable value
and each is appended with the specialist that wrote it and what it contributed. There is deliberately
no running `board` variable alongside it: a second copy is a second place the state could live, and
the first time they disagreed the log would be the one that looked authoritative while being wrong.
`blackboard` and the log's HEAD are asserted equal.

The supervisor's READ is recorded against the version it saw, with a note carrying the bounded
selection ("shown 12 of 15 finding(s), 668 prompt token(s)"). The note needs the selection count,
which is why the code PEEKS with `at()`, builds the prompt, then records the read — and a version
moving between those two steps would misattribute every replay, so it is checked and warned rather
than assumed.

`maxVersions` is DERIVED (`clusters × specialists + 2`), so a full-size fan-out can never trim. The
clock is injected and defaults to a CONSTANT: two runs of the same input produce a byte-identical
history, because a history you cannot diff is not one you can use to compare runs. The log is
in-process only — a per-write history of a 60-entry fan-out is exactly the growth ledger #20 tracks.

#### `createSpeculator` — speculative prefetch in the orchestrator (`2c069fa`, P5 DoD 1d)

**Stages declare, the orchestrator launches.** Speculation needs two facts that live in different
places: only the orchestrator knows a stage's reads are satisfied while the stage has not started
(i.e. that there is a wait to spend), and only the stage knows its own cache key and how to fill it.
`StageSpeculationSource` is the narrow optional capability that joins them, following
`StageEmbeddingTarget`'s precedent.

The one that pays for itself is RAG's chunk plan: a pure disk+CPU pass over every source file — no
provider, no money — computable the moment `connect` lands, while the stage that needs it runs LAST,
after `synthesize` has spent seconds blocked on a chat provider. In sequential mode (the default) that
wait was entirely unused. **The test proves the disk pass happens ONCE, not twice.**

Safe to default ON where layered scheduling is not: same function, same frozen prior slices, so the
staged value is byte-identical — asserted by running the real pipeline both ways and comparing the rag
slice. A claimed plan is still GROUNDED on the way in; "we computed it ourselves" is a reason to
expect grounding to hold, not to stop checking.

**Two real bugs in the unwired module, both found only by wiring it:**
1. A queued task was **invisible to `claim`**. `staged` was populated when `pump()` dequeued, so
   anything past the concurrency bound returned null: the caller recomputed the work AND the queued
   task later ran and was discarded. The bound turned a hit into a miss plus a duplicate — worse than
   not speculating. It was latent because the one test that over-queued asserted peak concurrency and
   never checked that the claims returned values.
2. `commit()`/`rollback()` cleared the maps but **left the queue**, so unclaimed tasks kept starting
   after the run had decided what it wanted. "A wrong guess costs exactly the CPU it used" is only
   true if we stop starting new ones.

#### Beyond the brief: the measured cost reached nothing (`7fcb760`)

Found while auditing for unwired code, and the same defect class:

- **`Span.recordUsage` had zero call sites.** "Cost is MEASURED, not estimated" reported **$0.00 for
  every run**.
- **`RecordingTracerOptions.pricing`** was an accepted option no composition root supplied.
- **THE WALLET BUG.** `budget.record` sat AFTER the schema/grounding check in synthesize and AFTER the
  whole batch loop in RAG. A completion the grounding check rejected was **never recorded**, and a
  throw on embedding batch 7 discarded batches 1–6. The provider charged for all of it. Three rejected
  synthesis attempts spent real money against a daily ceiling that never saw a token — the wallet
  guard was blind to exactly the failure mode that retries most, and the retry loop makes it a
  multiple rather than a rounding error.

Fixed: `ProgressEvent.usage` as a first-class field (not three numbers through `preview`, because it
carries `measured` and an honesty flag a loose record can drop is one that will be); the orchestrator
FORWARDS it; synthesize charges the moment `complete()` returns and emits an interim event per call;
RAG charges per batch; the worker records usage from EVERY event, not just terminal ones — an AI
stage's terminal event only exists on the success path, so attributing cost only there reports zero
for a run that spent money and then failed. `pricingFromEnv(LLM_PRICING)` returns an EMPTY table when
unconfigured, so `usd` is `null` and the unpriced models are NAMED. `AnalysisResult.cost` (six numbers,
attached before `saveAnalysis`, omitted when nothing was spent).

**Measured on the retry path: 3 paid attempts, $31.50, recorded three times** — the case both halves
of the bug hid.

### Part 2 — the frontend, from the design

The claude_design MCP could not authorize in a non-interactive session, so the build is from the
written spec plus the twelve screenshots the owner supplied; motion is a judgement call inside the
design DNA, and that is recorded in `VERIFICATION_REPORT.md`.

#### The data first, so no component had to invent anything (`b3bf10a`)

- **`apps/web/src/lib/architecture.ts`** (35 tests): container lanes from role + PATH SEGMENTS, never
  substrings (`src/dbutils/` is not the data lane); every assignment carries `matchedBy` so a hover can
  say WHY; an unplaceable module renders UNCLASSIFIED rather than being dropped. Edge classification
  with exactly the two owner-sanctioned violation rules and no third. Hop-tiered blast radius by
  SHORTEST distance. MOVE impact as a genuinely different question from CHANGE — a rename breaks only
  direct references, and counting four-hop dependents would inflate it into a refactor.
- **`AnalysisResult.ai.domains`** (11 tests): the bounded, re-grounded projection of the fan-out's
  knowledge base. Titles DERIVED from real shared paths, because a model-written title reads as a fact
  while being a guess.
- **`/api/meta`** + `answerLatency.ts` (11 tests): analyzer version, build SHA (null when unset — a
  build id nobody can look up is decoration), the measured p50 with its per-process scope and sample
  count travelling WITH it, and REAL indexed analyses. Refusals are excluded from the latency window —
  a metric that improves when the product fails to answer is worse than none.
- **`siteModel.ts`** (23 tests): maps the design's six rows onto the real eight stages, and makes the
  three grounding states the run's ACTUAL delivered scope. Distinguishes "nothing was spent" from
  "unpriced" — two different em-dashes.

#### The two surfaces (`e34cedd`)

**THE MOCK PATH IS GONE.** `PublicRepoInput` shipped a "Use Mock Data Instead" button that loaded
fabricated module names, paths and metrics into every dashboard view. A user could not tell it from a
real analysis. Deleted; nothing replaces it. The fixture moved to `src/test/fixture.ts`, which makes
the boundary structural rather than a matter of discipline.

Four em-dashes with nothing analysed, each with its reason. The status pill reads CONNECTING / READY /
OFFLINE, green only when `/api/meta` answered. The hero mesh carries a visible "representative shape ·
not a repository" badge. TAB 04 labels inference three times over and does NOT substitute the
community partition when there are no lanes. TAB 01 omits the violation legend key when no rule fires.
TAB 03's coverage card is relabelled to what it actually knows. TAB 02 states the provenance of the
reading order.

The radial layout replaces the force simulation: `react-force-graph-2d`'s positions are
non-deterministic and encode nothing, whereas ring = fan-in rank means distance from the centre is how
foundational a module is, and two runs draw the same map. Dropping it and `zustand` also removed two
dependencies.

**Removed as dead code, not as a missing feature:** five ui primitives, `graphView`, `pipeline`,
`dashboard`, `analysisNormalizer`, `types/web` — all zero shipped importers after the new views
landed. Their 23 tests went with them. Also fixed: the web suite never called RTL `cleanup`, so every
render leaked into the next test.

### Part 3 — verification

Full report in `VERIFICATION_REPORT.md`. One finding fixed here:

**`refactor(eval)` (`65fed98`)** — V3-P0 §0.5 wrapped the grounding passes as Arena verifiers so "the
eval and the Arena stop needing their own copies". They did not: `answerScore.ts` kept its own
`containedInRetrieved` and `createCitationVerifier` had zero consumers outside the Arena's own suite.
The reason is the interesting part — a `Verifier` is async and sandbox-aware while `scoreAnswer` is a
synchronous pure function, so the wrapper was the wrong SHAPE to share. The RULE is now exported on
its own and both callers use it. The eval keeps its own zero-citation policy, deliberately, and a test
says why.

### Gates

| package | before (V3-P5) | after | Δ |
|---|---:|---:|---:|
| agents | 201 | 225 | +24 |
| analyzers | 283 | 305 | +22 |
| arena | 68 | 68 | — |
| config | 0 | 0 | — |
| eval | 109 | 113 | +4 |
| graph | 33 | 33 | — |
| memory | 62 | 62 | — |
| observability | 42 | 55 | +13 |
| parsers | 28 | 28 | — |
| retrieval | 155 | 155 | — |
| shared-types | 3 | 3 | — |
| api | 79 | 102 | +23 |
| local-cli | 17 | 17 | — |
| mcp | 33 | 33 | — |
| web | 60 | 88 | +28 |
| worker | 34 | 49 | +15 |
| **total** | **1207** | **1336** | **+129** |

typecheck ✅ (exit 0) · lint ✅ (exit 0) · 1336 tests ✅ · build ✅ (exit 0) · legacy 25/25 ✅ ·
compose config ✅ · keyless eval check ✅ (byte-identical across two loads)

Web is +28 NET: 51 new tests less the 23 that went with the deleted modules.

### Honest deviations

1. **The design came from the spec and screenshots, not the MCP.** `claude_design` cannot authorize
   in a non-interactive session. Layout, type, colour and copy are from the contract; motion and
   easing are a judgement call inside the design DNA.
2. **Two views were STOPPED on and asked about** rather than guessed: the architectural violation rule
   set, and the coverage card. Both answered by the owner and built to the answer.
3. **Cost is measured but UNPRICED by default.** `LLM_PRICING` is unset, so `usd` is null and the
   models are named. Tokens are measured either way. Setting it is a GO_LIVE step.
4. **The p50 is per-process.** In-memory, does not survive a restart, and two replicas report two
   numbers. Stated in the payload (`scope: "process"`) and rendered with its sample count. Making it
   global is the same Redis wiring ledger #21 tracked for the answer cache.
5. **No browser screenshot.** The suite drives the real component tree in jsdom (31 interaction tests)
   and the production bundle builds and serves, but nothing in this environment renders pixels.

---

## 2026-09-01 — V3-SECURITY+DEPLOY: CodeQL triage + deploy-ready config (branch `V2-codeflow`)

Two jobs on the pushed branch: get PR #1's blocking check green **honestly**, and make the app
deployable to a non-AWS host. **Nothing was deployed, `main` was not touched, PR #1 was not merged.**

### A. CodeQL — 22 alerts, 22 FIXED, 0 dismissed

The check said "17 new alerts including 17 high severity". The real number on `refs/pull/1/merge`
is **22**; GitHub attributes only some of them to the diff because the change was large enough that
it stopped trying. **Ten of the 22 also stand open on `main`** — pre-existing, not introduced by
this branch, and fixed here anyway: leaving a known-exploitable pattern in place to keep a diff
tidy is not a triage decision.

All 22 are one rule, `js/polynomial-redos`. **Nothing was dismissed, because nothing was
dismissible.** This app clones an arbitrary public repository and runs regexes over its source
text; "untrusted input reaches a regex" is the product here, not a theoretical taint path.

Each alert was settled by MEASUREMENT, not argument — every flagged pattern run against the input
its own alert message described, at 4 000 and 16 000 characters:

- Seven grew **15.7–16.0× for 4× the input**: quadratic, exactly as predicted.
- **Three are CUBIC** and did not finish at n=4 000 within twenty seconds — they pair three
  quantifiers that can all claim the same character. The fence regex took 31 ms at n=250 and 322 ms
  at n=1 000.

Two alerts needed real work to confirm rather than assume, and both confirmed:

- The Python import patterns LOOK unreachable, because every caller passes `line.trim()` and a
  trimmed string cannot end in whitespace. The exploit is **U+2028 LINE SEPARATOR**: whitespace to
  `\s`, invisible to `.`, and `splitLines` splits on `\r\n|\r|\n` only — so it sits INSIDE a line
  and survives the trim. That is the 608 ms measurement.
- `slug()` takes `repoFullName`, which is user-supplied. `/^-+|-+$/g` looks safe because the `^-+`
  alternative short-circuits — but only when the string STARTS with a dash. A name of punctuation
  collapses to a dash run with content either side, and `-+$` is then quadratic.

CodeQL's precision is itself part of the verdict. It did NOT flag the `\*`-pinned namespace-alias
pattern two lines above one it did, nor the `^`-anchored named-export pattern; both are genuinely
linear, because each has exactly one viable start position. A query that flagged every `\s+` would
have flagged those too. There was no honest dismissal available.

**Fixes**, in order of preference: pin the boundary between adjacent quantifiers so only one split
is viable (`(\S.*)`, `import\s+(?=\S)`, `=[^=]*=>`), or drop the regex for an index scan when
pinning would change what the pattern accepts (`namedBraceBody`, `stripCodeFence`,
`stripTrailingCodeFence`, `stripTrailingBlockComment`, `trimDashes`, `splitAliasSegments`).

Two new modules: `packages/parsers/src/utils/importScan.ts` and
`packages/analyzers/src/llm/completionText.ts`. **The five identical copies of the cubic fence
regex became ONE shared linear unwrapper** — the same consolidation V3-FINAL did for the citation
rule, for the same reason.

**After: every one of the 22 handles 200 000 characters in 0.1–1.9 ms**, against inputs that cost
the removed patterns ~95 seconds (measured quadratic, extrapolated) to hours (the cubic three).

`=[^=]*=>` looks like a weakening and is not: every component the old pattern spelled out after the
`=` — `\s*`, `async`, `\(`, `\)`, `\s*` — is a subset of `[^=]`, so the concatenation IS `[^=]*`.
Same language, written without the ambiguity, and `[^=]*` cannot cross the `=` of the arrow, so it
has one place to stop instead of one per space.

**Every replacement was differentially tested against the pattern it replaced BEFORE any source
file was touched.** That is what caught two first attempts that were wrong: the first arrow fix was
still 40 SECONDS at n=200 000 (the ambiguity was the `\s*` before the class, not the group after
it), and a `[^{}]`-based brace match is linear but changes the captured text on nested braces.
Guessing at the fix and running the suite would have shipped both.

Two intentional behaviour changes survived the differential, both only on input that is not valid
source in any dialect these parsers claim, and both asserted in tests so they are on the record:
`import "a" from "b"` now reads as a side-effect import of `a` (the lazy `(.*?)` was free to
swallow a quoted string and reported `b`), and the shared alias splitter is case-sensitive — the
two JavaScript call sites used `/\s+as\s+/i` and so also matched `AS`, which is the keyword in
neither language.

**One prescribed measure deliberately NOT taken.** The brief also said to bound input length. With
every pattern now linear at 200 000 characters in under 2 ms, a bound adds no security — and a
line-length cap in a fallback parser silently stops reporting imports on minified or generated
files, returning FEWER dependency edges with no signal that it gave up. That is precisely the quiet
wrongness the grounding rules exist to prevent. Recorded as a decision in `SECURITY_TRIAGE.md`
rather than skipped in silence.

**Regression tests assert a 2 000 ms budget on a 200 000-character pathological input.** The
measurements are what make that a gate and not a formality: three orders of magnitude of headroom
for a linear implementation, unreachable for a quadratic one. The old patterns are deliberately NOT
kept in the test files — a test that asserts code is SLOW fails for good reasons on fast hardware,
and re-introducing the vulnerable pattern to prove a point puts it back in the tree. Parser-level
tests sit alongside the helper-level ones (`pythonParser.parseFile`, `javascriptParser.parseFile`,
`extractCpgFacts`, `deriveEnrichment`, `retrievalNamespace` each driven with hostile input),
because a helper test proves the helper is linear and only the caller test proves the fix is on the
path the product uses.

### B. Deploy-ready config — non-AWS, and NOTHING was deployed

`render.yaml` (Blueprint) + `DEPLOY.md` (ordered walkthrough, Railway appendix). Five services: api
(docker web, `healthCheckPath: /health`), worker (docker worker), web (static + SPA rewrite),
Postgres 16 with pgvector, and a Key Value instance. One shared env group, every secret
`sync: false`.

**One code change was genuinely required, and it was a live bug.** The API read only `API_PORT` and
called `app.listen(env.apiPort)`. Render, Railway, Fly and Heroku all assign the port at boot as
`PORT` — so the API would have bound 4000 while the proxy routed somewhere else, and been reported
unhealthy with no useful error anywhere. `resolvePort` now resolves `API_PORT` → `PORT` → 4000 with
the source NAMED in the boot log, binds `0.0.0.0` explicitly, and WARNS when both are set and
disagree rather than resolving it quietly. Precedence favours the explicit name deliberately: an
operator who set `API_PORT` meant it, and honouring `PORT` over it would silently change an
existing self-hosted deployment.

It also closes a latent bug on the old path: `Number(process.env.API_PORT || 4000)` on a typo
produced `NaN`, and `listen(NaN)` binds a RANDOM free port — a failure that looks like success.

`X-Accel-Buffering: no` added to the SSE route. A managed host fronts the app with an nginx-family
proxy that buffers a response body by default, which turns a progress stream into one delivery at
the end: the stream still passes every test and is useless in production.

**pgvector needed no new bootstrap, and none was invented.** `ensureSchema()` already runs
`CREATE EXTENSION IF NOT EXISTS vector`, the dimension-typed table and the HNSW cosine index, with
`ensureSchema` defaulting ON and the dimension in the TABLE NAME so two embedding spaces cannot
share a table. One assertion was missing and is now added: that EVERY DDL statement carries
`IF NOT EXISTS`. A redeploy re-runs them, and one non-idempotent statement throws, is caught by the
store factory, and degrades the whole index to per-process memory — for a reason that reads like a
connection problem.

**`.env.example` was incomplete**: ten variables the code reads were undocumented (`PORT`,
`WORKER_CONCURRENCY`, `WORKER_HEALTH_PORT`, `LLM_PRICING`, `GIT_SHA`, `SOURCE_COMMIT`,
`CODEFLOW_API_URL`, `CODEFLOW_GIT_TIMEOUT_MS`, `EVAL_DATASET`, `EVAL_FAIL_ON_THRESHOLD`). Added.

**Two errors in `GO_LIVE.md` found and corrected** while folding the deploy steps in. It listed
`DAILY_LLM_BUDGET` as an env var — it is a compile-time constant in `@codeflow/config`
(`5_000_000` tokens), so setting it in the environment does nothing and moving the wallet ceiling is
a code change. And it named the MCP scope variable `MCP_SCOPES`; the variable is
`CODEFLOW_MCP_SCOPES` (`MCP_SCOPES` is an unrelated TS constant listing the valid scope names).

**Two things the Blueprint cannot do, stated rather than papered over.** `CORS_ORIGINS` needs the
web URL while the web build needs the API URL — a mutual reference Render cannot resolve on first
create, so it is `sync: false` and a numbered step; until it is set the browser gets CORS errors
against a perfectly healthy API. And a static site has no entrypoint, so the runtime `/config.js`
injection cannot run and the API URL is baked at build time — `apiClient.ts` already prefers the
runtime value and falls back to the built one, so the Docker path is unchanged and Railway can use
it.

Also caught while writing the runbook: Render does not expand `$VAR` inside an envVar `value:`, so
`https://$CODEFLOW_API_HOST` would have been baked into the bundle literally. The expansion moved
into the build command, which is a real shell.

**One observability gap found and REPORTED, not fixed.** The retrieval backend's degradation is
announced in the LOGS only; `/health` reports Mongo and warm-up but not whether Postgres was
reached, so "the API is up" and "the API can answer anything the worker indexed" are not
distinguishable from any endpoint. `DEPLOY.md` gives the exact log lines and makes the functional
cross-process ask the definitive check. Adding a health field is a real improvement and out of
scope for a config pass.

`apps/mcp` and `apps/local-cli` are deliberately absent from the Blueprint: one speaks stdio to a
model client on a developer's machine, the other runs on a laptop and its whole selling point is
that no code leaves it. Their channel is `npm publish`, not a deploy.

### C. A red tree, caught — and what it was not

The first full-gate run was killed at a 10-minute tool timeout MID-`tsc`, leaving truncated `dist`
output. The next run reported 20 analyzers failures that looked exactly like a behaviour regression
in `retrieval`. Bisecting by stash pointed at `namespace.ts` — but a differential test of the slug
function old-vs-new found ZERO divergence on any input, so the code could not be the cause. A clean
`rm -rf dist` rebuild passed 313/313 with every change applied.

Recorded because the reasoning generalises, and because it is the same family as the masked-exit-code
mistake V3-FINAL recorded: an interrupted build is not a neutral event, and a failure whose bisect
and whose differential test DISAGREE is evidence about the tree, not about the change. The fix was
to make the gate script clean `dist` first and report a real exit code per stage rather than piping
into `grep`.

---

## DEFERRED TO MANUAL PHASE (P5/P6)

Everything below is BUILT, hermetically tested and integration-ready, but needs real infra, real
keys, real spend or a real clock to actually run. Nothing in these phases blocks on any of it.

**Retrieval infra (V3-P2)**
1. **Real pgvector integration run.** `docker compose up -d postgres` (the `pgvector/pgvector:pg16`
   service added in V3-P2), set `POSTGRES_URL=postgres://codeflow:codeflow@localhost:5432/codeflow`
   for BOTH the api and the worker, then analyse a repo and ask a question. What this confirms that
   the hermetic suite cannot: that Postgres accepts the emitted DDL and SQL, that `CREATE EXTENSION
   vector` succeeds, and that HNSW recall is acceptable at real scale. The adapter's SQL is already
   asserted against a recording fake, so this is a confirmation rather than a first check.
2. **Reranker weights + a real cross-encoder.** Blocked on a WASM-clean tokenizer, not on effort —
   see the V3-P2 probe table. The path if it becomes worthwhile: `onnxruntime-web` (no install
   script, no native binaries) + a JS WordPiece implementation, behind the existing
   `CrossEncoderSession` interface. Nothing else changes.
3. **The scored eval (#17) + `EVAL_THRESHOLDS` calibration.** Needs `GEMINI_API_KEY` and spends
   money. Since V3-P2 it needs TWO inputs per dataset: `results/<name>.json` (the `AnalysisResult`)
   and `results/<name>.index.json` (the chunk text + vectors, which no longer travel inside the
   result). The CLI names the exact shape when either is missing.
4. **The real-model enrichment recall@k on the golden set.** The hermetic A/B measured +0.500
   recall@3 with a bag-of-words embedder; the magnitude a real embedding model shows is unmeasured.
5. **A big-repo end-to-end run**, which is also the decision point for ledger #20 (whether the
   graph slice needs externalising too) and for the P4-flagged chunking constants
   (`MAX_CHUNK_TOKENS`, `WINDOW_CHUNK_LINES`) and the P5-flagged retrieval knobs
   (`RETRIEVAL_*`, `BM25_*`, `RRF_K`, `MMR_LAMBDA`) — every one of which is a documented default
   with no calibration against this repo's own eval.
6. **BullMQ/SSE wire smoke** (`pnpm dev:api` + `pnpm dev:worker` against the dev compose stores).

**Agentic Q&A + memory (V3-P3)**
10. **A real multi-turn agent run with keys.** Needs a chat provider; the whole loop is covered
    hermetically with a scripted client, so this measures real-model behaviour (how often it picks the
    right tool, how often output is unparseable) rather than whether the plumbing works.
11. **The Redis session store against a live Redis.** Driven in-suite against a fake `MemoryRedisLike`
    — key scheme, TTL, serialisation and bounds are all asserted; what remains is the round trip.
12. **A shared repo-memory store.** Repo snapshots are per-process today, so `what_changed` reports
    "only one commit analysed" after a restart. Same P5 wiring task as ledger #21's answer cache, onto
    the Redis connection `redisClient.ts` already provides.
13. **Scored multi-turn eval scenarios.** Needs keys, and needs a real model in the loop for the
    numbers to mean anything.

**Bounded fan-out + test-time compute (V3-P4)**
14. **A real multi-agent run with keys** (`FANOUT_SYNTHESIS=true` + a chat provider). The whole
    orchestrator is covered hermetically with a scripted client, so this measures real-model
    behaviour — whether the five lenses genuinely produce complementary findings, and how often a
    specialist refuses when it should.
15. **Verified quality lift from best-of-N, on the eval.** What is measured hermetically is that the
    better-scoring trajectory wins and that the N-times cost stays on the routed tail. A LIFT needs a
    real model: a mock cannot be better on its second attempt except by being told to be.
16. **Calibrating the routing weights** (size/coupling/cycles/density) and the hard threshold against
    a real corpus. Same big-repo run as the V3-P2 retrieval knobs.

**Owner setup**
7. A GitHub `eval` environment + the `GEMINI_API_KEY` secret, for the scored-eval workflow's
   approval gate.
8. Hand-label >= 20 (answer, chunks) pairs to promote the judge from advisory to gating. No
   placeholder labels were shipped on purpose.
9. `git push` for CI on every V3 branch.
