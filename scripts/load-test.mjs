#!/usr/bin/env node
/**
 * LOAD TEST against a running stack (docker-compose.app.yml + docker-compose.loadtest.yml).
 *
 * Two kinds of traffic at once, the way a deployed CodeFlow sees it:
 *   - BOTS: a burst of analysis jobs — one per public repository below, each from its own client IP
 *     (X-Forwarded-For; the API runs with TRUST_PROXY_HOPS=1), as PR bots would send them.
 *   - USERS: virtual users who watch job progress, open finished results and hit /health, with
 *     100–300 ms think time, until every job is done.
 *
 * Reports API latency per endpoint (p50/p95/p99/max), job queue wait and end-to-end time, throughput,
 * errors, and peak container memory (sampled from `docker stats`).
 *
 * USAGE  node scripts/load-test.mjs [--api http://localhost:4000] [--users 20] [--label run] [--out report.json]
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const API = arg("--api", "http://localhost:4000");
const USERS = Number(arg("--users", "20"));
const LABEL = arg("--label", "run");

// Small-to-mid public repositories across the supported languages. Distinct repos, so the queue does
// real work; the result cache is namespaced per run by ANALYZER_VERSION.
const REPOS = [
  "expressjs/express", "koajs/koa", "chalk/chalk", "vercel/ms", "axios/axios", "sindresorhus/ky",
  "pallets/flask", "pallets/click", "psf/requests", "encode/httpx",
  "spf13/cobra", "gorilla/mux", "urfave/cli", "spf13/viper", "go-chi/chi",
  "jhy/jsoup", "google/gson", "square/javapoet",
  "madler/zlib", "libuv/libuv", "fmtlib/fmt", "google/leveldb",
  "jamiebuilds/the-super-tiny-compiler", "colinhacks/zod",
];

const samples = new Map(); // endpoint → latencies (ms)
const errors = new Map();
const record = (endpoint, ms, ok) => {
  if (!samples.has(endpoint)) samples.set(endpoint, []);
  samples.get(endpoint).push(ms);
  if (!ok) errors.set(endpoint, (errors.get(endpoint) ?? 0) + 1);
};
const ip = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

/** Requests slower than this count as a timeout error: one stuck socket must not hold the run open. */
const REQUEST_DEADLINE_MS = 30_000;
const slow = []; // every request over 5 s, with when it started — to line up with server logs

async function call(endpoint, path, { method = "GET", body, client } = {}) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  try {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-forwarded-for": client },
      signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    const ms = performance.now() - started;
    record(endpoint, ms, response.ok);
    if (ms > 5000) slow.push({ endpoint, path, startedAt, ms: Math.round(ms), status: response.status });
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch (error) {
    const ms = performance.now() - started;
    record(endpoint, ms, false);
    slow.push({ endpoint, path, startedAt, ms: Math.round(ms), error: error?.name === "TimeoutError" ? "timeout" : String(error?.message ?? error) });
    return { status: 0, body: null };
  }
}

const memory = new Map(); // container → peak bytes
const UNITS = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
function sampleMemory() {
  execFile("docker", ["stats", "--no-stream", "--format", "{{.Name}} {{.MemUsage}}"], (error, stdout) => {
    if (error) return;
    for (const line of stdout.split("\n")) {
      const match = /^(\S+)\s+([\d.]+)(B|KiB|MiB|GiB)/.exec(line);
      if (!match) continue;
      const bytes = Number(match[2]) * UNITS[match[3]];
      memory.set(match[1], Math.max(memory.get(match[1]) ?? 0, bytes));
    }
  });
}

const pct = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const t0 = performance.now();
const memoryTimer = setInterval(sampleMemory, 2000);
sampleMemory();

// BOTS: the burst.
const jobs = await Promise.all(
  REPOS.map(async (repo, index) => {
    const submitted = performance.now();
    const response = await call("POST /api/analyze", "/api/analyze", {
      method: "POST",
      body: { mode: "public_hosted", repoUrl: `https://github.com/${repo}` },
      client: ip(1000 + index),
    });
    return { repo, jobId: response.body?.jobId, submitted, started: null, finished: null, status: response.status === 202 ? "queued" : `rejected ${response.status}`, files: 0, runStatus: null, error: null };
  }),
);

const pending = () => jobs.filter((job) => job.jobId && job.finished === null);

// Job tracker: polls every job every 250 ms to timestamp start and finish.
const tracker = (async () => {
  while (pending().length) {
    await Promise.all(
      pending().map(async (job) => {
        const { body } = await call("GET /api/job/:id (tracker)", `/api/job/${job.jobId}`, { client: ip(1) });
        if (!body) return;
        const now = performance.now();
        if (body.status !== "queued" && job.started === null) job.started = now;
        if (body.status === "completed" || body.status === "failed") {
          job.finished = now;
          job.status = body.status;
          job.runStatus = body.runStatus ?? null;
          job.error = body.error ?? body.runStatusReason ?? null;
          // The job record does not carry a file count; the finished result does.
          if (body.status === "completed") {
            const { body: done } = await call("GET /api/result/:id (tracker)", `/api/result/${job.jobId}`, { client: ip(1) });
            const analysed = done?.result ?? done;
            job.files = analysed?.summary?.files ?? analysed?.graph?.nodes?.length ?? 0;
          }
        }
      }),
    );
    await sleep(250);
  }
})();

