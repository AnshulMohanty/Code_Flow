# ARCHITECTURE

How CodeFlow is built, and why it is built that way. This file is the *why*; `README.md` is the
*what*, `DEPLOY.md` and `GO_LIVE.md` are the *how to run it*, and `CURRENT_STATE.md` carries the open
ledger.

Where a decision was made against a measurement, the measurement is quoted. Where it was made on
judgement, it says so. Numbers marked **orchestration-only** were taken on a hermetic harness with
mock providers and say nothing about a real repository or a real network.

---

## 1. The shape

Four services over three data stores, in a pnpm + TypeScript monorepo.

```
            ┌───────────┐      enqueue       ┌──────────┐ → MongoDB  (results, caches, SSE replay)
  Browser → │  web (SPA)│ ─────────────────→ │ api      │ → Redis    (BullMQ, budget, rate limit)
            │           │ ←── SSE progress ── │          │ → Postgres (pgvector — the Q&A index)
            └───────────┘                    └────┬─────┘
                                                  │ job
                                             ┌────▼─────┐
                                             │ worker   │  clone → 8 stages → persist
                                             └──────────┘
```

**Why a separate worker.** An analysis holds a job for minutes and is I/O-bound on provider calls for
most of that time; the API is request-shaped and stateless. They need to scale on different signals —
queue depth and request volume — and a single process makes that one signal. The split is the default.

**Why it can also be one process.** Render has no free `worker` service type, so the correct
architecture is not deployable for free, and an architecture nobody can run is not better than one
they can. `RUN_WORKER_IN_PROCESS=true` hosts the BullMQ consumer inside the API. Concurrency is forced
to 1 there, because a CPU-bound parse and an HTTP server now share an event loop and the API is what a
human is waiting on. See `DEPLOY.md` Appendix C for the full trade.

**What the single-process mode is better at, which is not nothing:** with no Postgres, retrieval falls
back to a per-process in-memory index. Split across two processes that means the worker writes an
index the API cannot read and every question is refused. In one process they share a heap, so they are
handed the same store and Q&A works with no database at all — until a restart, which `/health` reports
rather than implies.

---

## 2. The deterministic spine

Stages 1–6 do no network I/O except the clone. Same `{repo, sha, analyzerVersion}` in, byte-identical
slices out. This is load-bearing rather than tidy: the analysis cache is keyed on the commit SHA, and
a cache that can return a different answer for the same key is a cache that returns wrong answers.

Determinism is paid for in specific places:

- **Community detection is a seeded Louvain.** Classic Louvain shuffles node order with a real RNG,
  which would make the partition differ run to run. The visit order is a seeded permutation of sorted
  ids, ties break on the lowest community index, and the final communities are canonically relabelled
  by size then lowest member. Two runs of the same graph give the same partition, byte for byte.
- **The dependency map is a radial layout, not a force simulation.** A force layout is prettier and
  its positions encode nothing — two loads of the same repository give two different pictures, and
  neither says which module is load-bearing. Ring is fan-in *rank* (not raw fan-in, so one enormous
  hub cannot flatten every other ring); angle is position in a stable sort. Dropping
  `react-force-graph-2d` also took ~90 kB of canvas and physics out of the bundle. There is no graph
  library at all now; it is hand-written inline SVG.
- **Span ids in the tracer are `s1`, `s2`, …** rather than UUIDs, so a recorded trace is assertable in
  a unit test. The cost is stated in the module: they are unique within a trace and not globally
  unique, so the OTel bridge mints real ids at export.
- **KB consolidation is extractive, not generative.** Merging, de-duplicating and templating rather
  than another model pass. A generated KB would be non-reproducible, so it could not be diffed,
  cached, or trusted to answer the same question twice.

The parallel stage schedule is asserted byte-identical to the sequential one. What is *not*
deterministic, deliberately, is the order progress EVENTS arrive in within a layer — an event stream
is a live UI signal, and buffering it to preserve an order nobody depends on would delay feedback for
nothing.

