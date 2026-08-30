import { describe, expect, it } from "vitest";
import type { BudgetHandle } from "@codeflow/shared-types";
import { appendTurn, emptySession, type SessionMemory } from "@codeflow/memory";
import { createLexicalOverlapReranker } from "@codeflow/retrieval";
import { askAgent, entitiesFrom } from "../askAgent.js";
import { createGraphTools } from "../tools/graphTools.js";
import { createSearchTool } from "../tools/searchTool.js";
import type { AgentTool } from "../contracts.js";
import { answerAction, fixtureResult, fixtureStores, mockEmbed, scriptedChat, toolAction } from "./fixtures.js";

// The bounded multi-turn agent. Every test below targets a property whose failure is a distinct,
// serious product problem: an unbounded loop (cost), a refusal that stops firing (fabrication), a
// citation that is not grounded (fabrication), or a follow-up that cannot resolve "it" (the whole
// point of the phase).

const result = fixtureResult();
const stores = await fixtureStores();

async function tools(): Promise<AgentTool[]> {
  return [
    ...createGraphTools(),
    createSearchTool({ ...stores, embeddingClient: mockEmbed(), reranker: createLexicalOverlapReranker() }),
  ];
}

const ALL_TOOLS = await tools();

describe("askAgent — the loop is BOUNDED", () => {
  it("stops at maxTurns and reports the turn limit", async () => {
    // A model that never answers must cost a known, finite amount.
    const chat = scriptedChat([toolAction("get_callers", { fileId: "src/auth.ts" })]);
    const answer = await askAgent({
      question: "who calls auth?",
      result,
      chatClient: chat,
      tools: ALL_TOOLS,
      maxTurns: 3,
      maxToolCalls: 99,
    });
    expect(answer.trace.turns).toHaveLength(3);
    expect(chat.consumed).toBe(3);
    expect(answer.answered).toBe(false);
  });

  it("stops calling tools at maxToolCalls and forces a final answering turn", async () => {
    // Not cut off mid-thought: a truncated loop that returns nothing has spent the whole budget
    // for no answer, so the last turn drops the tools and demands an answer.
    const chat = scriptedChat([
      toolAction("get_callers", { fileId: "src/auth.ts" }),
      toolAction("get_callers", { fileId: "src/auth.ts" }),
      answerAction("index.ts calls it.", { fileIds: ["src/index.ts"] }),
    ]);
    const answer = await askAgent({
      question: "who calls auth?",
      result,
      chatClient: chat,
      tools: ALL_TOOLS,
      maxTurns: 6,
      maxToolCalls: 2,
    });
    expect(answer.trace.toolCalls).toBe(2);
    expect(answer.answered).toBe(true);
    // The forced turn offers NO tool descriptions — also the cheapest turn of the loop.
    expect(answer.trace.turns.at(-1)?.offeredTools).toEqual([]);
    expect(chat.prompts.at(-1)).toContain("No tools are available on this turn");
  });

  it("counts a HALLUCINATED tool name against the tool budget", async () => {
    // Otherwise a model that invents names loops for free to the turn cap — the same runaway with
    // extra steps.
    const chat = scriptedChat([toolAction("no_such_tool", {})]);
    const answer = await askAgent({
      question: "anything",
      result,
      chatClient: chat,
      tools: ALL_TOOLS,
      maxTurns: 4,
      maxToolCalls: 2,
    });
    expect(answer.trace.toolCalls).toBe(2);
    expect(answer.trace.turns[0].toolError).toMatch(/no such tool/);
    // And it is TOLD what exists, so it can recover rather than guessing again.
    expect(chat.prompts[1]).toContain("Available:");
  });

  it("gives up after bounded parse retries", async () => {
    const chat = scriptedChat(["I think the answer is probably in auth.ts, honestly."]);
    const answer = await askAgent({ question: "q", result, chatClient: chat, tools: ALL_TOOLS, maxTurns: 6 });
    expect(answer.trace.stopReason).toBe("parse-failure");
    expect(answer.answered).toBe(false);
    // Told WHAT was wrong, or it repeats the same mistake.
    expect(chat.prompts[1]).toContain("could not be parsed");
  });

  it("truncates a huge tool observation and SAYS it truncated", async () => {
    const huge: AgentTool = {
      id: "huge",
      description: "huge() — returns a lot",
      args: [],
      async run() {
        return { text: "x".repeat(9_000), fileIds: ["src/auth.ts"] };
      },
    };
    const chat = scriptedChat([toolAction("huge"), answerAction("done", { fileIds: ["src/auth.ts"] })]);
    await askAgent({
      question: "q",
      result,
      chatClient: chat,
      tools: [huge],
      maxToolResultChars: 100,
      maxTurns: 3,
    });
    expect(chat.prompts[1]).toContain("(truncated from 9000 characters)");
    expect(chat.prompts[1].length).toBeLessThan(4_000);
  });

  it("checks the daily budget before EVERY turn and keeps earlier work when it runs out", async () => {
    let allowed = 1;
    const budget: BudgetHandle = {
      async check() {
        return allowed-- > 0;
      },
      async record() {},
    };
    const chat = scriptedChat([toolAction("get_callers", { fileId: "src/auth.ts" })]);
    const answer = await askAgent({ question: "who calls auth?", result, chatClient: chat, tools: ALL_TOOLS, budget, maxTurns: 5 });
    expect(answer.trace.stopReason).toBe("budget-exhausted");
    // One turn was paid for and happened; the loop stopped rather than discarding it or continuing.
    expect(chat.consumed).toBe(1);
    expect(answer.trace.turns).toHaveLength(2); // the paid turn + the refused-by-budget turn
    expect(answer.answered).toBe(false);
  });

  it("records the provider's real usage per turn and in total", async () => {
    const chat = scriptedChat([toolAction("get_callers", { fileId: "src/auth.ts" }), answerAction("index.ts.", { fileIds: ["src/index.ts"] })]);
    const answer = await askAgent({ question: "who calls auth?", result, chatClient: chat, tools: ALL_TOOLS });
    expect(answer.trace.turns[0].usage).toEqual({ inputTokens: 100, outputTokens: 20, measured: true });
    expect(answer.trace.totalUsage).toEqual({ inputTokens: 200, outputTokens: 40, measured: true });
  });
});

