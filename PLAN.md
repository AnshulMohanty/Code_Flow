# CodeFlow — Project Plan (Source of Truth)

> This is the canonical plan. `CURRENT_STATE.md` tracks live status and `PHASE_LOG.md`
> records what actually executed. When they conflict, **this file defines intent**.
> Update `CURRENT_STATE.md` + `PHASE_LOG.md` at the end of every session.

---

## 1. What CodeFlow is

A **hosted web app** that helps developers onboard to unfamiliar codebases.

Flow: a user pastes a **public GitHub repo URL** → CodeFlow clones it, parses the source,
builds a dependency graph, and runs a **staged analysis pipeline** that streams its
progress live. The output answers three things:

- **New devs:** "Where do I even start?" — an onboarding guide with a ranked reading order.
- **Experienced devs:** real structural analytics (key files, coupling, complexity, cycles).
- **Everyone:** an "ask the repo" chat, with answers cited to real files and lines.

**Target users:** open-source contributors — newcomers who need orientation, and
experienced devs who want fast structural insight into a large, unfamiliar repo.

**Positioning (hiring):** a portfolio piece for a **fullstack AI engineer** role — MERN
+ a production job queue + a genuinely *grounded* AI layer (RAG + graph-grounded synthesis,
validated with a small eval set). The AI is done with real depth, not a raw API call.

---

## 2. Locked decisions

- **Hosted + deployed**, public link. (Not a local/desktop app.)
- **Public GitHub repos only.** No private-repo or local mode for now.
  **Do not claim private-repo support** anywhere — code lands on the server, so it's public-only.
- **AI layer is provider-agnostic**, behind injectable clients selected by env (no vendor lock-in):
  - **Synthesis (chat):** Anthropic *or* Gemini (`LLM_PROVIDER`).
  - **Embeddings (RAG):** Voyage *or* Gemini (`EMBEDDING_PROVIDER`).
  - A single `GEMINI_API_KEY` can power both stages (cheapest demo path); Voyage gives better
    *code* retrieval if you want to split. Protected by **rate limiting + a global daily budget**.
- **USP = the staged pipeline (chain-of-thought)**, streamed to the UI over **SSE**.
  The user watches it reason, stage by stage. This is the differentiator — treat it as the heart.
- **Frontend graph: 2D force-directed.** 3D is deferred.
- **Build sessions are hermetic; manual setup is consolidated into one final phase (P7).** Every
  build session runs with mocked LLM/embeddings + in-memory cache and needs no keys or live
  services. All physical setup — API keys, local Mongo/Redis, the real scored eval run, the first
  big-repo run, and deploy — happens together in P7, so the build never blocks on external setup.
- **Deferred (not in scope now):** PR analysis, exports, 3D graph, ownership/churn analysis.

---

## 3. Architecture

```
User → React (apps/web) → Express API (apps/api) → validates URL, enqueues BullMQ job
                                                  ↘ SSE progress stream back to UI
Redis + BullMQ → Worker (apps/worker) → clone → resolve commit SHA → check Mongo cache
                                       → run analysis PIPELINE → save AnalysisResult → Mongo
```

