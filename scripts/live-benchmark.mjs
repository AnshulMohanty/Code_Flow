#!/usr/bin/env node
/**
 * LIVE LATENCY BENCHMARK (V3-P5 task 5) — the same four tiers, against a REAL deployment.
 *
 * BUILT NOW, RUN IN PHASE 7. It needs a deployed API, real provider keys and a real repository, so
 * it is deliberately not part of the hermetic suite and nothing in CI invokes it.
 *
 * WHAT IT IS FOR, and why the hermetic bench does not replace it. `packages/analyzers/src/bench`
 * measures the ORCHESTRATION with mock providers: scheduling, layering, cache hits. It says how much
 * time this codebase adds around a provider call, and says so explicitly. It cannot say what a user
 * waits, because the provider call, the network, the clone and the databases are all absent. This
 * measures exactly those — end to end, over HTTP, against the deployed thing.
 *
 * IT REPORTS THE SAME FOUR TIERS, on purpose, so the two are comparable and the DIFFERENCE between
 * them is itself the interesting number: hermetic `aiSynthesis` versus live `aiSynthesis` is the
 * provider's contribution, isolated.
 *
 * THE STAGE SPLIT COMES FROM THE PIPELINE'S OWN RECORDED TIMINGS, not from polling.
 * `result.pipeline.stages[]` carries a `durationMs` per stage, so `coreAnalysis` and `aiSynthesis`
 * are sums of exactly the stages that belong to each — attributable to the stage that regressed, and
 * free of the resolution error a 2-second poll would introduce. End-to-end wall clock is reported
 * alongside as a separate note, because the gap between it and the stage sum is queue wait plus
 * clone, which is worth seeing rather than folding in.
 *
 * THREE HONEST LIMITS, in the code rather than only in a runbook:
 *   1. IT COSTS MONEY. Every run is a real analysis plus two real Q&A calls against a paid provider.
 *      Default `--runs 1`. The daily budget guard still applies, so an exhausted ceiling shows up as
 *      a degraded run — which is a correct result, not a failed benchmark.
 *   2. THE FIRST RUN MAY INCLUDE COLD START. `--warmup` pings /health first and reports `warmedUp`,
 *      so a cold number is labelled rather than silently mixed into the median.
 *   3. CACHING MAKES A REPEAT ANALYSIS FREE. The cache is keyed on
 *      (repo, commit, analyzerVersion), so re-benchmarking the same commit measures the cache and
 *      not the pipeline. A cache hit is detected and SKIPPED rather than reported as a fast analysis,
 *      which would be the most misleading number this script could print.
 *
 * USAGE
 *   node scripts/live-benchmark.mjs --api https://api.example.com --repo https://github.com/owner/name
 *   node scripts/live-benchmark.mjs --api ... --repo ... --runs 3 --warmup --json report.json
 */

import { writeFile } from "node:fs/promises";

const args = parseArgs(process.argv.slice(2));

if (!args.api || !args.repo) {
  console.error(
    [
      "usage: node scripts/live-benchmark.mjs --api <base-url> --repo <github-repo-url> [options]",
      "  --runs N     how many end-to-end runs (default 1). EACH RUN COSTS REAL PROVIDER SPEND.",
      "  --warmup     ping /health first and report warmedUp, so a cold number is labelled",
      "  --question Q the Q&A question to time (default: a generic architecture question)",
      "  --json FILE  also write the raw report as JSON",
      "  --timeout S  per-analysis ceiling in seconds (default 900)",
    ].join("\n"),
  );
  process.exit(2);
}

const API = String(args.api).replace(/\/+$/, "");
const RUNS = Number(args.runs ?? 1);
const TIMEOUT_MS = Number(args.timeout ?? 900) * 1000;
const QUESTION = args.question ?? "What is the overall architecture of this repository?";
const POLL_MS = 2000;

/**
 * Which stages belong to which tier. Declared, not inferred from `kind`: `rag` is a deterministic
 * chunker wrapped around an embedding call, so classifying by stage kind would put it in the wrong
 * tier — and it is the AI cost that a user actually waits for.
 */