describe("askAgent — graph tools answer EXACTLY", () => {
  it("answers 'who calls X' from the CPG, not from retrieval", async () => {
    const chat = scriptedChat([
      toolAction("get_callers", { fileId: "src/auth.ts" }),
      // The model can only cite index.ts if the tool actually returned it.
      (prompt) => {
        expect(prompt).toContain("1 file(s) call into src/auth.ts: src/index.ts");
        return answerAction("src/index.ts calls it.", { fileIds: ["src/index.ts"] });
      },
    ]);
    const answer = await askAgent({ question: "which files call src/auth.ts?", result, chatClient: chat, tools: ALL_TOOLS });
    expect(answer.answered).toBe(true);
    expect(answer.citedFiles).toEqual(["src/index.ts"]);
  });

  it("answers 'what breaks' with the transitive dependents", async () => {
    const chat = scriptedChat([
      toolAction("get_blast_radius", { fileId: "src/util.ts" }),
      (prompt) => {
        // util.ts <- auth.ts <- index.ts
        expect(prompt).toContain("src/auth.ts");
        expect(prompt).toContain("src/index.ts");
        return answerAction("auth.ts and index.ts.", { fileIds: ["src/auth.ts", "src/index.ts"] });
      },
    ]);
    const answer = await askAgent({ question: "what breaks if I change src/util.ts?", result, chatClient: chat, tools: ALL_TOOLS });
    expect(answer.citedFiles).toEqual(["src/auth.ts", "src/index.ts"]);
  });

  it("reports an EXACT empty answer without treating it as a failure", async () => {
    const chat = scriptedChat([
      toolAction("get_callers", { fileId: "src/orphan.ts" }),
      answerAction("Nothing calls it.", { answered: false }),
    ]);
    const answer = await askAgent({ question: "who calls src/orphan.ts?", result, chatClient: chat, tools: ALL_TOOLS });
    expect(answer.trace.turns[0].toolEmpty).toBe(true);
    expect(answer.answered).toBe(false);
    expect(answer.trace.stopReason).toBe("refused");
  });
});

