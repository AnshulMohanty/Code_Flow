# DEPLOY — Render (primary), Railway (appendix)

**Nothing in this file has been executed.** No service was created, no key was set, no image was
pushed. It is the ordered walkthrough for the owner; the config it refers to (`render.yaml`,
`.env.example`, the four Dockerfiles) is in the repository and passes the gate.

Where a step has a verification command, run it. **A step you cannot check is a step you have not
done** — and this system is specifically built to degrade quietly and *announce* it, so a service
that is up and answering can still be answering from per-process memory with no index behind it.
Every check below exists because there is a way for that step to half-work.

Companion documents:

| File | What it is for |
|---|---|
| `render.yaml` | The Blueprint itself, with the reasoning per field. |
| `.env.example` | Every variable the code reads, what breaks without it, and what it turns into in the UI. |
| `GO_LIVE.md` | The wider go-live runbook: first analysis, the proofs that need a real service, the scored eval. |
| `docs/archive/VERIFICATION_REPORT.md` §D | What remains owner-only, and why. |

---

## 0. What is being deployed, and what is not

Five services and one external database:

| Service | Render type | Why it is separate |
|---|---|---|
| `codeflow-api` | web (docker) | Express + SSE. Stateless. |
| `codeflow-worker` | worker (docker) | BullMQ consumer — clones, parses, and calls the providers. All the time and all the money is here, and it needs to scale on a different signal from the API. |
| `codeflow-web` | static | The built SPA. No server. |
| `codeflow-postgres` | database | pgvector: the Q&A index. The **worker writes it and the API reads it**, which is exactly why it cannot be per-process memory. |
| `codeflow-keyvalue` | keyvalue | The BullMQ queue, the shared rate limit, the shared daily budget. |
| MongoDB Atlas | *external* | No Render equivalent. Created by hand in step 1. |

**Not deployed, on purpose:**

- **`apps/mcp`** speaks **stdio** to a model client running on a developer's machine. There is no
  port to expose and nothing for a proxy to route to. Its distribution channel is `npm publish`.
- **`apps/local-cli`** runs on a laptop and its entire selling point is that no code leaves it.
  Deploying it would defeat the feature. Also `npm publish`.

Both still need `pnpm -r build` to pass, which the gate covers.

---

## 1. MongoDB Atlas first

The worker **refuses to boot** without `MONGO_URI`. The API degrades to per-process in-memory maps
and reports `mongo-unavailable` as a visible degradation — so a missing Mongo looks like a working
API with amnesia, which is worse than a crash.

1. Create a free M0 cluster.
2. Create a database user, and a database named `codeflow`.
3. Network access: Render does not publish stable egress IPs on the plans in `render.yaml`, so
   either allow `0.0.0.0/0` (relying on the credential, not the network, as the control) or move
   to a Render plan with a static outbound IP and allowlist that. **Decide this deliberately** —
   `0.0.0.0/0` on a cluster whose password is in one place is a different risk from `0.0.0.0/0` on
   a shared credential.
4. Copy the SRV connection string, with the database name in the path.

```bash
# Verify from your own machine before handing it to Render — a URI that fails here fails there.
mongosh "<MONGO_URI>" --eval 'db.runCommand({ ping: 1 })'
```

---

## 2. Create the Blueprint

Render → **New → Blueprint** → pick this repository → it reads `render.yaml`.

Confirm before applying:

- **Branch.** Render uses the branch you created the Blueprint from. If you deploy from
  `V2-codeflow` and later merge to `main`, re-point it or it keeps deploying the old branch.
- **Plans and cost.** `render.yaml` asks for `starter` on the API and worker and `basic-256mb` on
  Postgres. **There is no free plan for a Render worker**, and a free web instance would be the
  wrong choice regardless: it spins down on idle, and this worker holds a job for minutes.
- **Region.** All five are `oregon`. Keep them in ONE region — cross-region Postgres from the
  worker adds a round trip to every embedding batch write.

Applying creates the services and starts the first build. It will **fail** until step 3. That is
expected: the secrets are `sync: false`, which means Render will not invent them.

---

## 3. Fill the secrets

Render → **Env Groups → `codeflow-shared`**. Every value here is `sync: false` in the Blueprint
because a secret in a git-tracked file is a leaked secret.

**Required:**