const CORE_STAGES = new Set(["ingest", "orient", "map-structure", "inventory", "connect", "analyze"]);
const AI_STAGES = new Set(["synthesize", "rag"]);

const samples = [];
const notes = [];

if (args.warmup) {
  try {
    const health = await getJson(`${API}/health`);
    notes.push(`warm-up: status=${health.status} warmedUp=${health.warmedUp} warming=${health.warming}`);
    if (health.warmedUp === false) notes.push("DEPLOYMENT WAS COLD at start — run 1 includes cold-start cost.");
  } catch (error) {
    notes.push(`warm-up ping failed: ${error?.message ?? String(error)}`);
  }
}

for (let run = 1; run <= RUNS; run++) {
  console.error(`--- run ${run}/${RUNS} ---`);
  try {
    await benchmarkOnce(run);
  } catch (error) {
    // One failed run must not discard the runs that succeeded: partial numbers with a stated
    // failure are more useful than an exception and no numbers.
    notes.push(`run ${run} FAILED: ${error?.message ?? String(error)}`);
    console.error(`run ${run} failed: ${error?.message ?? String(error)}`);
  }
}

await report();

async function benchmarkOnce(run) {
  const submittedAt = Date.now();
  // The real contract: POST /api/analyze with mode + repoUrl.
  const submission = await postJson(`${API}/api/analyze`, { mode: "public_hosted", repoUrl: args.repo });
  const jobId = submission.jobId;
  if (!jobId) throw new Error(`no jobId in response: ${JSON.stringify(submission).slice(0, 200)}`);

  if (submission.cached) {
    notes.push(`run ${run}: served from CACHE — analysis tiers NOT sampled (bench a commit not yet analysed).`);
    return;
  }

  const job = await pollUntilTerminal(jobId);
  const endToEndMs = Date.now() - submittedAt;

  if (job.status !== "completed") {
    throw new Error(`job ${jobId} ended ${job.status}: ${job.error ?? job.runStatusReason ?? "no reason given"}`);
  }
  if (job.runStatus && job.runStatus !== "completed") {
    // Not fatal — a partial run still produced real deterministic timings, and the reason is
    // exactly the sort of thing a benchmark should surface rather than average away.
    notes.push(`run ${run}: runStatus=${job.runStatus}${job.runStatusReason ? ` (${job.runStatusReason})` : ""}`);
  }

  // `/api/result/:jobId` returns the stored analysis, including pipeline.stages with durations.
  const result = await getJson(`${API}/api/result/${jobId}`);
  const stages = result?.result?.pipeline?.stages ?? result?.pipeline?.stages ?? [];
  if (stages.length === 0) {
    notes.push(`run ${run}: no pipeline.stages in the result — analysis tiers not sampled.`);
  } else {
    const coreMs = sumStages(stages, CORE_STAGES);
    const aiMs = sumStages(stages, AI_STAGES);
    samples.push({ tier: "coreAnalysis", ms: coreMs, conditions: `live, ${args.repo}, run ${run}` });
    if (aiMs > 0) {
      samples.push({ tier: "aiSynthesis", ms: aiMs, conditions: `live, real provider, run ${run}` });
    } else {
      notes.push(`run ${run}: AI stages contributed 0ms — no provider key configured, or both were skipped.`);
    }
    const accounted = coreMs + aiMs;
    notes.push(
      `run ${run}: end-to-end ${endToEndMs}ms vs ${accounted}ms of stage time — ` +
        `${endToEndMs - accounted}ms is queue wait + clone + persistence.`,
    );
  }

  // qaGenerate then qaCoreHit: the SAME question twice, and the order matters — the first must miss.
  // Note the endpoint takes the JOB id, not the analysis id.
  const first = await timed(() => postJson(`${API}/api/result/${jobId}/ask`, { question: QUESTION }));
  if (first.value?.unavailable) {
    notes.push(`run ${run}: Q&A unavailable (${String(first.value.answer).slice(0, 120)}) — Q&A tiers not sampled.`);
    return;
  }
  samples.push({ tier: "qaGenerate", ms: first.ms, conditions: `live, cold cache, run ${run}` });

  const second = await timed(() => postJson(`${API}/api/result/${jobId}/ask`, { question: QUESTION }));
  samples.push({ tier: "qaCoreHit", ms: second.ms, conditions: `live, repeat question, run ${run}` });

  if (second.ms > first.ms * 0.5) {
    // Not a failure, but the reason to look: a repeat question that is not dramatically faster means
    // the answer cache is not hitting, which after V3-P5 most likely means Redis is unreachable and
    // the cache fell back to per-process (ledger #21).
    notes.push(
      `run ${run}: repeat question ${second.ms}ms vs first ${first.ms}ms — the answer cache may not be ` +
        "hitting. Check Redis reachability; the cache degrades to per-process and logs when it does.",
    );
  }
}

