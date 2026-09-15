# CodeFlow — Architecture Defense

Written to be defended cold, from the code rather than from the docs. Every claim below names the
file it comes from. Three sections: how a citation is made structurally honest, how the pipeline is
scheduled, and what the graph engine actually computes.

---

## 1. The citation grounding path — why a fabricated citation is inexpressible

### The claim

A model answering a question about this repository **cannot invent a file path or a line number**.
Not "is instructed not to", not "is usually right" — cannot. The reason is a type boundary, not a
prompt.

### The mechanism

The model is never allowed to emit a location. Look at what the protocol actually accepts
([`askAgent.ts:80-86`](packages/agents/src/askAgent.ts#L80-L86)):

```
{"action":"answer","answer":"<prose>","answered":true|false,
 "citedChunkIds":["<chunk id>"],"citedFileIds":["<file path>"],"thought":"why"}
```

There is no `startLine` field. There is no `endLine` field. The model's entire vocabulary for "where
did you get that" is a **chunk id** — an opaque token it can only have learned by calling a tool.

The file and the line range are then looked up, not accepted
([`askAgent.ts:334-350`](packages/agents/src/askAgent.ts#L334-L350)):

```ts
for (const id of args.action.citedChunkIds) {
  const chunk = args.seenChunks.get(id);
  if (!chunk) { dropped.push(...); continue; }
  ...
  citations.push({ fileId: chunk.fileId, startLine: chunk.startLine, endLine: chunk.endLine });
}
```

`seenChunks` is the evidence ledger accumulated across the session's tool calls
([`askAgent.ts:103`](packages/agents/src/askAgent.ts#L103)) — *"This is what grounding checks
against — NOT the model's claims, and not the whole index."* The coordinates on the emitted citation
come from `chunk`, the object the retriever returned. They are copied out of retrieved evidence.

So there are exactly two cases for any id the model emits:

1. **The id was retrieved this session.** The coordinates are the retriever's, and are correct by
   construction — the model contributed nothing but the selection.
2. **The id was not retrieved.** `seenChunks.get(id)` returns `undefined`, the citation is dropped
   and counted in `droppedCitations`.

A hallucinated id cannot become a wrong line number, because it never reaches a line number. It
becomes a dropped citation. **The failure mode is a missing citation, never a false one.** That
asymmetry is the whole argument.

The code even distinguishes the two reasons a lookup can miss
([`askAgent.ts:338-344`](packages/agents/src/askAgent.ts#L338-L344)): an id this session never
retrieved is *fabricated*, while an id from an **earlier turn** of the same session is legitimate but
has no coordinates in hand now. Both are dropped; neither is guessed at; both are counted.

### The third guard — the one that matters most

Grounding alone still permits "confident prose with zero citations". That is closed separately
([`askAgent.ts:363-366`](packages/agents/src/askAgent.ts#L363-L366)):

```ts
const hasEvidence = citations.length > 0 || citedFiles.length > 0;
const answered = args.action.answered && args.action.answer !== "" && hasEvidence;
```

`answered: true` with no surviving evidence is **downgraded to a refusal**. The code's own note on
why this is the important one ([`askAgent.ts:48-51`](packages/agents/src/askAgent.ts#L48-L51)): *"a
model that ignores every empty tool result and answers from pre-training cannot produce an answered
response, because the check is on evidence rather than on the model's own claim."*

Three independent guards, and none is a prompt instruction:

| Guard | Where | Why the model can't route around it |
|---|---|---|
| Similarity floor | inside `search_code` ([`searchTool.ts:44`](packages/agents/src/tools/searchTool.ts#L44)) | No model-settable argument exposes it |
| Citation resolution | `ground()` ([`askAgent.ts:327`](packages/agents/src/askAgent.ts#L327)) | Coordinates are read from retrieved chunks |
| Evidence downgrade | [`askAgent.ts:363`](packages/agents/src/askAgent.ts#L363) | Checks evidence, not the model's `answered` flag |

### The floor is compared against the right number

A subtle point worth having ready, from
[`hybridSearch.ts:33-37`](packages/retrieval/src/hybridSearch.ts#L33-L37): the refusal floor is
compared **against the vector arm's raw cosine**, never against the fused or reranked score — *"RRF
output is ordinal and reranker scales are model-specific"*. Comparing a similarity threshold to an
ordinal fusion score would be a category error that quietly destroys the meaning of "I don't know".

The retrieval path itself ([`hybridSearch.ts:17`](packages/retrieval/src/hybridSearch.ts#L17)):

```
vector arm ┐
lexical arm┴── RRF fusion ── text fetch ── reranker ── MMR ── top-k
```

`RetrievedChunk` ([`contracts.ts:181-193`](packages/retrieval/src/contracts.ts#L181-L193)) keeps
`vectorScore`, `lexicalScore`, `fusedScore`, `rerankScore` and a `sources` array separately rather
than collapsing them — because *"the lexical arm found what the vector arm missed" is the whole
argument for hybrid retrieval*, and you cannot make that argument from a single fused number.

### Anticipated objection

*"The model could cite a real chunk id that doesn't support its prose."* True, and out of scope for
this mechanism — grounding guarantees the **citation resolves to code the system actually read**,
not that the prose is a fair reading of it. That is what the scored eval measures. The claim being
defended is narrower and absolute: the citation points at real, retrieved code.

---

## 2. The 8-stage pipeline DAG, and where the AI attaches

### The stages

Eight, in [`packages/analyzers/src/stages/`](packages/analyzers/src/stages/):

| # | Stage | Kind | File |
|---|---|---|---|
| 1 | `ingest` | deterministic | [`ingest.ts:60`](packages/analyzers/src/stages/ingest.ts#L60) |
| 2 | `orient` | deterministic | [`orient.ts:108`](packages/analyzers/src/stages/orient.ts#L108) |
| 3 | `map-structure` | deterministic | [`mapStructure.ts:73`](packages/analyzers/src/stages/mapStructure.ts#L73) |
| 4 | `inventory` | deterministic | [`inventory.ts:61`](packages/analyzers/src/stages/inventory.ts#L61) |
| 5 | `connect` | deterministic | [`connect.ts:65`](packages/analyzers/src/stages/connect.ts#L65) |
| 6 | `analyze` | deterministic | [`analyze.ts:46`](packages/analyzers/src/stages/analyze.ts#L46) |
| 7 | `synthesize` | **ai** | [`synthesize.ts:65`](packages/analyzers/src/stages/synthesize.ts#L65) |
| 8 | `rag` | **ai** | [`rag.ts:138`](packages/analyzers/src/stages/rag.ts#L138) |

### The shape

From [`schedule.ts:7-12`](packages/analyzers/src/pipeline/schedule.ts#L7-L12):

```
ingest → orient → map-structure → inventory → connect → analyze → ┬ synthesize
                                                                  └ rag
```

**The honest reading, and the one to give first:** six of the eight are a genuinely linear chain,
and that is not a missed parallelism opportunity. Each consumes the slice the previous produced —
`map-structure` reads `orientation`, `inventory` reads `structure`, `connect` reads both, `analyze`
reads `graph`. Parallelising a chain whose every link is a real data dependency *"would either
produce wrong output or require duplicating work."*

There is **exactly one parallel layer**: `synthesize` ∥ `rag`. Those are also the only two
provider-bound stages, i.e. the two slowest. The code's own summary: *"there is exactly one parallel
layer in this pipeline, and it is the layer worth having. A four-way fan-out over the parse chain
would have looked more impressive on a diagram and been slower and wrong."*

Say that sentence in a defense and you have pre-empted the obvious challenge.

### Dependencies are declared, not inferred

`STAGE_READS` ([`schedule.ts:48`](packages/analyzers/src/pipeline/schedule.ts#L48)) states what each
stage reads from `ctx.prior`; `stage.owns` states what it writes. Layering is **Kahn's algorithm**
over the two. Inferring reads by grepping or by proxying `ctx.prior` was rejected as *"clever and
fragile"* — a stage that starts reading a new slice must declare it, and a contract test fails if the
declaration and the code disagree.

Note what is deliberately *not* in `STAGE_READS`: `ctx.repoPath` and `ctx.commitSha`. Those are
ambient context `ingest` bootstraps rather than slices, so every non-ingest stage depends on ingest
by construction — modelled as `INGEST_FIRST` rather than by inventing a fake slice that would then
pollute the coverage partition and the cache logic.

### Determinism survives the parallel layer

This is the part to lead with if challenged on "parallel but deterministic"
([`schedule.ts:27-33`](packages/analyzers/src/pipeline/schedule.ts#L27-L33)). Within a layer:

- every stage sees the **same `ctx.prior` snapshot**, taken before the layer starts;
- slices are assigned **after the layer settles**, in declared order;
- per-stage records are ordered **by declaration, not by completion**.

Result: byte-identical to the sequential run, asserted by a test that runs both and compares. What
is *not* deterministic is the order progress **events** arrive in within a layer — deliberately, since
buffering a live UI signal to preserve an order nobody depends on would delay feedback for nothing.

### Failure semantics

From [`orchestrator.ts:131-136`](packages/analyzers/src/pipeline/orchestrator.ts#L131-L136):

- a **deterministic** stage fails → run `failed`, dependents skipped, partial returned;
- an **AI** stage fails → run `partial`, **deterministic result intact**;
- abort signal → remaining stages skipped.

That ordering is the product argument: the map, the metrics, the cycles and the communities do not
depend on a provider being up or a key being present. Losing the AI loses stages 7–8 and nothing else.

### Where the result is assembled

The orchestrator assembles `AnalysisResult` by **per-key slice assignment, never a deep-merge**
([`orchestrator.ts:131-132`](packages/analyzers/src/pipeline/orchestrator.ts#L131-L132)), emitting
one `ProgressEvent` per stage. Deep-merging would let a later stage silently half-overwrite an
earlier stage's slice; assignment makes slice ownership total and checkable.

---

## 3. The graph engine

Two graphs, one set of algorithms.

### The dependency graph and the code-property graph

`buildDependencyGraph` ([`buildGraph.ts`](packages/graph/src/buildGraph.ts)) builds from
import/require edges. The code-property graph
([`codePropertyGraph.ts`](packages/graph/src/codePropertyGraph.ts)) builds over the **union** of
dependency edges and V3-P1 call/inheritance edges.

The design point worth defending
([`codePropertyGraph.ts:17-20`](packages/graph/src/codePropertyGraph.ts#L17-L20)): *every existing
algorithm — centrality, cycles, blast radius, coupling, traversal, serialization — works on the
result unchanged, because they all read `nodes` / `outgoing` / `incoming` and never assume an edge is
an import.* The CPG was added without forking a single algorithm.

Two deliberate properties:

- CPG edges carry `weight = count`, so a file calling 40 symbols in another is more strongly coupled
  than one importing a single type. **Community detection reads that weight; the degree metrics do
  not** — because `metrics.perFile.fanIn`/`fanOut` are contractually "files that import this file",
  and silently redefining them would break every metric and every UI reading them.
- `edge.type` distinguishes `import`/`require` from `call`/`extends`/`implements`, so a caller can
  traverse dependency edges only, via `TraversalOptions.includeTypes`.

### Centrality

[`centrality.ts:4-20`](packages/graph/src/centrality.ts#L4-L20). Per node: `inDegree`, `outDegree`,
`totalDegree`, plus **transitive** `dependentCount` and `dependencyCount`.

Be precise under questioning: this is **degree and reachability centrality, not PageRank and not
betweenness**. Sorted by `totalDegree`, ties broken by `path.localeCompare` — a deterministic
tiebreak, so the ordering is stable across runs rather than dependent on node insertion order.

### Cycles

[`cycles.ts`](packages/graph/src/cycles.ts). DFS with an explicit `stack` plus an `inStack` set. On
reaching a node already in the stack, the cycle is sliced out (`stack.slice(startIndex)`) and
**canonically normalized** before being keyed into a `Map`. The normalization is what makes
`A→B→C→A` and `B→C→A→B` one finding instead of three — rotations of the same cycle collapse to one
key. Cycles are reported as node **paths**, resolved through `graph.nodeById`.

### Blast radius

[`blastRadius.ts:6`](packages/graph/src/blastRadius.ts#L6). Direct dependents, transitive dependents,
`affectedCount`, `maxDepth`, `riskReasons`, and a **`confidence`** derived from the per-edge
confidence of the traversal path and of the incoming edges.

The `confidence` field is the honest part, and worth volunteering before you are asked: edges are
resolved by static import analysis, which is not perfect on dynamic requires or aliased paths. A
blast radius therefore carries how much the resolver trusts the edges it walked, instead of
presenting a count as fact. A file not found in the graph returns `affectedCount: 0`,
`confidence: 0`, and an explicit `riskReasons` string — never a silent empty result that reads like
"nothing depends on this".

### Communities

Louvain, **seeded and canonically relabelled**, so two runs over the same graph produce the same
partition ([`communities.ts`](packages/graph/src/communities.ts)). Determinism here is a deliberate
engineering choice, not a property of the algorithm — vanilla Louvain is order-sensitive and will
happily give you two different partitions for one graph.

---

## The through-line

One idea runs through all three sections: **where a result could be either computed or asserted,
this codebase computes it; and where it cannot compute it, it labels it.**

- A citation's coordinates are read from retrieved evidence, so they cannot be asserted wrongly.
- The stage DAG is derived from declared reads via Kahn, so the schedule cannot drift from the code.
- Graph ordering is deterministic by explicit tiebreak and canonical relabelling, so the same commit
  gives byte-identical numbers.
- Where a number is genuinely a heuristic — file roles, entry points, "tests that reach it" — it is
  labelled a heuristic in the UI rather than promoted to a fact.

If you defend one sentence, defend that one.
