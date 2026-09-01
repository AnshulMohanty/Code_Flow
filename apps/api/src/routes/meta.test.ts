import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANALYZER_VERSION } from "@codeflow/config";
import { createApp } from "../app.js";
import { clearAnalysisCacheForTests, saveAnalysis } from "../services/analysisCacheService.js";
import { answerLatency, recordAnswerLatency, resetAnswerLatencyForTests, LATENCY_WINDOW } from "../services/answerLatency.js";
import { env } from "../config/env.js";
import type { AnalysisResult } from "@codeflow/shared-types";

/**
 * V3-FINAL. Every figure the design puts in the nav, HUD and footer needs a real source, or the
 * component's only other option is to invent one. These tests are about that: the endpoint reports
 * what it measured, reports NOTHING when it measured nothing, and never fills a gap with a
 * plausible-looking number.
 */

function resultFor(id: string, files: number): AnalysisResult {
  return {
    id,
    repository: { provider: "github", owner: "acme", name: id },
    mode: "public_hosted",
    createdAt: "2026-08-31T00:00:00.000Z",
    commitSha: "a".repeat(40),
    warnings: [],
    summary: {
      repository: { provider: "github", owner: "acme", name: id },
      mode: "public_hosted",
      files,
      functions: 0,
      connections: 0,
      healthScore: null,
      healthGrade: null,
    },
    files: [],
    symbols: [],
    dependencies: [],
    issues: [],
    metrics: {
      perFile: [],
      keyFiles: [],
      hotspots: [],
      cycles: [],
      summary: { fileCount: files, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 },
    },
  };
}

describe("GET /api/meta", () => {
  const app = createApp();

  beforeEach(() => {
    clearAnalysisCacheForTests();
    resetAnswerLatencyForTests();
  });
  afterEach(() => {
    delete process.env.GIT_SHA;
  });

  it("reports the ANALYZER version — the thing that actually decides cache reuse", async () => {
    const response = await request(app).get("/api/meta").expect(200);
    expect(response.body.analyzerVersion).toBe(ANALYZER_VERSION);
  });

  it("reports build NULL when the deployment supplied none, rather than inventing an id", async () => {
    // A build id nobody can look up is decoration, and decoration in a footer reads as provenance.
    const response = await request(app).get("/api/meta").expect(200);
    expect(response.body.build).toBeNull();
  });

  it("reports the build SHA when one is configured", async () => {
    process.env.GIT_SHA = "abc1234";
    const response = await request(app).get("/api/meta").expect(200);
    expect(response.body.build).toBe("abc1234");
  });

  it("reports p50 NULL with a ZERO sample count before any answer has been served", async () => {
    const response = await request(app).get("/api/meta").expect(200);
    expect(response.body.answerLatency).toEqual({ p50Ms: null, p95Ms: null, sampleCount: 0, scope: "process" });
  });

  it("reports a measured p50 once answers have been served, with the sample count beside it", async () => {
    // The sample count travels with the figure because a p50 over two samples is not a p50, and a
    // reader cannot weigh the number without it.
    for (const ms of [100, 200, 300]) recordAnswerLatency(ms);
    const response = await request(app).get("/api/meta").expect(200);
    expect(response.body.answerLatency.p50Ms).toBe(200);
    expect(response.body.answerLatency.sampleCount).toBe(3);
    expect(response.body.answerLatency.scope).toBe("process");
  });

  it("lists REAL indexed analyses, newest first — never a hardcoded recents list", async () => {
    await saveAnalysis({
      repoFullName: "acme/older",
      repositoryRef: { provider: "github", owner: "acme", name: "older" },
      commitSha: "b".repeat(40),
      branch: "main",
      mode: "public_hosted",
      result: resultFor("older", 10),
      durationMs: 1,
      analyzerVersion: env.analyzerVersion,
    });
    await saveAnalysis({
      repoFullName: "acme/newer",
      repositoryRef: { provider: "github", owner: "acme", name: "newer" },
      commitSha: "c".repeat(40),
      branch: "main",
      mode: "public_hosted",
      result: resultFor("newer", 20),
      durationMs: 1,
      analyzerVersion: env.analyzerVersion,
    });

    const response = await request(app).get("/api/meta").expect(200);
    const names = response.body.indexed.map((entry: { repoFullName: string }) => entry.repoFullName);
    expect(names).toContain("acme/newer");
    expect(names).toContain("acme/older");
    expect(response.body.indexed[0].fileCount).toBeGreaterThan(0);
  });

  it("returns an EMPTY indexed list for a deployment that has analysed nothing", async () => {
    const response = await request(app).get("/api/meta").expect(200);
    expect(response.body.indexed).toEqual([]);
  });
});

describe("answerLatency — a measurement, with its limitations stated", () => {
  beforeEach(() => resetAnswerLatencyForTests());

  it("computes a NEAREST-RANK percentile, so every figure is a real observation", () => {
    // An interpolated p50 over a handful of samples invents a millisecond value no request took.
    for (const ms of [10, 20, 30, 40]) recordAnswerLatency(ms);
    expect(answerLatency().p50Ms).toBe(20);
    expect(answerLatency().p95Ms).toBe(40);
  });

  it("DROPS a non-finite or negative sample instead of clamping it", () => {
    // Recording a bad measurement would corrupt every percentile after it.
    recordAnswerLatency(Number.NaN);
    recordAnswerLatency(-5);
    recordAnswerLatency(Number.POSITIVE_INFINITY);
    expect(answerLatency().sampleCount).toBe(0);
  });

  it("BOUNDS the window, so a busy replica cannot leak through it", () => {
    for (let i = 0; i < LATENCY_WINDOW + 50; i++) recordAnswerLatency(i);
    expect(answerLatency().sampleCount).toBe(LATENCY_WINDOW);
    // Oldest dropped: the window holds the most recent samples.
    expect(answerLatency().p50Ms).toBeGreaterThan(LATENCY_WINDOW / 2);
  });

  it("reports scope explicitly, because a per-process p50 is not a fleet p50", () => {
    recordAnswerLatency(5);
    expect(answerLatency().scope).toBe("process");
  });
});