async function pollUntilTerminal(jobId) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await getJson(`${API}/api/job/${jobId}`);
    if (last.status === "completed" || last.status === "failed") return last;
    await sleep(POLL_MS);
  }
  throw new Error(`job ${jobId} did not reach a terminal state within ${TIMEOUT_MS / 1000}s (last: ${last?.status})`);
}

/** Sum the recorded durations of the stages in one tier. A stage with no duration contributes 0
 *  rather than NaN — a skipped stage genuinely took no measured time. */
function sumStages(stages, wanted) {
  return stages
    .filter((stage) => wanted.has(stage.stage))
    .reduce((total, stage) => total + (typeof stage.durationMs === "number" ? stage.durationMs : 0), 0);
}

async function report() {
  const tiers = {};
  for (const tier of ["coreAnalysis", "aiSynthesis", "qaCoreHit", "qaGenerate"]) {
    const values = samples
      .filter((sample) => sample.tier === tier)
      .map((sample) => sample.ms)
      .sort((a, b) => a - b);
    tiers[tier] = values.length
      ? {
          best: values[0],
          // MEDIAN, matching the hermetic bench: one cold start or one noisy neighbour would
          // otherwise dominate the headline.
          median: values[Math.floor(values.length / 2)],
          worst: values[values.length - 1],
          runs: values.length,
        }
      : null;
  }

  console.log("");
  console.log(`latency tiers (LIVE — ${API}, repo ${args.repo}; real providers, real network)`);
  for (const tier of ["coreAnalysis", "aiSynthesis", "qaCoreHit", "qaGenerate"]) {
    const stats = tiers[tier];
    console.log(
      stats
        ? `  ${tier.padEnd(13)} best ${String(stats.best).padStart(6)}ms · median ${String(stats.median).padStart(6)}ms · worst ${String(stats.worst).padStart(6)}ms  (${stats.runs} run(s))`
        : `  ${tier.padEnd(13)} not sampled`,
    );
  }
  for (const note of notes) console.log(`  note: ${note}`);
  console.log("");
  console.log("  Compare against the hermetic bench (packages/analyzers/src/bench): the DIFFERENCE per");
  console.log("  tier is the provider's and network's contribution, isolated from the orchestration.");

  if (typeof args.json === "string") {
    await writeFile(args.json, `${JSON.stringify({ api: API, repo: args.repo, samples, tiers, notes }, null, 2)}\n`, "utf8");
    console.log(`  wrote ${args.json}`);
  }

  // Exit non-zero when nothing was sampled: a benchmark that measured nothing must not look like a
  // pass in a CI log.
  if (samples.length === 0) {
    console.error("no samples collected — see the notes above.");
    process.exit(1);
  }
}

// --- plumbing ----------------------------------------------------------------

async function timed(work) {
  const startedAt = Date.now();
  const value = await work();
  return { value, ms: Date.now() - startedAt };
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`POST ${url} -> ${response.status} ${text.slice(0, 200)}`);
  }
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[name] = next;
      i += 1;
    } else {
      out[name] = true;
    }
  }
  return out;
}
