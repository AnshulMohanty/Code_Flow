# GO_LIVE — the manual runbook

**Nothing in this file has been executed.** It exists because four files reference it and because the
V3-FINAL pass deliberately stopped at the boundary between "code and config, verifiable here" and
"needs a key, a running service, or a deployment". Everything below is the second kind.

Read it as a checklist for the owner, not as a description of a live system. Where a step has a
verification command, run that command — a step you cannot check is a step you have not done.

---

## 0. Before anything

```bash
# DONE (2026-09-01): pushed as `V2-codeflow`, and PR #1 is open against main.
# `git push -u origin V2-codeflow`
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
| ~~`DAILY_LLM_BUDGET`~~ | **NOT an env var** — corrected 2026-09-01. It is a compile-time constant in `@codeflow/config` (`5_000_000` tokens) and setting it in the environment does nothing. Changing the wallet ceiling is a code change. |

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
| `CODEFLOW_MCP_SCOPES` | Comma-separated from `graph,retrieval,verify` (or `all`). **Unset ⇒ the MCP server exposes NOTHING.** An unknown scope name refuses to start. |

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

**Nothing here has been executed.** As of 2026-09-01 there IS a target platform and the config
for it is in the repository: **`render.yaml`** (Render Blueprint, with a Railway appendix) and
**`DEPLOY.md`** (the ordered, copy-pasteable walkthrough — Atlas, Blueprint, secrets, first
deploy, pgvector, first analysis, the live benchmark). Read `DEPLOY.md` for the sequence; the
points below are the ones that outlive any particular host.

Three things `DEPLOY.md` adds that are easy to get wrong and silent when wrong:

- **`PORT`, not `API_PORT`.** A managed host assigns the port at boot. The API now binds
  `0.0.0.0` on `API_PORT` if set, else `PORT`, else 4000, and logs which one it chose — setting
  `API_PORT` on Render binds a port the proxy is not routing to.
- **Redis must be `noeviction`.** BullMQ keeps job state in Redis; under any `allkeys-*`
  policy jobs are evicted mid-flight with no error anywhere. Managed Redis often defaults to
  an eviction policy.
- **`CORS_ORIGINS` cannot be derived** from the blueprint (it needs the web URL, and the web
  build needs the API URL). Until it is set, the browser gets CORS errors against a perfectly
  healthy API.

- **CDN:** serve `apps/web/dist` from a CDN. `config.js` is injected at container start, so ONE built
  image works across environments — do not cache it with the hashed assets.
- **Autoscale on QUEUE DEPTH, not CPU.** `/metrics` reports `queueDepth` for exactly this. The scale rule
  is printed at worker boot. CPU is the wrong signal: this worker is I/O-bound on provider calls for most
  of a run, so it looks idle while it is the bottleneck.
- **Readiness gates rollout.** `/ready` is 503 until warm-up completes; a scale-out instance must not be
  counted as capacity while it is still loading WASM grammars.
- **Keepalive: REMOVED, on purpose.** `scripts/keepalive.mjs` and `.github/workflows/keepalive.yml`
  are gone. A 10-minute cron ping keeps a free instance awake by keeping it RUNNING — ~4,300 requests
  a month — which burns the ~750 free instance-hours and gets the service suspended for the rest of
  the month. A suspended service is worse than a sleeping one: sleeping wakes in 30-50s, suspended
  does not wake. Cold start is handled in the browser instead (wake-on-visit, `apps/web/src/lib/useWake.ts`),
  which costs hours only when a human is actually there. Nothing to enable.

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

---

## 8. `LLM_PRICING` — turning `usd: null` into a number

Cost reporting is **measured for tokens and unpriced for money** until this is set. `AnalysisResult.cost`
and `/metrics` report real input/output/cache-read token counts read from the provider's own response,
and `usd: null` with the contributing models NAMED in `unpricedModels`. That is deliberate: prices
change, differ per account and region, and a stale constant compiled into the image would report a
confident wrong number where an empty table reports "we do not know".

### The shape

A JSON object keyed by the **model string the code actually reports**, which is what the pricing
lookup uses. Get the keys wrong and the run stays unpriced — visibly, in `unpricedModels`, not
silently at zero.

| Where the key comes from | Default value |
|---|---|
| `SYNTHESIS_MODEL`, else the Anthropic default | `claude-opus-4-8` |
| `GEMINI_MODEL`, else the Gemini default | `gemini-2.5-flash` |
| `VOYAGE_MODEL`, else the Voyage default | `voyage-code-3` |
| `GEMINI_EMBEDDING_MODEL`, else the Gemini embed default | `gemini-embedding-001` |
| `FAST_MODEL`, when model routing is on | whatever you set |

`cacheReadPerMillion` is optional and falls back to `inputPerMillion`. Setting it matters more than
it looks: the synthesis and answer prompts are built as `[stable facts][volatile tail]` specifically
so the prefix can be cached, and without this key every cache hit is billed at full input price in
the report while the provider charged you a fraction of it.

### The default deployment (one Gemini key powers chat + embeddings)

```bash
LLM_PRICING='{
  "gemini-2.5-flash":     {"inputPerMillion": 0.30, "outputPerMillion": 2.50, "cacheReadPerMillion": 0.075},
  "gemini-embedding-001": {"inputPerMillion": 0.15, "outputPerMillion": 0.00}
}'
```

### An Anthropic chat + Voyage embeddings deployment

```bash
LLM_PRICING='{
  "claude-opus-4-8": {"inputPerMillion": 15.00, "outputPerMillion": 75.00, "cacheReadPerMillion": 1.50},
  "voyage-code-3":   {"inputPerMillion": 0.18,  "outputPerMillion": 0.00}
}'
```

> **CHECK THE NUMBERS BEFORE YOU PASTE THEM.** The figures above are the published list prices at the
> time this was written and they are the one thing in this runbook that goes stale without anything
> breaking — a wrong price produces a confident wrong dollar figure, which is worse than the `null`
> it replaced. Read them off the provider's pricing page on the day:
> [Gemini](https://ai.google.dev/pricing) · [Anthropic](https://www.anthropic.com/pricing) ·
> [Voyage](https://docs.voyageai.com/docs/pricing). An embedding model has no output tokens, hence
> the `0.00`.

### Verify it took

```bash
curl -s "$API/api/result/<jobId>" | jq '.cost'
```

`measured: true` means every contributing figure came from a provider counter. `usd` non-null means
every model that contributed was found in the table; if it is still `null`, read `unpricedModels` —
it names exactly which key is missing, which is almost always a model override you set and did not
add here. A malformed blob applies **no** prices at all and logs why, rather than applying half of
them.

---

## 9. Free-tier deployment — the ordered checklist

The full walkthrough with the tradeoffs is **DEPLOY.md Appendix C**; `render.free.yaml` is the
blueprint. This is the sequence.

1. **MongoDB Atlas M0** (free forever, external). Create it first — the API refuses to boot without
   `MONGO_URI`. Verify the URI from your own machine before handing it to Render.
2. **Apply `render.free.yaml`** as a Blueprint. It creates the API (with `RUN_WORKER_IN_PROCESS=true`),
   the static site, a free Key Value instance and a free Postgres.
3. **Fill the secrets** in the `codeflow-shared` env group: `MONGO_URI`, `GEMINI_API_KEY`, and
   optionally `LLM_PRICING` (§8).
4. **Set `CORS_ORIGINS`** on the API to the static site's URL, and `CODEFLOW_API_HOST` on the static
   site to the API's host. The Blueprint cannot resolve this pair — each needs the other's URL — and
   until it is done the browser gets CORS errors against a perfectly healthy API.
5. **Confirm the topology took.** The boot log must contain
   `RUN_WORKER_IN_PROCESS=true — the BullMQ consumer runs INSIDE this API process`
   and `CodeFlow worker listening on BullMQ queue "codeflow-analysis" (embedded in the API process)`.
   Without both, jobs will queue and nothing will drain them.
6. **Check what retrieval resolved to:**
   ```bash
   curl -s "$API/health" | jq '{status, warmedUp, retrieval}'
   ```
   `retrieval.mode` should be `postgres`. `memory` means the index is per-process — survivable in
   this topology (one heap, so Q&A still works) and not survivable across a restart. The
   `degradation` string names the variable and the fix.
7. **Pre-warm the demo repositories** so the first click is a cache hit rather than a clone:
   ```bash
   node scripts/prewarm-demos.mjs https://<api-host>
   ```
   Needs the keys to be live and **spends money** — roughly one synthesis plus one embedding pass per
   repository. Re-run it after any `ANALYZER_VERSION` bump: the cache key includes it, so a bump
   invalidates every entry at once.
8. **Regenerate the bundled snapshot** if you want a different repository on the landing page than
   CodeFlow itself:
   ```bash
   git clone <demo-repo> ../demo && node scripts/build-demo-snapshot.mjs --repo ../demo --name owner/repo
   ```
   Offline, deterministic, no key. It refuses to run on a dirty working tree, because the provenance
   pins a commit and a snapshot of uncommitted changes under that label would misstate which code was
   read. Commit the regenerated `apps/web/src/demo/snapshot.json` and redeploy the static site.
9. **Open the site cold.** The pill should read `WARMING`, the demo repositories should be clickable
   immediately, and Analyze should be disabled saying why. ~30-50 s later the pill flips to `READY`
   and Analyze enables. That sequence IS the free-tier design working; if the pill goes straight to
   `OFFLINE`, the API never answered — check step 5 and the instance-hour budget.

**There is no keep-alive to enable.** See DEPLOY.md Appendix C on why a cron pinger makes this worse
rather than better.

---

## 10. Turning the flagship features on (paid / keyed instance)

All three are off in both blueprints, each for a stated reason, and each is one variable.

| Variable | What it turns on | What it costs |
|---|---|---|
| `FANOUT_SYNTHESIS=true` | Stage 7 becomes the bounded specialist fan-out over code communities — five lenses per community, a blackboard, one supervisor, best-of-N on the hard tail. **This is also the only thing that produces the DOMAINS tab**; with it off the tab is hidden rather than empty. | 5N+1 provider calls where the single-shot stage is 1. On a repository with 12 communities that is ~61 calls instead of 1. |
| `FAST_MODEL=<model>` | Model routing: specialist calls on a cheap tier, supervisor/synthesis/agent turns on the configured model. Needs `GEMINI_API_KEY`. | Nothing — it lowers cost. Unset, the single client is used UNWRAPPED, so cache keys are byte-identical to a non-routed deployment. |
| `PARALLEL_STAGES=true` | Readiness-based parallel stage execution. Exactly one parallel layer exists in this pipeline (synthesize ∥ rag) because the deterministic chain is genuinely linear. | Nothing measurable on a small instance; the slices are asserted byte-identical either way. |

Turn `FANOUT_SYNTHESIS` on **after** `LLM_PRICING`, not before — otherwise the first thing the
fan-out does is spend an unknown amount of money and report `usd: null`.

---

## 11. Publishing `codeflow-local` to npm

The package is prepared but **has never been published**. `npm publish` is an owner step: it needs an
npm account with 2FA, and the name `codeflow-local` must still be free.

```bash
cd apps/local-cli
pnpm build && pnpm bundle            # tsc, then the single-file bundle npm actually ships
npm pack --dry-run                   # confirm the tarball is ONLY bundle/ + package.json + README
node bundle/codeflow-local.mjs analyze ../../packages/graph --no-index   # run the artifact itself
npm publish --access public
```

**Why the bundle matters and is not an optimisation.** `dist/index.js` imports `@codeflow/parsers`,
`@codeflow/graph`, `@codeflow/analyzers` and friends — every one of them `private: true` and never
published. A package shipped that way resolves those from the public registry, finds nothing, and
fails at install for every user. `bundle/codeflow-local.mjs` compiles the whole workspace graph in and
leaves exactly two runtime dependencies: `web-tree-sitter` and `@vscode/tree-sitter-wasm`, the second
of which is loaded by path at runtime and so cannot be inlined.

**Check before you publish:**

| Check | Why |
|---|---|
| `npm view codeflow-local` returns 404 | The name is free. If not, scope it (`@yourname/codeflow-local`) and update `bin` — the command name can stay `codeflow-local`. |
| `pnpm --filter codeflow-local test` is green | `zeroEgress.test.ts` greps the SHIPPED bundle for `fetch(`, provider clients and provider hostnames. It is the privacy guarantee, checked against the artifact rather than the source. |
| `bundle/` is not minified | Deliberate. The product claim is "this sends nothing anywhere", and the cheapest way for a stranger to verify that is to read the file they installed. |
| The version was bumped | `0.1.0` is the first. npm will not accept a republish of the same version. |

After publishing, `npx codeflow-local .` works anywhere with Node 20+. Until then the command in the
README works from a checkout:

```bash
node apps/local-cli/bundle/codeflow-local.mjs analyze /path/to/repo
```
