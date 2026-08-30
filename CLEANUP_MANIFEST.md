# V3-CLEANUP — removal manifest

> Evidence-based dead-code audit, 2026-08-30. Branch `v3/cleanup-deadcode`.
> **Nothing here was deleted because it "looks unused."** Every REMOVE verdict carries the grep /
> import-graph proof below. Every KEEP records *why* it survived, so the next pass does not re-litigate it.
>
> Method: (1) an import-graph orphan sweep over all 220 tracked `.ts`/`.tsx` files, matching each
> file's module specifier against every tracked `.ts/.tsx/.js/.mjs/.cjs/.json/.yml/.sh/.bat/.html`
> file plus Dockerfiles — so a reference from a test, a package.json script, a tsconfig path, a
> compose file or a CI workflow counts as "referenced"; (2) `tsc --noUnusedLocals
> --noUnusedParameters` run per package as a report (the flags were NOT committed); (3) targeted
> greps for each candidate named in the cleanup brief.

---

## Corrections to the brief's premises

Three candidates in the brief turned out to be based on stale or incorrect information. Recording
them here because acting on them would have caused damage or wasted effort:

| Brief said | Reality | Consequence |
|---|---|---|
| `apps/worker/src/processors/analysisProcessor.ts` + test are unwired (ledger #4, ~415+207 LOC) | **The file does not exist in this tree.** `apps/worker/src/processors/` contains only `pipelineJobProcessor.ts` + its test. `git log --all` shows `e46f859 chore: remove unwired analysisProcessor reference (ledger #4)` on another branch. | Ledger #4 is **already satisfied**; nothing to delete. Ledger entry was stale. |
| Dead P5-era mock panels (ledger #15: RepositorySummary, ActionGrid, HealthPanel, SecurityPanel, ArchitectureRulesPanel, PRRiskPanel, AIContextPanel, ExportPanel, SettingsPanel, GraphPlaceholder, FileDetailDrawer + `selectedPanel`/`panelComponents` machinery + dead types) | **None of them exist.** grep for all 11 component names + `selectedPanel` + `panelComponents` + `SelectedPanel` + `FileDetailTab` across `apps/web/src` returns **zero hits**. | Ledger #15 is **already satisfied** for the components. Only the orphaned `.dashboard-layout` CSS survived — handled below. |
| `card/examples/*.svg` are "10 zero-byte files" | **They are 1.7 KB – 12.3 KB real rendered SVGs.** There are **zero** zero-byte tracked files in the entire repo (`git ls-files` + `-s` test). | The premise for deleting them is false; they are the Action's documented example gallery. KEEP. |

---

## REMOVE — proven dead

### R1. `apps/api/src/db/models/PRReportModel.ts` (21 LOC)
- **Evidence:** `grep -rn "PRReportModel\|prReports" apps packages --include=*.ts` → only its own declaration. Zero external references. Reference count vs. its siblings: `AnalysisModel` 4, `JobModel` 4, `RepoModel` 2, **`PRReportModel` 0**.
- Never imported ⇒ the `prReports` collection is never read or written. Not in any route, service, or test.
- **Blast radius:** none. Mongoose registers models on import; an unimported model is inert.

### R2. `apps/api/src/db/models/ShareModel.ts` (20 LOC)
- **Evidence:** same sweep → zero external references; `shares` collection never read or written. (The only other `shares` hits in the repo are the English word in three unrelated comments.)
- **Blast radius:** none, same reasoning as R1.

### R3. `apps/web/src/app/routes.tsx` (10 LOC)
- **Evidence:** `grep -rn "routes" apps/web/src` excluding the file itself → **zero hits**. `main.tsx` renders `<App />` directly; there is no router in the dependency tree.
- Content is a stub: a one-entry array plus `// TODO: Replace this simple route config with a real router`.
- **Blast radius:** none — nothing imports it, and removing it cannot change the render tree.

### R4. `apps/web/src/features/graph/GraphLegend.tsx` (10 LOC)
- **Evidence:** zero references. Content is self-declared placeholder (`aria-label="Graph legend placeholder"`) showing invented categories (UI / API / Data / Risk) that do not exist in the real graph model.
- **Superseded:** the shipped 2D graph renders its own legend (`DependencyGraph.tsx:170`, `.dash-graph__legend`) from real node roles.
- **Blast radius:** none. Orphans the `graph-legend` / `legend-dot` CSS, removed in the same commit.

### R5. `apps/web/src/features/graph/GraphToolbar.tsx` (12 LOC)
- **Evidence:** zero references. Self-declared placeholder (`aria-label="Graph toolbar placeholder"`) with three non-functional buttons and `// TODO: Replace with real graph controls when 2D/3D graph rendering is migrated.`
- **Superseded:** that migration shipped (P17); `DependencyGraph.tsx` has working controls ("Show all" / focus / "Open in drill-down").
- **Blast radius:** none. Orphans the `graph-toolbar` CSS, removed in the same commit.

### R6. `apps/web/src/components/ui/ErrorState.tsx` (13 LOC) + `LoadingState.tsx` (12 LOC)
- **Evidence:** zero references each. Their sibling `EmptyState` is used 11×, so this is not a false negative from a barrel export — there is no barrel; every UI primitive is imported by explicit path.
- Functional components, not placeholders — but unwired. Error and loading surfaces are rendered inline where they are actually needed (`PipelinePanel` banners, `AskRepo` states).
- **Blast radius:** none. `state-box` CSS is **kept** (EmptyState uses it); `state-error` and `loading-dot` become orphaned and are removed in the same commit.

### R7. `apps/web/src/lib/formatters.ts` (3 LOC)
- **Evidence:** zero references to `formatters` or `formatNumber` anywhere in `apps/web/src`.
- **Blast radius:** none.

### R8. `packages/exports/` — whole package (3 files)
- **Evidence:** `src/index.ts` is literally `export {};` plus a TODO. `grep -rn "@codeflow/exports"` across the tree → the package's own `package.json` name, one `tsconfig.base.json` `paths` entry, and three historical doc mentions (`PLAN.md` table row "Deferred", `PHASE_LOG.md`, `CURRENT_STATE.md`). **No source file in any package or app imports it.**
- It IS in the pnpm workspace (`packages/*`), so it currently costs a build/typecheck/test invocation per `pnpm -r` run for zero output.
- **Blast radius:** must remove the `tsconfig.base.json` `paths` entry in the same commit. `PLAN.md`'s table row is historical narrative and is left alone.

### R9. `apps/card-action/` — whole package (3 files, ~10 LOC)
- **Evidence:** `grep -rn "createCardActionPlaceholder\|@codeflow/card-action"` → the package's own name and its own export. **Zero importers, zero root scripts** (root `package.json` has `dev:web`/`dev:api`/`dev:worker`/`dev:local` — nothing for card-action), zero CI/compose/Dockerfile references.
- Body is `return { service: "codeflow-card-action", status: "placeholder" }` with `// TODO: Port the legacy card action from card/ …`.
- **The stub no longer marks a live plan:** `V3_PLAN.md` §Phase 5 specifies `apps/mcp` *"replacing the `card-action`/`local-cli` stub direction"*. The port it promises is explicitly not going to happen.
- **Blast radius:** one fewer workspace package. The real, working card action in `card/` is untouched (see K5).
- ⚠️ This is the one REMOVE that is a **roadmap** judgement rather than a pure deadness fact — see "Decisions" at the end.

### R10. `ProjectSummary` + `Citation` types in `packages/shared-types/src/index.ts`
- **Evidence:** V3-P0 removed `AiAnalysis.projectSummary` and the `aiProjectSummary` slice key (they had no producer and no consumer). `ProjectSummary` was that field's only type, and `Citation` was used only by `ProjectSummary.citations`. Precise grep for an import of a bare `Citation` or `ProjectSummary` across `apps` + `packages` → **no importers**. (`RagAnswerCitation` in `@codeflow/analyzers` and `AskCitation` in the web are separate, live types.)
- Keeping them reproduces exactly the smell V3-P0 removed: a declared contract nothing writes or reads.
- **Blast radius:** shared-types' public surface shrinks by two unused types. If Orient ever grows its AI summary, they return **with** the producer — the rule V3-P0 set.

### R11. Dead symbols flagged by `--noUnusedLocals --noUnusedParameters` (11 sites)
Run as a report; the compiler flags are **not** committed (enabling them repo-wide is a separate, larger change).

| File | Symbol | Note |
|---|---|---|
| `packages/graph/src/types.ts` | `GraphSummary`, `SerializedDependencyGraph` in the `import type` block | Unused *imports*; both are still re-exported directly from shared-types by the `export type` block below, so the public surface is unchanged. |
| `packages/parsers/src/parsers/pythonParser.ts` | `ParseFileInput` import | unused |
| `apps/worker/src/services/workerAnalysisService.ts` | `BudgetHandle` import, `DAILY_LLM_BUDGET` import, `LlmBudgetModel` + `llmBudgetSchema` | **Leftovers from my own V3-P0 change** — orphaned when `createMongoBudgetHandle` was deleted in favour of the shared Redis handle. |
| `packages/analyzers/src/__tests__/guards.test.ts` | `Inventory` import, `readFile` param | unused |
| `packages/arena/src/__tests__/contracts.test.ts` | `repo` destructured param | unused |
| `apps/web/.../AskRepo.test.tsx` | `waitFor` import | unused |
| `apps/web/.../DashboardShell.test.tsx` | `within` import | unused |
| `apps/web/.../FileDrilldown.tsx` | `ReactNode` import | unused |

### R12. Orphaned CSS in `apps/web/src/styles.css`
- `.dashboard-layout` (2 rules incl. one media-query override) — the last remnant of ledger #15: the P16 dashboard replaced `dashboard-layout` in `AppShell`, and **no `.tsx` references the class**.
- `.state-error`, `.loading-dot`, `.graph-legend`, `.legend-dot`, `.graph-toolbar` — orphaned by R4/R5/R6, removed in those commits.
- **Evidence:** per-class grep, `tsx` reference count 0 for each (vs `state-box` = 3, which is kept because `EmptyState` uses it).

### R13. Local junk on disk (untracked — **zero repo change**)
- `tmp/`, `temp/` (10 stale smoke logs from May), `codeflow.zip` (1.8 MB), all `dist/` dirs.
- **Evidence:** `git status --porcelain --ignored` shows every one as `!!` (ignored). `.gitignore` already covers `tmp/`, `temp/`, `*.zip`, `dist/`, `coverage/`, `*.log` as literal entries — verified individually. **No `.gitignore` change needed; junk cannot return to the repo.**
- Deleting them is working-tree hygiene only, so it is not a commit.

---

## KEEP — with the reason, so this is not re-litigated

| Item | Why it stays |
|---|---|
| **K1. `legacy/index.html`** | Live CI fixture: `tests/codeflow-golden.test.mjs`, `sync-with-html.test.mjs`, `numeric-fn-name.test.mjs`, `html-inline-script-analysis.smoke.js` parse it. **Also** `card/lib/analyzer.js` reads it at runtime (`path.join(repoRoot, 'legacy', 'index.html')`) and runs the analyzer block in a Node `vm`. Load-bearing twice over. |
| **K2. `tests/fixtures/golden-world/`, `tests/fixtures/vault/`** | Inputs to the legacy `node --test tests/*.mjs` suite (25 tests, a required gate). |
| **K3. `apps/web/public/config.js`** | Runtime API-URL injection stub; the nginx entrypoint `40-codeflow-config.sh` rewrites it from `$API_BASE_URL` at container start, and a default must ship in the build so dev/jsdom fall back. |
| **K4. `.env.example`** | The runtime env contract; `.gitignore` has an explicit `!.env.example` negation to keep it tracked. |
| **K5. `card/` (all 26 files, incl. `examples/*.svg`)** | **A published GitHub Action, not internal code.** `card/action.yml` declares a full input surface (`output`, `state`, `theme`, `accent`, `style`, `panels`, …) and `card/README.md` documents consumption as `.github/workflows/codeflow-card.yml`. External repositories can reference it by path — a consumer the hermetic suite cannot possibly see. It is also functional, not a stub: `card/lib/analyzer.js` reads `legacy/index.html` (K1) and executes the analyzer in a `vm`. The `examples/*.svg` are its 1.7–12 KB rendered gallery, **not** empty files. Deleting any of it is an external breaking change. |
| **K6. `docker-compose.yml`** | **Not a duplicate of `docker-compose.app.yml`.** It defines dev infrastructure ONLY (mongo:7 + redis:7-alpine + a volume, 15 lines); `.app.yml` is the full application stack. Everything documented (README, QUICKSTART, `start.sh`, `start.bat`) uses `-f docker-compose.app.yml`, so the two never collide. Plain `docker compose up -d` picks this one up, which is exactly what the deferred cross-process SSE/BullMQ wire smoke (and `pnpm dev:api` + `dev:worker`) needs. |
| **K7. `apps/web/src/lib/mockAnalysis.ts`** | Heavily load-bearing: imported by **8** test files (`dashboard.test`, `graphModel.test`, `analysisNormalizer.test`, `DashboardShell.test`, `DependencyGraph.test`, `PipelinePanel.test`, …) **and** a live UI path — `appStore.loadMockAnalysis` is called from `PublicRepoInput.tsx`'s demo button. |
| **K8. `apps/local-cli/`** | Referenced by the root `dev:local` script (`pnpm --filter @codeflow/local-cli dev`), so it is not an orphan. Also the natural home for Phase 5's local-first CLI task. (See "Decisions" — say the word and it goes too.) |
| **K9. `packages/config/`** | Zero tests, but imported by analyzers, parsers, eval, api and worker. Not an orphan. |
| **K10. Root devDependencies** (`prettier`, `tsx`, `typescript`, `vitest`) | All referenced: `prettier` by the `format` script, `tsx` by 8 package scripts (every CLI), `typescript` and `vitest` by every package's build/test. None removable. |
| **K11. `screenshot.png`, `codeflow-social.png`** | See "Decisions" — **UNSURE**, not deleted. |
| **K12. Commented-out code** | Searched for it; there is none. Every hit for a commented code-like line is prose, except `packages/eval/src/parity/corpus.ts:36` — a **deliberate fixture**: a commented-out `require` the parity harness uses to prove the regex parser hallucinates an import from a comment. Deleting it would silently weaken that test. |

---

## OUTCOME (all removals executed, gates green after each)

Executed in 6 commits, one logical removal each, with the full gate
(`typecheck` + `lint` + `pnpm test` + `build` + legacy `node --test`) run after every one.
**No removal reddened the tree, so nothing had to be reverted and no verdict was reclassified.**

| Commit | What | Files | LOC |
|---|---|---:|---:|
| `873e04b` | R8 — `packages/exports` + its `tsconfig.base.json` paths entry | −3 | −33 |
| `9bd9e40` | R9 — `apps/card-action` | −3 | −37 |
| `7c8353b` | R1+R2 — `PRReportModel`, `ShareModel` | −2 | −41 |
| `f8221ae` | R3–R7 + R12 — 6 web files + 71 lines of orphaned CSS | −6 | −135 |
| `2573240` | R10 — `Citation`, `ProjectSummary` | 0 | −21/+7 |
| `cfa3ed5` | R11 — 11 dead symbols incl. the orphaned `llmBudgetSchema`/`LlmBudgetModel` | 0 | −22/+7 |

**Totals:** tracked files **331 → 318 (−13)**; **−282 / +17 lines** (a net **−265**), excluding
this manifest and the lockfile. `apps/web/src/styles.css` 1278 → 1207. Two pnpm workspace packages
gone, so every `pnpm -r` run does two fewer typecheck/build/test invocations.

Off-repo: `tmp/` + `temp/` (10 stale May smoke logs) + `codeflow.zip` deleted from disk — **1.96 MB**
of working-tree junk, all already gitignored, so zero repo change and no `.gitignore` edit needed.

**Test counts after — identical to before, nothing failed and nothing was lost:**
analyzers 231 · eval 76 · arena 43 · web 60 · api 39 · graph 33 · parsers 28 · worker 13 ·
shared-types 3 = **526**, legacy **25/25**. Also still green: the keyless `parity` and `check` CI
steps, `docker compose config`, and all three Docker images rebuilt.

`tsc --noUnusedLocals --noUnusedParameters` re-run after the pass reports **zero** unused locals or
parameters across all 10 packages and apps (was 11).

### Minor orphan left in place, on purpose
`.button-row` in `styles.css` has zero `.tsx` references. It was NOT orphaned by anything in this
pass (it predates it and is unrelated to any removed component) and it sits in a shared flex-utility
group with `.badge-row`, which is live. Removing unrelated CSS was outside this pass's evidence
chain, so it is recorded here rather than deleted on a hunch.

---

## DECISIONS NEEDED (not acted on)

1. **`screenshot.png` (1.0 MB) + `codeflow-social.png` (297 KB) — UNSURE, kept.**
   Zero in-repo references (no README, QUICKSTART, card README, or workflow mentions them). But 1.3 MB
   of tracked binary with names that strongly suggest **GitHub repo-settings usage** — a social-preview
   image is configured in repo settings, not in files, and a screenshot may be linked from an external
   site or a README on another branch. That is precisely the "might break a path the hermetic suite
   cannot see" case, so per the cleanup rule they were **not** deleted. Your call.

2. **`apps/card-action/` — removed as R9, but it is a roadmap call.** The deadness is proven (zero
   references of any kind) and `V3_PLAN.md` §5 redirects that work to `apps/mcp`. If you would rather
   keep the placeholder as a marker, revert that single commit — it is isolated for exactly that reason.

3. **`apps/local-cli/` — kept as K8.** Same placeholder nature as card-action, but it *is* referenced
   (root `dev:local`). If you want the stub gone, the root script goes with it.
