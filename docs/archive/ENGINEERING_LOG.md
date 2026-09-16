# CodeFlow — Engineering Log

Decisions where the obvious approach was measured and rejected, with the number that decided it.

One rule for what belongs here: **an entry must contain a measurement, and the measurement must have
changed the decision.** A choice that merely turned out fine is not an entry. Consolidated from
`PHASE_LOG.md` across P1–P6 and V3-P0–P5; the phase log has the full narrative, this has the
evidence.

Numbers were measured on the machine that built this (Windows 11, Node 20/24, pnpm workspace) unless
stated otherwise. Where a number is machine-dependent, the **ratio** is quoted, because a ratio
survives being re-measured somewhere else.

---

## 1. Three dependency probes: install it, weigh it, then decide

**The obvious approach.** Need a reranker? `npm i @huggingface/transformers`. Need a local vector
store? `npm i @lancedb/lancedb`. Both are the standard, well-regarded answer.

**What was measured.** Each candidate was installed into a scratch workspace and weighed —
`node_modules` size, native binaries, install scripts — before any code was written against it.

| Package | Installed size | Native? | Install scripts | Verdict |
|---|---:|---|---:|---|
| `onnxruntime-node@1.24.3` | **211 MB** | prebuilt NAPI `.node`/`.so`/`.dll`/`.dylib`, six platforms | 1 (fetches more from a Nuget feed) | REJECT |
| `@huggingface/transformers` | pulls the above **+ `sharp`** | yes | 2 | REJECT |
| `@lancedb/lancedb@0.37.1` | **656 MB** | Rust NAPI (`lancedb.win32-x64-msvc.node`) | 3 (drags `onnxruntime-node` back in) | REJECT |
| `pg` | **+4 MB** | none — pure JavaScript | 0 | ACCEPT |

**The decision.** `pg` went in. The other three did not, and were replaced by code: a lexical-overlap
reranker, and a file-backed `VectorStore` implementing the same interface pgvector implements.

**Why the number mattered.** 211 MB and 656 MB are not "a bit heavy" in an image that otherwise
ships nothing native — for a local-first CLI whose entire premise is running on a laptop with no
toolchain, a 200 MB native download is the opposite of the feature. Accepting `pg` at +4 MB and
rejecting `onnxruntime-node` at 211 MB is the same rule applied consistently, not a preference.

**Cost of everything that WAS accepted, measured end to end:** worker image 485 MB → 491 MB, api
361 MB → 366 MB, web unchanged at 74.2 MB — across all of V3-P2, P3 and P4.

---

## 2. The keyless bag-of-words embedder beat "use a real model" where it was tested

**The obvious approach.** Semantic search needs semantic embeddings. Feature hashing is a toy.

**What was measured** (`packages/eval/src/enrichmentAb.ts`, hermetic, in CI): the same chunk plan and
the same corpus, with and without AST enrichment, scored with a deterministic bag-of-words embedder.

| metric | before enrichment | after | delta |
|---|---:|---:|---:|
| recall@3 | 0.500 | **1.000** | **+0.500** |
| MRR | 0.333 | **0.667** | **+0.333** |

**The decision.** Ship the keyless embedder as the local-first default, named `codeflow-local-bow` so
it can never be mistaken for a transformer, and cover its weakness structurally: `hybridSearch` fuses
it with a BM25 arm, and the enrichment header puts the class name and path words into the text it
sees.

**What the number does NOT say, stated plainly.** This measured lexical retrieval on CODE, where
developers search for identifiers. It says nothing about semantic recall — the embedder cannot tell
that "authenticate" and "login" are related, and a MiniLM can. The real-model magnitude on a golden
set is still unmeasured and is on the deferred list.

---

## 3. Layer barriers under-parallelize the DAG — the shape had to be measured

**The obvious approach.** To run pipeline stages in parallel, compute dependency layers and run each
layer behind a barrier. Textbook.