Going hosted makes the existing infra load-bearing (it's no longer over-engineering):
- **Mongo cache (keyed on commit SHA)** now saves real money — no re-cloning, re-parsing,
  or re-paying for LLM on a repo already analyzed.
- **Redis + BullMQ** is a legitimate production queue for slow clone→parse→AI jobs.
- **SSE** is the delivery mechanism for the USP — the pipeline streams its stages live.

**Packages:**
| Package | Role | Status |
|---|---|---|
| `@codeflow/shared-types` | All TS contracts | Real |
| `@codeflow/parsers` | File discovery + per-language parsing | Real (regex-based; AST upgrade is a known later fork) |
| `@codeflow/graph` | Dependency graph, centrality, blast radius, cycles, coupling | Real — **the crown jewel** |
| `@codeflow/analyzers` | Pipeline orchestrator + stages + provider clients (Anthropic/Gemini chat, Voyage/Gemini embeddings) | Being built |
| `@codeflow/config` | Shared constants | Trivial/real |
| `@codeflow/exports` | Export shapes | Deferred |

---

## 4. The analysis pipeline (the USP)

Eight stages. **Each stage emits an SSE progress event and contributes to the
`AnalysisResult`.** Deterministic stages produce *facts*; AI stages produce *judgment
grounded in those facts*. Keep deterministic and AI outputs clearly separated in the result.

1. **Ingest** — validate URL, shallow clone, resolve commit SHA, check cache. *(done)*
2. **Orient** — README + manifests; languages, frameworks, project type. *(done)*
3. **Map structure** — discover + classify files; detect layout. *(done)*
4. **Inventory** — symbols + entry points. *(done)*
5. **Connect** — dependency graph from real imports. *(done)*
6. **Analyze** — graph metrics: key files, blast radius, cycles, coupling, complexity. *(done)*
7. **Synthesize (AI)** — "where do I start" narrative + ranked reading order, cited to real
   files. Structured JSON, schema-validated, grounded-by-code. *(done)*
8. **Index for Q&A (AI / RAG)** — chunk → embed → store, so the user can ask the repo
   questions; answers cited to code. Index-build *done*; the query path (retrieve → answer →
   cite) is a P5 session.

Stages 1–6 are deterministic; 7–8 are the AI depth that earns the "AI engineer" half of the title.

---

## 5. Phases & sessions

Work in **phases**, each broken into small **sessions** (one job per session). All build
sessions are **hermetic** (see §2); manual setup is consolidated into **P7 — Go-live**.

### P1 — Rewire to real + build the orchestrator ✓ (done)
### P2 — Deterministic stages ✓ (done)

### P3 — AI layer / the depth (in progress)
- Synthesis stage ✓. RAG index-build ✓. Multi-provider abstraction ✓. Cache LLM + embedding
  output in Mongo (key = SHA + provider/model + prompt/content hash) ✓.
- **Eval harness:** build a small eval set on a known repo to *prove* the AI catches the right
  things. The **harness** (scoring + dataset schema + retrieval primitive) is built and unit-tested
  **hermetically against a mock** here; the **real scored run + threshold tuning on a chosen repo**
  happens in **P7 — Go-live**. This eval is the difference between "AI engineer" and "called an API."

### P4 — Scale + cost guardrails (built hermetically here; exercised in P7)
- Parsing concurrency (`p-limit`), per-file timeouts, repo-size cap.
- Per-IP rate limit + **global daily LLM budget** with graceful "demo at capacity" failure.
- Aggressive caching everywhere.
- *(The actual large-repo run + measured limits move to P7 — they need live services.)*

### P5 — Frontend (built against mock data here)
- Live pipeline panel (the streaming chain-of-thought) + SSE replay.
- The **RAG query path** (retrieve → answer → cite endpoint) + Ask-the-repo UI.
- Dashboard: Start Here / Structure map / 2D dependency graph / file drill-down.

### P6 — Ship prep (code only — no infra here)
- Dockerfiles for api/web/worker (written, not yet built/deployed).
- **CI** (GitHub Actions: typecheck + lint + tests) — runs **on mocks**, needs no keys/services.
- README scaffold: architecture diagram + "what's real vs simplified" section.

### P7 — Go-live (the single consolidated manual phase — all physical setup at once)
- **Keys:** `GEMINI_API_KEY` (single-key path, powers chat + embeddings) **or**
  `ANTHROPIC_API_KEY` + `VOYAGE_API_KEY`.
- **Docker Desktop;** local **Mongo** + **Redis** containers.
- **Run the eval for real** against the chosen provider; read scores, tune thresholds.
- **First real end-to-end run** on a genuinely large public repo; fix composition bugs; record
  measured limits ("tested to N files in Y sec; degrades by Z") — the best interview line.
- **BullMQ real-wire smoke** over Redis (the in-memory channel proves logic, not wire).
- **Deploy** to a host (Render / Railway / Fly) with managed Redis + Mongo Atlas; set prod env.
- **README:** architecture diagram + GIF + **live link**.

---

## 6. Working rules for Claude Code

- **One job per session** — a stage, a feature, or a fix. Never "build a whole phase."
- **Contract before code** — define the TypeScript type / JSON shape first, implement second.
- **Write + run tests in the same session**, **hermetic** — LLM/embeddings mocked, cache handle
  in-memory, **no real API/Mongo/Redis calls** in the suite.
- **Commit after every green session** — clean checkpoints make recovery cheap (cleanup separate).
- **Never truncate the analysis data** — only cap what is rendered (UI) or fed (LLM prompt); a
  prompt cap that feeds a cache key must be byte-deterministic.
- **Keep deterministic and AI outputs separated** in the result shape.
- **Cache all LLM + embedding output** (key = SHA + provider/model + prompt/content hash).
- **AI must be grounded** — synthesis and Q&A cite real files/lines; grounding enforced by code.
- Update `CURRENT_STATE.md` + `PHASE_LOG.md` at the end of each session.

---

## 7. Definition of done — "demo-complete" (the finish line)

Not "perfect." Stop when all of these are true:

- [ ] The 90-second flow works end-to-end on **3+ real public repos**.
- [ ] **Deployed**, public link is live.
- [ ] AI synthesis (onboarding guide) + RAG Q&A both work and are **cited**.
- [ ] The **eval set passes** on a known repo.
- [ ] **Tests run in CI** on every push/PR.
- [ ] README has an architecture diagram, a GIF, and the live link.
- [ ] Cost guardrails are active (rate limit + daily budget + caching), proven not to
      blow up on a big repo, with measured limits documented.

---

## 8. Cost & safety guardrails (don't skip — it's the owner's wallet)

- Cap repo size (file count + total bytes) before cloning/analyzing.
- Cache *everything* — never re-pay for an analyzed commit SHA (or re-embed unchanged content).
- Per-IP rate limit.
- Hard **global daily LLM spend ceiling** that fails gracefully ("demo at capacity").
- Free-tier headroom: a single `GEMINI_API_KEY` (chat + embeddings) keeps the demo near-free;
  `voyage-code-3` also has a large free tier. Real spend only starts in P7.
- Optional: a curated allowlist of impressive repos analyzable for free; arbitrary repos
  go behind the rate limit.

---

## 9. Known forks (decide later, don't block on them)

- **AI provider choice:** Gemini-only (one key, free tier, simplest) vs Anthropic chat + Voyage
  embeddings (better *code* retrieval). The abstraction supports both; decide at P7.
- **Parser accuracy:** parsers are regex/token-based, not AST. Fine for a demo; flaky on
  large real-world code. Likely fix: `web-tree-sitter` (WASM). Revisit if accuracy bites in P4.
- **Server vs local mode:** the Mongo/Redis/BullMQ stack stays as the production path. Don't
  maintain a second polished local mode.
