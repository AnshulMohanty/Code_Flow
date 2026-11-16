<div align="center">

# CodeFlow

### The codebase map that proves its answers.

CodeFlow maps how a JavaScript, TypeScript, Python, Go, Java or C/C++ codebase fits together, answers
questions cited to real files and lines, and **checks the code references in anyone's answer** — an AI
agent's, a PR description's, a reviewer's — against the repository. The graph is scored against each
language's own toolchain (the TypeScript compiler, `go list`, javac, clang); the checker runs offline,
with no key.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)
![Runs with Docker](https://img.shields.io/badge/run%20with-Docker%20Compose-2496ed.svg)

<!-- TODO(demo): record a ~20s GIF — paste a repo URL, the 8 stages stream, the radial map
     resolves, one question answered with a citation chip that opens GitHub at the analysed
     commit. Drop it at docs/demo.gif and uncomment. -->
<!-- ![CodeFlow analysing a repository](docs/demo.gif) -->

<!-- TODO(deploy): nothing is deployed yet. DESIGN.md §3.5 is the runbook;
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

The same check is available for text CodeFlow did **not** write: `codeflow-local verify`, the
`verify_citations` MCP tool and the GitHub Action take any prose and mark every `path:line`, GitHub
link and named symbol as verified, unverifiable or wrong. See [Check an answer or a PR](#check-an-answer-or-a-pr).

### Measured, not asserted: the import graph vs each language's own toolchain

**TypeScript / JavaScript**, against the TypeScript compiler.

`scripts/graph-accuracy.mjs` resolves every import in a repository with `ts.resolveModuleName` under
the nearest `tsconfig` — what `tsc` itself does — and compares each one with CodeFlow's edge for the
same `(file, specifier)`. Measured on 2026-11-16 at each repository's default-branch HEAD:

| Repository | In-repo imports (per tsc) | Agree | Wrong | Missed | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|
| trpc/trpc (pnpm monorepo) | 2,753 | 2,751 | 0 | 2 | 100% | 99.93% |
| colinhacks/zod (NodeNext `.js`→`.ts`) | 823 | 821 | 0 | 2 | 100% | 99.76% |
| CodeFlow itself | 824 | 824 | 0 | 0 | 100% | 100% |
| shadcn-ui/taxonomy (`@/` aliases) | 260 | 260 | 0 | 0 | 100% | 100% |
| expressjs/express | 154 | 154 | 0 | 0 | 100% | 100% |

The four misses are imports written inside `declare module "…" { … }` blocks. CodeFlow additionally
maps workspace-package imports (`@acme/ui`) to their **source** files, which tsc can only resolve to a
built `dist/`; those are reported as "extra" by the script rather than counted either way. CI runs the
same check on this repository and fails below 100% precision / 99% recall.

**Go**, against the Go toolchain. `scripts/accuracy/go.mjs` asks `go list -deps -test` — in every
module, with each repository's own `replace`, `go.work` and vendoring — which directory every import
resolves to, and compares it with CodeFlow's edge. CodeFlow points a Go import at the file that
declares what is used (`store.Open` → the file declaring `Open`), so an edge agrees when its target
is in the directory `go list` chose. Measured on 2026-11-16:

| Repository | Layout | In-repo imports (per `go list`) | Wrong | Missed | Precision | Recall |
|---|---|---:|---:|---:|---:|---:|
| kubernetes/kubernetes | 40 modules, staging + `replace` | 59,823 | 0 | 0 | 100% | 100% |
| gohugoio/hugo | 4 modules | 2,222 | 0 | 0 | 100% | 100% |
| etcd-io/etcd | 14 modules, `go.work` | 2,124 | 0 | 0 | 100% | 100% |
| etcd-io/etcd v3.3.27 | GOPATH era, no `go.mod` | 1,262 | 0 | 0 | 100% | 100% |
| spf13/cobra | 1 module | 7 | 0 | 0 | 100% | 100% |

For the GOPATH-era repository the import prefix it was checked out under is inferred from its own
imports (`github.com/coreos/etcd`); `go list` ran in GOPATH mode at that path. "Extra" edges —
CodeFlow has one, `go list` does not — are all files behind build tags (`_windows.go`,
`//go:build tools`), which a default `go list` skips. CI runs the etcd check and fails below 100%
precision / 99% recall. Kubernetes (26,558 files) analyses in 34 s on a laptop.

**Java**, against javac. `scripts/accuracy/JavaTruth.java` runs javac's own attribution (the Compiler
Tree API) over every source file and records each name that resolves to a type declared in the
repository — imports, same-package types (Java needs no import for those), nested and fully qualified
names. CodeFlow's file-to-file edges are compared with that set. Measured on 2026-11-16:

| Repository | Layout | Edges (per javac) | CodeFlow-only | Missed | Precision | Recall |
|---|---|---:|---:|---:|---:|---:|
| apache/ant | legacy Ant layout (`src/main/org/…`) | 5,725 | 7 | 3 | 99.88% | 99.95% |
| junit-team/junit4 | Maven, Java 5 era | 2,474 | 0 | 3 | 100% | 99.88% |
| apache/commons-lang | Maven | 1,783 | 0 | 0 | 100% | 100% |
| jhy/jsoup | Maven | 1,425 | 0 | 0 | 100% | 100% |
| google/gson | Maven, multi-module | 1,326 | 0 | 0 | 100% | 100% |

Every remaining difference is the reference, not CodeFlow: the truth compiles without third-party jars,
so where a file explicitly imports a library class (`javax.mail.Message`, hamcrest's `TypeSafeMatcher`)
javac falls back to a same-named class in the file's own package; and Ant's test fixtures declare the
same class in several directories, which one javac run maps to the first copy. CI runs the jsoup check
and fails below 100% precision / 99% recall.

**C/C++**, against clang. `scripts/accuracy/c.mjs` has CMake write `compile_commands.json` — every
file's real `-I`/`-D` flags — then compiles each translation unit with clang 21, which reports every
file it opened and what each of its `#include`s resolved to (include-guarded re-includes too). CodeFlow
never sees the build flags; it follows the compiler's search order from the repository alone.
Measured on 2026-11-16:

| Repository | Language | In-repo includes (per clang) | Wrong | Missed | Precision | Recall |
|---|---|---:|---:|---:|---:|---:|
| libuv/libuv | C | 510 | 0 | 0 | 100% | 100% |
| google/leveldb | C++ | 310 | 0 | 0 | 100% | 100% |
| fmtlib/fmt | C++ | 125 | 0 | 0 | 100% | 100% |
| madler/zlib | C, legacy | 39 | 0 | 0 | 100% | 100% |

Includes in `#if` branches a Linux build does not take (`uv/win.h`, `uv/os390.h`) are real edges the
compiler never opens, so they are reported but not judged. CI runs the libuv check.

Python imports are not benchmarked against a reference resolver yet.

---

## Real vs heuristic vs experimental

Not everything here is the same kind of thing, and the difference matters more than the feature list.

| Capability | Kind | What that means |
|---|---|---|
| Import graph | **Real, measured** | Relative imports, `.js`→`.ts` (NodeNext), tsconfig/jsconfig `paths` + `baseUrl` (with `extends`/`references`), workspace packages, Python relative + absolute (src layout) imports, Go modules (`replace`, `go.work`, nested modules, GOPATH-era repos), Java (imports, same-package types, on-demand and static imports, any source layout), C/C++ (`#include` in the compiler's search order; calls reach the defining file). Scored against tsc, `go list`, javac and clang above. Committed JS bundles (webpack/browserify/Parcel) are left out rather than reported as hundreds of broken imports. |
| Call graph, centrality, blast radius | **Real** | Computed from parsed source. Deterministic: same commit in, byte-identical numbers out. Key-file ranking counts production imports only, so heavily-tested files do not outrank load-bearing ones. |
| Import cycles | **Real** | **Load-time** cycles only: `import type`, `if TYPE_CHECKING:`, imports inside function bodies and dynamic `import()` cannot cause an import-order failure and are excluded — on Zod, tRPC and Flask that is the difference between dozens of reported cycles and the true number, zero. |
| Citation check of arbitrary text | **Real** | Does the file exist, are the cited lines inside it (physical line count), is the named symbol declared there? It proves a reference points at something real — not that the prose around it describes that code correctly. |
| PR impact (`impact`, GitHub Action) | **Real** | Dependents, entry points, tests that reach the change, new load-time cycles and imports that resolve to nothing — from the import graph of both sides of the diff. |
| Symbol extraction (JS/TS/JSX/TSX/Python/Go) | **Real** | tree-sitter WASM. JS/TS/Python measured against authored ground truth in `packages/eval`. |
| Community detection (Louvain) | **Real** | Seeded and canonically relabelled, so two runs of the same graph give the same partition. |
| Citation grounding | **Real** | Structural — see above. Enforced at the point of production, and shared as one predicate between the app, the eval and the verifier harness. |
| Hybrid retrieval (BM25 + vector → RRF → rerank → MMR) | **Real** | The refusal floor is compared against the vector arm's raw cosine, before fusion, so "I don't know" stays meaningful. |
| File-role classification, entry-point detection | **Heuristic** | Pattern-based. Usually right, occasionally not, and never presented as more than a classification. |
| "Test files that reach it" | **Heuristic** | Import reachability, **not** coverage. Labelled that way in the UI because there is no coverage data. |
| AI summary, reading order, inferred domains | **Model output** | Grounded and labelled as inference wherever shown. The parser's structural roles sit on a different tab for exactly this reason. |
| Specialist fan-out over communities, best-of-N | **Experimental** | Flag-gated (`FANOUT_SYNTHESIS`), off by default, and **unproven at real scale** — there is no measurement against a live model showing it produces better output than the single-shot stage. |
| Model routing, parallel stages | **Experimental** | Flag-gated, off by default. The measured speedups are orchestration-only, on a hermetic harness with mock providers. |
| Speculative prefetch | **Experimental, on by default** | Builds the RAG chunk plan while synthesis waits on the provider; `speculate: false` turns it off. Its speedup is measured only on the hermetic harness. |

---

## Honest limits

- **Language coverage is narrower than "any codebase".** Deep support — symbols, call edges and a
  measured import graph — covers **JavaScript, TypeScript, JSX, TSX, Python, Go, Java and C/C++**.
  C#, Rust and PHP are next; until then they get line counts only, so `find_references`, callers
  and blast radius return little of use on those repositories. The pipeline degrades gracefully; it
  does not pretend.
- **The AI stages need your key.** No key means no summary and no Q&A. The map, the metrics, the
  cycles and the communities all still work.
- **The fan-out is opt-in.** It is 5N+1 provider calls where the single-shot stage is 1. With it
  off, the Domains tab is hidden rather than empty.
- **Local-CLI search is lexical only.** The offline embedder is feature hashing, not a transformer:
  it finds chunks that share *words*, not meaning. See [Analyse a private repo](#analyse-a-private-repo-offline).
- **Cost reports tokens always and dollars only if you price them.** `usd` is `null` until
  `LLM_PRICING` is set, with the unpriced models named. Tokens are read from the provider's own
  counters either way.
- **The graph does not see imports inside `declare module` blocks**, or `import`/`require` calls built
  from non-literal strings. Both are rare; the accuracy table above counts them.
- **`impact` needs the base commit locally.** It runs local git only (`diff`, `merge-base`, `archive`)
  and never fetches, so CI checkouts need `fetch-depth: 0`.
- **Nothing is deployed, and the AI stages have not run against a live provider.** The graph numbers
  above are measured on real repositories; every AI-side number comes from a hermetic suite with
  mocked providers. `DESIGN.md` §6 lists what still needs a real service.

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
load-bearing. See `DESIGN.md` for the reasoning behind this and the other significant choices.

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
docker compose --env-file codeflow.env -f docker-compose.app.yml logs -f     # follow logs
docker compose --env-file codeflow.env -f docker-compose.app.yml down        # stop
docker compose --env-file codeflow.env -f docker-compose.app.yml down -v     # stop + wipe the local databases
```

---

## Analyse a private repo, offline

No key, no network, no code leaving the machine:

```bash
npx codeflow-local analyze .              # graph, metrics, cycles, communities + a lexical index
npx codeflow-local ask . "where are retries handled?"
```

Parsing is tree-sitter WASM, the embedder is in-process, and the index is a file on disk — there is
no HTTP client, no socket and no provider key anywhere in that module's import graph, which is a
property you can verify by reading the imports rather than trusting this sentence.

It stops at a complete deterministic analysis plus a searchable index. **There is no AI summary**:
synthesis needs a model and there is no keyless local one, so rather than degrade into something that
looks like a summary and is not, it says what it cannot do. Search is lexical — shared identifiers
and path words, not meaning.

**Speed.** Each file's parse is cached under its content hash in `.codeflow/cache` (add `.codeflow/` to
your `.gitignore`), so a re-run parses only what changed; `--no-cache` turns it off. Measured on
Kubernetes (26,558 files) on an Apple M5 laptop, Node 26:

| Run | Wall time | Peak memory |
|---|---:|---:|
| Full analysis, no cache | 20.7 s | 1.07 GB |
| First run, filling the cache | 25.6 s | 1.01 GB |
| Re-run, nothing changed | 7.7 s | 0.74 GB |
| Re-run after editing one file (2 files parsed) | 7.8 s | — |

The graph is identical across all four — checked edge for edge. `impact` analyses the head and the
base of a PR in one process and parses every untouched file once.

---

## Check an answer or a PR

Three model-free checks, all offline:

```bash
# 1. Every code reference in a piece of text — an AI answer, a PR description, a review comment.
#    Exit code 1 when any reference is wrong.
pbpaste | npx codeflow-local verify . -
#   ✓ packages/analyzers/src/stages/rag.ts:128 `createRagStage` — declared at line 125-369
#   ✗ apps/worker/src/index.ts:9999 — line 9999 is outside the file (412 lines)
#   ✗ packages/config/src/loader.ts — no file "packages/config/src/loader.ts" in this repository

# 2. What a change set touches, against its merge-base with main.
npx codeflow-local impact . --base main                     # text
npx codeflow-local impact . --base main --format markdown   # a PR comment
npx codeflow-local impact . --base main --fail-on new-cycle,broken-import
```

**3. On every pull request** — one comment, updated in place, plus a check of the references written in
the PR description:

```yaml
# .github/workflows/codeflow.yml
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  impact:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: AnshulMohanty/Code_Flow@main
        with:
          fail-on: new-cycle,broken-import,wrong-citation   # optional
```

**For coding agents**, the MCP server's `verify` scope adds `verify_citations` (check a draft answer
before showing it) next to `verify_answer` (grade a structured claim such as "who calls X").

> `codeflow-local` is not on npm yet. Until it is, run it from a checkout:
> `pnpm --filter "codeflow-local..." build && node apps/local-cli/dist/index.js <command>`.
> The GitHub Action builds it from source in the job.

---

## Configuration

All runtime config is environment variables — [`.env.example`](.env.example) has the full list with
what breaks without each one. For the Docker run above, the only thing you must provide is
`GEMINI_API_KEY`.

| Variable | Default | Notes |
|----------|---------|-------|
| `GEMINI_API_KEY` | — | **Required** for stages 7–8. One key powers both chat and embeddings. |
| `LLM_PROVIDER` | inferred | `gemini`, `anthropic` or `openai`. More than one key set with no explicit choice throws at boot rather than guessing. |
| `EMBEDDING_PROVIDER` | inferred | `gemini`, `voyage` or `openai`. Gemini recommended — Voyage's free tier allows 3 req/min. |
| `MONGO_URI` / `REDIS_URL` / `POSTGRES_URL` | local containers | Point at managed services for a cloud deploy. |
| `CORS_ORIGINS` | — | Comma-separated browser origins. Until it is set the browser gets CORS errors against a healthy API. |
| `TRUST_PROXY_HOPS` | `0` | Reverse proxies in front of the API (Render: `1`). Without it every visitor shares the proxy's IP, so the per-IP rate limit becomes one global bucket. |
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

**1534 vitest tests (99 files, 15 packages) + 26 root tests**, all passing — measured on the commit
that introduced this line, not estimated. CI runs the same four commands plus parser-parity, a
keyless eval check, the graph-accuracy gate against tsc, and a Docker smoke test that builds the
three images, boots the stack and runs a real analysis through it (`scripts/docker-smoke.sh`).

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
| `DESIGN.md` | How it is built and why, the critical decisions, the process (develop, verify, deploy, operate), and the roadmap with current status. |