**What was measured.** The actual layer shape of this pipeline: **`[1,1,1,1,1,2,1]`**. Only one layer
has more than one member. And the reason is specific: `rag` reads `{graph, structure, inventory}`, so
it becomes ready at the same time as `analyze` — but `synthesize` also needs `metrics`, which
`analyze` produces. A barrier therefore holds `synthesize` behind `rag`, **serialising the two
slowest stages in the pipeline** — the exact pair the change existed to overlap.

**The decision.** Drop barriers. Launch each stage the moment its own declared reads are satisfied
(`STAGE_READS`, declared in a table, not inferred). Measured result:

```
sequential 74ms → layered 31–38ms   (~2x, over repeated runs on a 20ms mock provider delay)
```

**The invariant that had to survive.** The deterministic spine must produce byte-identical slices
under either schedule. Asserted directly: same input, both schedules, `JSON.stringify` compared —
excluding `startedAt`/`durationMs`, which are wall-clock facts about one execution and not part of
the analysis.

**And the bug this found later.** `Ingest` is the one stage that MUTATES `ctx` (it resolves
`repoPath` and `commitSha`), and a launched stage receives its own `{...ctx, prior}` copy — so a
launched Ingest mutates the copy and every later stage sees nothing. Surfaced by the local-first CLI,
whose first stage does exactly that; it would have broken a hosted run with `PARALLEL_STAGES=true`
identically. Ingest is now never launched, which costs nothing because every other stage depends on
it anyway.

---

## 4. Orchestrator context that does not grow with worker count — 5× the workers, same prompt

**The obvious approach.** Fan out five specialists over the repository and let the supervisor read
what they produced. The documented failure mode of multi-agent systems at 4+ workers is orchestrator
context growing with worker count.

**What was measured.**

| communities | findings on the blackboard | supervisor prompt | specialist calls |
|---:|---:|---:|---:|
| 1 | 5 | 417 tok | 5 |
| 3 | 15 | 667 tok | 15 |
| 12 | 60 | **668 tok** | 60 |
| 60 | 300 | **668 tok** | 300 |

**5× the workers and 5× the findings for the same 668-token prompt.**

**The decision, and the detail that carries it.** The supervisor reads at most
`SUPERVISOR_MAX_FINDINGS` bounded findings, so its input is a function of the CAP and nothing else.
The selection is **round-robin across communities, not an importance sort** — and that is
load-bearing rather than cosmetic: one pathological community with five `high` findings would
otherwise consume the entire cap, and the supervisor would synthesise one corner of the repository
while believing it had seen the whole blackboard. Breadth first, depth second, so the cap degrades
coverage gracefully instead of catastrophically. The full finding list is still kept for the report
and the trace — the bound applies to the PROMPT, because losing the record would trade one problem
for a worse one.

**Also non-obvious:** the fan-out is over Louvain **communities**, not over "five specialists reading
the repo". Communities are low-coupling by construction — that is what modularity measures — so
per-community work is genuinely independent and the results genuinely compose. Five lenses over one
repo would be five agents reading the same files and reporting overlapping findings: parallel in
wall-clock, redundant in content.

---

## 5. "Parallel" was verified with a counter, not a stopwatch

**The obvious approach.** Prove concurrency by timing: if five calls finish faster than one at a
time, they ran in parallel.

**What was measured.**

```
maxConcurrency 1: 496ms, peak concurrency 1, 15 calls (15 jobs)
maxConcurrency 5: 126ms, peak concurrency 5, 15 calls (15 jobs)   → 3.9x
```

**The decision.** Report the wall clock, because that is what a reader wants — but ASSERT on
`peakConcurrency`, observed with a counter incremented around each call. A wall-clock comparison is
flaky on a loaded machine and can pass by accident; peak 5 means five calls were genuinely in flight.

**Corollary, on a flaky test that was fixed rather than loosened.** The first version asserted
`setTimeout(30)` against five `setTimeout(1)` calls and failed on Windows, which clamps short timers
— so five "1ms" waits exceeded the 30ms one. Replaced with an explicitly-held promise, removing
timing from the assertion entirely. The same clamp is why the latency bench uses a 20ms delay and not
a 1ms one.

**And the pool shape.** `mapWithConcurrency` is a worker pool pulling from a shared cursor, not fixed
batches: batching idles the whole pool behind one slow call per batch, which on a provider with
variable latency throws away most of the saving.

