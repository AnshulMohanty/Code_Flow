import { describe, expect, it } from "vitest";
import {
  SESSION_MAX_ANSWER_CHARS,
  SESSION_MAX_CHUNK_IDS,
  SESSION_MAX_ENTITIES,
  SESSION_MAX_TURNS,
} from "@codeflow/config";
import {
  appendTurn,
  applySessionBounds,
  createMemorySessionStore,
  emptySession,
  mostRecentEntity,
} from "../sessionStore.js";
import { createRedisSessionStore, type MemoryRedisLike } from "../redisSessionStore.js";
import type { NewTurn, SessionMemory } from "../contracts.js";

// Session memory is what makes a follow-up answerable. The tests below are mostly about the two
// things that would break that: bounds that let the prompt grow forever, and a session quietly
// mixing two analyses so "it" resolves to a file from another repository.

function turn(overrides: Partial<NewTurn> = {}): NewTurn {
  return {
    question: "how does auth work?",
    answer: "It uses bearer tokens.",
    answered: true,
    citations: [{ fileId: "src/auth.ts", startLine: 1, endLine: 10 }],
    retrievedChunkIds: ["src/auth.ts#1-10"],
    toolsUsed: ["search_code"],
    ...overrides,
  };
}

describe("appendTurn", () => {
  it("assigns the turn number from the existing turns, not from the caller", () => {
    // Two concurrent appends must not both claim to be turn 3, and a caller tracking its own
    // counter is the thing that would get it wrong.
    let session = emptySession("s1", "a1");
    session = appendTurn(session, turn());
    session = appendTurn(session, turn({ question: "second" }));
    expect(session.turns.map((entry) => entry.turn)).toEqual([1, 2]);
  });

  it("truncates the answer on the way IN, so no reader has to remember the bound", () => {
    const session = appendTurn(emptySession("s1", "a1"), turn({ answer: "x".repeat(SESSION_MAX_ANSWER_CHARS + 500) }));
    expect(session.turns[0].answer).toHaveLength(SESSION_MAX_ANSWER_CHARS);
    expect(session.turns[0].answer.endsWith("…")).toBe(true);
  });

  it("puts new entities FIRST — the order a pronoun resolves in", () => {
    let session = appendTurn(emptySession("s1", "a1"), turn({ entities: [{ kind: "file", value: "src/first.ts" }] }));
    session = appendTurn(session, turn({ entities: [{ kind: "file", value: "src/second.ts" }] }));
    expect(session.resolvedEntities.map((entity) => entity.value)).toEqual(["src/second.ts", "src/first.ts"]);
  });

  it("MOVES a re-mentioned entity to the front rather than duplicating it", () => {
    // Recency is the only thing the order encodes, so a duplicate would make it ambiguous.
    let session = appendTurn(emptySession("s1", "a1"), turn({ entities: [{ kind: "file", value: "src/a.ts" }] }));
    session = appendTurn(session, turn({ entities: [{ kind: "file", value: "src/b.ts" }] }));
    session = appendTurn(session, turn({ entities: [{ kind: "file", value: "src/a.ts" }] }));
    expect(session.resolvedEntities.map((entity) => entity.value)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("stamps entities with the turn that introduced them", () => {
    let session = appendTurn(emptySession("s1", "a1"), turn({ entities: [{ kind: "file", value: "src/a.ts" }] }));
    session = appendTurn(session, turn({ entities: [{ kind: "symbol", value: "login", fileId: "src/a.ts" }] }));
    expect(session.resolvedEntities.find((entity) => entity.value === "login")?.turn).toBe(2);
    expect(session.resolvedEntities.find((entity) => entity.value === "src/a.ts")?.turn).toBe(1);
  });

  it("dedupes retrieved chunk ids while keeping the most recent position", () => {
    let session = appendTurn(emptySession("s1", "a1"), turn({ retrievedChunkIds: ["a", "b"] }));
    session = appendTurn(session, turn({ retrievedChunkIds: ["b", "c"] }));
    // `b` survives once, at its LATEST position, so a trim from the old end keeps recency.
    expect(session.retrievedChunkIds).toEqual(["a", "b", "c"]);
  });

  it("remembers a REFUSAL as well as an answer", () => {
    // A refusal tells the next turn what has already been tried and failed.
    const session = appendTurn(emptySession("s1", "a1"), turn({ answered: false, answer: "could not find it" }));
    expect(session.turns[0].answered).toBe(false);
  });
});

describe("applySessionBounds", () => {
  it("drops turns OLDEST first — recent context is what a follow-up needs", () => {
    let session = emptySession("s1", "a1");
    for (let i = 0; i < SESSION_MAX_TURNS + 3; i++) session = appendTurn(session, turn({ question: `q${i}` }));
    expect(session.turns).toHaveLength(SESSION_MAX_TURNS);
    expect(session.turns[0].question).toBe("q3");
    expect(session.turns.at(-1)?.question).toBe(`q${SESSION_MAX_TURNS + 2}`);
  });

  it("caps entities and chunk ids", () => {
    let session = emptySession("s1", "a1");
    session = appendTurn(session, {
      ...turn(),
      entities: Array.from({ length: SESSION_MAX_ENTITIES + 5 }, (_, i) => ({ kind: "file" as const, value: `f${i}.ts` })),
      retrievedChunkIds: Array.from({ length: SESSION_MAX_CHUNK_IDS + 10 }, (_, i) => `c${i}`),
    });
    expect(session.resolvedEntities).toHaveLength(SESSION_MAX_ENTITIES);
    expect(session.retrievedChunkIds).toHaveLength(SESSION_MAX_CHUNK_IDS);
  });

  it("is idempotent, so a store can apply it defensively on read", () => {
    let session = emptySession("s1", "a1");
    for (let i = 0; i < SESSION_MAX_TURNS + 2; i++) session = appendTurn(session, turn());
    expect(applySessionBounds(applySessionBounds(session))).toEqual(applySessionBounds(session));
  });
});

describe("mostRecentEntity", () => {
  it("returns the most recent, filtered by kind when asked", () => {
    let session = appendTurn(emptySession("s1", "a1"), turn({ entities: [{ kind: "file", value: "src/a.ts" }] }));
    session = appendTurn(session, turn({ entities: [{ kind: "symbol", value: "login", fileId: "src/b.ts" }] }));
    expect(mostRecentEntity(session)?.value).toBe("login");
    expect(mostRecentEntity(session, "file")?.value).toBe("src/a.ts");
  });

  it("returns null when there is nothing of that kind", () => {
    expect(mostRecentEntity(emptySession("s1", "a1"))).toBeNull();
    const session = appendTurn(emptySession("s1", "a1"), turn({ entities: [{ kind: "file", value: "src/a.ts" }] }));
    expect(mostRecentEntity(session, "symbol")).toBeNull();
  });
});

describe("createMemorySessionStore", () => {
  it("round-trips a session and returns the post-append state", async () => {
    const store = createMemorySessionStore();
    const after = await store.append("s1", "a1", turn());
    expect(after.turns).toHaveLength(1);
    // `append` returns the memory AFTER the append, so a caller never re-reads to see its own write.
    expect(await store.load("s1")).toEqual(after);
  });

  it("STARTS FRESH when the analysisId differs — never mixes two repositories", async () => {
    // Silently continuing would let a follow-up resolve "it" to a file from another repository.
    const store = createMemorySessionStore();
    await store.append("s1", "analysis-A", turn({ entities: [{ kind: "file", value: "src/from-a.ts" }] }));
    const after = await store.append("s1", "analysis-B", turn({ entities: [{ kind: "file", value: "src/from-b.ts" }] }));
    expect(after.analysisId).toBe("analysis-B");
    expect(after.turns).toHaveLength(1);
    expect(after.resolvedEntities.map((entity) => entity.value)).toEqual(["src/from-b.ts"]);
  });

  it("hands out COPIES, so a caller cannot mutate stored memory by editing what it got", async () => {
    const store = createMemorySessionStore();
    const handed = await store.append("s1", "a1", turn());
    handed.turns.length = 0;
    handed.resolvedEntities.push({ kind: "file", value: "injected.ts", turn: 99 });
    const reloaded = await store.load("s1");
    expect(reloaded?.turns).toHaveLength(1);
    expect(reloaded?.resolvedEntities.some((entity) => entity.value === "injected.ts")).toBe(false);
  });

  it("load returns null for an unknown session, and clear forgets one", async () => {
    const store = createMemorySessionStore();
    expect(await store.load("nope")).toBeNull();
    await store.append("s1", "a1", turn());
    await store.clear("s1");
    expect(await store.load("s1")).toBeNull();
  });

  it("reports its identity, so a degradation is visible", () => {
    expect(createMemorySessionStore().id).toBe("memory-session-store");
  });
});

describe("createRedisSessionStore", () => {
  function fakeRedis(): MemoryRedisLike & { store: Map<string, string>; sets: Array<{ key: string; ttl: number }> } {
    const store = new Map<string, string>();
    const sets: Array<{ key: string; ttl: number }> = [];
    return {
      store,
      sets,
      async get(key) {
        return store.get(key) ?? null;
      },
      async set(key, value, _mode, seconds) {
        sets.push({ key, ttl: seconds });
        store.set(key, value);
        return "OK";
      },
      async del(key) {
        store.delete(key);
        return 1;
      },
    };
  }

  it("namespaces its keys and sets a TTL on every write", async () => {
    // Namespaced because a shared Redis also holds the budget and the rate limiter; TTL because
    // conversations are short-lived and expiry is a job Redis already does correctly.
    const redis = fakeRedis();
    const store = createRedisSessionStore({ redis, ttlSeconds: 60 });
    await store.append("s1", "a1", turn());
    expect(redis.sets[0].key).toBe("codeflow:session:s1");
    expect(redis.sets[0].ttl).toBe(60);
  });

  it("refreshes the TTL on every write, so an active conversation cannot expire mid-thread", async () => {
    const redis = fakeRedis();
    const store = createRedisSessionStore({ redis, ttlSeconds: 60 });
    await store.append("s1", "a1", turn());
    await store.append("s1", "a1", turn({ question: "second" }));
    expect(redis.sets).toHaveLength(2);
    expect(redis.sets.every((entry) => entry.ttl === 60)).toBe(true);
  });

  it("round-trips through serialisation and applies the bounds on READ", async () => {
    // A value written by an older build (or different constants) must not inflate today's prompt.
    const redis = fakeRedis();
    const store = createRedisSessionStore({ redis });
    const oversized: SessionMemory = {
      sessionId: "s1",
      analysisId: "a1",
      turns: Array.from({ length: SESSION_MAX_TURNS + 5 }, (_, i) => ({
        turn: i + 1,
        question: `q${i}`,
        answer: "a",
        answered: true,
        citations: [],
        retrievedChunkIds: [],
        toolsUsed: [],
      })),
      retrievedChunkIds: [],
      resolvedEntities: [],
    };
    redis.store.set("codeflow:session:s1", JSON.stringify(oversized));
    const loaded = await store.load("s1");
    expect(loaded?.turns).toHaveLength(SESSION_MAX_TURNS);
  });

  it("starts fresh on a different analysisId, like the in-memory store", async () => {
    const redis = fakeRedis();
    const store = createRedisSessionStore({ redis });
    await store.append("s1", "analysis-A", turn());
    const after = await store.append("s1", "analysis-B", turn());
    expect(after.analysisId).toBe("analysis-B");
    expect(after.turns).toHaveLength(1);
  });

  it("FAILS SOFT and reports: a Redis outage costs context, never the request", async () => {
    // A lost session means a worse answer to THIS question — annoying, recoverable, and strictly
    // better than a 500. It is reported rather than swallowed.
    const errors: Array<{ operation: string }> = [];
    const broken: MemoryRedisLike = {
      async get() {
        throw new Error("redis down");
      },
      async set() {
        throw new Error("redis down");
      },
      async del() {
        throw new Error("redis down");
      },
    };
    const store = createRedisSessionStore({ redis: broken, onError: (_error, operation) => errors.push({ operation }) });

    expect(await store.load("s1")).toBeNull();
    // The turn still HAPPENED, so the caller gets correct memory for this request even though it
    // did not persist — returning the pre-append state would be a lie about what memory holds.
    const after = await store.append("s1", "a1", turn());
    expect(after.turns).toHaveLength(1);
    await store.clear("s1");
    expect(errors.map((entry) => entry.operation)).toEqual(["load", "append/read", "append/write", "clear"]);
  });

  it("survives corrupt stored JSON by starting fresh rather than throwing", async () => {
    const redis = fakeRedis();
    redis.store.set("codeflow:session:s1", "{not json");
    const store = createRedisSessionStore({ redis });
    expect(await store.load("s1")).toBeNull();
    const after = await store.append("s1", "a1", turn());
    expect(after.turns).toHaveLength(1);
  });

  it("reports its identity", () => {
    expect(createRedisSessionStore({ redis: fakeRedis() }).id).toBe("redis-session-store");
  });
});