| Key | Consequence of leaving it empty |
|---|---|
| `MONGO_URI` | Worker will not boot. API runs with per-process memory and says so. |
| `ANTHROPIC_API_KEY` **or** `GEMINI_API_KEY` | Synthesis never registers. Runs complete as `runMode: "deterministic-only"` — a real dependency map, no onboarding narrative. Honest, and not the product. |
| `GEMINI_API_KEY` **or** `VOYAGE_API_KEY` | RAG never registers, so there is no Q&A index. `/api/result/:id/ask` returns an honest "no index" rather than an error. |
| `LLM_PROVIDER` / `EMBEDDING_PROVIDER` | Only needed when BOTH keys are present. Two keys and no explicit choice **throws at boot** rather than picking one for you. |

`POSTGRES_URL` and `REDIS_URL` are **not** in this list — the Blueprint wires them from the
managed instances with `fromDatabase` / `fromService`. Do not set them by hand; a hand-typed copy
is a copy that goes stale when the instance is replaced.

**Do not set `API_PORT`.** It takes precedence over the platform's `PORT`, so setting it binds a
port Render is not routing to and the service is reported unhealthy with no useful error. The API
logs which variable chose its port at boot — see step 5.

Optional, and each one turns a `—` in the UI into a number: `LLM_PRICING`, `FANOUT_SYNTHESIS`,
`PARALLEL_STAGES`, `FAST_MODEL`, `LANGFUSE_*`, `HELICONE_API_KEY`, `SOURCE_COMMIT`. `.env.example`
says what each one changes.

---

## 4. First deploy

Trigger a redeploy of `codeflow-api` and `codeflow-worker`.

The Docker builds install the **whole pnpm workspace** and run `pnpm -r build` (see
`apps/api/Dockerfile`) — the first build is slow and later ones hit Render's layer cache. The
worker image also installs `git`, because it shallow-clones the repositories it analyses.

---

## 5. Verify the API — including the two things that look fine when broken

```bash
API=https://codeflow-api-XXXX.onrender.com

curl -s $API/health | jq '{status, warmedUp, warming, tasks: .warmup.tasks}'
```

`warmedUp` must be `true`. If it is `false`, read the per-task list — that is what it is for. A
failed `mongo-connection` is the **only** task that blocks readiness; `shared-redis` and
`qa-dependencies` record their failure without taking the instance out of rotation, on purpose.

**Check the port line in the logs.** This is the failure mode that costs the most time to diagnose:

```
codeflow-api listening on 0.0.0.0:10000 (port from platform) ...
```

`port from platform` is what you want. `port from explicit` means `API_PORT` is set and the
platform's port is being ignored — remove it. `port from default` on Render means neither was
readable, and Render is not routing to 4000.

```bash
# SSE must arrive INCREMENTALLY. A managed host fronts the app with an nginx-family proxy that
# buffers a response body by default, which turns a progress stream into one delivery at the end --
# the stream still "works" and is useless. The API sends `X-Accel-Buffering: no` for this.
curl -N -s "$API/api/job/<jobId>/events" | head -5
```

If those lines appear all at once when the job finishes rather than as it runs, buffering is still
on somewhere in front of the app.

---

## 6. Set `CORS_ORIGINS` — the step the Blueprint cannot do for you

`CORS_ORIGINS` needs the web site's URL, and the web build needs the API's URL. That is a mutual
reference Render cannot resolve on first create, so it is `sync: false`.

Until it is set, **the browser gets CORS errors against a completely healthy API**, which reads
like an outage and is not one.

```
CORS_ORIGINS = https://codeflow-web-XXXX.onrender.com
```

Comma-separated for more than one. Then redeploy `codeflow-api`.

---

## 7. Enable pgvector, and confirm it took