---

## 6. BSON is 1.083× JSON, so the obvious size check understates by 8%

**The obvious approach.** Mongo rejects documents over 16 MB. So check
`JSON.stringify(doc).length < 16 * 1024 * 1024`.

**What was measured** (`BSON.calculateObjectSize`, offline, over synthetic `cpgEdges`):

| edges | JSON | BSON | ratio |
|---:|---:|---:|---:|
| 1,000 | 0.13 MB | 0.15 MB | 1.084 |
| 20,000 | 2.74 MB | 2.97 MB | 1.083 |
| 100,000 | 13.81 MB | **14.95 MB** | 1.083 |
| 200,000 | 27.83 MB | 30.11 MB | 1.082 |

**Two things the numbers settled.** First, the ratio is a stable 1.083 — BSON adds a type byte and a
length prefix per value, and turns every array index into a string key — so the naive JSON check
understates the real size by 8% and would let documents through that Mongo rejects. Second,
**100,000 call edges alone is 14.95 MB of BSON**: the ceiling is not theoretical, one large monorepo
reaches it.

**The decision, which is also what the earlier phase deliberately did NOT do.** V3-P2 left this open
on the explicit grounds that the graph slice's growth was unmeasured and externalising on a guess is
building without evidence. That was right. With the measurement, the fix is: measure each document,
and shed its heaviest OPTIONAL fields — in a fixed order, only until it fits. A normal analysis is
stored exactly as before, with no second collection and no join on read. The order is by what a read
needs, not by size: `cpgEdges` first (nothing in the default view touches it), `graph.edges` last and
reluctantly. `graph.nodes` is never a candidate, because grounding resolves citations against it —
externalising it would let a storage failure turn a valid citation into a rejected one, converting a
storage problem into a correctness problem.

---

## 7. A refusal threshold set at the noise level stops refusing

**The obvious approach.** A similarity floor of 0.05 is conservative — almost nothing scores that
low, so almost nothing is wrongly refused.

**What was measured**, on the local-first acceptance fixture with `codeflow-local-bow`:

| query | cosine |
|---|---:|
| on-topic ("AuthService login hash") | **0.683** |
| entirely off-topic ("kubernetes helm chart ingress annotations") | **0.051** |

**The decision.** 0.051 is not signal, it is hash-collision noise: feature hashing into 256
dimensions never returns a true zero for unrelated text. The floor of 0.05 sat *at* the noise level,
so the refusal had quietly stopped refusing — an off-topic question returned three confident,
irrelevant files. The floor is now **0.15**: ~3× above the measured noise, ~4.5× below a real match.
Both measurements are exported as constants and the test asserts the RELATIONSHIP, so a future
embedder change that raises the noise floor fails loudly instead of silently weakening the refusal.

**Generalisation, which is the actually useful part:** a threshold is only meaningful relative to a
measured noise floor. Picking one by intuition means picking it relative to an imagined one.

---

## 8. The right tokenizer for retrieval is the wrong tokenizer for a merge key

**The obvious approach.** Reuse the shared code tokenizer for de-duplicating agent findings. One
tokenizer, consistent behaviour.

**What was measured.** Nine deliberately distinct headlines — `Point number 0` … `Point number 8` —
collapsed into **one** merged point, which then reported itself as corroborated by every lens that
produced it.

**The cause.** `tokenizeCode` drops tokens shorter than `LEXICAL_MIN_TOKEN_LENGTH`, because single
characters are noise when RETRIEVING code. Correct there. As a merge key it makes
`Table 1 is unindexed` and `Table 2 is unindexed` normalise identically — so two findings about
different things merge, and the system reports agreement that never happened.

**The decision.** A separate normaliser for the merge key that keeps every alphanumeric token,
digits included. Caught by a bound test that expected 5 points and got 1 — the failure was in the
source, not the expectation, and the fix went into the source.

---

## 9. Report `null`, never `0`, for a metric you could not read

**The obvious approach.** An autoscaler needs a queue depth. If Redis is unreachable, return 0 —
it's a number, and the endpoint stays simple.

