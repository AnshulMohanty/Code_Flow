# CodeFlow — Verification Report

**Date:** 2026-09-01 · **Branch:** `v3/final-build-verify` (off `v3/p5-marvel-reach` @ `ca89bb1`)
**Scope:** Phases 0–5 plus every change made in the V3-FINAL pass.

Gate at the start: typecheck ✅ · lint ✅ · **1207 tests** ✅ · build ✅ · legacy 25/25 ✅
Gate at the end: typecheck ✅ (exit 0) · lint ✅ (exit 0) · **1336 tests** ✅ · build ✅ (exit 0) ·
legacy 25/25 ✅ · compose config ✅ · keyless eval check ✅

**The one sentence this report exists to make concrete:** a unit test proves a module WORKS; it does not
prove anything USES it. Five features shipped in V3-P5 with complete, passing suites and no call site,
and the gates were green the entire time.

---

## A. Per-check verdicts

### 1. No hollowness, and no built-but-unwired modules — **CONCERN → RESOLVED**

**Hollowness: PASS.** A sweep for `TODO|FIXME|XXX|HACK|not implemented|@stub` across every non-test path
in `packages/*/src` and `apps/*/src` returns **two** hits, and neither is a stub:

| Location | What it is |
|---|---|
| `packages/eval/src/thresholds.ts:37` | A labelled `TODO (owner, out-of-band)` on threshold CALIBRATION. The code is real; the constants are marked `PLACEHOLDER` and `eval-scored.yml` defaults `fail-on-threshold` to FALSE so nothing gates on them. Ledger #24. |
| `apps/api/src/routes/analyze.ts:85` | A TODO proposing an inline runner *as an enhancement*. The code there today does the right thing: it fails honestly with a 503 and marks the job failed rather than fabricating a result. |

**Unwired modules: this is where the pass found its work.** The audit (script preserved at
`scratchpad/unwired.mjs`) greps every exported RUNTIME symbol of every package barrel for a call site
outside its own file, its barrel, and the test suite. It reported 85 candidates; triaging them by hand
separated three classes:

- **False positives (majority)** — a symbol used only inside its own defining file (`createHttpTraceExporter`
  is called by `exportersFromEnv` two functions below it; `buildInteractionGraph` at `tracer.ts:280`),
  or a bound/id exported deliberately as public API.
- **Legitimately library-only** — `@codeflow/arena`'s harness (`runArena`, `loadSandbox`, the graph
  oracle). Its consumers are the eval harness and, per V3_PLAN §8, RL work that is explicitly out of
  scope. Reported, not "fixed".
- **REAL, and every one is now closed:**

| Symbol | Was | Now | Commit |
|---|---|---|---|
| `createSpeculator` | zero production call sites | wired into the pipeline orchestrator via `StageSpeculationSource`; RAG declares its chunk plan | `2c069fa` |
| `createVersionedBlackboard` | zero production call sites | the fan-out's running state IS the version log; the supervisor's read is recorded | `7c0527a` |
| `exportersFromEnv` | zero production call sites | resolved at the worker's composition root; `/metrics` reports the counters | `02c89fc` |
| `Span.recordUsage` | **zero call sites anywhere** | the worker records usage from every progress event | `7fcb760` |
| `RecordingTracerOptions.pricing` | never supplied | `pricingFromEnv(LLM_PRICING)` at the composition root | `7fcb760` |
| `createCitationVerifier` | zero consumers; the eval kept its own copy | the RULE is shared; both callers use it | `65fed98` |

**Also removed rather than left unwired:** eight web modules orphaned by the frontend rebuild (five ui
primitives, `graphView`, `pipeline`, `dashboard`, `analysisNormalizer`, `types/web`) plus the
`react-force-graph-2d` and `zustand` dependencies — all zero shipped importers.

---

### 2. Grounding end-to-end, including every new UI view — **PASS**

The three enforced passes are unchanged and still enforced at the point of production. What this pass
verified is the new surface area.

**An ungrounded citation cannot reach a user:**
- `CitationChip` renders an `<a>` ONLY when a URL can be built from a GitHub ref + owner/name + a
  **pinned SHA**; otherwise it renders as plain text. A dead link on a citation would be worse than no
  link, because it looks verifiable. Asserted: the href contains the analysed `commitSha` and `#L4-L9`,
  not a branch.
