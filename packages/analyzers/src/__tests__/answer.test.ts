import { describe, expect, it } from "vitest";
import {
  createMemoryChunkTextStore,
  createMemoryVectorStore,
  type ChunkTextStore,
  type VectorStore,
} from "@codeflow/retrieval";
import type { AnalysisCacheHandle, BudgetHandle, Rag, RagChunk } from "@codeflow/shared-types";
import { answerQuestion } from "../rag/answer.js";
import { tokensOf } from "../budget/budgetHandle.js";
import { embedCacheKey } from "../rag/embedCache.js";
import type { LlmClient, LlmCompletionRequest } from "../llm/llmClient.js";
import type { EmbeddingClient, EmbeddingRequest } from "../embedding/embeddingClient.js";

// Deterministic mock embeddings: a question maps to an authored query vector (so retrieval is
// known by construction); unknown text → a far vector (low similarity → no-answer).
const QUERY_VECTORS: Record<string, number[]> = {
  "how does auth work?": [0.95, 0.05, 0],
  "where is the db?": [0.05, 0.95, 0],
  "what is xyzzy?": [0, 0, 1], // orthogonal to both chunks → below the similarity floor
};

// V3-P2: the index slice is METADATA; the text + vectors live in the stores. The fixture
// therefore has two halves, and keeping them separate here is the point — a test that could
// still read a vector off `rag.chunks` would not be testing the current query path.
const SPACE = { embeddingModel: "mock-embed", embeddingDim: 3 };
const NAMESPACE = "acme-repo@sha1/mock-embed/3";
/** A namespace nothing was ever written to — the "empty index" case. */
const EMPTY_NAMESPACE = "acme-repo@empty/mock-embed/3";

const CHUNK_META: RagChunk[] = [
  { id: "src/auth.ts#1-10", fileId: "src/auth.ts", startLine: 1, endLine: 10, tokenCount: 6 },
  { id: "src/db.ts#1-8", fileId: "src/db.ts", startLine: 1, endLine: 8, tokenCount: 6 },
];
const CHUNK_TEXT: Record<string, string> = {
  "src/auth.ts#1-10": "export class AuthService {}",
  "src/db.ts#1-8": "export function connectDb() {}",
};
const CHUNK_VECTOR: Record<string, number[]> = {
  "src/auth.ts#1-10": [1, 0, 0],
  "src/db.ts#1-8": [0, 1, 0],
};

// Top-level await: the stores must be POPULATED before any `describe` body runs, and a
// `beforeAll` would fire after collection (the trap V3-P1 hit with tree-sitter init).
const vectorStore: VectorStore = createMemoryVectorStore(SPACE);
const textStore: ChunkTextStore = createMemoryChunkTextStore();
await textStore.put(
  NAMESPACE,
  CHUNK_META.map((chunk) => ({ id: chunk.id, text: CHUNK_TEXT[chunk.id] })),
);
await vectorStore.upsert(
  NAMESPACE,
  CHUNK_META.map((chunk) => ({
    id: chunk.id,
    vector: CHUNK_VECTOR[chunk.id],
    fileId: chunk.fileId,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  })),
);

function ragIndex(): Rag {
  return {
    ...SPACE,
    chunkCount: CHUNK_META.length,
    chunks: CHUNK_META,
    store: { namespace: NAMESPACE, vectorStoreId: vectorStore.id, textStoreId: textStore.id },
  };
}

interface MockEmbed extends EmbeddingClient {
  calls: EmbeddingRequest[];
}
function mockEmbed(dim = 3): MockEmbed {
  const calls: EmbeddingRequest[] = [];
  return {
    provider: "voyage",
    model: "mock-embed",
    dimension: dim,
    calls,
    async embed(req) {
      calls.push(req);
      return {
        vectors: req.texts.map((t) => QUERY_VECTORS[t] ?? new Array(dim).fill(0)),
        // Mocks report MEASURED usage so the budget assertions exercise the real path.
        usage: { inputTokens: 7, outputTokens: 0, measured: true },
      };
    },
  };
}

interface MockChat extends LlmClient {
  calls: LlmCompletionRequest[];
}
function mockChat(response?: string, opts: { throwIfCalled?: boolean } = {}): MockChat {
  const calls: LlmCompletionRequest[] = [];
  return {
    provider: "anthropic",
    model: "mock-chat",
    calls,
    async complete(req) {
      calls.push(req);
      if (opts.throwIfCalled) throw new Error("LLM must not be called");
      const text =
        response ?? JSON.stringify({ answer: "Auth uses tokens.", answered: true, citations: [{ chunkId: "src/auth.ts#1-10" }] });
      return { text, usage: { inputTokens: 100, outputTokens: 20, measured: true } };
    },
  };
}

