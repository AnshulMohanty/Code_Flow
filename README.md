<div align="center">

# CodeFlow

### Understand any codebase, fast.

Paste a public GitHub URL and CodeFlow clones it, maps its structure and dependency graph,
ranks the files that matter, writes a grounded "where do I start" onboarding with AI, and lets
you **ask questions about the repo** — every answer cited to real files and line numbers.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)
![Runs with Docker](https://img.shields.io/badge/run%20with-Docker%20Compose-2496ed.svg)

</div>

---

## What it is

CodeFlow is a self-hostable code-analysis app. Give it a repository and it runs an **8-stage
pipeline** — streamed live to the UI — that turns raw source into an explorable map:

| # | Stage | What it produces |
|---|-------|------------------|
| 1 | **Ingest** | shallow-clones the repo, resolves the commit SHA |
| 2 | **Orient** | manifests, languages, frameworks, README |
| 3 | **Map structure** | the full file tree, classified by role |
| 4 | **Inventory** | symbols (functions/classes/…) + entry points |
| 5 | **Connect** | the real import/dependency graph |
| 6 | **Analyze** | metrics: centrality, fan-in/out, blast radius, cycles |
| 7 | **Synthesize** (AI) | a grounded onboarding summary + ranked reading order |
| 8 | **Index for Q&A** (AI) | a RAG index so you can ask questions about the code |

Everything the AI says is **grounded in code** — reading-order steps and answer citations are
validated against real graph nodes and line ranges, never fabricated.

## Features

- **Live pipeline view** — watch all 8 stages stream in real time (SSE), with honest terminal
  states (e.g. "partial" when an optional AI stage is skipped).
- **Dashboard** — *Start Here* (AI summary + reading path), *Structure* map, and a per-file
  *drill-down* (centrality, blast radius, imports/importers, symbols).
- **2D dependency graph** — interactive force-directed graph; click a node to focus its
  neighbourhood; cycles highlighted.
- **Ask the repo** — grounded Q&A with clickable citations to the exact files.
- **Bring-your-own AI** — chat on **Gemini** or Anthropic; embeddings on **Gemini** or Voyage,
  selected by env. One Gemini key powers the whole AI layer.
- **Built-in guardrails** — repo-size cap, per-IP rate limit, and a daily LLM-spend ceiling.

## Architecture

A pnpm + TypeScript monorepo of three services backed by MongoDB + Redis:

```
            ┌───────────┐      enqueue       ┌──────────┐
  Browser → │  web (SPA)│ ─────────────────→ │ api      │ → MongoDB (results, cache)
            │  :5173    │ ←── SSE progress ── │ :4000    │ → Redis  (BullMQ queue)
            └───────────┘                    └────┬─────┘
                                                  │ job
                                             ┌────▼─────┐  git clone + Gemini/Voyage
                                             │ worker   │  runs the 8-stage pipeline
                                             └──────────┘
```

| Path | Service |
|------|---------|
| `apps/web` | React + Vite SPA (nginx in prod) |
| `apps/api` | Express API + SSE progress stream |
| `apps/worker` | BullMQ worker — clones repos, runs the pipeline, calls the AI providers |
| `packages/*` | `analyzers` (the pipeline), `graph`, `parsers`, `shared-types`, `config`, `eval` |

---

## Run it locally (Docker)

The whole stack — web, API, worker, MongoDB, and Redis — runs with **one command**. You only
need Docker and your own free Gemini API key.

### Prerequisites
- **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** installed and **running**.
- A **Gemini API key** (free) — get one at **https://aistudio.google.com/apikey**.
  CodeFlow never ships a key; you use your own, and it stays on your machine.

### 1. Get the code
**Clone:**
```bash
git clone https://github.com/AnshulMohanty/Code_Flow.git
cd Code_Flow
```
**…or download the release `.zip`**, unzip it, and `cd` into the folder.

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
Watch the 8 stages stream, then explore the dashboard, graph, and Ask tab.

### Manage it
```bash
docker compose -f docker-compose.app.yml logs -f     # follow logs
docker compose -f docker-compose.app.yml down        # stop
docker compose -f docker-compose.app.yml down -v     # stop + wipe the local database
```

### Ports
| Service | URL / Port |
|---------|------------|
| Web UI | http://localhost:5173 |
| API | http://localhost:4000 |
| MongoDB | 27017 |
| Redis | 6379 |

If a port is taken, change the left-hand number under `ports:` in `docker-compose.app.yml`
(and update `CORS_ORIGINS` / `API_BASE_URL` to match the new web port).

---

## Configuration

All runtime config is environment variables (see [`.env.example`](.env.example) for the full
list). For the Docker run above, the only thing you must provide is `GEMINI_API_KEY`. Notable
options:

| Variable | Default | Notes |
|----------|---------|-------|
| `GEMINI_API_KEY` | — | **Required.** Your own key. |
| `EMBEDDING_PROVIDER` | `gemini` | `gemini` or `voyage`. Gemini is recommended — Voyage's free tier rate-limits at 3 req/min. |
| `LLM_PROVIDER` | `gemini` | `gemini` or `anthropic` (set the matching key). |
| `MONGO_URI` / `REDIS_URL` | local containers | Point at managed services for cloud deploys. |
| `CORS_ORIGINS` | — | Comma-separated browser origins allowed in production. |

Without an AI key the deterministic pipeline (stages 1–6) still runs; the AI stages (7–8)
simply don't register, and the run reports "partial" honestly.

---

## Local development (contributors)

Run the apps from source with hot reload, using Docker only for MongoDB + Redis.

```bash
# 1. Install deps (Node 20 + pnpm 9)
pnpm install --frozen-lockfile

# 2. Start MongoDB + Redis (dev compose = data stores only)
docker compose up -d

# 3. Create a .env in the repo root from the template, add your key
cp .env.example .env        # then set GEMINI_API_KEY, EMBEDDING_PROVIDER=gemini

# 4. Run the services (separate terminals)
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

Quality gates (hermetic — no network, no real API calls):
```bash
pnpm -r typecheck                # type-check every package
pnpm test                        # serial test suite (-r --workspace-concurrency=1)
node --test tests/*.mjs          # legacy root tests
```

> Note (Windows): run installs one at a time — concurrent `pnpm install`s corrupt the
> node_modules link step.

---

## Troubleshooting

- **First `docker compose up` is slow** — it's building three images from source; subsequent
  starts reuse the cache.
- **"Could not reach the API"** — make sure the `api` container is healthy and `CORS_ORIGINS`
  matches the web origin (`http://localhost:5173` by default).
- **Run says "partial" / no Q&A index** — an embedding call was rate-limited. Keep
  `EMBEDDING_PROVIDER=gemini` (Voyage's free tier allows only 3 requests/min).
- **A port is already in use** — change the host port under `ports:` in `docker-compose.app.yml`.

---

## License

MIT — use it however you want.
