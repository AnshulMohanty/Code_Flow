<div align="center">

# CodeFlow

### Maps how a codebase fits together, and answers questions cited to real files and lines.

CodeFlow maps how any codebase fits together and answers questions cited to real files and
lines — built for developers navigating large, unfamiliar, or fast-moving codebases where
nobody holds the whole map in their head.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)
![Runs with Docker](https://img.shields.io/badge/run%20with-Docker%20Compose-2496ed.svg)

<!-- TODO(demo): record a ~20s GIF — paste a repo URL, the 8 stages stream, the radial map
     resolves, one question answered with a citation chip that opens GitHub at the analysed
     commit. Drop it at docs/demo.gif and uncomment. -->
<!-- ![CodeFlow analysing a repository](docs/demo.gif) -->

<!-- TODO(deploy): nothing is deployed yet. DEPLOY.md and GO_LIVE.md are the runbooks;
     render.yaml (paid) and render.free.yaml (free tier) are the blueprints.
     **Live demo:** _not deployed_ -->

</div>

---

## What it is

Give CodeFlow a repository and it runs an **8-stage pipeline** — streamed to the browser as it
happens — that turns source into a map you can interrogate.

| # | Stage | What it produces | Needs a key? |
|---|-------|------------------|---|
| 1 | **Ingest** | shallow-clones the repo, resolves the commit SHA | no |
| 2 | **Orient** | manifests, languages, frameworks, README | no |
| 3 | **Map structure** | the full file tree, classified by role | no |
| 4 | **Inventory** | symbols (functions/classes/…) + entry points | no |
| 5 | **Connect** | the import graph, plus call/inheritance edges | no |
| 6 | **Analyze** | centrality, fan-in/out, blast radius, cycles, communities | no |
| 7 | **Synthesize** | a grounded onboarding summary + ranked reading order | **yes** (chat) |
| 8 | **Index for Q&A** | a hybrid retrieval index so you can ask questions | **yes** (embeddings) |

Stages 1–6 are deterministic and always run. 7 and 8 register only when the matching provider key
is configured; without one the run completes as `deterministic-only` and **says so** rather than
sitting at "pending" forever.

### The one claim worth checking

**An answer cannot cite a file or line that was not actually read.** That is enforced structurally,
not by prompting: the model is only permitted to emit a *chunk id*, and the file path and line range
are read off the chunk that was genuinely retrieved. A fabricated line number is not rejected — it
cannot be expressed. Layered on top: reading-order steps whose file is not a real graph node are
dropped and counted, an entirely ungrounded synthesis is rejected outright, and `answered: true` with
no surviving evidence is downgraded to a refusal. Citation chips link to GitHub **at the analysed
commit**, so you can follow any claim to the source it came from.

---

## Real vs heuristic vs experimental

Not everything here is the same kind of thing, and the difference matters more than the feature list.

| Capability | Kind | What that means |
|---|---|---|
| Import / call graph, centrality, cycles, blast radius | **Real** | Computed from parsed source. Deterministic: same commit in, byte-identical numbers out. |
| Symbol extraction (JS/TS/JSX/TSX/Python) | **Real** | tree-sitter WASM. Measured against authored ground truth in `packages/eval`. |
| Community detection (Louvain) | **Real** | Seeded and canonically relabelled, so two runs of the same graph give the same partition. |
| Citation grounding | **Real** | Structural — see above. Enforced at the point of production, and shared as one predicate between the app, the eval and the verifier harness. |
| Hybrid retrieval (BM25 + vector → RRF → rerank → MMR) | **Real** | The refusal floor is compared against the vector arm's raw cosine, before fusion, so "I don't know" stays meaningful. |
| File-role classification, entry-point detection | **Heuristic** | Pattern-based. Usually right, occasionally not, and never presented as more than a classification. |
| "Test files that reach it" | **Heuristic** | Import reachability, **not** coverage. Labelled that way in the UI because there is no coverage data. |
| AI summary, reading order, inferred domains | **Model output** | Grounded and labelled as inference wherever shown. The parser's structural roles sit on a different tab for exactly this reason. |
| Specialist fan-out over communities, best-of-N | **Experimental** | Flag-gated (`FANOUT_SYNTHESIS`), off by default, and **unproven at real scale** — there is no measurement against a live model showing it produces better output than the single-shot stage. |
| Speculative prefetch, model routing, parallel stages | **Experimental** | Flag-gated, off by default. The measured speedups are orchestration-only, on a hermetic harness with mock providers. |

---

## Honest limits

- **Language coverage is narrower than "any codebase".** tree-sitter covers **JavaScript,
  TypeScript, JSX, TSX and Python**. Everything else gets regex import-scanning and line counts —
  no symbols, no call edges — so `find_references`, callers and blast radius return little of use
  on a Go, Rust, Java or C# repository. The pipeline degrades gracefully; it does not pretend.
- **The AI stages need your key.** No key means no summary and no Q&A. The map, the metrics, the
  cycles and the communities all still work.
- **The fan-out is opt-in.** It is 5N+1 provider calls where the single-shot stage is 1. With it
  off, the Domains tab is hidden rather than empty.
- **Local-CLI search is lexical only.** The offline embedder is feature hashing, not a transformer:
  it finds chunks that share *words*, not meaning. See [Analyse a private repo](#analyse-a-private-repo-offline).
- **Cost reports tokens always and dollars only if you price them.** `usd` is `null` until
  `LLM_PRICING` is set, with the unpriced models named. Tokens are read from the provider's own
  counters either way.
- **Nothing is deployed, and nothing has run against a live provider.** Every number in this repo
  comes from a hermetic suite with mocked providers. See `GO_LIVE.md` for what still needs a real
  service.

---

## Architecture

A pnpm + TypeScript monorepo. Four services over three data stores.

```
            ┌───────────┐      enqueue       ┌──────────┐ → MongoDB  (results, caches)
  Browser → │  web (SPA)│ ─────────────────→ │ api      │ → Redis    (queue, budget, limits)
            │  :5173    │ ←── SSE progress ── │ :4000    │ → Postgres (pgvector — the Q&A index)
            └───────────┘                    └────┬─────┘
                                                  │ job
                                             ┌────▼─────┐  git clone + Gemini / Anthropic / Voyage
                                             │ worker   │  runs the 8-stage pipeline
                                             └──────────┘
```

| Path | What it is |
|------|-----------|
| `apps/web` | React 18 + Vite SPA. No UI framework, no chart library. |
| `apps/api` | Express + SSE. Can also host the worker in-process (`RUN_WORKER_IN_PROCESS`). |
| `apps/worker` | BullMQ consumer — clones, parses, calls the providers. |
| `apps/mcp` | MCP stdio server exposing the graph + retrieval + a verifier to a coding agent. |
| `apps/local-cli` | `codeflow-local` — offline analysis, no key, no network. |
| `packages/*` | `analyzers` (pipeline), `agents`, `graph`, `parsers`, `retrieval`, `memory`, `observability`, `arena`, `eval`, `shared-types`, `config` |

The dependency map in the UI is a **radial layout rendered as hand-written inline SVG — no graph
library**. Distance from the centre is fan-in rank, so the most depended-upon modules sit in the
middle. It replaced a force-directed graph deliberately: force layouts are non-deterministic, so two
loads of the same repository produced two different pictures and neither said which module was
load-bearing. See `ARCHITECTURE.md` for the reasoning behind this and the other significant choices.

---

## Run it locally (Docker)

The whole stack — web, API, worker, MongoDB, Redis and Postgres — runs with **one command**. You
need Docker and your own free Gemini API key.

### Prerequisites
- **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** installed and **running**.
- A **Gemini API key** (free) — get one at **https://aistudio.google.com/apikey**.
  CodeFlow never ships a key; you use your own, and it stays on your machine.

### 1. Get the code
```bash
git clone https://github.com/AnshulMohanty/Code_Flow.git
cd Code_Flow
```

### 2. Add your API key
Create a file named **`codeflow.env`** in the project root with a single line:
```
GEMINI_API_KEY=your-key-here
```
> `codeflow.env` is git-ignored — your key is never committed.

### 3. Start it
```bash
# macOS / Linux
./start.sh

# Windows
start.bat

# …or run the command directly (any OS)
docker compose --env-file codeflow.env -f docker-compose.app.yml up -d --build
```
The **first run builds the images (a few minutes)**; later starts are quick.

### 4. Open the app
Go to **http://localhost:5173** and paste a public GitHub repo URL, for example:
```
https://github.com/jamiebuilds/the-super-tiny-compiler
```

### Ports
| Service | URL / Port |
|---------|------------|
| Web UI | http://localhost:5173 |
| API | http://localhost:4000 |
| MongoDB | 27017 |
| Redis | 6379 |
| Postgres (pgvector) | 5432 |

Postgres is **required for Q&A across processes**: the worker writes the index and the API reads
it. Without it both fall back to a private in-memory index and every question comes back "I could
not find that" — `GET /health` reports which one you actually have, under `retrieval`.

### Manage it
```bash
docker compose -f docker-compose.app.yml logs -f     # follow logs
docker compose -f docker-compose.app.yml down        # stop
docker compose -f docker-compose.app.yml down -v     # stop + wipe the local databases
```

---

## Analyse a private repo, offline

No key, no network, no code leaving the machine:

```bash
npx codeflow-local .
```

Parsing is tree-sitter WASM, the embedder is in-process, and the index is a file on disk — there is
no HTTP client, no socket and no provider key anywhere in that module's import graph, which is a
property you can verify by reading the imports rather than trusting this sentence.

It stops at a complete deterministic analysis plus a searchable index. **There is no AI summary**:
synthesis needs a model and there is no keyless local one, so rather than degrade into something that
looks like a summary and is not, it says what it cannot do. Search is lexical — shared identifiers
and path words, not meaning.

---

## Configuration

All runtime config is environment variables — [`.env.example`](.env.example) has the full list with
what breaks without each one. For the Docker run above, the only thing you must provide is
`GEMINI_API_KEY`.

| Variable | Default | Notes |
|----------|---------|-------|
| `GEMINI_API_KEY` | — | **Required** for stages 7–8. One key powers both chat and embeddings. |
| `LLM_PROVIDER` | inferred | `gemini` or `anthropic`. Both keys set with no explicit choice throws at boot rather than guessing. |
| `EMBEDDING_PROVIDER` | inferred | `gemini` or `voyage`. Gemini recommended — Voyage's free tier allows 3 req/min. |
| `MONGO_URI` / `REDIS_URL` / `POSTGRES_URL` | local containers | Point at managed services for a cloud deploy. |
| `CORS_ORIGINS` | — | Comma-separated browser origins. Until it is set the browser gets CORS errors against a healthy API. |
| `RUN_WORKER_IN_PROCESS` | `false` | Runs the worker inside the API — one service instead of two, for a free tier. |
| `LLM_PRICING` | — | JSON model→price. Unset ⇒ `usd: null` with the models named. |
| `FANOUT_SYNTHESIS` | `false` | The experimental specialist fan-out. Also the only thing that fills the Domains tab. |

---

## Local development

Run the apps from source with hot reload, using Docker only for the data stores.

```bash
pnpm install --frozen-lockfile     # Node 20 + pnpm 9
docker compose up -d               # mongo + redis + pgvector (dev stores only)
cp .env.example .env               # then set GEMINI_API_KEY

pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

Quality gates — **hermetic**: no network, no keys, no service containers, and zero skipped tests.

```bash
pnpm -r typecheck                # type-check all 16 workspaces
pnpm test                        # serial vitest suite
pnpm -r build
node --test tests/*.mjs          # root suite
```

**1441 vitest tests + 26 root tests**, all passing, at the time of writing. CI runs the same four
commands plus parser-parity, a keyless eval check, and a build of all three Docker images.

> Note (Windows): run installs one at a time — concurrent `pnpm install`s corrupt the
> node_modules link step.

---

## Troubleshooting

- **First `docker compose up` is slow** — it builds three images from source; later starts reuse
  the cache.
- **"Could not reach the API"** — check the `api` container is healthy and `CORS_ORIGINS` matches
  the web origin (`http://localhost:5173` by default).
- **Every question answers "I could not find that"** — `curl localhost:4000/health | jq .retrieval`.
  If `mode` is `memory`, Postgres is not reachable and the API is querying an index the worker
  never wrote to.
- **Run says "partial" / no Q&A index** — an embedding call was rate-limited. Keep
  `EMBEDDING_PROVIDER=gemini`; Voyage's free tier allows only 3 requests/min.
- **A port is already in use** — change the host port under `ports:` in `docker-compose.app.yml`.

---

## Docs

| File | What it is for |
|------|---------------|
| `ARCHITECTURE.md` | How the system is built and why — the decisions, with the measurements behind them. |
| `DEPLOY.md` | Ordered deploy walkthrough. Render (paid), Render free tier, Railway. |
| `GO_LIVE.md` | The manual runbook: keys, pricing, the pre-warm run, the proofs that need a real service. |
| `CURRENT_STATE.md` | Live status and the deferred ledger — what is open, and why. |
| `docs/archive/` | Superseded planning and phase logs, kept for provenance. |

`legacy/index.html` and `card/` are **inherited from the upstream project** and are not part of this
system — see `docs/archive/README.md`.
