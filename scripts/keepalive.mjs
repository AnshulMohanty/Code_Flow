#!/usr/bin/env node
/**
 * KEEP-ALIVE PING (V3-P5 task 5) — stops a free-tier host from cold-sleeping the API.
 *
 * WHY THIS EXISTS. Free and hobby tiers on most platforms suspend a service after ~15 minutes with
 * no traffic. The next request then pays a full cold start: process boot, Mongo connect, and — for
 * the worker — the tree-sitter WASM load that V3-P5's warm-up registry exists to front-load. A
 * visitor arriving at a suspended deployment does not experience "a slow app", they experience a
 * request that appears to hang.
 *
 * WHY IT PINGS `/health` AND CHECKS `warmedUp` RATHER THAN JUST TOUCHING THE HOST. Reaching the
 * process is not the same as the process being useful: `/health` returns 200 while still cold, by
 * design (see apps/api/src/routes/health.ts). So this reports `warmedUp` separately, and a ping that
 * finds a cold instance has done its job — it triggered the warm-up that the next real user would
 * otherwise have waited through.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - It does not ping the WORKER. The worker has no public URL and sleeps on its own schedule; the
 *     honest fix there is a platform-level minimum instance count, which is a deploy setting rather
 *     than something a script can arrange. Named in GO_LIVE.md.
 *   - It does not hit any endpoint that costs money. `/health` touches no provider and no LLM. A
 *     keep-alive that ran a real analysis every 10 minutes would be a bill, not a warm-up.
 *   - It does not retry aggressively. One attempt per invocation: this runs on a schedule, so the
 *     schedule IS the retry, and a tight retry loop against a service that is genuinely down turns a
 *     keep-alive into a load test.
 *
 * ONE FAIR WARNING, worth stating in the code rather than only in a runbook: some providers'
 * free-tier terms treat synthetic traffic whose only purpose is to defeat sleep as abuse. On a paid
 * tier this is uncontroversial. Check the terms before scheduling it.
 *
 * USAGE
 *   node scripts/keepalive.mjs https://api.example.com
 *   CODEFLOW_API_URL=https://api.example.com node scripts/keepalive.mjs
 *
 * Exit code 0 when the service answered (warm or cold), 1 when it did not — so a scheduler's own
 * failure reporting is meaningful.
 */

const target = process.argv[2] ?? process.env.CODEFLOW_API_URL;

if (!target) {
  console.error("usage: node scripts/keepalive.mjs <api-base-url>   (or set CODEFLOW_API_URL)");
  process.exit(2);
}

const url = new URL("/health", target).toString();
// 20s: comfortably longer than a cold start's first byte, short enough that a scheduled job does not
// sit open for minutes against a dead host.
const TIMEOUT_MS = 20_000;

const startedAt = Date.now();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

try {
  const response = await fetch(url, {
    signal: controller.signal,
    headers: { "user-agent": "codeflow-keepalive/1" },
  });
  const elapsed = Date.now() - startedAt;

  if (!response.ok) {
    console.error(`keepalive: ${url} -> HTTP ${response.status} in ${elapsed}ms`);
    process.exit(1);
  }

  // Best-effort parse: a 200 is already the signal that matters, so an unexpected body must not
  // turn a successful ping into a failure.
  let warmedUp = null;
  try {
    const body = await response.json();
    warmedUp = typeof body?.warmedUp === "boolean" ? body.warmedUp : null;
  } catch {
    /* a 200 with an unreadable body still means the service is awake */
  }

  const state = warmedUp === null ? "warmedUp unreported" : warmedUp ? "warm" : "COLD (this ping is warming it)";
  console.log(`keepalive: ${url} -> 200 in ${elapsed}ms, ${state}`);
  process.exit(0);
} catch (error) {
  const elapsed = Date.now() - startedAt;
  const reason = error?.name === "AbortError" ? `no response in ${TIMEOUT_MS}ms` : String(error?.message ?? error);
  console.error(`keepalive: ${url} -> FAILED after ${elapsed}ms (${reason})`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}
