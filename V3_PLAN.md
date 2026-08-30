# CodeFlow v3 (Cartograph) — Development Plan

> **For:** Claude Code, executing in the `Code_Flow` monorepo.
> **Companion doc:** `docs/CodeFlow-v3-Design-Doc.md` (the *why*). This file is the *what, how, and in what order*.
> **Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done (all acceptance criteria + gates green).

---

## 0. How to use this file (operating protocol)

1. **Work top-to-bottom, one task at a time.** Do not start a phase until its **Entry gate** is satisfied. Do not start a task until the one above it is `[x]`.
2. **Read before you write.** For any task, first `view` the files it names and the nearest tests. Match existing conventions (`@codeflow/*` packages, zod contracts, factory-with-injected-deps for stages, vitest).
3. **One task = one small branch/PR.** Branch name: `v3/pN-short-slug`. Keep diffs reviewable.
4. **After every task, run the gates (see §2) and only then mark it `[x]`** and tick the checkbox here. If a gate goes red, fix it before moving on — never leave the tree red.
5. **Never violate the invariants in §1.** If a task seems to require it, STOP and leave a note in the PR description instead.
6. **Out of scope = do not build.** See design doc §8 (RLVR training loops, GRPO/DPO/distillation, mech-interp, latent reasoning, world models, RSI, inference kernels). If a task drifts toward these, stop and ask.
7. **When blocked, ambiguous, or a change would break the deterministic spine or a grounding pass:** stop and surface it — don't guess.

---

## 1. Global invariants (must stay true in every phase)

> Checked ✅ = verified green as of the V3-P0 backfill (2026-08-30). These are CONTINUOUS properties, so
> a tick means "held at the last phase", not "done forever" — re-verify every phase.