// USERS: browse while the jobs run.
const users = Array.from({ length: USERS }, async (_, n) => {
  const client = ip(5000 + n);
  while (pending().length) {
    const roll = Math.random();
    const done = jobs.filter((job) => job.status === "completed");
    const any = jobs.filter((job) => job.jobId);
    if (roll < 0.5 && any.length) {
      const job = any[Math.floor(Math.random() * any.length)];
      await call("GET /api/job/:id", `/api/job/${job.jobId}`, { client });
    } else if (roll < 0.8 && done.length) {
      const job = done[Math.floor(Math.random() * done.length)];
      await call("GET /api/result/:id", `/api/result/${job.jobId}`, { client });
    } else {
      await call("GET /health", "/health", { client });
    }
    await sleep(100 + Math.random() * 200);
  }
});

await Promise.all([tracker, ...users]);
clearInterval(memoryTimer);
sampleMemory();
await sleep(2500);

const finished = jobs.filter((job) => job.finished !== null);
// Throughput is the JOBS' timeline — first submit to last finish — not the test's wall clock, which a
// single slow browsing request can stretch.
const makespan = finished.length ? (Math.max(...finished.map((job) => job.finished)) - Math.min(...jobs.map((job) => job.submitted))) / 1000 : 0;
const queueWaits = finished.filter((job) => job.started !== null).map((job) => job.started - job.submitted);
const totals = finished.map((job) => job.finished - job.submitted);
const round = (value) => (value === null ? null : Math.round(value));

const report = {
  label: LABEL,
  api: API,
  users: USERS,
  jobs: {
    submitted: jobs.length,
    accepted: jobs.filter((job) => job.jobId).length,
    completed: jobs.filter((job) => job.status === "completed").length,
    failed: jobs.filter((job) => job.status === "failed").map((job) => ({ repo: job.repo, error: job.error })),
    filesAnalysed: finished.reduce((sum, job) => sum + job.files, 0),
    makespanSeconds: Number(makespan.toFixed(1)),
    throughputJobsPerMinute: Number(((finished.length / makespan) * 60).toFixed(1)),
    queueWaitMs: { p50: round(pct(queueWaits, 50)), p95: round(pct(queueWaits, 95)), max: round(pct(queueWaits, 100)) },
    endToEndMs: { p50: round(pct(totals, 50)), p95: round(pct(totals, 95)), max: round(pct(totals, 100)) },
  },
  endpoints: Object.fromEntries(
    [...samples].map(([endpoint, values]) => [
      endpoint,
      { requests: values.length, errors: errors.get(endpoint) ?? 0, p50: round(pct(values, 50)), p95: round(pct(values, 95)), p99: round(pct(values, 99)), max: round(pct(values, 100)) },
    ]),
  ),
  slowRequests: slow,
  peakMemoryMiB: Object.fromEntries([...memory].filter(([name]) => /api|worker|mongo|redis|postgres/.test(name)).map(([name, bytes]) => [name, Math.round(bytes / 1048576)])),
};

if (arg("--out")) writeFileSync(arg("--out"), JSON.stringify(report, null, 2));
console.log(`\n== ${LABEL}: ${report.jobs.completed}/${report.jobs.submitted} jobs completed in ${report.jobs.makespanSeconds}s — ${report.jobs.throughputJobsPerMinute} jobs/min, ${report.jobs.filesAnalysed} files`);
console.log(`   job end-to-end p50 ${report.jobs.endToEndMs.p50} ms, p95 ${report.jobs.endToEndMs.p95} ms; queue wait p50 ${report.jobs.queueWaitMs.p50} ms, p95 ${report.jobs.queueWaitMs.p95} ms`);
for (const [endpoint, stats] of Object.entries(report.endpoints)) {
  console.log(`   ${endpoint.padEnd(30)} n=${String(stats.requests).padStart(5)} err=${stats.errors}  p50 ${stats.p50} ms  p95 ${stats.p95} ms  p99 ${stats.p99} ms  max ${stats.max} ms`);
}
console.log(`   peak memory MiB: ${JSON.stringify(report.peakMemoryMiB)}`);
for (const request of slow) console.log(`   slow: ${request.endpoint} ${request.path} at ${request.startedAt} — ${request.ms} ms${request.error ? ` (${request.error})` : ""}`);
for (const failure of report.jobs.failed) console.log(`   failed: ${failure.repo} — ${failure.error ?? "no error recorded"}`);