---

## 3. Grounding

Three passes, enforced at the point of production rather than measured afterwards.

1. **Reading-order steps** must name a file that is a real graph node. Ungrounded steps are dropped
   and counted; a synthesis where *everything* is ungrounded is rejected outright rather than shipped
   thinner.
2. **RAG chunk line ranges** must lie inside the file they name.
3. **Q&A citations** must resolve to a chunk retrieved in this session.

The third is the strongest and the one worth understanding, because it is structural rather than
policed. The model is only permitted to emit a **chunk id**. The file path, start line and end line
are read off the chunk that was actually retrieved — never off the model. So a fabricated line number
is not caught by a validator; it cannot be expressed. Unmatched ids are dropped and counted, and
`answered: true` with no surviving evidence is downgraded to a refusal — the check is on EVIDENCE, not
on the model's claim about itself.

The rule exists **once**, as a pure predicate (`citationInRetrieved`), shared by the production path,
the eval scorer and the verifier harness. It previously existed as four copies, and V3-P0's stated fix
— wrapping it as an async `Verifier` — did not actually let the eval share it, because `scoreAnswer`
is synchronous. Exporting the predicate rather than the envelope is what finally removed the
duplicate.

Citation chips link to GitHub **at the analysed commit**, not at HEAD, and render as plain text rather
than a dead link when any part of the URL is unknown. A dead link on a citation is worse than no link:
it looks verifiable.

---

## 4. Retrieval

```
vector arm  ──┐
              ├── RRF fusion ── text fetch ── reranker ── MMR ── top-k
lexical arm ──┘
```

Each stage earns its place: the vector arm answers "where is authentication handled" and misses
`parseJwtHeader`; BM25 answers `parseJwtHeader` and misses paraphrases. They fail in *different*
directions, which is the only thing that makes fusing them worth the cost. RRF fuses **ranks**, not
scores — a cosine of 0.83 and a BM25 of 11.4 are not comparable quantities, and normalising them
invents a scale that shifts with every result set.

**The refusal floor is compared against the vector arm's raw cosine**, before fusion and before
reranking. RRF output is ordinal and reranker scales are model-specific; comparing either against a
0.2 threshold would be meaningless, and the failure mode would be the worst kind — answering
confidently on a question the repository cannot answer.

Chunks are enriched before embedding and **not** before storage: the stored text stays byte-exact for
its line range because that is what a citation resolves to, while the embedded text gets the class
name, the file path and the language prepended so a method body that never mentions its own class can
still be found.

---

## 5. Dependencies: weighed, then chosen

The single most consistent decision in this codebase is refusing dependencies on measured grounds.
Each candidate was installed into a scratch workspace and weighed before any code was written against
it.

| Package | Installed | Native? | Verdict |
|---|---:|---|---|
| `onnxruntime-node` | **211 MB** | prebuilt NAPI for six platforms, postinstall fetches more | REJECT |
| `@huggingface/transformers` | the above **+ `sharp`** | yes | REJECT |
| `@lancedb/lancedb` | **656 MB** | Rust NAPI, drags `onnxruntime-node` back in | REJECT |
| `pg` | **+4 MB** | none — pure JavaScript | ACCEPT |

Downstream of that: no vendor SDK for Anthropic, Gemini, Voyage, Langfuse or OpenTelemetry — all raw
`fetch`. No UI framework, no CSS framework, no chart or graph library. Hand-written BM25 and Louvain.
The test suite stays hermetic *because* of this, not in spite of it.

**What that cost, stated rather than hidden.** `V3_PLAN` §5 asked for LanceDB and int8 MiniLM local
embeddings. Neither shipped. The local store is a JSON file with an exact cosine scan, and the local
embedder is **feature hashing** — a deterministic bag-of-words over the shared code tokenizer. It
captures lexical overlap and cannot tell that "authenticate" and "login" are related. It is worth
shipping anyway because the keyless, offline, zero-egress claim becomes *provable* (there is no
client, no socket, no protocol) rather than asserted, and because on code specifically developers
search for identifiers. The upgrade path is one file: implement `EmbeddingClient` over
`onnxruntime-web` plus a JS WordPiece.

