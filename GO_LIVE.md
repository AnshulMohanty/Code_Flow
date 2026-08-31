# GO_LIVE — the manual runbook

**Nothing in this file has been executed.** It exists because four files reference it and because the
V3-FINAL pass deliberately stopped at the boundary between "code and config, verifiable here" and
"needs a key, a running service, or a deployment". Everything below is the second kind.

Read it as a checklist for the owner, not as a description of a live system. Where a step has a
verification command, run that command — a step you cannot check is a step you have not done.

---

## 0. Before anything

```bash
git push -u origin v3/final-build-verify        # NOT done by the agent, by request
```

Then run the gate on a clean checkout, because a green gate on the machine that wrote the code proves
less than a green gate anywhere else:

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck && pnpm -r lint && pnpm test && pnpm -r build && node --test tests/*.mjs
```

Expected: **1336 tests**, legacy **25/25**, every command exit 0.

---

## 1. Secrets and configuration

Nothing here is committed and nothing is baked into an image. Every value is read from env at runtime.

### Required for the AI stages to run at all

| Variable | What breaks without it |
|---|---|
| `ANTHROPIC_API_KEY` **or** `GEMINI_API_KEY` | Synthesize (stage 7) never registers. The run completes as `runMode: "deterministic-only"` — an honest, usable result with no onboarding narrative. |
| `GEMINI_API_KEY` **or** `VOYAGE_API_KEY` | RAG (stage 8) never registers, so there is no Q&A index. `/api/result/:id/ask` returns an honest "no index" rather than an error. |
| `LLM_PROVIDER` / `EMBEDDING_PROVIDER` | Only needed when BOTH keys are present — otherwise the provider is inferred, and two keys with no explicit choice throws a clear error at boot rather than picking one. |

### Required for the shared guards

| Variable | Consequence if unset |
|---|---|
| `MONGO_URI` | The API falls back to per-process in-memory maps and reports `mongo-unavailable` as a visible degradation. The worker refuses to boot. |
| `REDIS_URL` | The worker refuses to boot (BullMQ needs it). The API degrades and ANNOUNCES it: the rate limit becomes per-process, the daily budget stops being shared with the worker, and sessions/repo memory/answer cache become per-process. |
| `POSTGRES_URL` | Retrieval degrades to an in-memory index, which is invisible to the other process — so the API can answer only for indexes it built itself, which for the API is none. Logged loudly at boot. |
| `DAILY_LLM_BUDGET` | Defaults apply. This is the wallet ceiling; set it deliberately. |

### Optional, and each one turns a `—` in the UI into a number

| Variable | Effect |
|---|---|
| `LLM_PRICING` | **Cost currently reports `usd: null` with the unpriced models NAMED.** Tokens are measured either way; only the dollar figure is missing. Set it and `/metrics`, `AnalysisResult.cost` and the site's COST PER FULL INDEX all become real. Format: `{"claude-sonnet-4-5":{"inputPerMillion":3,"outputPerMillion":15,"cacheReadPerMillion":0.3}}`. Prices are **not** baked in on purpose: they change per account and region, and a stale constant reports a confident wrong number where an empty table reports "we do not know". A malformed blob applies NO prices and logs why. |
| `LANGFUSE_HOST` + `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` | Traces POST to Langfuse's public ingest alongside the in-process buffer. **Never exercised against a real project** — see §4. |
| `HELICONE_API_KEY` (+ `HELICONE_ENDPOINT`) | Same, for Helicone. |
| `GIT_SHA` / `SOURCE_COMMIT` | The site footer shows a build id. Unset ⇒ `—`, deliberately: a build id nobody can look up is decoration. |
| `PARALLEL_STAGES=true` | Readiness-based parallel stage execution. Slices are asserted byte-identical either way; opt-in because this is the deterministic spine. |
| `FANOUT_SYNTHESIS=true` | Stage 7 becomes the 5N+1 specialist fan-out. **This is also what produces the DOMAINS tab** — without it there are no inferred domain lanes and the tab says so. |
| `FAST_MODEL` | Model routing (needs `GEMINI_API_KEY`). Unset ⇒ the single client is used UNWRAPPED, so cache keys are byte-identical to a non-routed deployment. |
| `WORKER_CONCURRENCY` | Jobs per worker instance. Default 2 — the previous hardcoded value, so an existing deployment is unchanged. Out-of-range values are clamped and announced. |
| `WORKER_HEALTH_PORT` | Binds the worker's `/health` `/ready` `/metrics`. **Unset ⇒ no socket is opened**, which is the default; set it before relying on a healthcheck or an autoscaler. |
| `MCP_SCOPES` | Comma-separated from `graph,retrieval,verify`. **Unset ⇒ the MCP server exposes NOTHING.** An unknown scope name refuses to start. |

---

## 2. Bring the services up

```bash
docker compose -f docker-compose.yml up -d           # mongo, redis, pgvector
docker compose -f docker-compose.app.yml build
docker compose -f docker-compose.app.yml up -d
```

**Verify, do not assume:**

```bash
curl -s localhost:4000/health | jq '{status, warmedUp, warming, tasks: .warmup.tasks}'
```

`warmedUp` must be `true`. If it is `false`, read the per-task list — that is what it is for. A failed
`mongo-connection` is the only task that blocks readiness; `shared-redis` and `qa-dependencies` record
their failure without taking the replica out of rotation, on purpose.

```bash
curl -s localhost:$WORKER_HEALTH_PORT/ready | jq
curl -s localhost:$WORKER_HEALTH_PORT/metrics | jq '{queueDepth, queueDepthAvailable, traceExport}'
```

`queueDepth: null` with `queueDepthAvailable: false` means Redis is unreadable — **do not treat it as
zero**, which would scale the fleet in exactly when the backlog became invisible.

---

## 3. First real analysis

Open the web app, paste a small public repository, and check three things that only a real run can show:

1. **Every pipeline row has a real duration**, and `ground` is either a number or an em-dash. An em-dash
   there means no chat provider is configured — it is not a spinner.
2. **The honest-state line matches reality.** GROUNDED only if the graph resolved and the AI stages ran.
3. **A citation chip opens GitHub at the analysed commit**, not at HEAD.

Then, with `LLM_PRICING` set:

```bash
curl -s localhost:4000/api/result/<jobId> | jq '.cost'
```

`measured: true` means every contributing figure came from a provider counter. `measured: false` means at
least one was an estimate — today the only such path is Gemini's batch-embed endpoint (ledger #22).

---

## 4. The proofs that need a real service

Each of these is unit-tested against an injected fake and has **never** run against the real thing.

| Proof | How |
|---|---|
| **Langfuse / Helicone export** (ledger, §1) | Set the env, run one analysis, confirm the trace appears in the backend. The exporter never throws and never blocks the run, so a failure is silent by design — check the worker log for `trace export failed`. |
| **Redis-backed stores** (ledger #25) | Two API replicas against one Redis: the per-IP rate limit must hold across both, and the daily budget must be one ceiling. |
| **pgvector** (ledger, V3-P2) | Confirm `retrieval.mode` is not `memory` at worker boot, and that the API can answer for an index the WORKER built. |
| **Anthropic / Gemini / Voyage adapters** (ledger #5, #12) | A keyed end-to-end run. The adapters are fetch-based with no SDK and are tested only against a stubbed `fetch`. |
| **MCP from a real agent** (ledger #31) | Point Cursor / Claude Code / Windsurf at `apps/mcp` with `MCP_SCOPES` set. Confirm `graph_facts`, `get_blast_radius` and `verify_answer` return, and that a tool outside the scope list is ABSENT rather than present-and-refusing. |

---

## 5. The scored eval

Needs `GEMINI_API_KEY` and **spends money**. This is what turns the placeholder thresholds into measured
ones, and until it runs no gating decision should rest on them.

```bash
# Produce an AnalysisResult per dataset first, then:
pnpm --filter @codeflow/eval run eval:scored
# or dispatch .github/workflows/eval-scored.yml (approval environment + concurrency lock)
```

`fail-on-threshold` defaults to **FALSE** deliberately: the workflow publishes numbers so the thresholds
can be calibrated FROM them. Flip it only once they are real.

Then, separately: hand-label **≥ 20** (answer, chunks) pairs as faithful/not and pass them as
`judgeLabels`. `judgeIsGateable` requires sample size AND Cohen's kappa ≥ 0.6 AND a CI lower bound ≥ 0.7
before faithfulness can gate anything. Do not shortcut this with invented labels — a judge calibrated
against those is worse than an uncalibrated one, because it looks trustworthy.

---

## 6. Deploy and scale

Nothing here was executed, and the config was written without a target platform in mind.

- **CDN:** serve `apps/web/dist` from a CDN. `config.js` is injected at container start, so ONE built
  image works across environments — do not cache it with the hashed assets.
- **Autoscale on QUEUE DEPTH, not CPU.** `/metrics` reports `queueDepth` for exactly this. The scale rule
  is printed at worker boot. CPU is the wrong signal: this worker is I/O-bound on provider calls for most
  of a run, so it looks idle while it is the bottleneck.
- **Readiness gates rollout.** `/ready` is 503 until warm-up completes; a scale-out instance must not be
  counted as capacity while it is still loading WASM grammars.
- **Keepalive:** `.github/workflows/keepalive.yml` is present and DISABLED. Enable it only if the host
  sleeps idle containers, and point it at `/health` (liveness), not `/ready`.

Then run the live benchmark, which is the only number here that says anything about real hardware:

```bash
pnpm bench:live -- <deployed-url>
```

The 1.76× scheduling speedup in the logs is **orchestration-only**, measured on a hermetic harness whose
stages do no parse or clone work. It is a bound on the scheduling win, not a claim about a repository.

---

## 7. Two things that stay as they are

Both are owner-deferred with the reasoning recorded (ledger #26, #27), and both are honestly labelled in
the code and the UI:

- The **local CLI's vector store** is a JSON file with an exact cosine scan, not LanceDB (656 MB, NAPI,
  drags back onnxruntime + sharp).
- The **local CLI's embeddings** are feature-hashed bag-of-words, not int8 MiniLM (its tokenizer is
  NAPI). Lexical, not semantic — it finds chunks sharing WORDS, not meaning, and the local similarity
  floor is raised to match.

Adopting either would make the test suite non-hermetic, which is why neither was done in-session.
