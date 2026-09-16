import { afterEach, describe, expect, it, vi } from "vitest";
import { vectorTableName } from "@codeflow/retrieval";
import {
  createAnthropicClient,
  createGeminiClient,
  createGeminiEmbeddingClient,
  createOpenAiClient,
  createOpenAiEmbeddingClient,
  createVoyageClient,
  createEmbeddingClientFromEnv,
  createLlmClientFromEnv,
  resolveChatProvider,
  resolveEmbeddingDimension,
  resolveEmbeddingProvider,
  type ProviderEnv,
} from "../index.js";

// --- fetch mocking ----------------------------------------------------------

interface Captured {
  url: string;
  init: RequestInit;
}

/** Stub global fetch with a JSON responder; returns the captured calls. */
function stubFetch(json: unknown, ok = true, status = 200): Captured[] {
  const captured: Captured[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    captured.push({ url, init });
    return {
      ok,
      status,
      async json() {
        return json;
      },
      async text() {
        return typeof json === "string" ? json : JSON.stringify(json);
      },
    } as unknown as Response;
  });
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function body(c: Captured): Record<string, unknown> {
  return JSON.parse(c.init.body as string);
}

// --- Chat provider selection ------------------------------------------------

describe("resolveChatProvider", () => {
  it("explicit LLM_PROVIDER wins", () => {
    expect(resolveChatProvider({ LLM_PROVIDER: "gemini", ANTHROPIC_API_KEY: "a" })).toBe("gemini");
    expect(resolveChatProvider({ LLM_PROVIDER: "anthropic", GEMINI_API_KEY: "g" })).toBe("anthropic");
  });
  it("infers from the single present key", () => {
    expect(resolveChatProvider({ GEMINI_API_KEY: "g" })).toBe("gemini");
    expect(resolveChatProvider({ ANTHROPIC_API_KEY: "a" })).toBe("anthropic");
  });
  it("throws when both keys set and no explicit provider", () => {
    expect(() => resolveChatProvider({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" })).toThrow(/LLM_PROVIDER/);
  });
  it("throws on an invalid LLM_PROVIDER, and the message lists every valid one", () => {
    // "openai" used to be this test's example of an unsupported value. It is supported now, so the
    // example moved rather than the assertion: an unknown provider must still name the whole set.
    expect(() => resolveChatProvider({ LLM_PROVIDER: "cohere" })).toThrow(/anthropic.*gemini.*openai/);
  });
  it("returns null when no key at all", () => {
    expect(resolveChatProvider({})).toBeNull();
  });
});

describe("createLlmClientFromEnv", () => {
  it("LLM_PROVIDER=gemini → Gemini client with the default model", () => {
    const client = createLlmClientFromEnv({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "g" });
    expect(client?.provider).toBe("gemini");
    expect(client?.model).toBe("gemini-2.5-flash");
  });
  it("inferred anthropic uses SYNTHESIS_MODEL override", () => {
    const client = createLlmClientFromEnv({ ANTHROPIC_API_KEY: "a", SYNTHESIS_MODEL: "claude-x" });
    expect(client?.provider).toBe("anthropic");
    expect(client?.model).toBe("claude-x");
  });
  it("selected provider's key absent → undefined (stage not registered)", () => {
    expect(createLlmClientFromEnv({ LLM_PROVIDER: "gemini", ANTHROPIC_API_KEY: "a" })).toBeUndefined();
  });
  it("no key → undefined", () => {
    expect(createLlmClientFromEnv({})).toBeUndefined();
  });
});

// --- Embedding provider selection -------------------------------------------

describe("resolveEmbeddingProvider", () => {
  it("explicit EMBEDDING_PROVIDER wins; infers single key; both → throw", () => {
    expect(resolveEmbeddingProvider({ EMBEDDING_PROVIDER: "gemini", VOYAGE_API_KEY: "v" })).toBe("gemini");
    expect(resolveEmbeddingProvider({ VOYAGE_API_KEY: "v" })).toBe("voyage");
    expect(resolveEmbeddingProvider({ GEMINI_API_KEY: "g" })).toBe("gemini");
    expect(() => resolveEmbeddingProvider({ VOYAGE_API_KEY: "v", GEMINI_API_KEY: "g" })).toThrow(/EMBEDDING_PROVIDER/);
    expect(() => resolveEmbeddingProvider({ EMBEDDING_PROVIDER: "cohere" })).toThrow(/voyage.*gemini.*openai/);
    expect(resolveEmbeddingProvider({})).toBeNull();
  });
});

describe("createEmbeddingClientFromEnv", () => {
  it("gemini-only setup → Gemini embeddings client at the default dim 768", () => {
    const client = createEmbeddingClientFromEnv({ GEMINI_API_KEY: "g" });
    expect(client?.provider).toBe("gemini");
    expect(client?.model).toBe("gemini-embedding-001");
    expect(client?.dimension).toBe(768);
  });
  it("GEMINI_EMBEDDING_DIM override is honored", () => {
    const client = createEmbeddingClientFromEnv({ GEMINI_API_KEY: "g", GEMINI_EMBEDDING_DIM: "1536" });
    expect(client?.dimension).toBe(1536);
  });
  it("voyage inference → voyage-code-3 / dim 1024", () => {
    const client = createEmbeddingClientFromEnv({ VOYAGE_API_KEY: "v" });
    expect(client?.provider).toBe("voyage");
    expect(client?.dimension).toBe(1024);
  });
  it("a single GEMINI_API_KEY powers BOTH chat and embeddings", () => {
    const env: ProviderEnv = { GEMINI_API_KEY: "g" };
    expect(createLlmClientFromEnv(env)?.provider).toBe("gemini");
    expect(createEmbeddingClientFromEnv(env)?.provider).toBe("gemini");
  });
});

// --- Adapter conformance + happy path (mocked fetch) ------------------------

describe("chat adapters conform to LlmClient", () => {
  it("Anthropic: returns text content + MEASURED usage; provider tagged", async () => {
    const captured = stubFetch({
      content: [{ type: "text", text: "hello-anthropic" }],
      usage: { input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 },
    });
    const client = createAnthropicClient({ apiKey: "a", model: "claude-x" });
    expect(client.provider).toBe("anthropic");
    const result = await client.complete({ prompt: "p" });
    expect(result.text).toBe("hello-anthropic");
    // V3-P0: real provider usage, not a chars/4 guess.
    expect(result.usage).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      measured: true,
      cacheReadTokens: 100,
      cacheWriteTokens: 7,
    });
    expect(captured[0].url).toContain("/v1/messages");
  });

  it("Anthropic: a cachePrefix becomes a cache_control breakpoint on the system blocks", async () => {
    const captured = stubFetch({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const client = createAnthropicClient({ apiKey: "a", model: "claude-x" });
    await client.complete({ cachePrefix: "STABLE", system: "volatile", prompt: "p" });
    expect(body(captured[0]).system).toEqual([
      { type: "text", text: "STABLE", cache_control: { type: "ephemeral" } },
      { type: "text", text: "volatile" },
    ]);
  });

  it("Anthropic: without a cachePrefix the system field stays a plain string (no behaviour change)", async () => {
    const captured = stubFetch({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const client = createAnthropicClient({ apiKey: "a", model: "claude-x" });
    await client.complete({ system: "be terse", prompt: "p" });
    expect(body(captured[0]).system).toBe("be terse");
  });

  it("Anthropic: a missing usage counter falls back to an ESTIMATE, flagged measured:false", async () => {
    // A silent 0-token record would under-charge the wallet; an explicit estimate is honest.
    stubFetch({ content: [{ type: "text", text: "hello" }] });
    const client = createAnthropicClient({ apiKey: "a", model: "claude-x" });
    const result = await client.complete({ prompt: "some prompt text" });
    expect(result.usage.measured).toBe(false);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it("Gemini: returns candidates text; temp 0 + json mime + systemInstruction; x-goog-api-key", async () => {
    const captured = stubFetch({
      candidates: [{ content: { parts: [{ text: "hello-gemini" }] } }],
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30, cachedContentTokenCount: 150 },
    });
    const client = createGeminiClient({ apiKey: "g", model: "gemini-2.5-flash" });
    expect(client.provider).toBe("gemini");
    const result = await client.complete({ system: "be terse", prompt: "p", temperature: 0 });
    expect(result.text).toBe("hello-gemini");
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 30, measured: true, cacheReadTokens: 150 });

    const c = captured[0];
    expect(c.url).toContain("/v1beta/models/gemini-2.5-flash:generateContent");
    expect((c.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g");
    const b = body(c);
    const gen = b.generationConfig as Record<string, unknown>;
    expect(gen.temperature).toBe(0); // determinism preserved
    expect(gen.responseMimeType).toBe("application/json");
    expect(b.systemInstruction).toEqual({ parts: [{ text: "be terse" }] });
    expect(b.contents).toEqual([{ parts: [{ text: "p" }] }]);
  });

  it("Gemini: a cachePrefix LEADS the systemInstruction (implicit caching needs a stable prefix)", async () => {
    const captured = stubFetch({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
      usageMetadata: { promptTokenCount: 1 },
    });
    const client = createGeminiClient({ apiKey: "g" });
    await client.complete({ cachePrefix: "STABLE", system: "volatile", prompt: "p" });
    expect(body(captured[0]).systemInstruction).toEqual({ parts: [{ text: "STABLE" }, { text: "volatile" }] });
  });
});

describe("embedding adapters conform to EmbeddingClient", () => {
  it("Voyage: returns embeddings ordered by index + MEASURED usage; provider tagged", async () => {
    const captured = stubFetch({
      data: [{ embedding: [9, 9], index: 1 }, { embedding: [1, 1], index: 0 }],
      usage: { total_tokens: 88 },
    });
    const client = createVoyageClient({ apiKey: "v", model: "voyage-code-3" });
    expect(client.provider).toBe("voyage");
    const { vectors, usage } = await client.embed({ texts: ["x", "y"], inputType: "document" });
    expect(vectors).toEqual([[1, 1], [9, 9]]); // reordered by index
    // Voyage reports total_tokens; embeddings have no output tokens.
    expect(usage).toEqual({ inputTokens: 88, outputTokens: 0, measured: true });
    expect(captured[0].url).toContain("/v1/embeddings");
  });

  it("Voyage: an empty input costs nothing and makes no call", async () => {
    const captured = stubFetch({});
    const client = createVoyageClient({ apiKey: "v" });
    const result = await client.embed({ texts: [], inputType: "document" });
    expect(result).toEqual({ vectors: [], usage: { inputTokens: 0, outputTokens: 0, measured: true } });
    expect(captured).toHaveLength(0);
  });

  it("Gemini: returns embeddings[].values; RETRIEVAL_DOCUMENT + outputDimensionality", async () => {
    const captured = stubFetch({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] });
    const client = createGeminiEmbeddingClient({ apiKey: "g", dimension: 2 });
    expect(client.provider).toBe("gemini");
    const { vectors, usage } = await client.embed({ texts: ["x", "y"], inputType: "document" });
    expect(vectors).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    // HONEST GAP: the Gemini batch-embed endpoint reports no usage, so this is an ESTIMATE
    // and says so via measured:false — never passed off as a provider number.
    expect(usage.measured).toBe(false);
    expect(usage.inputTokens).toBeGreaterThan(0);

    const c = captured[0];
    expect(c.url).toContain(":batchEmbedContents");
    expect((c.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g");
    const reqs = (body(c).requests as Array<Record<string, unknown>>);
    expect(reqs[0].taskType).toBe("RETRIEVAL_DOCUMENT");
    expect(reqs[0].outputDimensionality).toBe(2);
    expect(reqs[0].model).toBe("models/gemini-embedding-001");
  });

  it("Gemini: re-chunks under its per-request batch cap (>100 texts → multiple calls)", async () => {
    const big = Array.from({ length: 150 }, (_, i) => `t${i}`);
    // Responder must echo a values array per requested text; build from the request body.
    const captured: Captured[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      captured.push({ url, init });
      const reqs = JSON.parse(init.body as string).requests as unknown[];
      return { ok: true, status: 200, async json() { return { embeddings: reqs.map(() => ({ values: [0] })) }; }, async text() { return ""; } } as unknown as Response;
    });
    const client = createGeminiEmbeddingClient({ apiKey: "g", dimension: 1 });
    const { vectors, usage } = await client.embed({ texts: big, inputType: "document" });
    expect(vectors).toHaveLength(150);
    expect(captured).toHaveLength(2); // 100 + 50
    // Usage is summed across batches; one estimated batch makes the whole total an estimate.
    expect(usage.measured).toBe(false);
  });

  it("Gemini: reports MEASURED usage if the endpoint ever starts sending usageMetadata", async () => {
    // Read opportunistically, so the day Google adds it this becomes measured for free.
    stubFetch({ embeddings: [{ values: [1] }], usageMetadata: { totalTokenCount: 42 } });
    const client = createGeminiEmbeddingClient({ apiKey: "g", dimension: 1 });
    const { usage } = await client.embed({ texts: ["x"], inputType: "document" });
    expect(usage).toEqual({ inputTokens: 42, outputTokens: 0, measured: true });
  });
});

// --- OpenAI: selection, models, and the dimension that names the table ------

describe("OpenAI is a first-class provider for BOTH roles", () => {
  it("is selectable explicitly and inferable from OPENAI_API_KEY alone", () => {
    expect(resolveChatProvider({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "o" })).toBe("openai");
    expect(resolveChatProvider({ OPENAI_API_KEY: "o" })).toBe("openai");
    expect(resolveEmbeddingProvider({ EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "o" })).toBe("openai");
    expect(resolveEmbeddingProvider({ OPENAI_API_KEY: "o" })).toBe("openai");
  });

  it("one OPENAI_API_KEY powers chat AND embeddings, exactly like one GEMINI_API_KEY", () => {
    const env: ProviderEnv = { OPENAI_API_KEY: "o" };
    expect(createLlmClientFromEnv(env)?.provider).toBe("openai");
    expect(createEmbeddingClientFromEnv(env)?.provider).toBe("openai");
  });

  it("REFUSES to guess when a third key joins, and names all of them", () => {
    // The whole point of the ambiguity error: which vendor a deployment pays, and which embedding
    // space its index lives in, must never be decided by key-checking order.
    expect(() =>
      resolveChatProvider({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" }),
    ).toThrow(/ANTHROPIC_API_KEY and GEMINI_API_KEY and OPENAI_API_KEY.*LLM_PROVIDER/);
    expect(() => resolveEmbeddingProvider({ VOYAGE_API_KEY: "v", OPENAI_API_KEY: "o" })).toThrow(
      /VOYAGE_API_KEY and OPENAI_API_KEY.*EMBEDDING_PROVIDER/,
    );
  });

  it("the two roles are INDEPENDENT — OpenAI chat with Voyage embeddings is one env away", () => {
    const env: ProviderEnv = {
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "o",
      EMBEDDING_PROVIDER: "voyage",
      VOYAGE_API_KEY: "v",
    };
    expect(createLlmClientFromEnv(env)?.provider).toBe("openai");
    expect(createEmbeddingClientFromEnv(env)?.provider).toBe("voyage");
  });

  it("defaults to gpt-4.1 and honours OPENAI_MODEL", () => {
    expect(createLlmClientFromEnv({ OPENAI_API_KEY: "o" })?.model).toBe("gpt-4.1");
    expect(createLlmClientFromEnv({ OPENAI_API_KEY: "o", OPENAI_MODEL: "gpt-4.1-mini" })?.model).toBe("gpt-4.1-mini");
  });

  it("does NOT read SYNTHESIS_MODEL — a claude model id sent to OpenAI is a 404 that reads like an outage", () => {
    const client = createLlmClientFromEnv({ OPENAI_API_KEY: "o", SYNTHESIS_MODEL: "claude-opus-4-8" });
    expect(client?.provider).toBe("openai");
    expect(client?.model).toBe("gpt-4.1");
  });

  it("selected-but-keyless is undefined, not a crash (the stage is simply not registered)", () => {
    expect(createLlmClientFromEnv({ LLM_PROVIDER: "openai", GEMINI_API_KEY: "g" })).toBeUndefined();
    expect(createEmbeddingClientFromEnv({ EMBEDDING_PROVIDER: "openai", VOYAGE_API_KEY: "v" })).toBeUndefined();
  });
});

describe("the embedding dimension is derived from the model, and it names the pgvector table", () => {
  it("takes each OpenAI model's NATIVE width, not a constant", () => {
    expect(createEmbeddingClientFromEnv({ OPENAI_API_KEY: "o" })?.dimension).toBe(1536);
    expect(
      createEmbeddingClientFromEnv({ OPENAI_API_KEY: "o", OPENAI_EMBEDDING_MODEL: "text-embedding-3-large" })
        ?.dimension,
    ).toBe(3072);
  });

  it("OPENAI_EMBEDDING_DIM truncates, and a nonsense value is IGNORED rather than obeyed", () => {
    expect(
      createEmbeddingClientFromEnv({ OPENAI_API_KEY: "o", OPENAI_EMBEDDING_DIM: "512" })?.dimension,
    ).toBe(512);
    // "0" would become codeflow_vectors_0 and "abc" would become NaN — both are table names nothing
    // can ever read, so an unusable override falls back to the model's real width.
    for (const bad of ["0", "abc", "1.5", "", "-8"]) {
      expect(createEmbeddingClientFromEnv({ OPENAI_API_KEY: "o", OPENAI_EMBEDDING_DIM: bad })?.dimension).toBe(1536);
    }
  });

  it("A SWITCH CANNOT QUERY THE 768 TABLE WITH 1536-d VECTORS — every provider names its own", () => {
    // This is the property the whole provider swap rests on. `resolveEmbeddingDimension` answers
    // the width WITHOUT a client, and `vectorTableName` is the same function the pgvector store
    // uses, so what is asserted here is literally the table each configuration addresses.
    const cases: Array<[ProviderEnv, number, string]> = [
      [{ GEMINI_API_KEY: "g" }, 768, "codeflow_vectors_768"],
      [{ VOYAGE_API_KEY: "v" }, 1024, "codeflow_vectors_1024"],
      [{ OPENAI_API_KEY: "o" }, 1536, "codeflow_vectors_1536"],
      [{ OPENAI_API_KEY: "o", OPENAI_EMBEDDING_MODEL: "text-embedding-3-large" }, 3072, "codeflow_vectors_3072"],
      [{ GEMINI_API_KEY: "g", GEMINI_EMBEDDING_DIM: "3072" }, 3072, "codeflow_vectors_3072"],
    ];
    for (const [env, dim, table] of cases) {
      // The env-only answer and the built client's answer must agree: they are read by different
      // processes (the worker builds the index, the api queries it) and a disagreement between them
      // is exactly how a deployment ends up writing one table and reading another.
      expect(resolveEmbeddingDimension(env)).toBe(dim);
      expect(createEmbeddingClientFromEnv(env)?.dimension).toBe(dim);
      expect(vectorTableName("codeflow_vectors", dim)).toBe(table);
    }
    expect(resolveEmbeddingDimension({})).toBeNull();
  });
});

describe("the OpenAI chat adapter conforms to LlmClient", () => {
  it("returns choices[].message.content + MEASURED usage, with cached tokens read not assumed", async () => {
    const captured = stubFetch({
      choices: [{ message: { content: "hello-openai" } }],
      usage: { prompt_tokens: 300, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 256 } },
    });
    const client = createOpenAiClient({ apiKey: "o", model: "gpt-4.1" });
    expect(client.provider).toBe("openai");
    const result = await client.complete({ prompt: "p" });
    expect(result.text).toBe("hello-openai");
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 40, measured: true, cacheReadTokens: 256 });
    expect(captured[0].url).toContain("/v1/chat/completions");
    expect((captured[0].init.headers as Record<string, string>).authorization).toBe("Bearer o");
  });

  it("asks for JSON at temperature 0, and the cachePrefix LEADS the system message", async () => {
    const captured = stubFetch({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const client = createOpenAiClient({ apiKey: "o" });
    await client.complete({ cachePrefix: "STABLE", system: "volatile", prompt: "p" });
    const b = body(captured[0]);
    expect(b.model).toBe("gpt-4.1");
    expect(b.temperature).toBe(0); // determinism, same as the other two adapters
    expect(b.response_format).toEqual({ type: "json_object" });
    expect(b.messages).toEqual([
      { role: "system", content: "STABLE\n\nvolatile" },
      { role: "user", content: "p" },
    ]);
  });

  it("a missing usage counter falls back to an ESTIMATE, flagged measured:false", async () => {
    stubFetch({ choices: [{ message: { content: "hello" } }] });
    const client = createOpenAiClient({ apiKey: "o" });
    const result = await client.complete({ prompt: "some prompt text" });
    expect(result.usage.measured).toBe(false);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it("raises the provider's own status and detail, in the shape the stages already retry on", async () => {
    stubFetch("invalid_api_key", false, 401);
    const client = createOpenAiClient({ apiKey: "o" });
    await expect(client.complete({ prompt: "p" })).rejects.toThrow(/OpenAI API error 401.*invalid_api_key/);
  });
});

describe("the OpenAI embedding adapter conforms to EmbeddingClient", () => {
  it("returns embeddings ordered by index + MEASURED usage; provider tagged", async () => {
    const captured = stubFetch({
      data: [{ embedding: [9, 9], index: 1 }, { embedding: [1, 1], index: 0 }],
      usage: { prompt_tokens: 88, total_tokens: 88 },
    });
    const client = createOpenAiEmbeddingClient({ apiKey: "o" });
    expect(client.provider).toBe("openai");
    expect(client.model).toBe("text-embedding-3-small");
    expect(client.dimension).toBe(1536);
    const { vectors, usage } = await client.embed({ texts: ["x", "y"], inputType: "document" });
    expect(vectors).toEqual([[1, 1], [9, 9]]); // reordered by index, like the Voyage adapter
    expect(usage).toEqual({ inputTokens: 88, outputTokens: 0, measured: true });
    expect(captured[0].url).toContain("/v1/embeddings");
  });

  it("sends `dimensions` ONLY when it is a real truncation (ada-002 would 400 on it)", async () => {
    const captured = stubFetch({ data: [{ embedding: [1], index: 0 }], usage: { total_tokens: 1 } });
    await createOpenAiEmbeddingClient({ apiKey: "o" }).embed({ texts: ["x"], inputType: "document" });
    expect(body(captured[0]).dimensions).toBeUndefined();

    const truncated = stubFetch({ data: [{ embedding: [1], index: 0 }], usage: { total_tokens: 1 } });
    await createOpenAiEmbeddingClient({ apiKey: "o", dimension: 512 }).embed({ texts: ["x"], inputType: "document" });
    expect(body(truncated[0]).dimensions).toBe(512);
  });

  it("re-chunks under its per-request input cap (>256 texts → multiple calls, order preserved)", async () => {
    const big = Array.from({ length: 300 }, (_, i) => `t${i}`);
    const captured: Captured[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      captured.push({ url, init });
      const input = JSON.parse(init.body as string).input as string[];
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: input.map((text, i) => ({ embedding: [Number(text.slice(1))], index: i })), usage: { total_tokens: 1 } };
        },
        async text() {
          return "";
        },
      } as unknown as Response;
    });
    const { vectors } = await createOpenAiEmbeddingClient({ apiKey: "o" }).embed({ texts: big, inputType: "document" });
    expect(captured).toHaveLength(2); // 256 + 44
    expect(vectors).toHaveLength(300);
    // The batch boundary is where a re-order bug would hide: chunk 299 must still be chunk 299.
    expect(vectors[0]).toEqual([0]);
    expect(vectors[255]).toEqual([255]);
    expect(vectors[299]).toEqual([299]);
  });

  it("an empty input costs nothing and makes no call", async () => {
    const captured = stubFetch({});
    const result = await createOpenAiEmbeddingClient({ apiKey: "o" }).embed({ texts: [], inputType: "document" });
    expect(result).toEqual({ vectors: [], usage: { inputTokens: 0, outputTokens: 0, measured: true } });
    expect(captured).toHaveLength(0);
  });

  it("refuses a response that does not answer every input, rather than storing a short index", async () => {
    stubFetch({ data: [{ embedding: [1], index: 0 }], usage: { total_tokens: 1 } });
    await expect(
      createOpenAiEmbeddingClient({ apiKey: "o" }).embed({ texts: ["x", "y"], inputType: "document" }),
    ).rejects.toThrow(/returned 1 embeddings for 2 inputs/);
  });
});