---

## 6. Observability: what it is and what it is not

**This is custom in-process request tracing. It is not OpenTelemetry.** There is no `@opentelemetry/*`
dependency anywhere in the repo, and calling it OTel would be an overclaim.

The rationale is the one that applies to a single-tenant application with no external observability
backend: what is needed is per-stage timings and per-step token/cost attribution readable from
`/metrics` and from the analysis result itself. A lightweight recorder gives that, keeps the package
at zero dependencies, and — because its span ids are deterministic — can be asserted in a unit test,
which a hosted-backend integration cannot. What exists:

- a recording tracer with a span tree, an interaction graph and a cost model;
- a `fetch`-based exporter in the shape Langfuse and Helicone accept;
- an **OTel bridge** that takes an *injected* tracer-provider, so a consumer who wants real OTel
  supplies it and this package still depends on nothing.

Every exporter obeys one rule: it must not throw and must not block the run. An observability layer
that can fail the thing it observes is worse than none, and it fails in exactly the situation you most
need the trace.

**Cost is measured, not estimated.** `budget.record` takes the provider's reported usage, and it fires
at the point the provider call *succeeds* — not after the schema and grounding checks. That ordering
was a real wallet bug: a completion the grounding check rejected was never recorded, so three rejected
synthesis attempts spent real money against a ceiling that never saw a token. `usd` stays `null` when a
contributing model has no configured price, with the model named; visibly incomplete beats confidently
wrong.

---

## 7. Experimental, flag-gated, unproven

Three features are built, tested, off by default, and **have never been measured against a live model
at real scale**. They are described here rather than in the README's feature list, because a
capability nobody has evidence for does not belong in a pitch.

- **Specialist fan-out over communities** (`FANOUT_SYNTHESIS`). Five lenses per community on a shared
  blackboard, one supervisor over a bounded selection. What *is* proven, hermetically: the supervisor
  prompt is 668 tokens at 12 communities and 668 at 60 — the context ceiling holds — and peak
  concurrency is observed by a counter rather than inferred. What is **not** proven: that its output
  is better than the single-shot stage. Cost shape is 5N+1 provider calls against 1.
- **Best-of-N on the hard tail.** N trajectories on communities above a complexity threshold, scored
  by an exact verifier. The hermetic test proves it picks the better-scoring candidate; nothing proves
  a better-scoring candidate is a better answer.
- **Speculative prefetch.** RAG's chunk plan is built during synthesis's provider wait, so the disk
  pass happens once rather than twice, and the resulting slice is asserted byte-identical with and
  without. The hit rate that decides whether it is worth keeping has never been measured on a real run.

The measured scheduling win (sequential 67 ms → layered 38 ms, **1.76×**) is **orchestration-only**:
the harness's stages do no parse and no clone work, so that number is a bound on how much time this
codebase adds *around* a provider call, not a claim about analysing a repository.

---

## 8. Honest degradation as a discipline

The system is designed to keep working when a dependency is missing, and to *say so* every time.

- `runMode: "deterministic-only"` plus typed `degradations[]` on both the job and the result, so a
  skipped AI stage survives a reload and a cache hit instead of living in one process's stdout.
- `usd: null`, never `0`. `queueDepth: null`, never `0` — reporting zero for an unreadable queue would
  scale the fleet in exactly when the backlog became invisible.
- `/health` reports `retrieval: { mode, degradation }` from a synchronous snapshot. A health endpoint
  that can block on the dependency it reports on turns one outage into two.
- Warm-up constructs provider clients and never probes them: a warm-up that spent money would be
  charging the owner for a health check.
