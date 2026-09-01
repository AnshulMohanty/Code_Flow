import {
  answerQuestion,
  createEmbeddingClientFromEnv,
  createInMemoryBudgetHandle,
  createLlmClientFromEnv,
  createRedisBudgetHandle,
  type RagAnswer,
} from "@codeflow/analyzers";
import {
  askAgent,
  createGraphTools,
  createSearchTool,
  createWhatChangedTool,
  entitiesFrom,
  type AgentAnswer,
} from "@codeflow/agents";
import { RAG_TOP_K } from "@codeflow/config";
import {
  createMemoryRepoStore,
  createRedisRepoStore,
  createMemorySessionStore,
  createRedisSessionStore,
  type RepoMemoryStore,
  type SessionMemoryStore,
} from "@codeflow/memory";
import { createLexicalOverlapReranker, createRetrievalStores, type RetrievalStores } from "@codeflow/retrieval";
import type { AnalysisCacheHandle, AnalysisResult, BudgetHandle } from "@codeflow/shared-types";
import { env } from "../config/env.js";
import { getSharedRedis, isSharedRedisEnabled } from "../queues/redisClient.js";
import { createRedisAnalysisCache } from "./redisAnalysisCache.js";

/**
 * Answers a question against a stored analysis. Injectable so tests supply a mock (with mock
 * chat/embedding clients) and the suite makes zero real calls.
 *
 * V3-P3 widened the INPUT (a session id + the analysis id, for conversation memory) and the
 * OUTPUT (`AgentAnswer` is a superset of `RagAnswer`) additively, so an existing test double that
 * returns a plain `RagAnswer` still satisfies it.
 */
export type AskHandler = (input: {
  result: AnalysisResult;
  question: string;
  /** Present when the client is continuing a conversation. Absent ⇒ a stateless one-shot ask. */
  sessionId?: string;
  /** The stored analysis' id — scopes a session so it cannot mix two repositories. */
  analysisId?: string;
}) => Promise<RagAnswer | AgentAnswer>;

let testOverride: AskHandler | null = null;
let productionHandler: AskHandler | null = null;

export function setAskHandlerForTests(handler: AskHandler | null) {
  testOverride = handler;
}

export function getAskHandler(): AskHandler {
  if (testOverride) return testOverride;
  productionHandler ??= createProductionAskHandler();
  return productionHandler;
}

/**
 * The daily LLM budget for the API's Q&A path (V3-P0).
 *
 * Before this, the API kept a PER-PROCESS in-memory ledger while the worker kept a Mongo
 * one, so "the global daily ceiling" was actually two independent ceilings: a Q&A call could
 * not see what the pipeline had spent, and vice versa. Both now decrement the SAME Redis
 * counter. Falling back to in-memory when Redis is absent is honest degradation, not the
 * intended path, and it is logged.
 *
 * Memoized: one handle per process, resolved on first use (the Redis connection is async
 * while `answerQuestion` needs a `BudgetHandle` synchronously).
 */
let sharedBudget: BudgetHandle | null = null;

async function resolveBudget(): Promise<BudgetHandle> {
  if (sharedBudget) return sharedBudget;
  const redis = await getSharedRedis();
  if (redis) {
    sharedBudget = createRedisBudgetHandle(redis);
  } else {
    if (isSharedRedisEnabled()) {
      console.warn(
        "[codeflow] Q&A budget: Redis unavailable — falling back to a PER-PROCESS ceiling. " +
          "The daily LLM budget is no longer shared with the worker.",
      );
    }
    sharedBudget = createInMemoryBudgetHandle();
  }
  return sharedBudget;
}

/** Test seam: forget the memoized budget so a suite can re-resolve it. */
export function resetQaBudgetForTests(): void {
  sharedBudget = null;
  sharedRetrieval = null;
  sessionStore = null;
  repoStore = null;
  answerCache = null;
}

/**
 * Conversation + repository memory (V3-P3).
 *
 * Redis-backed when a shared Redis is available, in-memory otherwise — and the fallback is
 * ANNOUNCED, because it is a genuinely different product: an in-memory session lives in one API
 * process's heap, so two replicas give a user two different conversations and a restart forgets
 * every follow-up. Same honest-degradation rule V3-P0 applied to the budget.
 *
 * Repo memory is now Redis-backed too (V3-P5, ledger #21). It was the last per-process store, and
 * the consequence was felt exactly where the feature lives: after a restart `what_changed` reported
 * "only one commit analysed", for a tool whose whole value is remembering the previous one. Both
 * stores fall back to in-memory and both ANNOUNCE it.
 */
