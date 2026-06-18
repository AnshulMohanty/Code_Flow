import { describe, expect, it } from "vitest";
import type { AnalysisCacheHandle, BudgetHandle, Rag } from "@codeflow/shared-types";
import { answerQuestion } from "../rag/answer.js";
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

function ragIndex(): Rag {
  return {
    embeddingModel: "mock-embed",
    embeddingDim: 3,
    chunkCount: 2,
    chunks: [
      { id: "src/auth.ts#1-10", fileId: "src/auth.ts", startLine: 1, endLine: 10, text: "export class AuthService {}", embedding: [1, 0, 0], tokenCount: 6 },
      { id: "src/db.ts#1-8", fileId: "src/db.ts", startLine: 1, endLine: 8, text: "export function connectDb() {}", embedding: [0, 1, 0], tokenCount: 6 },
    ],
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
      return req.texts.map((t) => QUERY_VECTORS[t] ?? new Array(dim).fill(0));
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
      return response ?? JSON.stringify({ answer: "Auth uses tokens.", answered: true, citations: [{ chunkId: "src/auth.ts#1-10" }] });
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
  return { checks, records, async check(n) { checks.push(n); return allow; }, async record(n) { records.push(n); } };
}

describe("answerQuestion — retrieval + prompt isolation", () => {
  it("retrieves the right chunk and feeds ONLY retrieved chunks to the prompt (no leakage)", async () => {
    const chat = mockChat();
    await answerQuestion({ question: "how does auth work?", ragIndex: ragIndex(), chatClient: chat, embeddingClient: mockEmbed(), cache: memCache(), k: 1 });

    const prompt = chat.calls[0].prompt;
    expect(prompt).toContain("export class AuthService"); // retrieved auth chunk
    expect(prompt).not.toContain("connectDb"); // db chunk NOT retrieved ⇒ never in the prompt
  });
});

describe("answerQuestion — grounding", () => {
  it("drops an ungrounded citation (records it) and keeps the grounded one", async () => {
    const chat = mockChat(JSON.stringify({ answer: "Auth uses tokens.", answered: true, citations: [{ chunkId: "src/auth.ts#1-10" }, { chunkId: "ghost#1-1" }] }));
    const result = await answerQuestion({ question: "how does auth work?", ragIndex: ragIndex(), chatClient: chat, embeddingClient: mockEmbed(), cache: memCache(), k: 2 });

    expect(result.answered).toBe(true);
    expect(result.citations).toEqual([{ fileId: "src/auth.ts", startLine: 1, endLine: 10 }]);
    expect(result.droppedCitations).toEqual({ count: 1, ids: ["ghost#1-1"] });
  });
});

describe("answerQuestion — honest no-answer (never fabricate)", () => {
  it("below the similarity floor ⇒ answered:false and NO LLM call", async () => {
    const chat = mockChat(undefined, { throwIfCalled: true });
    const result = await answerQuestion({ question: "what is xyzzy?", ragIndex: ragIndex(), chatClient: chat, embeddingClient: mockEmbed(), cache: memCache() });

    expect(result.answered).toBe(false);
    expect(result.answer).toMatch(/couldn't find/i);
    expect(chat.calls).toHaveLength(0); // never called the answer model
  });

  it("empty index ⇒ answered:false and NO LLM call", async () => {
    const chat = mockChat(undefined, { throwIfCalled: true });
    const empty: Rag = { embeddingModel: "mock-embed", embeddingDim: 3, chunkCount: 0, chunks: [] };
    const result = await answerQuestion({ question: "how does auth work?", ragIndex: empty, chatClient: chat, embeddingClient: mockEmbed(), cache: memCache() });
    expect(result.answered).toBe(false);
    expect(chat.calls).toHaveLength(0);
  });

  it("an LLM that returns answered:false is surfaced honestly", async () => {
    const chat = mockChat(JSON.stringify({ answer: "Not in the provided code.", answered: false, citations: [] }));
    const result = await answerQuestion({ question: "how does auth work?", ragIndex: ragIndex(), chatClient: chat, embeddingClient: mockEmbed(), cache: memCache() });
    expect(result.answered).toBe(false);
    expect(result.citations).toEqual([]);
  });
});

describe("answerQuestion — homogeneity guard", () => {
  it("throws when the embedding client's dim ≠ the index's", async () => {
    await expect(
      answerQuestion({ question: "how does auth work?", ragIndex: ragIndex(), chatClient: mockChat(), embeddingClient: mockEmbed(8), cache: memCache() }),
    ).rejects.toThrow(/does not match/);
  });
});

describe("answerQuestion — cache-before-budget", () => {
  it("answer-cache hit ⇒ zero LLM + budget untouched; miss ⇒ check then record", async () => {
    const cache = memCache();
    // Cold miss: a budget that allows; assert check + record happen and the LLM is called.
    const budget1 = spyBudget(true);
    const chat1 = mockChat();
    await answerQuestion({ question: "how does auth work?", ragIndex: ragIndex(), chatClient: chat1, embeddingClient: mockEmbed(), cache, budget: budget1, commitSha: "sha-1" });
    expect(chat1.calls).toHaveLength(1);
    expect(budget1.records.length).toBeGreaterThan(0);

    // Warm hit: same question + cache ⇒ qa-cache + embed-cache hit ⇒ no LLM, budget never touched.
    const budget2 = spyBudget(false);
    const chat2 = mockChat(undefined, { throwIfCalled: true });
    const result = await answerQuestion({ question: "how does auth work?", ragIndex: ragIndex(), chatClient: chat2, embeddingClient: mockEmbed(), cache, budget: budget2, commitSha: "sha-1" });
    expect(chat2.calls).toHaveLength(0);
    expect(budget2.checks).toHaveLength(0);
    expect(budget2.records).toHaveLength(0);
    expect(result.answered).toBe(true);
  });

  it("over budget ⇒ throws budget-exhausted, no LLM call", async () => {
    const chat = mockChat(undefined, { throwIfCalled: true });
    // Budget denies; the query embed is the first guarded call ⇒ throws before answering.
    await expect(
      answerQuestion({ question: "how does auth work?", ragIndex: ragIndex(), chatClient: chat, embeddingClient: mockEmbed(), cache: memCache(), budget: spyBudget(false) }),
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