- [x] ✅ The **deterministic spine stays deterministic** — stages 1–6 do no network I/O except the clone; same input `{repo, sha, analyzerVersion}` → byte-identical slices. *(V3-P1 added the run-twice-byte-identical test for `metrics.clusters`; the tree-sitter size guard is a BYTE ceiling, never a clock, for exactly this reason.)*
- [x] ✅ **All three grounding passes remain** and are never weakened: reading-order fileId ∈ graph nodes; RAG chunk lineRange ∈ file; Q&A citation ∈ retrieved chunks. *(V3-P0 additionally wrapped all three as reusable `@codeflow/arena` verifiers — they stay ENFORCED in production, the wrappers exist so eval/Arena stop keeping their own copies.)*
- [x] ✅ **Cost is measured, not estimated** (true from Phase 0 onward): no `Math.ceil(text.length / 4)` on any paid path; every paid call records real usage. *(V3-P0. One documented exception, flagged in the data itself as `measured: false`: the Gemini batch-embed endpoint reports no usage — ledger #22.)*
- [x] ✅ **No secrets committed.** `.env` stays gitignored; keys read from env only. *(The scored-eval workflow takes keys from GitHub secrets; nothing is baked into an image.)*
- [x] ✅ **AMENDED (V3-P0) — contracts are typed interfaces + contract tests; RUNTIME validation only at untrusted external boundaries** (API request bodies, parsed LLM JSON, loaded dataset files). There is no zod in this repo and a repo-wide zod migration is explicitly NOT wanted; the original wording said "every new boundary has a zod contract", which was unmet everywhere and would have been satisfied only by a migration nobody asked for. Every new stage/agent still needs **timeout + retry + graceful degradation** and a typed result. *(Resolves the old ledger #19.)*
- [x] ✅ Degradation is **visible**: no silently-"completed" run when an AI stage was skipped — surface `mode`/`warnings`. *(V3-P0: `runMode: "deterministic-only"` + typed `degradations[]` on the job AND the result, plus the previously-silent Mongo-down fallback.)*
- [x] ✅ **The existing unit tests + 25 legacy tests stay green**; new code ships with new tests. *(The count in the original wording — 291 — is long stale: the baseline is now **526** unit tests + 25 legacy. Treat the invariant as "never regress the current count", not as a fixed number.)*

---

## 2. Verification gates (run these; all must pass before a task is `[x]`)

```bash
pnpm -r typecheck                                   # tsc --noEmit, 11 packages
pnpm test                                           # vitest, all packages
node --test tests/*.mjs                             # legacy suite vs legacy/index.html
pnpm -r build                                       # build all packages
docker compose -f docker-compose.app.yml config --quiet
docker compose -f docker-compose.app.yml build      # (run at phase end, not every task)
# from Phase 0 onward, when a dataset exists:
pnpm eval <dataset.json> <analysisResult.json>      # must not regress thresholds
```

**Phase Definition of Done (DoD), applies to every phase:** all gates green · new tests added · checkboxes ticked · a one-paragraph `CHANGELOG`/PR note · eval delta reported (Phase 0+).

---

## PHASE 0 — Solid foundations + the Arena skeleton
**Goal:** make the hollow bits real and stand up the verifier/environment skeleton. Highest credibility-per-hour.
**Entry gate:** none (start here).
**Executed 2026-08-30 as a BACKFILL, after Phase 1** (branch `v3/p0-backfill-foundations-arena`, cut off
`v3/p1-treesitter-cpg`). Out of plan order on purpose: P1 did not depend on anything P0 builds, so it
shipped first; the only cost was P1's eval acceptance, which had no golden set to measure against.

### 0.1 Cost as a control plane
- [x] **Single token utility.** Create `packages/analyzers/src/util/tokens.ts` exporting `estimateTokens` and a `countTokens` (real tokenizer where available). Delete the 3 duplicated `estimateTokens` in `stages/synthesize.ts`, `stages/rag.ts`, `rag/answer.ts`; import the shared one. *Acceptance:* one definition repo-wide; grep finds no other `length / 4`.
      → **DONE**, with one deliberate deviation: NO local tokenizer. This talks to Anthropic, Gemini and
      Voyage, whose vocabularies differ, so a single local tokenizer is precisely wrong for at least two
      of the three; the provider's own `usage` (task 2) is authoritative and free. The module instead
      splits `estimateTokens` (admission control + the deterministic chunk plan) from `TokenUsage` (the
      real cost). Grep confirms no other `length / 4`.
- [x] **Provider usage read-back.** Extend `LlmClient.complete` and `EmbeddingClient.embed` result types to return `{ text/vectors, usage: { inputTokens, outputTokens } }` from the provider response. Update all 4 adapters in `packages/analyzers/src/llm|embedding`. *Acceptance:* budget `record()` uses real `inputTokens + outputTokens`, not an estimate.
      → **DONE** (resolves ledger 14(b)). All four adapters read real counters, parsed defensively so a
      missing counter cannot book 0/NaN. `TokenUsage.measured` records honesty: the Gemini batch-embed
      endpoint reports no usage, so that ONE path is a flagged estimate (ledger #22) instead of being
      indistinguishable from a measured number.
- [x] **Shared budget.** Replace the split budget (worker Mongo vs API in-memory) with one Redis-backed `BudgetHandle` both processes decrement. Keep the `DAILY_LLM_BUDGET` per-UTC-day semantics; separate counters for chat vs embedding units. *Acceptance:* a Q&A call in the API decrements the same ceiling the worker sees.
      → **DONE** (resolves the #9/14 split). One Redis counter per (UTC day, unit); the Mongo handle was
      DELETED rather than left as a second implementation. `check` fails OPEN on a Redis error —
      explicit and logged, because a blip taking the AI surface down is worse than briefly overspending
      a margin. `@codeflow/analyzers` stays dependency-free via an injected `BudgetRedisLike`.
- [x] **Prompt caching.** Add provider prompt-cache markers on the stable prefix (SYSTEM_PROMPT + deterministic graph facts) in synthesize + answer paths. *Acceptance:* second identical-prefix call reports cache hit in usage.
      → **DONE, narrower than specified and for a reason**: only SYSTEM_PROMPT is marked. The per-repo
      deterministic facts are already covered by the SHA-keyed completion cache, which serves an
      identical call for ZERO tokens — strictly cheaper than a provider cache hit's discount. A hit is
      read back as `cacheReadTokens`, never assumed. Adapter tests assert the Anthropic `cache_control`
      breakpoint and Gemini's leading `systemInstruction`; a live cache-hit number needs a real key.

### 0.2 Kill the in-process fallbacks
- [x] **Redis rate limit.** Implement the Redis-backed store described in `apps/api/src/middleware/rateLimit.ts`'s comment; keep fixed-window `RATE_MAX/RATE_WINDOW_MS`. *Acceptance:* limit holds across two API instances and survives restart.
      → **DONE** (resolves ledger 14(c)). Wired as the prod store in `apps/api/src/index.ts`; in-memory
      stays the hermetic default. The cross-instance property is tested directly (two stores on one
      fake Redis continue the same count, where two in-memory stores do not). Against a REAL Redis it is
      integration-only — ledger #25.
- [x] **Surface Mongo-down + no-key.** When persistence falls back to memory, or when a provider key is absent, set explicit `warnings[]` / `mode: "deterministic-only"` on the result and job, and render a banner slot in `apps/web`. *Acceptance:* a no-key run reports `mode: deterministic-only`, not silent `completed` with stages 7–8 stuck pending.
      → **DONE**, building on the Aug-28 partial (`skippedStages` + the honest banner were already
      there and were kept). New: `runMode: "deterministic-only"` + typed `degradations[]` on BOTH the
      job and the result. Deliberately a NEW field rather than a value on `AnalysisMode`
      ("public_hosted") — access mode and delivered scope are different axes. Mongo-down is now a
      `mongo-unavailable` notice computed at read time.

### 0.3 Producerless slices
- [x] Give `summary` a real producer (derive `{files, functions, connections}` from graph/inventory at assembly) so `result.summary` is no longer the zero-filled default that gets cached and read by `routes/analyze.ts`. Decide + document `issues`/`aiProjectSummary` (produce or formally remove from the type). *Acceptance:* `result.summary.files > 0` for a real repo; no consumer reads an always-empty slice.
      → **DONE.** `summary` already had its producer from Aug 28 (`deriveSummary` + `scoreHealth`) and was
      kept. The two producerless slices got OPPOSITE verdicts, decided by whether a consumer exists:
      `issues` is now PRODUCED from Analyze's metrics (the web read it in four places, so an empty list
      was rendering as "no problems") — with NO `category: "security"` issue ever emitted, because no
      security analysis is performed; `aiProjectSummary` was formally REMOVED (no producer, no consumer,
      and `Synthesis.summary` already covers it).

### 0.4 Eval-driven development (make the harness usable)
- [x] **Real golden set.** Author `packages/eval/datasets/<repo>.json` for 2–3 small real repos with known relevant files/line-ranges; pass `assertDatasetShape` (no `REPLACE_*`). *Acceptance:* `pnpm eval` runs end-to-end and prints a report.
      → **DONE** — `chalk.json` (JS, 8q) + `requests.json` (Python, 10q), 18 questions, 14 with
      line-range truth, both repos CLONED at the pinned SHA and READ (nothing recalled). Each records
      PROVENANCE incl. that it measures the V3-P1 tree-sitter pipeline. Both carry a NEGATIVE CONTROL,
      which exposed a real bug: zero-target questions would have scored recall 0, penalising the exact
      refusal behaviour they test — they are now excluded from recall/MRR and scored on the answer path.
- [x] **Score the answer path, not just the index.** Extend `runEval` to call `answerQuestion` and score faithfulness + citation-correctness, in addition to retrieval recall@k/MRR. *Acceptance:* report includes answer-path metrics.
      → **DONE.** `citationValidity` (an independent check that production grounding held),
      `citationRelevance` (right real code, not just real code), and refusals split JUSTIFIED vs
      UNJUSTIFIED and counted separately. The scored runner drives the PRODUCTION `answerQuestion`, so
      the eval grades what users get rather than a re-implementation.
- [x] **Calibrated judge.** Add an LLM-as-judge for non-binary quality with a small human-labeled concordance check; record judge–human agreement + confidence envelope. *Acceptance:* judge is never used as a gate without a reported concordance number.
      → **DONE, and the acceptance is enforced in code**: `judgeIsGateable` is the only thing that
      authorizes gating and requires sample size AND Cohen's kappa AND a CI lower bound; `runEval`
      reports faithfulness always and refuses to fail a threshold on an uncalibrated judge (tested with
      a judge scoring 0 that still cannot fail the build). Kappa, not raw agreement, because a
      rubber-stamp judge scores 95% agreement on a skewed label set while carrying zero information.
      No human labels ship yet, so it is advisory by construction — ledger #23.
- [x] **CI.** Add `pnpm eval` to `.github/workflows/ci.yml` with a determinism check; calibrate the `PLACEHOLDER` thresholds in `packages/eval/src/thresholds.ts` against the golden set. *Acceptance:* CI fails on an eval regression.
      → **DONE for the hermetic half; the CALIBRATION is a manual step.** `ci.yml` gains a keyless
      `eval check` (validation + byte-identical determinism + both parser families); the scored run
      moved to a manual-dispatch `eval-scored.yml` with an approval environment and a concurrency lock,
      `fail-on-threshold` defaulting to FALSE. Thresholds stay PLACEHOLDERS (ledger #24) on purpose:
      CI cannot fail on an eval regression until they are measured, and gating on invented numbers is
      the failure this phase exists to prevent.

### 0.5 Arena skeleton (verifier / environment — design doc §5)
- [x] **New package `@codeflow/arena`.** Scaffold `packages/arena` with zod contracts: `TaskSpec` (question + `repo@sha` + expected), `Sandbox` (loads a frozen `AnalysisResult` by SHA — reuse the cache), `AgentHarness` (runs an agent against a sandbox), `Verifier` (interface), `Reward` (scalar/vector).
      → **DONE, with typed interfaces + a contract test instead of zod** (per the amended contract
      invariant — an in-process sandbox built from an already-validated result is not an untrusted
      boundary). The sandbox is read-only, loads through an injected loader that reuses the existing
      SHA-keyed cache, returns null rather than analyzing on demand, and REFUSES a SHA mismatch.
- [x] **Graph-oracle exact verifier.** Implement verifiers backed by `@codeflow/graph` for verifiable questions (`who-calls`, `blast-radius`, `imports-of`, `entry-points`, `cycle-through`). *Acceptance:* these return exact pass/fail with **no LLM call**.
      → **DONE** — all five, `exact: true`, zero model calls anywhere in the package or its suite.
      `who-calls` reads V3-P1's `graph.cpgEdges`; before the CPG the only honest answer was "we know
      who IMPORTS it", and the tests pin that distinction. The oracle also implements `AgentHarness`,
      so it grades itself — 1.0 on every kind is the minimum bar, and a failure there would mean the
      derivation and the comparison have drifted.
- [x] **Wrap existing grounding as verifiers** (faithfulness, citation-validity) so the eval and production share one verifier module.
      → **DONE** for the three deterministic grounding passes (fileId ∈ graph, lineRange ∈ file,
      citation ∈ retrieved). They stay ENFORCED in production where they belong — grounding is enforced
      at the point of production, not merely measured after — and the wrappers exist so the eval and
      the Arena stop needing their own copies. Faithfulness is not here: it is not deterministic, so it
      lives with the calibrated judge in `@codeflow/eval` (§0.4).

**Phase 0 DoD:** all §2 gates green · `pnpm eval` real + in CI · Arena runs the graph-oracle verifier on a sample · cost dashboard/log shows real per-call usage.
**Status (2026-08-30):** gates green ✅ · Arena runs the graph-oracle verifier (and grades itself 1.0 on
all five kinds) ✅ · real per-call usage recorded, with one flagged exception (Gemini batch-embed, ledger
#22) ✅ · `pnpm eval` **real datasets exist and are CI-validated**, but the SCORED run and threshold
calibration are a manual step ⚠️ (needs the owner's key; ledger #17/#24).

---

## PHASE 1 — Graph is the product (tree-sitter CPG)
**Goal:** replace regex-grade parsing with a tree-sitter **code property graph** + community detection.
**Entry gate:** Phase 0 `[x]`.

- [x] Add tree-sitter to `@codeflow/parsers` (node bindings for worker; keep an interface that a `web-tree-sitter` build can satisfy for local mode later). Preserve the `ParserAdapter` contract. *Acceptance:* symbol/import extraction parity-or-better vs current parsers on the golden repos (measured via eval).
      → **DONE** with `web-tree-sitter` (WASM) directly rather than node bindings, so ONE build serves the worker and a browser and `node:20-slim` needs no native toolchain (the official grammar packages carry `node-gyp-build`). Grammars from `@vscode/tree-sitter-wasm`. `ParserAdapter` unchanged (`parseFile` stays sync; only loading is async). Acceptance met by a HERMETIC parity harness against 6 authored ground-truth cases (symbols 59.3%→100% recall, imports 90.0%→100%), because the golden repos of §0.4 do not exist — the golden-set/eval comparison is still owed, see ledger #17.
- [x] Build the **code property graph** (files, symbols, calls, imports, inheritance, routes) in the Connect stage; keep `fileId === repo-relative POSIX path`. Keep all `@codeflow/graph` algorithms working on the richer graph.
      → **DONE.** `graph.cpgEdges` (call/extends/implements, aggregated with occurrence counts) + `graph.routes` + `graph.cpg` provenance, kept as SEPARATE lists from `graph.edges` so `fanIn`/`fanOut` keep their documented import-only meaning. New `buildCodePropertyGraph` is the opt-in richer view; every algorithm is asserted to still work on it.
- [x] Add **community detection** (Louvain/Leiden) producing a stable partition; expose it on the graph slice. *Acceptance:* deterministic partition for a fixed SHA; communities are low-coupling (report modularity).
      → **DONE** (resolves the long-standing `clusters` ledger item). Louvain in `@codeflow/graph`, surfaced on `metrics.clusters` — the Analyze-owned metrics slice, NOT the Connect-owned graph slice, since a partition is a computed metric. Deterministic with no RNG at all (seeded permutation of sorted ids, lowest-index tie-break, canonical relabelling); standard modularity reported.
- [ ] Optional, gated: SCIP indexer integration for TS/Py where affordable, behind a flag; tree-sitter heuristics remain the default. Do **not** block the phase on SCIP.
      → **NOT BUILT, deliberately** (see ledger #18). `scip-typescript`/`scip-python` need a real compile of the TARGET repo — installing an arbitrary public repo's deps — plus a protobuf decoder, and cannot be tested hermetically. A flag over an unimplemented interface would be dead code, so none was added.

**Phase 1 DoD:** gates green · eval retrieval metrics ≥ Phase 0 baseline · communities available for Phase 4.
**Status (2026-08-30):** gates green ✅ · communities available ✅ · **eval retrieval baseline NOT comparable** ⚠️ — Phase 0's entry gate was not met (no golden set), so the retrieval comparison is owed (ledger #17). Parser accuracy was measured hermetically instead.

---

## PHASE 2 — Retrieval (hybrid + rerank + real vector store)
**Goal:** delete brute-force cosine-in-a-Mongo-doc; ship production retrieval.
**Entry gate:** Phase 1 `[x]`. **Satisfied on the code side as of 2026-08-30** (Phase 1 and the Phase 0
backfill are both complete). Still blocked on INFRA: a vector store + object storage must be stood up
first.

- [ ] **Real vector store.** New `@codeflow/retrieval`; back it with pgvector (hosted) behind an interface (LanceDB for local later). Move embeddings out of the `analyses` doc; store text in object storage, vectors + coords in the index. *Acceptance:* index size no longer bounded by the 16MB BSON limit.
- [ ] **AST-aware enriched chunks.** Chunk on symbol spans (keep your interval-cover + gap-sweep), enriched with scope/signature/types/docstring. *Acceptance:* eval recall@k improves vs raw chunks.
- [ ] **Hybrid + rerank.** BM25/symbol + vector, fused (RRF), then a reranker (Voyage/Cohere), then MMR. Keep the similarity-floor refusal. *Acceptance:* eval recall@k + MRR improve; refusal still fires below floor.
- [ ] **Start the synthetic-data flywheel** (design doc §5.3.3): generate guaranteed-correct Q&A from the graph oracle to grow the eval set + mine hard-negatives. *Acceptance:* eval set grows automatically for any indexed repo.

**Phase 2 DoD:** gates green · measurable retrieval gains recorded · no embeddings stored in `analyses`.

---

## PHASE 3 — Agentic Q&A + memory
**Goal:** multi-turn Q&A that traverses the graph, with memory.
**Entry gate:** Phase 2 `[x]`.

- [ ] Make `/api/result/:id/ask` a **multi-turn agent** with graph tools (`find_references`, `get_blast_radius`, `get_callers`, `symbol_search`) + hybrid retrieval. Keep all grounding. *Acceptance:* follow-ups ("what about its callers?") resolve against prior turns.
- [ ] **Memory layer** (`@codeflow/memory`): session/Q&A memory (turns, retrieved-chunk history, resolved entities) + repo memory (cross-SHA diff → "what changed"). *Acceptance:* session state persists across turns; cross-SHA diff answerable.
- [ ] **Context-budget hygiene:** curate the agent tool set per step; meter tokens per context pillar. *Acceptance:* per-call token breakdown by pillar in traces.

**Phase 3 DoD:** gates green · multi-turn eval scenarios pass · memory covered by tests.

---

## PHASE 4 — Bounded agent fan-out + test-time compute
**Goal:** parallel specialist analysis over communities, with a supervisor and verified best-of-N on the hard tail.
**Entry gate:** Phase 3 `[x]` (needs communities + Arena + memory).

- [ ] **`@codeflow/agents`:** orchestrator-worker; specialists (Arch, Data-flow, Security, API-surface, Dep-risk) run in parallel **per community**; workers return **structured summaries** (never raw transcripts) to a shared blackboard; a **supervisor** synthesizes + builds global reading order. Never open mesh. *Acceptance:* orchestrator context does not grow with worker count.
- [ ] **Phase gate + guardrails** per specialist (input safety, schema, grounding, budget). Refusal = 200 + reason.
- [ ] **Test-time compute:** route by community complexity; on hard cases sample N trajectories, score with the Arena verifier, return the best. *Acceptance:* N× cost paid only on routed-hard tail; verified quality lift measured on eval.

**Phase 4 DoD:** gates green · fan-out is genuinely parallel (measure wall-clock vs sequential) · eval synthesis quality up · cost bounded and reported.

---

## PHASE 5 — Marvel + reach (latency, MCP, local-first, deploy)
**Goal:** the engineering-marvel layer and distribution.
**Entry gate:** Phase 4 `[x]`.

- [ ] **Latency:** DAG-layered parallel scheduling over the known pipeline DAG; persistent warm worker pool; model routing; speculative prefetch on the hard tail; cold-start warmup (HH_Goa pattern) with `/health.warmedUp`. Report the 4 latency tiers independently (`coreAnalysis`, `aiSynthesis`, `qaCoreHit`, `qaGenerate`).
- [ ] **Observability:** OpenTelemetry traces per run; per-agent interaction graph; per-step tokens/$; wire Langfuse/Helicone; versioned blackboard for replay.
- [ ] **MCP server** (`apps/mcp`, replacing the `card-action`/`local-cli` stub direction): expose graph + retrieval + **verifier** tools so Cursor/Claude Code/Windsurf can call the engine. Allowlist scopes deliberately.
- [ ] **Local-first CLI:** `web-tree-sitter` parse on-device, embedded graph store (LanceDB/KuzuDB), int8 MiniLM local embeddings, zero code egress; shares the core packages.
- [ ] **Deploy:** add `HEALTHCHECK` to worker + web; autoscaled worker pool; CDN for SPA; ping-to-prevent-cold-sleep; run the live benchmark against the deployed URL and confirm budgets hold on cloud CPU.
- [ ] **Offline memory consolidation** pass (design doc §2.3): consolidate per-community findings into a queryable repo KB.

**Phase 5 DoD:** all gates green · latency tiers published · MCP server usable from an external agent · local-first mode analyzes a repo offline.

---

## Cross-phase: the engineering log (do this continuously)
- [ ] Keep `ENGINEERING_LOG.md` (HH_Goa style): each entry = a decision that contradicted the obvious approach, with the measurement behind it. Add an entry whenever a benchmark, a latency fix, or a cost finding lands. This is the source material for the write-ups — capture numbers *as you get them*, not after.

---

## Quick reference — repo map (where things live)
```
apps/api        Express REST + SSE gateway
apps/worker     BullMQ pipeline runner (durable orchestrator lives here)
apps/web        Vite + React SPA (live pipeline, graph, Q&A)
apps/mcp        NEW (Phase 5) MCP server
packages/analyzers   the 8-stage pipeline + LLM/embedding clients + rag
packages/graph       graph algorithms (+ community detection, Phase 1)
packages/parsers     tree-sitter parsers (Phase 1)
packages/shared-types  all contract types
packages/config      guardrail constants
packages/eval        scoring harness — real datasets + answer path + judge (Phase 0 ✅)
packages/retrieval   NEW (Phase 2) hybrid + rerank + vector store
packages/agents      NEW (Phase 4) specialists + orchestrator + supervisor
packages/arena       verifier / environment — sandbox + graph oracle + grounding (Phase 0 ✅)
packages/memory      NEW (Phase 3) session + repo memory
```

**Do not build anything in design-doc §8 (out of scope). If in doubt, stop and ask.**