function memCache(): AnalysisCacheHandle {
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

interface SpyBudget extends BudgetHandle {
  checks: number[];
  records: number[];
}
function spyBudget(allow: boolean): SpyBudget {
  const checks: number[] = [];
  const records: number[] = [];
  return {
    checks,
    records,
    async check(n) {
      checks.push(n);
      return allow;
    },
    // `record` now takes a number OR a TokenUsage — normalize so assertions stay simple.
    async record(actual) {
      records.push(tokensOf(actual));
    },
  };
}

describe("answerQuestion — retrieval + prompt isolation", () => {
  it("retrieves the right chunk and feeds ONLY retrieved chunks to the prompt (no leakage)", async () => {
    const chat = mockChat();
    await answerQuestion({ question: "how does auth work?", ragIndex: ragIndex(), vectorStore, textStore, chatClient: chat, embeddingClient: mockEmbed(), cache: memCache(), k: 1 });

    const prompt = chat.calls[0].prompt;
    expect(prompt).toContain("export class AuthService"); // retrieved auth chunk
    expect(prompt).not.toContain("connectDb"); // db chunk NOT retrieved ⇒ never in the prompt
  });
});

describe("answerQuestion — grounding", () => {
  it("drops an ungrounded citation (records it) and keeps the grounded one", async () => {
    const chat = mockChat(JSON.stringify({ answer: "Auth uses tokens.", answered: true, citations: [{ chunkId: "src/auth.ts#1-10" }, { chunkId: "ghost#1-1" }] }));
    const result = await answerQuestion({ question: "how does auth work?", ragIndex: ragIndex(), vectorStore, textStore, chatClient: chat, embeddingClient: mockEmbed(), cache: memCache(), k: 2 });

    expect(result.answered).toBe(true);
    expect(result.citations).toEqual([{ fileId: "src/auth.ts", startLine: 1, endLine: 10 }]);
    expect(result.droppedCitations).toEqual({ count: 1, ids: ["ghost#1-1"] });
  });
});

describe("answerQuestion — honest no-answer (never fabricate)", () => {
  it("below the similarity floor ⇒ answered:false and NO LLM call", async () => {
    const chat = mockChat(undefined, { throwIfCalled: true });
    const result = await answerQuestion({ question: "what is xyzzy?", ragIndex: ragIndex(), vectorStore, textStore, chatClient: chat, embeddingClient: mockEmbed(), cache: memCache() });

    expect(result.answered).toBe(false);
    expect(result.answer).toMatch(/couldn't find/i);
    expect(chat.calls).toHaveLength(0); // never called the answer model
  });

  it("empty index ⇒ answered:false and NO LLM call", async () => {
    const chat = mockChat(undefined, { throwIfCalled: true });
    const empty: Rag = {
      ...SPACE,
      chunkCount: 0,
      chunks: [],
      store: { namespace: EMPTY_NAMESPACE, vectorStoreId: vectorStore.id, textStoreId: textStore.id },
    };
    const result = await answerQuestion({ question: "how does auth work?", ragIndex: empty, vectorStore, textStore, chatClient: chat, embeddingClient: mockEmbed(), cache: memCache() });
    expect(result.answered).toBe(false);
    expect(chat.calls).toHaveLength(0);
  });

  it("an LLM that returns answered:false is surfaced honestly", async () => {
    const chat = mockChat(JSON.stringify({ answer: "Not in the provided code.", answered: false, citations: [] }));
    const result = await answerQuestion({ question: "how does auth work?", ragIndex: ragIndex(), vectorStore, textStore, chatClient: chat, embeddingClient: mockEmbed(), cache: memCache() });
    expect(result.answered).toBe(false);
    expect(result.citations).toEqual([]);
  });
});

describe("answerQuestion — hybrid retrieval (V3-P2)", () => {
  it("attaches the per-stage retrieval trace to an answer", async () => {
    const result = await answerQuestion({
      question: "how does auth work?",
      ragIndex: ragIndex(),
      vectorStore,
      textStore,
      chatClient: mockChat(),
      embeddingClient: mockEmbed(),
      cache: memCache(),
      k: 2,
    });
    expect(result.retrieval?.refused).toBe(false);
    expect(result.retrieval?.vectorHits).toBeGreaterThan(0);
    // The default reranker is the deterministic one — keyless and in-process (see the probe in
    // @codeflow/retrieval's reranker.ts for why no ONNX cross-encoder ships).
    expect(result.retrieval?.rerankerId).toBe("lexical-overlap");
  });

  it("attaches the trace to a REFUSAL too — the case you most want it for", async () => {
    const chat = mockChat(undefined, { throwIfCalled: true });
    const result = await answerQuestion({
      question: "what is xyzzy?",
      ragIndex: ragIndex(),
      vectorStore,
      textStore,
      chatClient: chat,
      embeddingClient: mockEmbed(),
      cache: memCache(),
    });
    expect(result.answered).toBe(false);
    expect(result.retrieval?.refused).toBe(true);
    // Refusing still costs exactly one vector search: no lexical arm, no rerank, no LLM.
    expect(result.retrieval?.lexicalHits).toBe(0);
    expect(chat.calls).toHaveLength(0);
  });

  it("still refuses below the floor even though the LEXICAL arm would have matched", async () => {
    // Worth pinning: the lexical arm could easily have been allowed to rescue a below-floor
    // query, which would silently delete the honest-no-answer behaviour. The floor is the
    // vector arm's cosine, full stop.
    const chat = mockChat(undefined, { throwIfCalled: true });
    const result = await answerQuestion({
      // "AuthService" appears verbatim in a chunk, so BM25 would score it highly — but the
      // authored query vector for this question is orthogonal to the whole index.
      question: "what is xyzzy?",
      ragIndex: ragIndex(),
      vectorStore,
      textStore,
      chatClient: chat,
      embeddingClient: mockEmbed(),
      cache: memCache(),
    });
    expect(result.answered).toBe(false);
    expect(chat.calls).toHaveLength(0);
  });
});

describe("answerQuestion — a pre-V3-P2 index is refused, not silently answered", () => {
  it("throws with a rebuild instruction when ai.rag has no `store` reference", async () => {
    // Before P2 the vectors were inline in this slice. Such an index is not "empty", it is
    // UNREADABLE, and answering from zero retrieved chunks would look like an honest refusal
    // while actually being a broken index nobody noticed.
    const legacy: Rag = { ...SPACE, chunkCount: 2, chunks: CHUNK_META };
    const chat = mockChat(undefined, { throwIfCalled: true });
    await expect(
      answerQuestion({
        question: "how does auth work?",
        ragIndex: legacy,
        vectorStore,
        textStore,
        chatClient: chat,
        embeddingClient: mockEmbed(),
        cache: memCache(),
      }),
    ).rejects.toThrow(/pre-V3-P2|Re-analyse/i);
    expect(chat.calls).toHaveLength(0);
  });
});

describe("answerQuestion — homogeneity guard", () => {
  it("throws when the embedding client's dim ≠ the index's", async () => {
    await expect(
      answerQuestion({ question: "how does auth work?", ragIndex: ragIndex(), vectorStore, textStore, chatClient: mockChat(), embeddingClient: mockEmbed(8), cache: memCache() }),
    ).rejects.toThrow(/does not match/);
  });

  it("throws when the STORE is in a different space than the client (a misconfigured deploy)", async () => {
    // Distinct from the check above: the index slice agrees with the client, but the store the
    // deployment actually points at holds 8-dim vectors. Cosine would still return a number.
    const wrongStore = createMemoryVectorStore({ embeddingModel: "mock-embed", embeddingDim: 8 });
    await expect(
      answerQuestion({
        question: "how does auth work?",
        ragIndex: ragIndex(),
        vectorStore: wrongStore,
        textStore,
        chatClient: mockChat(),
        embeddingClient: mockEmbed(),
        cache: memCache(),
      }),
    ).rejects.toThrow(/vector store/);
  });
});

describe("answerQuestion — cache-before-budget", () => {
  it("answer-cache hit ⇒ zero LLM + budget untouched; miss ⇒ check then record", async () => {
    const cache = memCache();
    // Cold miss: a budget that allows; assert check + record happen and the LLM is called.
    const budget1 = spyBudget(true);
    const chat1 = mockChat();
    await answerQuestion({ question: "how does auth work?", ragIndex: ragIndex(), vectorStore, textStore, chatClient: chat1, embeddingClient: mockEmbed(), cache, budget: budget1, commitSha: "sha-1" });
    expect(chat1.calls).toHaveLength(1);
    expect(budget1.records.length).toBeGreaterThan(0);

    // Warm hit: same question + cache ⇒ qa-cache + embed-cache hit ⇒ no LLM, budget never touched.
    const budget2 = spyBudget(false);
    const chat2 = mockChat(undefined, { throwIfCalled: true });
    const result = await answerQuestion({ question: "how does auth work?", ragIndex: ragIndex(), vectorStore, textStore, chatClient: chat2, embeddingClient: mockEmbed(), cache, budget: budget2, commitSha: "sha-1" });
    expect(chat2.calls).toHaveLength(0);
    expect(budget2.checks).toHaveLength(0);
    expect(budget2.records).toHaveLength(0);
    expect(result.answered).toBe(true);
  });

  it("over budget ⇒ throws budget-exhausted, no LLM call", async () => {
    const chat = mockChat(undefined, { throwIfCalled: true });
    // Budget denies; the query embed is the first guarded call ⇒ throws before answering.
    await expect(
      answerQuestion({ question: "how does auth work?", ragIndex: ragIndex(), vectorStore, textStore, chatClient: chat, embeddingClient: mockEmbed(), cache: memCache(), budget: spyBudget(false) }),
    ).rejects.toThrow(/capacity|budget/i);
    expect(chat.calls).toHaveLength(0);
  });
});

describe("embedCacheKey — input_type scoping (no query/document collision)", () => {
  it("the same text under query vs document yields different keys", () => {
    const q = embedCacheKey("voyage", "voyage-code-3", 1024, "query", "same text");
    const d = embedCacheKey("voyage", "voyage-code-3", 1024, "document", "same text");
    expect(q).not.toBe(d);
    expect(q).toContain("/query/");
    expect(d).toContain("/document/");
  });
});