- TAB 02's reading order is **re-grounded on read** against `graph.nodes`, even though it was grounded
  when produced — a durable document outlives the run that produced it.
- `AnalysisResult.ai.domains` module ids are **re-grounded** when the lane is built; a lane whose every
  module was ungrounded is DROPPED rather than rendered empty.

**An inferred domain cannot be shown as fact.** TAB 04 states it three times, in three registers: the
section header (`DOMAIN LANES — SPECIALIST AGENTS · INFERRED`), a serif note between the halves
(`Roles come from the parser. Domains below are inferred by specialist agents — labelled as inference,
never as fact.`), and `agent · <tag>` on every lane. When there are no lanes the tab says so and
**does not substitute the community partition**, which is structural — asserted by test.

**No shipped view can show fabricated data.** The `Use Mock Data Instead` button is deleted, the fixture
moved under `src/test/`, and a test asserts no `/mock/i` text anywhere in the rendered marketing site.
`grep -rlo "mockAnalysis\|Use Mock Data" dist/` on the production bundle returns nothing.

**Unmeasured is visibly unmeasured.** With nothing analysed, all four headline stats render `—` with
`data-measured="false"` and a stated reason — asserted for all four. The hero mesh, the one bundled
representative graphic the brief permits, carries a visible `representative shape · not a repository`
badge.

---

### 3. Hermeticity — **PASS**

- No `fetch`, `WebSocket`, `http.request`, `net.connect` or `createConnection` on any test path.
- The five `postgres://user@host:5432/db` strings in `retrieval/__tests__/sqlStores.test.ts` are passed
  alongside an **injected** `createClient` that returns `null` or a throwing stub. The URL is never
  dialled; the tests are about the degradation path.
- No model download: tree-sitter grammars come from the `@vscode/tree-sitter-wasm` package on disk; the
  reranker is deterministic and in-process; local embeddings are feature-hashed (see ledger #27 for why
  that is a deferral rather than a shortcut).
- No key is required by any test. Langfuse/Helicone activate only from env no test sets, and every
  remote-backend test injects `fetch`.
- The full suite runs green with no Mongo, no Redis, no Postgres, no network.

---

### 4. Spine determinism — **PASS**

- Same `{repo, sha, analyzerVersion}` → byte-identical deterministic slices, asserted across
  `schedule: "sequential"` vs `"layered"` including the failure path (per-stage *timings* are excluded,
  and that is not a loophole: they are wall-clock facts about one execution).
- **New in this pass:** the same assertion for speculation. The real pipeline runs with `speculate: true`
  and `speculate: false` and the `ai.rag` slice is compared byte-for-byte.
- `metrics.clusters` remains byte-identical across re-runs and input orderings (V3-P1).
- `pnpm --filter @codeflow/eval run check` confirms the golden-set load is byte-identical across two
  loads.
- The new derivations are pure and asserted deterministic: `architecture.ts` (classification is
  order-independent), `radial.ts` (ring by fan-in RANK, angle by stable sort, no RNG, no clock),
  `domainLanes.ts` (same KB ⇒ byte-identical projection), and the blackboard version log (injected clock
  defaulting to a constant).

**No AI output mutates a deterministic slice.** `aiSynthesis`, `aiRag` and the new `aiDomains` are all
assembled under `result.ai.*`; the orchestrator assigns per key and no stage writes another's slice.

---

### 5. Cost measured — **FAIL at the start of this pass → PASS**

This is the check that found the most.

- **`Math.ceil(len/4)` on a paid path: none.** The only definition is
  `TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4` in `util/tokens.ts`, and every use of `estimateTokens` feeds
  `budget.check(...)` — admission control, which must guess before the call. The one other hit is in the
  hermetic A/B harness, which makes no paid call.
- **Real usage read-back: every `budget.record()` call takes the provider's `usage`.** Verified across
  all seven call sites.
- **One shared budget:** the worker and the API's Q&A path both take `createRedisBudgetHandle` off the
  same Redis.
- **THE FAILURE, and it was total.** `Span.recordUsage` had no caller, so the trace reported **$0.00 for
  every run**, and `pricing` was never supplied so it could not have priced one anyway.
- **THE WALLET BUG BEHIND IT.** `budget.record` sat AFTER the schema/grounding check in `synthesize` and
  AFTER the whole batch loop in `rag`. A completion the grounding check rejected was **never recorded**;
  a throw on embedding batch 7 discarded batches 1–6. The provider charged for all of it. Three rejected
  synthesis attempts spent real money against a ceiling that never saw a token — the guard was blind to
  exactly the failure mode that retries most.

