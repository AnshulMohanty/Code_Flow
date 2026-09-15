# docs/archive — superseded, kept for provenance

Nothing in this folder is current. It is here because the *reasoning* in it is worth keeping and
because deleting a decision record makes the decision look arbitrary later.

**What is current:** `README.md` (what it is), `ARCHITECTURE.md` (how and why), `DEPLOY.md` and
`GO_LIVE.md` (running it), `CURRENT_STATE.md` (live status + the deferred ledger).

| File | What it was | Why it is archived |
|---|---|---|
| `PLAN.md` | The original project plan (2026-06-10). | Predates all V3 work — no tree-sitter, no CPG, no agents, no MCP, no local CLI. Its "deferred, not in scope" list is still accurate about what was never built. |
| `V3_PLAN.md` | The V3 build plan, phases P0–P5. | Executed. Its §5 asked for LanceDB and int8 MiniLM, neither of which shipped; `ARCHITECTURE.md` §5 records what shipped instead and why. It names a companion design doc (`docs/CodeFlow-v3-Design-Doc.md`) that **does not exist in this repository**. |
| `PHASE_LOG.md` | Append-only session record, 2026-05-30 onward. | Superseded as a status source by `CURRENT_STATE.md`. Note it uses a `#N` numbering scheme that COLLIDES with the ledger's — "#20" means two unrelated things depending on the paragraph. |
| `ENGINEERING_LOG.md` | Decisions with the measurement that decided them. | The best of the old docs. Its substance is folded into `ARCHITECTURE.md`; the full entries are here. |
| `VERIFICATION_REPORT.md` | The V3-FINAL audit (2026-09-01). | A point-in-time verdict. Its test counts (1207 → 1336) are superseded. |
| `CLEANUP_MANIFEST.md` | The dead-code removal pass. | Evidence that the P5-era mock panels (SecurityPanel, ArchitectureRulesPanel, PRRiskPanel and eight others) were deleted rather than merely hidden. |
| `SECURITY_TRIAGE.md` | CodeQL triage — 22 `js/polynomial-redos` alerts, 22 fixed, 0 dismissed. | Closed. Kept because the U+2028 exploit analysis is the part worth re-reading. |
| `QUICKSTART.md` | The one-command Docker walkthrough. | Merged into `README.md`, which now also documents the Postgres service it was missing. |

## Deleted rather than archived

`CODEBASE_SNAPSHOT.md` (2026-08-27) was removed. It described branch `fresh-main` at `799b6ff` with
280 tracked files — 54 commits and five weeks stale by the time anyone read it — and it was written in
the voice of ground truth ("ABSENT = verified not to exist"). A confidently-worded stale snapshot is
worse than no snapshot: it is the file most likely to be trusted and wrong. `docs/HANDOFF_SNAPSHOT.md`
is the current audit, and it is dated in its header for the same reason.

## Not part of the system

`legacy/index.html` is the original single-file application this project grew out of. It shares no
code with `packages/*` and is kept because `card/` executes it and the root test suite pins its
behaviour.

`card/` is a GitHub Action rendering an SVG repository card, inherited from the upstream fork
(`braedonsaunders/codeflow`) and powered by that legacy analyzer. No workflow in this repository
invokes it.

## Images

`screenshot.png` (1.0 MB) was **deleted**. It had zero in-repo references and, more to the point, it
showed the pre-V3-FINAL dashboard — a UI that no longer exists. A stale screenshot is not neutral
weight: it is a picture of a product nobody can run, and it is the first thing a reader believes.
`README.md` carries a `TODO(demo)` for a recording of the current UI instead.

`codeflow-social.png` (297 KB) was **kept**, with the same reasoning the earlier cleanup pass reached
and did not act on: a GitHub social-preview image is configured in repository *settings*, not
referenced from any file, so "zero in-repo references" is exactly what a correctly-working social card
looks like. Deleting it to tidy 297 KB would break a path no test can see. If the repository settings
do not reference it, it is safe to remove.
