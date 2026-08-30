import type { AnalysisResult, PipelineRunStatus, ProgressEvent, ProgressMessage, ProgressSubscriber } from "@codeflow/shared-types";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { createInMemoryRateLimitStore } from "./middleware/rateLimit.js";
import { setAnalysisQueueEnqueueForTests } from "./queues/analysisQueue.js";
import { setProgressSubscriberForTests } from "./queues/progressChannel.js";
import { BudgetExceededError } from "@codeflow/analyzers";
import { ANALYZER_VERSION } from "@codeflow/config";
import { streamProgress } from "./routes/jobs.js";
import { createInMemoryEventLogStore } from "./queues/eventLogStore.js";
import { setAskHandlerForTests } from "./services/ragQaService.js";
import { clearAnalysisCacheForTests, saveAnalysis } from "./services/analysisCacheService.js";
import { clearAnalysisJobsForTests, createAnalysisJob } from "./services/analysisJobService.js";
import { clearRepositoryCacheForTests } from "./services/repositoryService.js";

const COMMIT_SHA = "abcdef1234567890abcdef1234567890abcdef12";

describe("codeflow api", () => {
  const app = createApp();

  beforeEach(() => {
    // Default: queue is unavailable so the honest 503 path is exercised unless a test
    // explicitly installs an enqueue override.
    setAnalysisQueueEnqueueForTests(null);
    setProgressSubscriberForTests(null);
    setAskHandlerForTests(null);
    clearAnalysisJobsForTests();
    clearAnalysisCacheForTests();
    clearRepositoryCacheForTests();
  });

  function withAvailableQueue() {
    const enqueuedPayloads: unknown[] = [];
    setAnalysisQueueEnqueueForTests(async (payload) => {
      enqueuedPayloads.push(payload);
      return { enqueued: true };
    });
    return enqueuedPayloads;
  }

  async function seedCachedAnalysis(): Promise<{ id: string; result: AnalysisResult }> {
    const record = await saveAnalysis({
      repoFullName: "facebook/react",
      repositoryRef: { provider: "github", owner: "facebook", name: "react" },
      commitSha: COMMIT_SHA,
      branch: "main",
      mode: "public_hosted",
      result: buildResult("seed-analysis"),
      durationMs: 1234,
      analyzerVersion: env.analyzerVersion,
    });
    return { id: record.id, result: record.result };
  }

  it("GET /health reports readiness SEPARATELY from liveness (V3-P5)", async () => {
    // A container that takes traffic before its caches are warm serves its first users a latency
    // that looks like a bug. `status` stays "ok" while cold — the process is alive and CAN serve, so
    // reporting an error would make a liveness probe kill a healthy container mid-warm-up.
    const response = await request(app).get("/health").expect(200);
    expect(response.body.status).toBe("ok");
    expect(response.body).toHaveProperty("warmedUp");
    expect(typeof response.body.warmedUp).toBe("boolean");
    // Nothing registered in this process ⇒ NOT warm. "Nothing to do" and "ready" are different
    // claims, and reporting an unconfigured process as ready is how a misconfiguration ships.
    expect(response.body.warmedUp).toBe(false);
    expect(Array.isArray(response.body.warmup.tasks)).toBe(true);
  });

  it("GET /health returns ok", async () => {
    const response = await request(app).get("/health").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      service: "codeflow-api",
    });
    expect(response.body.version).toBeDefined();
    expect(response.body.timestamp).toBeDefined();
  });

  it("POST /api/analyze rejects an unsupported mode", async () => {
    const response = await request(app)
      .post("/api/analyze")
      .send({ mode: "unsupported_mode", repo: "react" })
      .expect(400);

    expect(response.body).toMatchObject({
      error: {
        code: "INVALID_REQUEST",
      },
    });
  });

  it("POST /api/analyze rejects unsafe public repo refs", async () => {
    await request(app)
      .post("/api/analyze")
      .send({ mode: "public_hosted", owner: "facebook", repo: "../react" })
      .expect(400);

    await request(app)
      .post("/api/analyze")
      .send({ mode: "public_hosted", owner: "facebook", repo: "react", branch: "../main" })
      .expect(400);

    await request(app)
      .post("/api/analyze")
      .send({ mode: "public_hosted", repoUrl: "http://github.com/facebook/react" })
      .expect(400);
  });

  it("POST /api/analyze rejects malformed JSON", async () => {
    const response = await request(app)
      .post("/api/analyze")
      .set("Content-Type", "application/json")
      .send("{")
      .expect(400);

    expect(response.body).toMatchObject({
      error: {
        code: "INVALID_REQUEST",
      },
    });
  });

  it("POST /api/analyze queues owner/repo when the queue is available", async () => {
    withAvailableQueue();
    const response = await request(app)
      .post("/api/analyze")
      .send({ mode: "public_hosted", owner: "facebook", repo: "react", branch: "main" })
      .expect(202);

    expect(response.body).toMatchObject({ status: "queued", cached: false });
    expect(response.body.jobId).toEqual(expect.any(String));
  });

  it("POST /api/analyze queues repoUrl when the queue is available", async () => {
    withAvailableQueue();
    const response = await request(app)
      .post("/api/analyze")
      .send({ mode: "public_hosted", repoUrl: "https://github.com/facebook/react" })
      .expect(202);

    expect(response.body.jobId).toEqual(expect.any(String));
    expect(response.body.status).toBe("queued");
  });

  it("POST /api/analyze fails honestly with 503 when the queue is unavailable", async () => {
    const response = await request(app)
      .post("/api/analyze")
      .send({ mode: "public_hosted", owner: "facebook", repo: "react", branch: "main" })
      .expect(503);

    expect(response.body).toMatchObject({
      error: {
        code: "QUEUE_UNAVAILABLE",
      },
    });
    expect(response.body.error.details.jobId).toEqual(expect.any(String));

    // The failed job must NOT have produced an analysis result.
    const progress = await request(app).get(`/api/job/${response.body.error.details.jobId}`).expect(200);
    expect(progress.body.status).toBe("failed");
    expect(progress.body.analysisId).toBeUndefined();
  });

  it("POST /api/analyze rate-limits a single IP after the window max (429)", async () => {
    // Guard 4 — dedicated app with a tiny limit + a fresh in-memory store (hermetic).
    withAvailableQueue();
    const limited = createApp({ rateLimit: { max: 2, store: createInMemoryRateLimitStore() } });
    const body = { mode: "public_hosted", owner: "facebook", repo: "react", branch: "main" };

    await request(limited).post("/api/analyze").send(body).expect(202);
    await request(limited).post("/api/analyze").send(body).expect(202);
    const blocked = await request(limited).post("/api/analyze").send(body).expect(429);

    expect(blocked.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("POST /api/analyze returns a cached analysis when a known commit SHA is supplied", async () => {
    const seeded = await seedCachedAnalysis();

    const response = await request(app)
      .post("/api/analyze")
      .send({ mode: "public_hosted", owner: "facebook", repo: "react", branch: "main", commitSha: COMMIT_SHA })
      .expect(202);

    expect(response.body.cached).toBe(true);
    expect(response.body.analysisId).toBe(seeded.id);
    expect(response.body.message).toBe("Cached analysis returned.");
  });

  it("POST /api/analyze queues a job when the queue service is available", async () => {
    const enqueuedPayloads = withAvailableQueue();

    const response = await request(app)
      .post("/api/analyze")
      .send({ mode: "public_hosted", owner: "facebook", repo: "react", branch: "main" })
      .expect(202);

    expect(response.body).toMatchObject({
      status: "queued",
      cached: false,
      message: "Analysis job queued.",
    });
    expect(enqueuedPayloads).toEqual([
      expect.objectContaining({
        jobId: response.body.jobId,
        mode: "public_hosted",
        // Placeholder SHA until Ingest resolves the real HEAD; the cache-key namespace is
        // a real version, never "mock-*".
        commitSha: "pending-facebook-react-main",
        analyzerVersion: ANALYZER_VERSION,
      }),
    ]);
  });

  it("namespaces the analysis cache with a real version, never a 'mock' placeholder", () => {
    // analyzerVersion is the third component of the Mongo analysis_cache_key, so a "mock-*"
    // default silently namespaced every real cached analysis under a fake version.
    expect(env.analyzerVersion).not.toMatch(/mock/i);
    expect(env.analyzerVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ANALYZER_VERSION).toBe(env.analyzerVersion);
  });

  it("GET /api/job/:id returns queued progress before a worker completes it", async () => {
    withAvailableQueue();
    const created = await request(app)
      .post("/api/analyze")
      .send({ mode: "public_hosted", owner: "facebook", repo: "react" })
      .expect(202);

    const response = await request(app).get(`/api/job/${created.body.jobId}`).expect(200);

    expect(response.body).toMatchObject({
      id: created.body.jobId,
      status: "queued",
      progress: 0,
      currentStep: "Analysis job queued.",
      cached: false,
    });
  });

  it("GET /api/result/:id returns pending for a queued job", async () => {
    withAvailableQueue();
    const created = await request(app)
      .post("/api/analyze")
      .send({ mode: "public_hosted", owner: "facebook", repo: "react" })
      .expect(202);

    const response = await request(app).get(`/api/result/${created.body.jobId}`).expect(202);

    expect(response.body).toMatchObject({
      status: "pending",
      jobId: created.body.jobId,
      message: "Analysis is not completed yet.",
    });
  });

  it("GET /api/result/:id returns the persisted analysis for a completed job", async () => {
    const seeded = await seedCachedAnalysis();
    const job = await createAnalysisJob({
      repositoryRef: { provider: "github", owner: "facebook", name: "react" },
      repoFullName: "facebook/react",
      mode: "public_hosted",
      commitSha: COMMIT_SHA,
      analyzerVersion: env.analyzerVersion,
      status: "completed",
      progress: 1,
      analysisId: seeded.id,
    });

    const response = await request(app).get(`/api/result/${job.jobId}`).expect(200);

    expect(response.body).toMatchObject({
      id: seeded.id,
      repository: { owner: "facebook", name: "react" },
    });
    expect(response.body.summary.healthScore).toBeNull();
  });

  it("GET /api/result/:id returns 500 when a completed job has no analysisId", async () => {
    const job = await createAnalysisJob({
      repositoryRef: { provider: "github", owner: "facebook", name: "react" },
      repoFullName: "facebook/react",
      mode: "public_hosted",
      commitSha: COMMIT_SHA,
      analyzerVersion: env.analyzerVersion,
      status: "completed",
      progress: 1,
    });

    const response = await request(app).get(`/api/result/${job.jobId}`).expect(500);

    expect(response.body).toMatchObject({
      error: { code: "INTERNAL_ERROR" },
    });
  });

  it("GET /api/analysis/:analysisId returns the analysis directly", async () => {
    const seeded = await seedCachedAnalysis();

    const response = await request(app).get(`/api/analysis/${seeded.id}`).expect(200);

    expect(response.body.id).toBe(seeded.id);
    expect(response.body.repository.owner).toBe("facebook");
  });

  it("unknown job IDs return 404 error JSON", async () => {
    const response = await request(app).get("/api/job/missing-job").expect(404);

    expect(response.body).toMatchObject({
      error: {
        code: "NOT_FOUND",
      },
    });
  });

  // ── Ask-the-repo (P18) ────────────────────────────────────────────────────
  async function seedAskJob(withRag = true): Promise<string> {
    const result = buildResult("ask-analysis");
    if (withRag) {
      result.ai = {
        rag: {
          chunkCount: 1,
          embeddingModel: "mock-embed",
          embeddingDim: 3,
          // V3-P2: the persisted slice is metadata + a store reference. The route only needs
          // ai.rag to EXIST (the ask handler is mocked in this suite), so no store is stood up.
          chunks: [{ id: "src/index.ts#1-5", fileId: "src/index.ts", startLine: 1, endLine: 5, tokenCount: 2 }],
          store: { namespace: "facebook/react@sha/mock-embed/3", vectorStoreId: "memory-vector-store", textStoreId: "memory-chunk-text-store" },
        },
      };
    }
    const saved = await saveAnalysis({
      repoFullName: "facebook/react",
      repositoryRef: { provider: "github", owner: "facebook", name: "react" },
      commitSha: COMMIT_SHA,
      branch: "main",
      mode: "public_hosted",
      result,
      durationMs: 10,
      analyzerVersion: env.analyzerVersion,
    });
    const job = await createAnalysisJob({
      repositoryRef: { provider: "github", owner: "facebook", name: "react" },
      repoFullName: "facebook/react",
      mode: "public_hosted",
      commitSha: COMMIT_SHA,
      analyzerVersion: env.analyzerVersion,
      status: "completed",
      progress: 1,
      analysisId: saved.id,
    });
    return job.jobId;
  }

  it("POST /api/result/:id/ask returns a grounded answer", async () => {
    setAskHandlerForTests(async ({ question }) => ({
      answer: `Answer to: ${question}`,
      answered: true,
      citations: [{ fileId: "src/index.ts", startLine: 1, endLine: 5 }],
      retrievedChunkIds: ["src/index.ts#1-5"],
    }));
    const jobId = await seedAskJob();

    const response = await request(app).post(`/api/result/${jobId}/ask`).send({ question: "what is this?" }).expect(200);
    expect(response.body.answered).toBe(true);
    expect(response.body.citations).toEqual([{ fileId: "src/index.ts", startLine: 1, endLine: 5 }]);
  });

  it("POST /api/result/:id/ask returns 'Q&A unavailable' (not 500) when the run built no index", async () => {
    const jobId = await seedAskJob(false); // no ai.rag
    const response = await request(app).post(`/api/result/${jobId}/ask`).send({ question: "anything?" }).expect(200);
    expect(response.body.unavailable).toBe(true);
    expect(response.body.answered).toBe(false);
  });

  it("POST /api/result/:id/ask surfaces budget-exhausted as honest 'at capacity'", async () => {
    setAskHandlerForTests(async () => {
      throw new BudgetExceededError("Daily LLM budget exhausted; Q&A skipped (demo at capacity).");
    });
    const jobId = await seedAskJob();
    const response = await request(app).post(`/api/result/${jobId}/ask`).send({ question: "q?" }).expect(200);
    expect(response.body.atCapacity).toBe(true);
    expect(response.body.answered).toBe(false);
  });

  it("POST /api/result/:id/ask passes a sessionId through and echoes it back (V3-P3)", async () => {
    // The conversation contract: the client sends a session id, the handler receives it (so the
    // agent can load prior turns), and the response echoes it so the client can continue.
    const seen: Array<{ sessionId?: string; analysisId?: string }> = [];
    setAskHandlerForTests(async ({ sessionId, analysisId }) => {
      seen.push({ sessionId, analysisId });
      return { answer: "ok", answered: true, citations: [], retrievedChunkIds: [] };
    });
    const jobId = await seedAskJob();

    const response = await request(app)
      .post(`/api/result/${jobId}/ask`)
      .send({ question: "what about its callers?", sessionId: "sess-abc_1.2" })
      .expect(200);
    expect(response.body.sessionId).toBe("sess-abc_1.2");
    expect(seen[0].sessionId).toBe("sess-abc_1.2");
    // The analysis id is passed too, so a session cannot mix two repositories.
    expect(seen[0].analysisId).toBeTruthy();
  });

  it("POST /api/result/:id/ask omits the session entirely for a stateless ask", async () => {
    // A one-shot ask must not create a session, or a shared store fills with single-turn
    // sessions nobody can address again.
    const seen: Array<string | undefined> = [];
    setAskHandlerForTests(async ({ sessionId }) => {
      seen.push(sessionId);
      return { answer: "ok", answered: true, citations: [], retrievedChunkIds: [] };
    });
    const jobId = await seedAskJob();
    const response = await request(app).post(`/api/result/${jobId}/ask`).send({ question: "q?" }).expect(200);
    expect(seen[0]).toBeUndefined();
    expect(response.body.sessionId).toBeUndefined();
  });

  it("POST /api/result/:id/ask REJECTS a malformed sessionId rather than sanitising it", async () => {
    // A session id becomes a STORE KEY: unbounded length is a memory-exhaustion vector, and
    // separators could collide with another namespace in a shared Redis. Rejecting beats silently
    // rewriting, which would hand the client a session it cannot address again.
    setAskHandlerForTests(async () => ({ answer: "ok", answered: true, citations: [], retrievedChunkIds: [] }));
    const jobId = await seedAskJob();
    for (const bad of ["a".repeat(65), "has spaces", "colon:separated", "slash/es"]) {
      await request(app).post(`/api/result/${jobId}/ask`).send({ question: "q?", sessionId: bad }).expect(400);
    }
    await request(app).post(`/api/result/${jobId}/ask`).send({ question: "q?", sessionId: 42 }).expect(400);
  });

  it("POST /api/result/:id/ask rejects an empty question (400) and an unknown job (404)", async () => {
    const jobId = await seedAskJob();
    await request(app).post(`/api/result/${jobId}/ask`).send({ question: "  " }).expect(400);
    await request(app).post(`/api/result/missing-job/ask`).send({ question: "q?" }).expect(404);
  });

  it("POST /api/result/:id/ask is rate-limited (429) per IP", async () => {
    setAskHandlerForTests(async () => ({ answer: "ok", answered: true, citations: [], retrievedChunkIds: [] }));
    const limited = createApp({ rateLimit: { max: 1, store: createInMemoryRateLimitStore() } });
    const jobId = await seedAskJob();

    await request(limited).post(`/api/result/${jobId}/ask`).send({ question: "q?" }).expect(200);
    const blocked = await request(limited).post(`/api/result/${jobId}/ask`).send({ question: "q?" }).expect(429);
    expect(blocked.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });

  // The SSE write path is unit-tested via streamProgress with a fake sink —
  // superagent reports "aborted" on event-stream responses, so it can't assert the
  // streamed body directly. This exercises the exact framing the route uses.
  it("streamProgress writes a progress frame per event then a terminal done frame", () => {
    const jobId = "job-sse";
    const channel = makeReplayChannel(); // replay → deterministic publish-then-subscribe
    channel.publishProgress(jobId, ingestEvent(jobId));
    channel.publishDone(jobId, "completed");

    const chunks: string[] = [];
    let ended = false;
    const close = streamProgress({ write: (c) => chunks.push(c), end: () => { ended = true; } }, jobId, channel);

    const body = chunks.join("");
    expect(body).toContain("event: progress");
    expect(body).toContain('"stage":"ingest"');
    expect(body).toContain("event: done");
    expect(body).toContain('"status":"completed"');
    expect(ended).toBe(true); // terminal event closes the stream
    close(); // idempotent
  });

  it("GET /api/job/:id/events on an unknown job returns 404 JSON (not SSE)", async () => {
    setProgressSubscriberForTests(makeReplayChannel());
    const response = await request(app).get("/api/job/missing-job/events").expect(404);
    expect(response.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // #19 — REST surfaces the terminal pipeline outcome (SSE is for live watching only).
  it("GET /api/job/:id returns runStatus + runStatusReason for a partial run", async () => {
    const job = await createAnalysisJob({
      repositoryRef: { provider: "github", owner: "facebook", name: "react" },
      repoFullName: "facebook/react",
      mode: "public_hosted",
      commitSha: COMMIT_SHA,
      analyzerVersion: env.analyzerVersion,
      status: "completed",
      progress: 1,
      runStatus: "partial",
      runStatusReason: "budget-exhausted",
    });

    const response = await request(app).get(`/api/job/${job.jobId}`).expect(200);
    expect(response.body.runStatus).toBe("partial");
    expect(response.body.runStatusReason).toBe("budget-exhausted");
  });
});

// #20 — SSE replay: a late connection replays the buffered log from Ingest, then tails live,
// with no gaps or duplicates (deduped on the monotonic stageIndex + terminal).
describe("SSE replay (#20)", () => {
  const STAGES = ["ingest", "orient", "map-structure", "inventory", "connect", "analyze", "synthesize", "rag"] as const;

  function progressMessage(jobId: string, index: number): ProgressMessage {
    return {
      kind: "progress",
      jobId,
      event: {
        jobId,
        stage: STAGES[index - 1],
        stageIndex: index,
        stageCount: 8,
        kind: index <= 6 ? "deterministic" : "ai",
        status: "completed",
        label: STAGES[index - 1],
        progress: index / 8,
        startedAt: "2026-06-10T00:00:00.000Z",
        emittedAt: "2026-06-10T00:00:00.000Z",
      },
    };
  }

  it("replays buffered stages from Ingest, then tails live to the terminal event (no gaps/dupes)", async () => {
    const jobId = "job-replay";
    const log = createInMemoryEventLogStore();
    // The worker already emitted stages 1–5 before this client connects.
    for (let i = 1; i <= 5; i++) await log.append(jobId, progressMessage(jobId, i));

    let liveHandler: ((m: ProgressMessage) => void) | null = null;
    const subscriber = {
      subscribe(_id: string, handler: (m: ProgressMessage) => void) {
        liveHandler = handler;
        return () => {};
      },
    };

    const chunks: string[] = [];
    let ended = false;
    streamProgress({ write: (c) => chunks.push(c), end: () => { ended = true; } }, jobId, subscriber, log);

    // Let the async replay (eventLog.read) flush.
    await Promise.resolve();
    await Promise.resolve();

    // Live tail: a duplicate of stage 5 (must be deduped), then 6–8 and the terminal done.
    liveHandler!(progressMessage(jobId, 5)); // duplicate
    for (let i = 6; i <= 8; i++) liveHandler!(progressMessage(jobId, i));
    liveHandler!({ kind: "done", jobId, status: "completed" });

    const body = chunks.join("");
    // Every stage appears exactly once, in order.
    const indices = [...body.matchAll(/"stageIndex":(\d)/g)].map((m) => Number(m[1]));
    expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(body).toContain("event: done");
    expect((body.match(/event: done/g) ?? []).length).toBe(1);
    expect(ended).toBe(true);
  });

  it("a run that already finished replays its full log + terminal even with no live events", async () => {
    const jobId = "job-finished";
    const log = createInMemoryEventLogStore();
    for (let i = 1; i <= 8; i++) await log.append(jobId, progressMessage(jobId, i));
    await log.append(jobId, { kind: "done", jobId, status: "partial" });

    const chunks: string[] = [];
    streamProgress({ write: (c) => chunks.push(c), end: () => {} }, jobId, { subscribe: () => () => {} }, log);
    await Promise.resolve();
    await Promise.resolve();

    const body = chunks.join("");
    const indices = [...body.matchAll(/"stageIndex":(\d)/g)].map((m) => Number(m[1]));
    expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(body).toContain('"status":"partial"');
  });
});

/**
 * In-memory progress channel with replay — a test double for the BullMQ transport.
 * Messages published before a subscriber attaches are replayed on subscribe, which
 * keeps the SSE test deterministic (publish-then-GET). The real transport does NOT
 * replay (a late subscriber misses earlier events — see CURRENT_STATE.md).
 */
function makeReplayChannel(): ProgressSubscriber & {
  publishProgress(jobId: string, event: ProgressEvent): void;
  publishDone(jobId: string, status: PipelineRunStatus): void;
} {
  const buffers = new Map<string, ProgressMessage[]>();
  const push = (m: ProgressMessage) => {
    const list = buffers.get(m.jobId) ?? [];
    list.push(m);
    buffers.set(m.jobId, list);
  };
  return {
    publishProgress(jobId, event) {
      push({ kind: "progress", jobId, event });
    },
    publishDone(jobId, status) {
      push({ kind: "done", jobId, status });
    },
    subscribe(jobId, handler) {
      for (const message of buffers.get(jobId) ?? []) handler(message);
      return () => {};
    },
  };
}

function ingestEvent(jobId: string): ProgressEvent {
  return {
    jobId,
    stage: "ingest",
    stageIndex: 1,
    stageCount: 1,
    kind: "deterministic",
    status: "completed",
    label: "Ingesting repository",
    progress: 1,
    startedAt: "2026-05-31T00:00:00.000Z",
    durationMs: 5,
    emittedAt: "2026-05-31T00:00:00.005Z",
  };
}

function buildResult(id: string): AnalysisResult {
  return {
    id,
    repository: { provider: "github", owner: "facebook", name: "react" },
    mode: "public_hosted",
    commitSha: COMMIT_SHA,
    summary: {
      repository: { provider: "github", owner: "facebook", name: "react" },
      mode: "public_hosted",
      files: 2,
      functions: 1,
      connections: 1,
      healthScore: null,
      healthGrade: null,
      languages: ["TypeScript"],
      circularDependencies: 0,
    },
    files: [
      { id: "file-1", path: "src/index.ts", name: "index.ts", layer: "source", language: "TypeScript", lines: 2 },
    ],
    symbols: [],
    dependencies: [],
    issues: [],
    metrics: { perFile: [], keyFiles: [], hotspots: [], cycles: [], summary: { fileCount: 1, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 } },
    warnings: [],
    createdAt: "2026-05-05T00:00:00.000Z",
  };
}