describe("askAgent — GROUNDING is enforced by code, not by the prompt", () => {
  it("drops a citation to a chunk that was never retrieved", async () => {
    const chat = scriptedChat([
      toolAction("search_code", { query: "auth service" }),
      answerAction("Auth uses hashing.", { chunkIds: ["src/auth.ts#3-18", "src/ghost.ts#1-1"] }),
    ]);
    const answer = await askAgent({ question: "how does auth work?", result, chatClient: chat, tools: ALL_TOOLS });
    expect(answer.citations).toEqual([{ fileId: "src/auth.ts", startLine: 3, endLine: 18 }]);
    expect(answer.droppedCitations?.ids).toEqual(["src/ghost.ts#1-1"]);
  });

  it("drops a file citation no tool returned, even when the file EXISTS in the graph", async () => {
    // Existing in the repository is not evidence. The agent must have actually established it.
    const chat = scriptedChat([
      toolAction("get_callers", { fileId: "src/auth.ts" }),
      answerAction("It is all in db.ts.", { fileIds: ["src/db.ts"] }),
    ]);
    const answer = await askAgent({ question: "who calls src/auth.ts?", result, chatClient: chat, tools: ALL_TOOLS });
    expect(answer.citedFiles).toBeUndefined();
    expect(answer.droppedCitations?.ids).toEqual(["src/db.ts"]);
    // No grounded evidence survived, so the claim is downgraded (see the next block).
    expect(answer.answered).toBe(false);
  });

  it("DOWNGRADES answered:true with no grounded evidence to a refusal", async () => {
    // The guard that makes honest-no-answer survive an agent: it checks EVIDENCE, not the model's
    // claim, so a model answering from pre-training cannot produce an answered response.
    const chat = scriptedChat([answerAction("React uses a virtual DOM.", { answered: true })]);
    const answer = await askAgent({ question: "how does react work?", result, chatClient: chat, tools: ALL_TOOLS });
    expect(answer.answered).toBe(false);
    expect(answer.trace.stopReason).toBe("refused");
  });

  it("keeps the honest refusal when retrieval is below the similarity floor", async () => {
    // The floor lives inside `search_code` with no model-settable argument, so the agent cannot
    // argue past it — an empty result is a fact it has to work with.
    const chat = scriptedChat([
      toolAction("search_code", { query: "xyzzy" }),
      (prompt) => {
        expect(prompt).toContain("below the");
        expect(prompt).toContain("Do not guess an answer from outside the repository");
        return answerAction("", { answered: false });
      },
    ]);
    const answer = await askAgent({ question: "what is xyzzy?", result, chatClient: chat, tools: ALL_TOOLS });
    expect(answer.answered).toBe(false);
    expect(answer.answer).toMatch(/couldn't establish/i);
    expect(answer.trace.turns[0].toolEmpty).toBe(true);
  });

  it("dedupes citations that resolve to the same file + line range", async () => {
    const chat = scriptedChat([
      toolAction("search_code", { query: "auth service" }),
      answerAction("Auth.", { chunkIds: ["src/auth.ts#3-18", "src/auth.ts#3-18"] }),
    ]);
    const answer = await askAgent({ question: "how does auth work?", result, chatClient: chat, tools: ALL_TOOLS });
    expect(answer.citations).toHaveLength(1);
  });
});

describe("askAgent — follow-ups resolve against prior turns", () => {
  function memoryWithAuth(): SessionMemory {
    return appendTurn(emptySession("s1", result.id), {
      question: "how does auth work?",
      answer: "AuthService hashes the user.",
      answered: true,
      citations: [{ fileId: "src/auth.ts", startLine: 3, endLine: 18 }],
      retrievedChunkIds: ["src/auth.ts#3-18"],
      toolsUsed: ["search_code"],
      entities: [{ kind: "file", value: "src/auth.ts" }],
    });
  }

  it("puts prior turns AND resolved entities into the prompt", async () => {
    // Asserting the PLUMBING (memory -> prompt), which is the part we own. A test that only checked
    // the mock's reply would be checking nothing.
    const chat = scriptedChat([
      (prompt) => {
        expect(prompt).toContain("Q1: how does auth work?");
        expect(prompt).toContain("Recently discussed (most recent first): src/auth.ts");
        return answerAction("index.ts.", { fileIds: ["src/index.ts"] });
      },
    ]);
    await askAgent({ question: "what about its callers?", result, chatClient: chat, tools: ALL_TOOLS, memory: memoryWithAuth() });
  });

  it("resolves a MISSING fileId argument from memory — the acceptance criterion", async () => {
    // "what about its callers?" — the model calls the tool without naming a file, and the tool
    // resolves "it" from the previous turn, deterministically, in code.
    const chat = scriptedChat([
      toolAction("get_callers", {}),
      (prompt) => {
        expect(prompt).toContain("call into src/auth.ts");
        expect(prompt).toContain("(resolved from the previous turn)");
        return answerAction("src/index.ts calls it.", { fileIds: ["src/index.ts"] });
      },
    ]);
    const answer = await askAgent({
      question: "what about its callers?",
      result,
      chatClient: chat,
      tools: ALL_TOOLS,
      memory: memoryWithAuth(),
    });
    expect(answer.answered).toBe(true);
    expect(answer.citedFiles).toEqual(["src/index.ts"]);
  });

  it("resolves a PRONOUN fileId argument from memory", async () => {
    const chat = scriptedChat([toolAction("get_blast_radius", { fileId: "it" }), answerAction("index.ts.", { fileIds: ["src/index.ts"] })]);
    const answer = await askAgent({
      question: "what breaks if I change it?",
      result,
      chatClient: chat,
      tools: ALL_TOOLS,
      memory: memoryWithAuth(),
    });
    expect(answer.answered).toBe(true);
  });

  it("refuses to resolve when there is nothing in memory, rather than guessing a file", async () => {
    const chat = scriptedChat([toolAction("get_callers", {}), answerAction("", { answered: false })]);
    const answer = await askAgent({ question: "what about its callers?", result, chatClient: chat, tools: ALL_TOOLS });
    expect(chat.prompts[1]).toContain("Could not resolve which file");
    expect(answer.answered).toBe(false);
  });

  it("entitiesFrom derives entities from GROUNDED output, not from the question text", async () => {
    // So "it" resolves to something that demonstrably exists in the repository.
    const chat = scriptedChat([
      toolAction("search_code", { query: "auth service" }),
      answerAction("Auth.", { chunkIds: ["src/auth.ts#3-18"] }),
    ]);
    const answer = await askAgent({ question: "how does auth work?", result, chatClient: chat, tools: ALL_TOOLS });
    const entities = entitiesFrom(answer, []);
    expect(entities).toEqual([{ kind: "file", value: "src/auth.ts" }]);
  });
});

describe("askAgent — a failing tool is reported, not fatal", () => {
  it("tells the model the tool errored and lets it try something else", async () => {
    const exploding: AgentTool = {
      id: "explodes",
      description: "explodes() — throws",
      args: [],
      async run() {
        throw new Error("tool blew up");
      },
    };
    const chat = scriptedChat([
      toolAction("explodes"),
      (prompt) => {
        expect(prompt).toContain("explodes");
        return answerAction("", { answered: false });
      },
    ]);
    const answer = await askAgent({ question: "q", result, chatClient: chat, tools: [exploding], maxTurns: 3 });
    expect(answer.trace.turns[0].toolError).toMatch(/tool blew up/);
    expect(answer.answered).toBe(false);
  });
});