**No manual step should be needed.** `createPgvectorStore.ensureSchema()` runs, in order:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS codeflow_vectors_<dim> ( ... embedding vector(<dim>) NOT NULL, ... );
CREATE INDEX IF NOT EXISTS codeflow_vectors_<dim>_ns_file_idx ON ... (namespace, file_id);
CREATE INDEX IF NOT EXISTS codeflow_vectors_<dim>_hnsw_idx ON ... USING hnsw (embedding vector_cosine_ops);
```

Every statement is `IF NOT EXISTS`, so a redeploy re-runs it cleanly — asserted by a test, because
one non-idempotent statement there throws, the factory catches it, and the whole index degrades to
per-process memory for a reason that looks like a connection problem.

The dimension is **in the table name** (`codeflow_vectors_768` vs `codeflow_vectors_1024`) so two
embedding spaces can never share a table. `GEMINI_EMBEDDING_DIM` therefore selects a table, and
changing it writes a new index rather than corrupting the old one. Above 2000 dimensions the HNSW
index is deliberately skipped (pgvector's ceiling) and the search falls back to an exact scan.

**This has never run against a real managed Postgres.** It is tested against an injected fake SQL
client, which proves the statements and their order, not the permissions. `CREATE EXTENSION`
requires rights the database owner has on Render but not on every managed provider. So verify:

```bash
psql "$POSTGRES_URL" -c "SELECT extname, extversion FROM pg_extension WHERE extname='vector';"
psql "$POSTGRES_URL" -c "\dt codeflow_vectors_*"
```

If the extension is absent, create it once as the owner (`CREATE EXTENSION vector;`) and redeploy.

**Then confirm the mode.** There is no health field for this — the degradation is announced in
the **logs** and nowhere else, so read them rather than assuming:

```
[codeflow] Q&A retrieval DEGRADED — <reason> Questions will only be answerable ...   (api)
[worker] RETRIEVAL DEGRADED — <reason>                                               (worker)
```

The **absence** of those two lines is the pass. Their presence with `POSTGRES_URL` set means
Postgres was configured and *not reached*, so the API can only answer for indexes it built itself —
which, for the API, is none. The reason string says why.

That a log line is the only signal is a real observability gap, not a preference: `/health`
reports Mongo and warm-up but not the retrieval backend. The definitive check is functional, and
it is step 8.

---

## 8. One real analysis, to warm the caches and check the honest states

Open the web site, paste a small public repository, and check the three things only a real run can
show:

1. **Every pipeline row has a real duration**, and `ground` is either a number or an em-dash. An
   em-dash there means no chat provider is configured — it is not a spinner.
2. **The honest-state line matches reality.** `GROUNDED` only if the graph resolved *and* the AI
   stages ran.
3. **A citation chip opens GitHub at the analysed commit**, not at `HEAD`.

Then the cross-process proof — the single most valuable check here, because it is the one that
fails when everything looks fine:

```bash
# The WORKER built this index. The API is a different process. If this answers, Postgres and Redis
# are genuinely shared; if it says "no index", they are not, whatever /health said.
curl -s -X POST $API/api/result/<jobId>/ask \
  -H 'content-type: application/json' \
  -d '{"question":"where does authentication happen?"}' | jq '{answered, citations}'