**The reasoning, which needs no benchmark to be decisive.** Depth 0 means "no backlog", which scales
the fleet **IN**. Redis being unreachable is precisely the moment the backlog is growing and
invisible. So the obvious fallback inverts the correct action at the worst possible time.

**The decision.** `/metrics` returns `queueDepth: null`, `queueDepthAvailable: false`, and an
explicit `reason` a scaler's rule can test for — with HTTP **200**, not a 5xx, because a scaler that
receives an error typically discards the reading entirely rather than holding its last value.

**Same shape, elsewhere in the codebase.** Liveness stays 200 while a worker is cold (restarting a
cold worker only restarts the cold start) and readiness is the endpoint that gates capacity;
conflating them is how a rolling deploy takes a service down. And absent `cpgEdges` is left absent
rather than defaulted to `[]`, because an empty array is a false statement about the repository.

---

## 10. A single-tier router must return the client unwrapped

**The obvious approach.** Wrap the LLM client in a router. If only one model is configured, the
router just forwards.

**What that would have cost.** A router re-scopes cache keys by tier. A deployment with no
`FAST_MODEL` would get a different cache namespace for byte-identical requests — invalidating the
entire persistent LLM-output cache, which is the wallet defence, in exchange for nothing.

**The decision.** `maybeRouted` returns the single client **unwrapped** when only one tier exists, so
a deployment that sets no `FAST_MODEL` is byte-identical to before, cache keys included.

---

## 11. The evaluation judge is advisory *by construction*, and stays that way

**The obvious approach.** Ship an LLM-as-judge faithfulness metric and gate CI on it.

**What was measured.** Nothing — and that is the finding. `judgeIsGateable` requires ≥20 human
labels, Cohen's kappa ≥0.6, and an agreement CI lower bound ≥0.7. **Zero human labels exist**, so
none of the three thresholds is met.

**The decision.** `runEval` reports faithfulness and **refuses to fail a build on it**. A gate whose
calibration is unmeasured is worse than no gate: it produces confident red builds and trains everyone
to override it. The gate turns itself on when the labels exist, and the condition is in code rather
than in a comment.

**Same discipline on cost.** Every paid path reports usage read back from the provider, not an
estimate — with exactly **one** documented exception (Gemini's batch-embed endpoint returns no usage,
so that client sets `measured: false` and the RAG stage logs it). One documented exception, visible
in the budget ledger, beats a blanket "costs are tracked".

---

## 12. Deleting code needs evidence too

**The obvious approach.** It looks unused, and the tests pass. Delete it.

**What was measured.** An import-graph sweep, then a per-file decision. Result: **1.96 MB** of stale
off-repo files deleted (10 old smoke logs, a stray zip) — and two images kept
(`codeflow-social.png`, 297 KB, and one 1.0 MB screenshot) **despite zero in-repo references**,
because their names strongly suggest they are linked from outside the repository, where the import
graph cannot see.

**The decision.** Zero references is evidence of nothing when the referrer may not be in the
repository. The kept files are documented as kept, with the reason, so the next sweep does not
re-litigate them.

---

## What is measured but NOT yet resolved

Kept here rather than in a summary, because an engineering log that only lists wins is a brochure.

- **Real-provider retrieval quality is unmeasured.** The +0.500 recall@3 above used a bag-of-words
  embedder. What a real embedding model shows on a golden set needs authored datasets against pinned
  SHAs and a key — deferred, and the claim is not made in the meantime.
- **No large-repo end-to-end run exists.** Every size and latency number here is hermetic or
  synthetic. `scripts/live-benchmark.mjs` is written and reports the same four tiers so the two
  subtract; it has never been run against a deployment.
- **The overflow threshold is derived, not observed.** 8 MB of JSON was chosen from the measured
  1.083 ratio plus a deliberate margin. No real repository has yet crossed it.
- **`coreAnalysis` reads ~0ms in the hermetic bench**, and that is honest but narrow: it measures
  orchestrator overhead, because hermetic deterministic stages do no parsing. The bench says so in
  its own output so the number cannot be quoted as a parse time.