- Redis-backed stores announce their in-memory fallback — except the answer cache, which announces at
  info rather than warn, because an unshared answer cache costs money and not correctness, and a
  warning on every boot of a keyless local deployment trains operators to ignore warnings.

The one place this discipline had a hole was the most important one: `createRetrievalStores` returned
no `degradation` at all when `POSTGRES_URL` was simply unset, and all three callers gate their warning
on that field. So the most common misconfiguration was the one that stayed silent, under the headline
feature. Fixed; the distinction between "not configured" and "could not connect" now lives in the
wording of two different strings rather than in one of them being absent.

---

## 9. Boot-time warm-up (not a worker pool)

`warmup.ts` is a registry of **process-lifetime resources** initialised once at boot and reused by
every job in that process: the tree-sitter WASM grammars (the real cost — a one-time load the first
job would otherwise pay), provider client construction, and the retrieval schema round trip.

It was called a "persistent warm worker pool" in the plan. It pools nothing. The name was renamed
rather than the behaviour changed, because a name that overstates the mechanism survives into a README
and then into a conversation where somebody asks how the pool is sized.

It gates `/ready`, which is separate from `/health` on purpose: a container that accepts traffic
before its caches are warm serves its first users a latency that looks like a bug, and a liveness
probe pointed at readiness would restart every instance for being cold, forever.

---

## 10. Cold start, and why there is no pinger

The frontend is a **static site**: always on, free, never asleep, and it paints its entire shell with
no API call on the paint path — asserted by a test with `fetch` rejecting. The backend sleeps after
~15 minutes idle on a free tier and wakes in 30–50 seconds.

The obvious fix is a cron ping every 10 minutes. It is also self-defeating: ~4,300 requests a month
hold the container *running*, which exhausts the free ~750 instance-hours and **suspends** the service
for the rest of the month. A suspended service is strictly worse than a sleeping one — sleeping costs
a visitor 40 seconds, suspended costs them everything, and no retry fixes it.

So the wake is triggered by a real visitor. One fire-and-forget `GET /health` on first mount, retried
with backoff because the first request during a cold start usually fails outright, and **stopped** the
moment it answers. A month with no visitors costs no hours. Meanwhile the status pill reads `WARMING`
rather than a frozen spinner, the curated demo repositories are clickable (a cached result needs the
API but not the queue and not a provider), and the Analyze button is disabled with the reason and an
alternative.

---

## 11. What is inherited, not built

- `legacy/index.html` — the original single-file application this project grew out of. It shares no
  code with `packages/*`. Kept because `card/` executes it and the root test suite pins its
  behaviour.
- `card/` — a GitHub Action that renders an SVG repository card, inherited from the upstream fork and
  powered by that legacy analyzer. No workflow in this repository invokes it.

Neither is part of the system this document describes.

---

## 12. What was never built

Worth stating explicitly, because these appeared in early planning and in a set of P5-era UI panels
that shipped with **mock data** and were later deleted. The panels are gone; the features behind them
were never implemented, and nothing in this repository does any of it:

| Claimed capability | Reality |
|---|---|
| Security scanner | **Never built.** No secret detection, no CWE/OWASP rules, no SAST, no dependency-vulnerability check. The only thing resembling it is one *prompt persona* in the specialist fan-out that asks a model what handles trust boundaries — it produces text, not findings, and only when the fan-out is enabled. |
| Architecture rules / `.codeflow.yml` | **Never built.** No config file is read, no rule schema exists, nothing is enforced. The two "sanctioned rules" in the UI's edge classification are hard-coded and named as such. |
| PR risk scoring | **Never built.** |
| Ownership / churn analysis | **Never built.** Nothing in the pipeline reads git history — not blame, not commit frequency, not authorship. |
| Test-impact analysis | **Never built.** The UI's "test files that reach it" is **import reachability**, and is labelled that way precisely because it is not coverage. |
| 3D dependency graph | **Never built**, and explicitly out of scope in the original plan. The map is 2D SVG. |

If any of these turns up in a description of this project, it is wrong.
