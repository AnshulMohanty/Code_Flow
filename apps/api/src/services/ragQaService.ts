import {
  answerQuestion,
  createEmbeddingClientFromEnv,
  createInMemoryBudgetHandle,
  createLlmClientFromEnv,
  createRedisBudgetHandle,
  type RagAnswer,
} from "@codeflow/analyzers";
import { RAG_TOP_K } from "@codeflow/config";
import { createRetrievalStores, type RetrievalStores } from "@codeflow/retrieval";
import type { AnalysisCacheHandle, AnalysisResult, BudgetHandle } from "@codeflow/shared-types";
import { env } from "../config/env.js";
import { getSharedRedis, isSharedRedisEnabled } from "../queues/redisClient.js";

/** Answers a question against a stored analysis' RAG index. Injectable so tests supply a mock
 *  (with mock chat/embedding clients) and the suite makes zero real calls. */
export type AskHandler = (input: { result: AnalysisResult; question: string }) => Promise<RagAnswer>;

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
 * Production ask handler: build the chat + embedding clients from env (same provider selection
 * as the worker), then `answerQuestion` against the stored index. The embedding-space
 * homogeneity guard inside `answerQuestion` throws if the configured client can't match the
 * index — fail loud. Integration-only (needs real keys); the hermetic suite injects a mock.
 */
function createProductionAskHandler(): AskHandler {
  const cache = createInMemoryCache();
  return async ({ result, question }) => {
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
  };
}
