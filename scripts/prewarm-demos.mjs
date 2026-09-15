#!/usr/bin/env node
/**
 * PRE-WARM THE CURATED DEMOS — fill the analysis cache so a demo click is a cache hit.
 *
 * WHY THIS EXISTS. A first-time visitor lands on a static page and a backend that may be asleep.
 * Clicking a demo repository should put a real analysis on screen in roughly a round trip, not in
 * the forty seconds a cold start plus a fresh clone-and-parse takes. The cache that makes that
 * possible is keyed on (repo, commit SHA, analyzerVersion) and is filled by running the analysis
 * once — which is all this does. It adds no new path: it drives the SAME public endpoints a browser
 * drives, so anything it warms is warm for exactly the reason a real request would have been.
 *
 * IT IS NOT PART OF THE HERMETIC SUITE AND CANNOT BE. It needs a deployed API, provider keys and
 * network access to GitHub, and it SPENDS MONEY (one synthesis + one embedding pass per repository).
 * So it is a documented manual step — see GO_LIVE.md — and nothing in CI invokes it.
 *
 * IT IS RE-RUNNABLE, and it has to be: the cache key includes the commit SHA and the analyzer
 * version, so every push to a demo repository and every ANALYZER_VERSION bump invalidates entries.
 * A pre-warm is a maintenance task, not a one-off. Re-running it on an already-warm entry is cheap:
 * the pipeline's own cache lookup short-circuits the run before any provider call.
 *
 * USAGE
 *   node scripts/prewarm-demos.mjs https://api.example.com
 *   CODEFLOW_API_URL=https://api.example.com node scripts/prewarm-demos.mjs
 *   node scripts/prewarm-demos.mjs https://api.example.com --only AnshulMohanty/Code_Flow
 *
 * Exit 0 when every demo ended `completed` or `partial`; 1 otherwise, so a run that half-worked
 * fails visibly instead of leaving three of four demos cold.
 */

/**
 * The list is DUPLICATED from apps/web/src/lib/demoRepos.ts rather than imported, and that is a
 * deliberate trade. Importing it would mean this script depends on a built web package — so warming
 * a deployment would require a TypeScript build of a frontend it never runs. The two lists are
 * checked against each other by a test in the web package, which is the cheap half of the trade.
 */
const DEMOS = [
  { owner: "jamiebuilds", repo: "the-super-tiny-compiler" },
  { owner: "expressjs", repo: "express" },
  { owner: "psf", repo: "requests" },
  { owner: "AnshulMohanty", repo: "Code_Flow" },
];

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
const positional = args.filter((value, index) => !value.startsWith("--") && index !== onlyIndex + 1);
const base = (positional[0] ?? process.env.CODEFLOW_API_URL ?? "").replace(/\/+$/, "");

if (!base) {
  console.error("usage: node scripts/prewarm-demos.mjs <api-url>   (or set CODEFLOW_API_URL)");
  process.exit(2);
}

/** A cold clone-and-parse of a mid-size repository, plus two provider stages, with margin. */
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 3_000;

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${response.status} ${url} returned non-JSON: ${body.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(`${response.status} ${url}: ${JSON.stringify(parsed).slice(0, 300)}`);
  return parsed;
}

async function prewarm(demo) {
  const fullName = `${demo.owner}/${demo.repo}`;
  process.stdout.write(`${fullName} … `);
  const started = Date.now();

  const created = await json(`${base}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "public_hosted", owner: demo.owner, repo: demo.repo }),
  });

  const deadline = Date.now() + JOB_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`timed out after ${JOB_TIMEOUT_MS / 1000}s`);
    const progress = await json(`${base}/api/job/${created.jobId}`);
    if (progress.status === "completed" || progress.status === "failed") {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      // `cached: true` on the FIRST run means this entry was already warm — which is the expected
      // and desirable outcome of a re-run, not a no-op worth hiding.
      const how = progress.cached ? "already cached" : `analysed in ${seconds}s`;
      const mode = progress.runMode ? ` · ${progress.runMode}` : "";
      if (progress.status === "failed") {
        console.log(`FAILED — ${progress.message ?? progress.error ?? "no reason given"}`);
        return false;
      }
      console.log(`${how}${mode} · runStatus=${progress.runStatus ?? "completed"}`);
      // A run that completed with no Q&A index is warm for the analysis and cold for the thing the
      // demo is meant to show, so say so rather than counting it as a clean success.
      if (progress.runMode === "deterministic-only") {
        console.log("  note: deterministic-only — no AI summary and no Q&A index. Check the provider keys.");
      }
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const targets = only ? DEMOS.filter((demo) => `${demo.owner}/${demo.repo}` === only) : DEMOS;
if (targets.length === 0) {
  console.error(`--only ${only} matched none of: ${DEMOS.map((d) => `${d.owner}/${d.repo}`).join(", ")}`);
  process.exit(2);
}

console.log(`Pre-warming ${targets.length} demo repositor${targets.length === 1 ? "y" : "ies"} against ${base}`);
let ok = true;
for (const demo of targets) {
  try {
    if (!(await prewarm(demo))) ok = false;
  } catch (error) {
    console.log(`ERROR — ${error instanceof Error ? error.message : String(error)}`);
    ok = false;
  }
}
console.log(ok ? "All demos warm." : "At least one demo is NOT warm — see above.");
process.exit(ok ? 0 : 1);
