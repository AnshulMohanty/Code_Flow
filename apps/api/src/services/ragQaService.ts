import {
  answerQuestion,
  createEmbeddingClientFromEnv,
  createInMemoryBudgetHandle,
  createLlmClientFromEnv,
  type RagAnswer,
} from "@codeflow/analyzers";
import { RAG_TOP_K } from "@codeflow/config";
import type { AnalysisCacheHandle, AnalysisResult, BudgetHandle } from "@codeflow/shared-types";

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

// In-process caches for the query path. The answer cache + the per-UTC-day budget are
// per-process here; sharing them with the worker (Mongo/Redis) is a P7 wiring task (ledger).
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
  const budget: BudgetHandle = createInMemoryBudgetHandle();
  return async ({ result, question }) => {
    const ragIndex = result.ai?.rag;
    if (!ragIndex) {
      throw new Error("This analysis has no Q&A index.");
    }
    const chatClient = createLlmClientFromEnv(process.env);
    const embeddingClient = createEmbeddingClientFromEnv(process.env);
    if (!chatClient || !embeddingClient) {
      throw new Error("Q&A requires both a chat and an embedding provider to be configured.");
    }
    return answerQuestion({
      question,
      ragIndex,
      chatClient,
      embeddingClient,
      cache,
      budget,
      commitSha: result.commitSha,
      k: RAG_TOP_K,
    });
  };
}