Both fixed and asserted on the retry path: **3 paid attempts ⇒ 3 budget records ⇒ $31.50 measured.**
`usd` is NULL and the models are NAMED when no price is configured, which is the default — see the
still-remaining list.

---

### 6. Logs match reality — **CONCERN → RESOLVED**

`PHASE_LOG.md` had **no V3-P5 entry at all**, and `V3_PLAN.md`'s six Phase 5 boxes were unticked while
the code was shipped. Worse than a missing entry: the code claimed things the code did not do.

Both are now written from the real commits, and the backfill states the five gaps in the entry itself
rather than in a footnote. `V3_PLAN.md`'s boxes are ticked with the deviation recorded under each, and
the DoD line says plainly that it is met **as of V3-FINAL and was not met as V3-P5 shipped**.

Fresh gate run recorded in §C below.

---

### 7. DoD per phase — **see the table**

"Met" only where it resolves TRUTHFULLY on the live path.

| Phase | Verdict |
|---|---|
| **P0** — foundations + Arena | **MET, with one correction.** Cost control, shared budget, Redis rate limit, honest degradation, the golden set and the Arena are all real. §0.5's stated benefit — "the eval and the Arena stop needing their own copies" — was **NOT true**: the eval kept its own `containedInRetrieved`. Fixed in `65fed98`. The scored run and threshold calibration remain owner-manual (ledger #17/#24). |
| **P1** — tree-sitter CPG | **MET.** Parser accuracy measured hermetically (symbols 59.3%→100%, imports 90.0%→100%); communities deterministic. The retrieval-metric comparison is still owed (ledger #17) and SCIP is still deliberately not built (ledger #18) — both were already stated. |
| **P2** — retrieval | **MET.** No embeddings in `analyses`, asserted structurally. Enrichment gain measured hermetically with its limit stated. |
| **P3** — agentic Q&A + memory | **MET**, with scored multi-turn eval deferred (needs a real model). |
| **P4** — fan-out + test-time compute | **MET.** Context ceiling measured (668 tokens at 12 and at 60 communities), parallelism observed by counter. Quality lift on the eval still deferred. |
| **P5** — marvel + reach | **NOT MET as shipped; MET as of V3-FINAL.** Four modules unwired, one flag structurally false, and the consolidated KB discarded with the run. All closed. Two items remain manual: an external agent actually calling the MCP server, and the deployed live benchmark. |
| **V3-FINAL** | **MET.** Every named wire-in done with a test on the live path; both surfaces built; nine checks reported here. |

---

### 8. Invariants held, including in the new code — **PASS**

| Invariant | Verdict |
|---|---|
| Deterministic spine | ✅ — and the new speculation path is asserted byte-identical. |
| Three grounding passes never weakened | ✅ — and extended: a *claimed* chunk plan and a *persisted* domain lane are both re-grounded, on the principle that a durable artefact outlives its run. |
| Cost measured, not estimated | ✅ **now** — it was not, and §5 says how. |
| No secrets committed | ✅ — `LLM_PRICING`, `LANGFUSE_*`, `HELICONE_API_KEY` and `GIT_SHA` are all read from env; nothing baked. |
| Typed contracts, runtime validation only at untrusted boundaries | ✅ — no zod added. The one new runtime validator is `pricingFromEnv`, parsing an env blob: an untrusted external boundary, exactly where the amended invariant puts it. |
| Degradation visible | ✅ — and now visible in the UI: the workbench renders `degradations[]` as a banner and the honest-state block prints `warnings[]` VERBATIM. |
| Never build V3_PLAN §8 out-of-scope | ✅ — no RLVR, GRPO/DPO, distillation, mech-interp, latent reasoning, world models, RSI or inference kernels. |
| Shipped UI shows only real detected data | ✅ **now** — the mock path is deleted; see §2. |

---

### 9. Fresh full gate — **PASS**

See §C.

---

## B. Was missing, now done

Each of these was not done. I implemented it.

1. **`exportersFromEnv` had no production call site.** Every job built a full trace report and handed it
   to a `traceExporter` nothing ever supplied. I added a bounded in-memory replay buffer as the default
   (`packages/observability/src/memoryExporter.ts:63`) and resolved the exporter at the worker's
   composition root (`apps/worker/src/observability/traceExport.ts:49`, wired at
   `apps/worker/src/index.ts:187`), with the counters on `/metrics`
   (`apps/worker/src/health/healthServer.ts:118`). *Gate: 1207 → 1223, all green.*

2. **`/health.warmedUp` was structurally always false on the API.** Zero registered tasks, and the flag
   requires at least one. I added the API's three real warm-up tasks in an injected testable module
   (`apps/api/src/health/warmup.ts:57`), called from the composition root
   (`apps/api/src/index.ts:38`), pre-resolving the Postgres schema round trip that was previously paid
   inside the first `/ask` (`apps/api/src/services/ragQaService.ts:334`). *Gate: 1223 → 1235.*

3. **`createVersionedBlackboard` had no production call site,** so replay was unreachable. I made the
   fan-out's running state the log itself and recorded the supervisor's read against the version it saw
   (`packages/agents/src/orchestrator/runFanOut.ts:110` and `:299`), surfaced on the stage event
   (`packages/agents/src/orchestrator/synthesizeStage.ts:186`). *Gate: 1235 → 1248.*

4. **`createSpeculator` had no production call site.** I added the `StageSpeculationSource` capability
   (`packages/analyzers/src/pipeline/speculation.ts:191`), the orchestrator's launch window
   (`packages/analyzers/src/pipeline/orchestrator.ts:262`) and RAG's declared chunk plan
   (`packages/analyzers/src/stages/rag.ts:150`). **Wiring it exposed two real bugs in the module:** a
   queued task was invisible to `claim` (`speculation.ts:79`) and settle did not drain the queue
   (`speculation.ts:108`). *Gate: 1248 → 1270.*

5. **`Span.recordUsage` had no call site at all, and a rejected completion was never charged.** I made
   `ProgressEvent.usage` first-class (`packages/shared-types/src/index.ts:976`), forwarded it through the
   orchestrator (`orchestrator.ts:400`), moved the budget charge to the point the provider call succeeds
   (`synthesize.ts:127`, `rag.ts:662`), recorded usage from every event in the worker
   (`pipelineJobProcessor.ts:330`), added `pricingFromEnv` (`observability/src/exporters.ts:281`) and
   persisted `AnalysisResult.cost` (`pipelineJobProcessor.ts:389`). *Gate: 1270 → 1282.*

6. **The specialist fan-out's findings were paid for and discarded.** I added
   `AnalysisResult.ai.domains` (`shared-types/src/index.ts:955`) and its producer
   (`packages/agents/src/orchestrator/domainLanes.ts:56`), a bounded and re-grounded projection.
   *Included in the 1282 → 1362 step.*

7. **Nothing measured answer latency, and nothing exposed the chrome's facts.** I added
   `apps/api/src/services/answerLatency.ts:47` (measured around the ask handler, refusals excluded) and
   `apps/api/src/routes/meta.ts:36`.

8. **No deterministic derivation existed for lanes, edge classes, hop tiers, API reachability or test
   reachability.** I added `apps/web/src/lib/architecture.ts` with 35 tests.

9. **A shipped UI button loaded fabricated data.** `PublicRepoInput`'s `Use Mock Data Instead` put
   invented module names, paths and metrics into every dashboard view, indistinguishable from a real
   analysis. Deleted; the fixture moved to `apps/web/src/test/fixture.ts`.

10. **The whole design was unbuilt.** Both surfaces now exist — `apps/web/src/site/` and
    `apps/web/src/workbench/` — wired to real analysis output throughout.

11. **`@codeflow/eval` kept its own copy of the Arena's citation rule,** so V3-P0 §0.5's stated benefit
    was untrue. I exported the RULE rather than the async wrapper
    (`packages/arena/src/verifiers/grounding.ts:21`) and pointed the eval at it
    (`packages/eval/src/answerScore.ts:81`).

12. **The web suite never called RTL `cleanup`,** so every render leaked into the next test — a bug that
    surfaces as "found multiple elements" and reads like a component defect. Fixed at
    `apps/web/src/test/setup.ts:14`.

13. **`tracer.ts` contained a raw NUL byte,** which made every tool treat the file as binary — grep
    skipped it and a diff refused to show it. Written as an escape instead (`614fac8`).

14. **`PHASE_LOG.md` had no V3-P5 entry and `V3_PLAN.md`'s six Phase 5 boxes were unticked.** Both
    written from the real commits, with the gaps stated in the entries themselves.

---

## C. Gate, before and after

| | before | after |
|---|---:|---:|
| `pnpm -r typecheck` | ✅ | ✅ exit 0 |
| `pnpm -r lint` | ✅ | ✅ exit 0 |
| `pnpm test` (serial) | **1207** ✅ | **1336** ✅ exit 0 |
| `pnpm -r build` | ✅ | ✅ exit 0 |
| `node --test tests/*.mjs` | 25/25 ✅ | 25/25 ✅ exit 0 |
| `docker compose … config` | ✅ | ✅ |
| `pnpm --filter @codeflow/eval run check` | ✅ | ✅ byte-identical across two loads |

| package | before | after | Δ |
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

Web is +28 NET: 51 new tests, less the 23 that went with the deleted modules.

---

## D. STILL REMAINING — owner-only

Nothing below was attempted. Each needs a key, a running service, a deployment, or a decision.

### Owner actions

1. **`git push`.** Nothing has been pushed. Nine commits sit on `v3/final-build-verify`.
2. **Deploy.** No infrastructure was created and nothing was deployed. The config exists (healthchecks,
   `WORKER_CONCURRENCY`, CDN headers, keepalive workflow); `GO_LIVE.md` is the written runbook and
   **none of it has been executed**.
3. **The scored eval (ledger #17) and threshold calibration (#24).** Needs `GEMINI_API_KEY` and spends
   money. Run `eval-scored.yml` (or `pnpm --filter @codeflow/eval run eval:scored`) after producing an
   `AnalysisResult` per dataset, then calibrate `EVAL_THRESHOLDS` from the measured scores. Until then
   the thresholds are PLACEHOLDERS and `fail-on-threshold` stays FALSE.
4. **Human judge labels (ledger #23).** ≥ 20 hand-labelled (answer, chunks) pairs, then read the reported
   kappa. Deliberately not shortcut with invented labels: a judge calibrated against those is worse than
   an uncalibrated one, because it looks trustworthy.
5. **Integration runs against real services (ledger #5, #12, #25).** pgvector, Redis, Mongo, and the
   Anthropic/Gemini/Voyage adapters are all unit-tested against injected fakes. A real-service smoke run
   is the proof.
6. **`LLM_PRICING`.** Unset, so every cost reports `usd: null` with the models named. Tokens are measured
   regardless. Set it to get a dollar figure — see GO_LIVE.md.
7. **`LANGFUSE_*` / `HELICONE_API_KEY`.** Unset, so traces go only to the in-process buffer. A real send
   has never been exercised.
8. **An external agent calling the MCP server (ledger #31).** 33 hermetic tests; no real Cursor /
   Claude Code / Windsurf session.
9. **The live benchmark on cloud CPU.** `scripts/live-benchmark.mjs` needs a deployed URL. The 1.76×
   scheduling number is orchestration-only.

### Owner-deferred, by prior decision

10. **Local vector store is a JSON file, not LanceDB (ledger #26).** Re-confirmed honestly documented.
11. **Local embeddings are feature-hashed bag-of-words, not int8 MiniLM (ledger #27).** Same.

### Stopped on, answered, and built to the answer

12. **Architectural violation rules.** I stopped and asked rather than inventing a rule set. The owner
    chose two — UI→platform direct, and API skipping the domain — and only those two are implemented. A
    third is an owner decision, not a code change.
13. **"TESTS THAT COVER IT".** No coverage data and no test-execution graph exists. I stopped and asked;
    the owner chose to relabel to the fact available. The card reads **TEST FILES THAT REACH IT** with
    the caption *by import reachability, NOT coverage*.
14. **The design source.** `claude_design` cannot authorize in a non-interactive session. The owner chose
    to proceed from the written spec plus the twelve screenshots. Layout, typography, colour and copy
    come from that contract; **motion and easing are my judgement inside the design DNA**, because
    `support.js` was never available.

### Known limitations, stated rather than fixed

15. **The p50 is per-process (ledger #30).** Reported with `scope: "process"` and its sample count.
16. **No browser screenshot.** The suite drives the real component tree in jsdom (31 interaction tests)
    and the production bundle builds (214 kB / 68 kB gzipped) and serves, but nothing here renders
    pixels. A visual check against the twelve screenshots is an owner step.