```

With `LLM_PRICING` set:

```bash
curl -s $API/api/result/<jobId> | jq '.cost'
```

`measured: true` means every contributing figure came from a provider counter. `measured: false`
means at least one was an estimate — today the only such path is Gemini's batch-embed endpoint.

---

## 9. Record the real latency numbers

The site's NUMBERS section renders measured values or an em-dash. It has **no placeholder tier** —
figures that were never measured show as `—` with a reason. This is the step that replaces them.

```bash
pnpm bench:live -- https://codeflow-api-XXXX.onrender.com
```

Record the output in `CURRENT_STATE.md`. Two honesty notes that travel with the numbers:

- The **1.76× scheduling speedup** in the logs is **orchestration-only**, measured on a hermetic
  harness whose stages do no parse or clone work. It is a bound on the scheduling win, not a claim
  about a repository.
- The **Q&A p50 is PER-PROCESS** (ledger #30): a bounded in-memory ring that does not survive a
  restart, and two API instances report two different numbers. The payload carries
  `scope: "process"` and `sampleCount` and the UI renders both, so nothing reads it as a fleet
  percentile. On more than one instance, treat it as a sample.

---

## 10. Scale

- **Autoscale the worker on QUEUE DEPTH, not CPU.** `/metrics` reports `queueDepth` for exactly
  this. CPU is the wrong signal: the worker is I/O-bound on provider calls for most of a run, so it
  looks idle while it is the bottleneck. The scale rule is printed at worker boot.
- `queueDepth: null` with `queueDepthAvailable: false` means **Redis is unreadable — do not treat
  it as zero**, which would scale the fleet in exactly when the backlog became invisible.
- **Termination grace ≥ 300s.** An analysis job `SIGKILL`ed mid-run is re-delivered by BullMQ and
  redoes all of its work, *including the provider spend*.
- `WORKER_CONCURRENCY` tunes jobs per instance (default 2, ceiling 8). Past the ceiling, scale out.
- **There is deliberately NO scheduled keep-alive, and removing it was a decision, not a cleanup.**
  A cron ping every 10 minutes does defeat idle sleep — and it is ~4,300 requests a month that hold
  the container up 24/7, which exhausts a free tier's ~750 instance-hours and SUSPENDS the service
  for the remainder of the month. That is strictly worse than the problem: a sleeping service wakes
  in 30-50 seconds; a suspended one does not wake at all. The replacement is WAKE-ON-VISIT in the
  browser (`apps/web/src/lib/useWake.ts`): one fire-and-forget `GET /health` when a real person
  opens the page, retried with backoff and stopped the moment it answers. A month with no visitors
  costs no hours. On a PAID plan that never sleeps, none of this applies and nothing needs enabling.

---

## Appendix A — Railway

Same five services, different vocabulary. The application needs no changes: `PORT` is read the same
way, and `.env.example` is the same list.

| Render | Railway |
|---|---|
| Blueprint (`render.yaml`) | No equivalent — create services in the dashboard or with `railway up`. `render.yaml` is **not** read. |
| Postgres + `postgresMajorVersion` | **Postgres plugin.** Check the pgvector version it ships; if `CREATE EXTENSION vector` fails, that plugin build does not have it and step 7 cannot be worked around in the app. |
| Key Value | **Redis plugin.** Set `maxmemory-policy` to `noeviction` — see the warning below. |
| `type: web` vs `type: worker` | One service type. The difference is the **start command** and whether you attach a domain: API → `node apps/api/dist/index.js` with a domain; worker → `node apps/worker/dist/index.js` with none. |
| `healthCheckPath` | Healthcheck path in service settings. Use `/health`, not `/ready`. |
| static site | Serve `apps/web/dist` from any static host, or deploy `apps/web/Dockerfile` (nginx) — which **restores runtime API-URL injection** via `API_BASE_URL`, so one image works across environments. |
| `fromService` / `fromDatabase` | `${{Postgres.DATABASE_URL}}` / `${{Redis.REDIS_URL}}` reference syntax. |

**The one that will bite you:** BullMQ stores job state in Redis, and under any `allkeys-*`
eviction policy the store evicts keys when it fills — **jobs disappear mid-flight with no error
anywhere**. Managed Redis often defaults to an eviction policy. Set `noeviction` explicitly and
verify:

```bash
redis-cli -u "$REDIS_URL" CONFIG GET maxmemory-policy    # must be: noeviction
```

MongoDB stays Atlas on Railway too.

---

## Appendix B — what is still owner-only after all of this

Deploying does not close these. They are in `docs/archive/VERIFICATION_REPORT.md` §D and `GO_LIVE.md` §4–5:

| | Why it needs you |
|---|---|
| Langfuse / Helicone export | Never exercised against a real project. The exporter never throws and never blocks a run, so a failure is **silent by design** — check the worker log for `trace export failed`. |
| Redis-backed shared guards | Two API instances against one Redis: the per-IP rate limit must hold across both, and the daily budget must be one ceiling. |
| Provider adapters | Fetch-based, no SDK, tested only against a stubbed `fetch`. A keyed end-to-end run is the proof. |
| MCP from a real agent | Point Cursor / Claude Code / Windsurf at `apps/mcp` with `CODEFLOW_MCP_SCOPES` set. Confirm a tool outside the scope list is **absent**, not present-and-refusing. |
| The scored eval | Needs `GEMINI_API_KEY` and **spends money**. Until it runs, the thresholds are placeholders and no gating decision should rest on them. |
| Judge labels | Hand-label **≥ 20** (answer, chunks) pairs. `judgeIsGateable` requires sample size **and** Cohen's kappa ≥ 0.6 **and** a CI lower bound ≥ 0.7. Do not shortcut this with invented labels — a judge calibrated against those is worse than an uncalibrated one, because it looks trustworthy. |

---

## Appendix C — the FREE deployment, and what it actually costs you

**Nothing in this appendix has been executed either.** It is the free-tier shape described so it can
be reviewed, with the tradeoffs stated rather than discovered.

The paid shape above is the right architecture: the worker holds a job for minutes and scales on
queue depth, the API scales on request volume, and separating them is what lets either move without
the other. It is also not deployable for free — Render has no free `worker` service type — and an
architecture nobody can run is not better than one they can.

### The shape

| Piece | Free option | What you give up |
|---|---|---|
| `codeflow-web` | Render **static site** | Nothing. Static hosting is free, always on, and never sleeps. This is why the frontend must paint without the API — see below. |
| `codeflow-api` | Render **free web service**, with `RUN_WORKER_IN_PROCESS=true` | The BullMQ consumer runs inside the API process. One event loop for parsing and HTTP; concurrency forced to 1; a worker crash takes the API with it. |
| MongoDB | **Atlas M0** (external, free forever) | 512 MB. Fine for an analysis cache; it is the first thing to fill. |
| Redis | Render **Key Value**, free instance | Small. Set `maxmemoryPolicy: noeviction` — under any `allkeys-*` policy BullMQ jobs are evicted mid-flight with no error anywhere. |
| Postgres / pgvector | Render **free Postgres** | **Expires after 30 days.** When it does, `POSTGRES_URL` points at nothing and retrieval degrades — see the next section, which is the part worth reading. |

`render.free.yaml` is that blueprint. `render.yaml` remains the paid one; neither is applied.

### The two things that are genuinely different, not just smaller

**1. The frontend is always on and the backend is not.** A free web service suspends after ~15
minutes idle and takes roughly 30–50 seconds to wake. Three things in the code exist for exactly
this, and they are the reason a visitor never sees a dead page:

- The SPA renders its whole shell — nav, hero, sections, workbench chrome — with **no API call on
  the paint path**. A test asserts this with the API unreachable.
- **Wake-on-visit** (`apps/web/src/lib/useWake.ts`): one fire-and-forget `GET /health` on first
  mount, retried with backoff because the first request during a cold start usually times out, and
  **stopped** the moment it answers. The status pill reflects the real result; the analyze button
  stays in an honest "warming up" state until it does.
- The curated **demo repositories** are pre-warmed into the analysis cache, so there is real content
  on screen while the backend is still coming up.

**There is deliberately NO scheduled pinger, and this is the decision most likely to be second-guessed.**
A cron ping every 10 minutes keeps the service awake — and is ~4,300 requests a month that hold the
container running 24/7, which exhausts Render's free **~750 instance-hours** and **suspends the
service for the remainder of the month**. That is strictly worse than sleeping: a sleeping service
wakes in 40 seconds; a suspended one does not wake at all. A wake triggered by a real visitor costs
hours only when somebody is actually there. `scripts/keepalive.mjs` and `.github/workflows/keepalive.yml`
were removed for this reason, not because they did not work.

**2. Q&A survives losing Postgres in this mode, and only in this mode.** When the free Postgres
expires, `createRetrievalStores` falls back to a per-process in-memory index and says so — on
`/health` as `retrieval.mode: "memory"` with the reason, and in the boot log. In the normal split
deployment that means the worker writes an index the API cannot read and **every question is
refused**. In embedded mode the API and the worker share a heap, so they are handed the **same store
instance** and Q&A keeps working — with no durability: the index is rebuilt on every restart and
holds only what this process analysed.

That is a real, stated limitation, not a workaround. It is also the one thing the single-process
shape is better at.

### Enabling it

```bash
# On the API service only:
RUN_WORKER_IN_PROCESS=true
```

The flag is read by `resolveEmbeddedWorker` (`apps/api/src/config/embeddedWorker.ts`), which forces
concurrency to 1 and logs both facts at boot. An unrecognised value is treated as FALSE **and
announced** — a typo here silently produces the opposite deployment, and the symptom is "jobs queue
and nothing happens", which looks like a Redis problem.

With the flag off, the worker module is never even imported: the API uses a dynamic import, so a
normal deployment pays nothing for this path.

### Railway

The same flag is the whole story there too. Railway has no free worker/web distinction — it bills
usage — so one service running the API image with `RUN_WORKER_IN_PROCESS=true` is the equivalent
shape, plus the same external Atlas. Railway's plugin marketplace has Postgres and Redis; pgvector
needs the `pgvector/pgvector` image rather than the default Postgres plugin. Nothing in the code
changes between the two hosts.

### What you should expect it to feel like

- First visit after an idle period: page paints instantly, pill reads **warming analysis engine…**,
  demo repositories are clickable, analyze is disabled with the reason. ~30–50 s later the pill
  flips to **ready** and analyze enables.
- A demo click on a warm cache: roughly one round trip.
- A fresh repository: a real clone-and-parse, minutes for anything large, and `WORKER_CONCURRENCY`
  is ignored — one job at a time.
- After 30 days: `retrieval.mode` on `/health` reads `memory`. Read the degradation string; it names
  the variable and the fix.