let sessionStore: Promise<SessionMemoryStore> | null = null;
let repoStore: Promise<RepoMemoryStore> | null = null;

function resolveSessionStore(): Promise<SessionMemoryStore> {
  sessionStore ??= (async () => {
    const redis = await getSharedRedis();
    if (redis) return createRedisSessionStore({ redis: redis as never, onError: reportSessionError });
    if (isSharedRedisEnabled()) {
      console.warn(
        "[codeflow] Q&A session memory: Redis unavailable — conversations are PER-PROCESS. " +
          "Follow-ups will not resolve across replicas or survive a restart.",
      );
    }
    return createMemorySessionStore();
  })();
  return sessionStore;
}

function reportSessionError(error: unknown, operation: string): void {
  // Reported, never swallowed: a lost session costs context for one question, which is
  // recoverable — but silence would make it undiagnosable.
  console.warn(`[codeflow] session memory ${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
}

function resolveRepoStore(): Promise<RepoMemoryStore> {
  repoStore ??= (async () => {
    const redis = await getSharedRedis();
    if (redis) return createRedisRepoStore({ redis: redis as never, onError: reportRepoError });
    if (isSharedRedisEnabled()) {
      console.warn(
        "[codeflow] Repo memory: Redis unavailable — commit snapshots are PER-PROCESS. " +
          "`what_changed` will report only the commits this process analysed itself.",
      );
    }
    return createMemoryRepoStore();
  })();
  return repoStore;
}

function reportRepoError(error: unknown, operation: string): void {
  // Same rule as session memory: a lost snapshot degrades one answer, silence makes it
  // undiagnosable.
  console.warn(`[codeflow] repo memory ${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * The Q&A ANSWER CACHE, now shared (V3-P5, ledger #21).
 *
 * Resolved once per process. Redis when available, a process-local Map otherwise — and unlike the
 * budget and the session store, this degradation is NOT announced at warn level, deliberately: an
 * unshared answer cache costs money, not correctness, and a warning that fires on every boot of a
 * keyless local deployment trains operators to ignore warnings. It is reported once, at info.
 */
let answerCache: Promise<AnalysisCacheHandle> | null = null;

function resolveAnswerCache(): Promise<AnalysisCacheHandle> {
  answerCache ??= (async () => {
    const redis = await getSharedRedis();
    if (redis) {
      return createRedisAnalysisCache({
        redis: redis as never,
        onError: (error, operation) =>
          console.warn(
            `[codeflow] Q&A answer cache ${operation} failed (a miss, not an error): ` +
              `${error instanceof Error ? error.message : String(error)}`,
          ),
      });
    }
    if (isSharedRedisEnabled()) {
      console.log(
        "[codeflow] Q&A answer cache: Redis unavailable — PER-PROCESS. Repeated questions may be " +
          "paid for once per replica. The spend CEILING is unaffected (cache-before-budget still holds).",
      );
    }
    return createInMemoryCache();
  })();
  return answerCache;
}

/**
 * The retrieval stores for the query path (V3-P2).
 *
 * Memoized per process and resolved from the SAME factory + the same `POSTGRES_URL` the worker
 * uses, because the API must read the index the worker wrote. If these two resolved
 * differently — one Postgres, one in-memory — every question would come back "no index",
 * which is exactly the kind of split V3-P0 removed from the budget.
 *
 * Resolved LAZILY (per embedding space), not at boot: the space comes from the configured
 * embedding client, and the pgvector table name carries the dimension.
 */
let sharedRetrieval: Promise<RetrievalStores> | null = null;

function resolveRetrieval(space: { embeddingModel: string; embeddingDim: number }): Promise<RetrievalStores> {
  sharedRetrieval ??= createRetrievalStores({ space, postgresUrl: env.postgresUrl }).then((stores) => {
    if (stores.degradation) {
      console.warn(
        `[codeflow] Q&A retrieval DEGRADED — ${stores.degradation} Questions will only be answerable ` +
          "for indexes this process built itself, which for the API is none.",
      );
    }
    return stores;
  });
  return sharedRetrieval;
}

// In-process answer cache for the query path. (Sharing the answer CACHE with the worker is
// still open — see the deferred ledger; the BUDGET is now shared, which was the wallet risk.)
function createInMemoryCache(): AnalysisCacheHandle {
  const store = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string) {
      return store.has(key) ? (store.get(key) as T) : null;
    },
    async set<T = unknown>(key: string, value: T) {
      store.set(key, value);
    },
  };
}

/**
 * Production ask handler (V3-P3): the BOUNDED MULTI-TURN AGENT over graph tools + V3-P2 hybrid
 * retrieval, with session memory so a follow-up resolves against prior turns.
 *
 * WHY THE SINGLE-SHOT PATH IS STILL HERE. `answerQuestion` remains the fallback for an analysis
 * with an index but NO GRAPH — a pre-V3-P1 cached result. The agent's whole advantage is exact
 * graph lookups; with no graph its tools return nothing and it would burn turns discovering that.
 * Falling back is not hedging, it is picking the better path for the data that exists, and which
 * one ran is visible in the response (an agent answer carries a `trace`).
 *
 * The homogeneity guard, the similarity floor, cache-before-budget and the daily ceiling all still
 * apply — the first two inside `search_code`, the last two around every turn.
 */
function createProductionAskHandler(): AskHandler {
  return async ({ result, question, sessionId, analysisId }) => {
    // Resolved per call rather than captured at construction: the Redis connection is async, and
    // the handler is built synchronously at first use. Memoized inside, so this is one await.
    const cache = await resolveAnswerCache();
    const budget = await resolveBudget();
    const ragIndex = result.ai?.rag;
    if (!ragIndex) {
      throw new Error("This analysis has no Q&A index.");
    }
    const chatClient = createLlmClientFromEnv(process.env);
    const embeddingClient = createEmbeddingClientFromEnv(process.env);
    if (!chatClient || !embeddingClient) {
      throw new Error("Q&A requires both a chat and an embedding provider to be configured.");
    }
    const retrieval = await resolveRetrieval({
      embeddingModel: embeddingClient.model,
      embeddingDim: embeddingClient.dimension,
    });

    const hasGraph = (result.graph?.nodes.length ?? 0) > 0;
    if (!hasGraph) {
      return answerQuestion({
        question,
        ragIndex,
        vectorStore: retrieval.vectorStore,
        textStore: retrieval.textStore,
        chatClient,
        embeddingClient,
        cache,
        budget,
        commitSha: result.commitSha,
        k: RAG_TOP_K,
      });
    }

    const store = await resolveSessionStore();
    const scopedAnalysisId = analysisId ?? result.id;
    const memory = sessionId ? await store.load(sessionId) : null;

    const searchTool = createSearchTool({
      vectorStore: retrieval.vectorStore,
      textStore: retrieval.textStore,
      embeddingClient,
      reranker: createLexicalOverlapReranker(),
      k: RAG_TOP_K,
    });

    const answer = await askAgent({
      question,
      result,
      chatClient,
      budget,
      tools: [...createGraphTools(), searchTool, createWhatChangedTool({ store: await resolveRepoStore() })],
      ...(memory ? { memory } : {}),
    });

    // Persist the turn ONLY when the client is running a session. A stateless ask must not create
    // one, or a shared store would fill with single-turn sessions nobody can address.
    if (sessionId) {
      // Recover the retrieved chunks' METADATA from the index slice so `entitiesFrom` can derive
      // symbol entities (a follow-up like "where is it declared?" resolves against those). The
      // agent's answer carries only chunk ids; the coordinates and symbol names live here.
      const byId = new Map(ragIndex.chunks.map((chunk) => [chunk.id, chunk]));
      const chunks = answer.retrievedChunkIds
        .map((id) => byId.get(id))
        .filter((chunk): chunk is NonNullable<typeof chunk> => Boolean(chunk))
        .map((chunk) => ({ ...chunk, text: "", fusedScore: 0, sources: ["vector" as const] }));
      await store.append(sessionId, scopedAnalysisId, {
        question,
        answer: answer.answer,
        answered: answer.answered,
        citations: answer.citations,
        retrievedChunkIds: answer.retrievedChunkIds,
        toolsUsed: [...new Set(answer.trace.turns.map((turn) => turn.toolCalled).filter((id): id is string => Boolean(id)))],
        entities: entitiesFrom(answer, chunks),
      });
    }
    return answer;
  };
}

/**
 * WARM the Q&A path (V3-FINAL — closing P5 DoD 1e).
 *
 * WHAT WAS COLD, and it was not theoretical. Everything above resolves LAZILY on the first
 * `/api/result/:id/ask`: the answer cache, the budget, session and repo memory each await the
 * shared Redis connection, and `resolveRetrieval` runs `CREATE EXTENSION` / `CREATE TABLE` against
 * Postgres. So the first question of a process paid a round trip per store plus a schema round trip,
 * inside the request — the HH_Goa cold-start problem, in the one place this service does real work.
 *
 * WHY IT IS ALSO WHAT MAKES `/health.warmedUp` HONEST. Before this, the API imported
 * `warmupRegistry` and read `state()` while registering ZERO tasks — and `snapshot()` returns
 * `required.length > 0 && …`, so `warmedUp` was STRUCTURALLY false in every API process forever. The
 * flag was not wrong about a cold process; it was incapable of ever being right. Warming needed real
 * tasks before the flag could mean anything, and these are the API's real ones.
 *
 * NO PROBE REQUESTS, the same rule the worker's warm-up follows: provider clients are CONSTRUCTED,
 * never called. A warm-up that spent money would be charging the owner for a health check.
 *
 * Idempotent — every resolver here is memoized, so calling this twice costs one set of connections.
 * Best-effort per dependency: a store that cannot resolve leaves its descriptor saying so rather
 * than failing the warm-up, because the deterministic read paths do not need it.
 */
/**
 * A descriptor per warmed dependency. A TYPE alias rather than an interface on purpose: TypeScript
 * gives an object type alias an implicit index signature, so this satisfies the
 * `Record<string, string>` the warm-up registry logs without the caller having to widen it — while
 * still naming every key, which a bare Record would not.
 */
export type QaWarmupDescriptors = {
  answerCache: string;
  budget: string;
  sessionMemory: string;
  repoMemory: string;
  retrieval: string;
  providers: string;
};

export async function warmQaDependencies(): Promise<QaWarmupDescriptors> {
  const redis = await getSharedRedis();
  const shared = redis ? "redis (shared)" : isSharedRedisEnabled() ? "in-memory (redis unavailable)" : "in-memory";

  // These four share one memoized Redis handle, so resolving them is one connection, not four.
  await Promise.all([resolveAnswerCache(), resolveBudget(), resolveSessionStore(), resolveRepoStore()]);

  const chatClient = createLlmClientFromEnv(process.env);
  const embeddingClient = createEmbeddingClientFromEnv(process.env);
  const providers =
    chatClient && embeddingClient
      ? `${chatClient.provider}/${chatClient.model} + ${embeddingClient.provider}/${embeddingClient.model}`
      : "not configured (Q&A is unavailable; the deterministic read paths are not affected)";

  // The expensive one. Only resolvable once the embedding space is known, which is why it could
  // not be warmed at boot before the client was constructed here.
  let retrieval: string;
  if (!embeddingClient) {
    retrieval = "skipped (no embedding provider configured, so there is no embedding space to open)";
  } else {
    try {
      const stores = await resolveRetrieval({
        embeddingModel: embeddingClient.model,
        embeddingDim: embeddingClient.dimension,
      });
      retrieval = stores.degradation ? `${stores.vectorStore.id} — DEGRADED: ${stores.degradation}` : stores.vectorStore.id;
    } catch (error) {
      // Recorded, not thrown: the API answers deterministic reads without an index, and taking the
      // process out over an unreachable Postgres would cost far more than it protects.
      retrieval = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return { answerCache: shared, budget: shared, sessionMemory: shared, repoMemory: shared, retrieval, providers };
}

/** True when BOTH a chat and an embedding provider are configured, i.e. the Q&A path can run. */
export function isQaConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(createLlmClientFromEnv(env) && createEmbeddingClientFromEnv(env));
}
