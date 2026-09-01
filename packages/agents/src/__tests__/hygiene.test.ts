import { describe, expect, it } from "vitest";
import { AGENT_MAX_TOOLS_PER_STEP } from "@codeflow/config";
import { curateTools, emptyUsageState, recordToolOutcome, TOOL_EMPTY_DROP_THRESHOLD } from "../toolRouter.js";
import { dominantPillar, meterContext, sumContext } from "../contextMeter.js";
import { extractJsonObject, parseAgentAction } from "../parseAction.js";
import type { AgentTool } from "../contracts.js";

// V3-P3 task 3 (context-budget hygiene) plus the untrusted-LLM-JSON boundary. Everything here is
// pure and deterministic — no model decides which tools a model may see, because that would be a
// paid call to save a paid call and it would make the loop unreproducible.

function tool(id: string, triggers?: string[]): AgentTool {
  return {
    id,
    description: `${id}() — does ${id}`,
    args: [],
    ...(triggers ? { triggers } : {}),
    async run() {
      return { text: "" };
    },
  };
}

const SEARCH = tool("search_code"); // no triggers -> general purpose
const CALLERS = tool("get_callers", ["call", "caller"]);
const BLAST = tool("get_blast_radius", ["break", "affect"]);
const SYMBOLS = tool("symbol_search", ["symbol", "defined"]);
const CHANGED = tool("what_changed", ["change", "since"]);
const ALL = [SEARCH, CALLERS, BLAST, SYMBOLS, CHANGED];

describe("curateTools", () => {
  it("always offers a general-purpose tool (no triggers)", () => {
    const curated = curateTools({ question: "how does this thing work", tools: ALL, usage: emptyUsageState() });
    expect(curated.tools.map((entry) => entry.id)).toContain("search_code");
  });

  it("offers a tool whose trigger appears in the question, and omits the rest with a reason", () => {
    // Omitting a description is the saving: descriptions are the fixed per-call cost of having a
    // tool available at all, paid on every turn whether it is called or not.
    const curated = curateTools({ question: "which files call src/auth.ts?", tools: ALL, usage: emptyUsageState() });
    const ids = curated.tools.map((entry) => entry.id);
    expect(ids).toContain("get_callers");
    expect(ids).not.toContain("what_changed");
    expect(curated.omitted).toEqual(
      expect.arrayContaining([{ id: "what_changed", reason: "no-trigger-match" }]),
    );
  });

  it("ranks a stronger trigger match first", () => {
    const curated = curateTools({
      question: "what will break and what does it affect if I change this?",
      tools: ALL,
      usage: emptyUsageState(),
    });
    // blast matches "break" AND "affect"; what_changed matches only "change".
    expect(curated.tools[0].id).toBe("get_blast_radius");
  });

  it("keeps offering a tool that has already been USED, even without a trigger match", () => {
    // The model may legitimately call it again with different arguments.
    const usage = recordToolOutcome(emptyUsageState(), "what_changed", false);
    const curated = curateTools({ question: "unrelated question", tools: ALL, usage });
    expect(curated.tools.map((entry) => entry.id)).toContain("what_changed");
  });

  it("DROPS a tool that has come up empty twice", () => {
    // Offering it a third time invites a third empty call, and the model has no memory of the
    // pattern that a counter here has.
    let usage = emptyUsageState();
    for (let i = 0; i < TOOL_EMPTY_DROP_THRESHOLD; i++) usage = recordToolOutcome(usage, "get_callers", true);
    const curated = curateTools({ question: "which files call this?", tools: ALL, usage });
    expect(curated.tools.map((entry) => entry.id)).not.toContain("get_callers");
    expect(curated.omitted).toEqual(expect.arrayContaining([{ id: "get_callers", reason: "exhausted" }]));
  });

  it("does NOT drop a tool that returned RESULTS twice", () => {
    let usage = emptyUsageState();
    usage = recordToolOutcome(usage, "get_callers", false);
    usage = recordToolOutcome(usage, "get_callers", false);
    const curated = curateTools({ question: "which files call this?", tools: ALL, usage });
    expect(curated.tools.map((entry) => entry.id)).toContain("get_callers");
  });

  it("caps the offered set and records what went over the cap", () => {
    const many = [SEARCH, ...Array.from({ length: 8 }, (_, i) => tool(`t${i}`, ["change"]))];
    const curated = curateTools({ question: "what changed?", tools: many, usage: emptyUsageState() });
    expect(curated.tools).toHaveLength(AGENT_MAX_TOOLS_PER_STEP);
    expect(curated.omitted.filter((entry) => entry.reason === "over-cap").length).toBeGreaterThan(0);
  });

  it("is DETERMINISTIC — same inputs, same offered set and order", () => {
    const args = { question: "what breaks if I change the caller?", tools: ALL, usage: emptyUsageState() };
    expect(curateTools(args)).toEqual(curateTools(args));
  });

  it("handles an empty tool list", () => {
    expect(curateTools({ question: "q", tools: [], usage: emptyUsageState() })).toEqual({ tools: [], omitted: [] });
  });
});

describe("recordToolOutcome", () => {
  it("counts calls and empties separately, immutably", () => {
    const first = recordToolOutcome(emptyUsageState(), "a", true);
    const second = recordToolOutcome(first, "a", false);
    expect(second.calls.a).toBe(2);
    expect(second.empties.a).toBe(1);
    expect(first.calls.a).toBe(1); // the earlier state was not mutated
  });
});

describe("meterContext", () => {
  const parts = {
    instructions: "i".repeat(400),
    retrieval: "r".repeat(4_000),
    memory: "m".repeat(200),
    tools: "t".repeat(800),
    transcript: "x".repeat(1_200),
    question: "q".repeat(40),
  };

  it("breaks tokens down BY PILLAR, and the pillars sum to the total", () => {
    // The parts always adding up is what keeps a reader from wondering where tokens went; `total`
    // is the SUM, not a separate measurement of the assembled prompt.
    const breakdown = meterContext(parts);
    const summed =
      breakdown.instructions + breakdown.retrieval + breakdown.memory + breakdown.tools + breakdown.transcript + breakdown.question;
    expect(breakdown.total).toBe(summed);
    expect(breakdown.retrieval).toBeGreaterThan(breakdown.tools);
  });

  it("names the DOMINANT pillar and its share — what a cost review reads first", () => {
    // A total says the prompt grew; only the breakdown says whether that is a memory-bounds bug, a
    // routing bug, an agent that is looping, or retrieval working as intended.
    const breakdown = meterContext(parts);
    const dominant = dominantPillar(breakdown);
    expect(dominant.pillar).toBe("retrieval");
    expect(dominant.share).toBeGreaterThan(0.5);
    expect(dominant.share).toBeLessThanOrEqual(1);
  });

  it("handles all-empty parts without dividing by zero", () => {
    const empty = meterContext({ instructions: "", retrieval: "", memory: "", tools: "", transcript: "", question: "" });
    expect(empty.total).toBe(0);
    expect(dominantPillar(empty).share).toBe(0);
  });

  it("sums across turns", () => {
    const a = meterContext(parts);
    const total = sumContext([a, a, a]);
    expect(total.total).toBe(a.total * 3);
    expect(total.retrieval).toBe(a.retrieval * 3);
    expect(sumContext([]).total).toBe(0);
  });

  it("is deterministic", () => {
    expect(meterContext(parts)).toEqual(meterContext(parts));
  });
});

describe("extractJsonObject", () => {
  it("finds a bare object", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("unwraps a ```json fence", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("walks to the MATCHING brace, not the last one in the string", () => {
    // A model that adds a sentence containing a brace afterwards would otherwise produce an
    // unparseable slice.
    expect(extractJsonObject('{"a":1} and then I thought about } braces')).toBe('{"a":1}');
  });

  it("handles nested objects and braces inside strings", () => {
    expect(extractJsonObject('{"a":{"b":"}"},"c":2}')).toBe('{"a":{"b":"}"},"c":2}');
  });

  it("handles an escaped quote inside a string", () => {
    expect(extractJsonObject('{"a":"say \\" hi"}')).toBe('{"a":"say \\" hi"}');
  });

  it("returns null when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject('{"unterminated": 1')).toBeNull();
  });
});

describe("parseAgentAction — real runtime validation at an untrusted boundary", () => {
  it("parses a tool action, defaulting missing args to {}", () => {
    // Several tools legitimately take none, so an omitted `{}` is a formatting slip, not a wrong
    // decision.
    expect(parseAgentAction('{"action":"tool","tool":"get_callers"}')).toEqual({
      kind: "tool",
      tool: "get_callers",
      args: {},
    });
  });

  it("parses an answer action with both citation kinds", () => {
    const action = parseAgentAction(
      '{"action":"answer","answer":"yes","answered":true,"citedChunkIds":["c1"],"citedFileIds":["src/a.ts"]}',
    );
    expect(action).toEqual({
      kind: "answer",
      answer: "yes",
      answered: true,
      citedChunkIds: ["c1"],
      citedFileIds: ["src/a.ts"],
    });
  });

  it("accepts object-shaped citations, because models produce both shapes", () => {
    const action = parseAgentAction('{"action":"answer","answer":"a","citations":[{"chunkId":"c1"},{"id":"c2"}]}');
    expect(action.kind === "answer" && action.citedChunkIds).toEqual(["c1", "c2"]);
  });

  it("REJECTS a bare string where a list belongs", () => {
    // A string would iterate as characters and quietly ground nothing.
    const action = parseAgentAction('{"action":"answer","answer":"a","citedChunkIds":"c1"}');
    expect(action.kind === "answer" && action.citedChunkIds).toEqual([]);
  });

  it("treats an EMPTY answer as a refusal even when answered:true", () => {
    // Defaulting to true would turn a blank into a confident empty response.
    const action = parseAgentAction('{"action":"answer","answer":"","answered":true}');
    expect(action.kind === "answer" && action.answered).toBe(false);
  });

  it("defaults `answered` from whether there IS an answer", () => {
    expect(parseAgentAction('{"action":"answer","answer":"something"}')).toMatchObject({ answered: true });
    expect(parseAgentAction('{"action":"answer","answer":"   "}')).toMatchObject({ answered: false });
  });

  it("rejects a tool action with a non-string or empty tool name", () => {
    // `undefined` would reach the registry and silently become "no such tool".
    expect(parseAgentAction('{"action":"tool","tool":123}').kind).toBe("unparseable");
    expect(parseAgentAction('{"action":"tool","tool":"  "}').kind).toBe("unparseable");
  });

  it("reports WHY it could not parse — the model needs to know", () => {
    expect(parseAgentAction("just prose")).toMatchObject({ kind: "unparseable", reason: expect.stringContaining("no JSON") });
    expect(parseAgentAction('{"action":"dance"}')).toMatchObject({ kind: "unparseable", reason: expect.stringContaining("dance") });
    expect(parseAgentAction("[1,2,3]")).toMatchObject({ kind: "unparseable" });
  });

  it("never throws, whatever it is given", () => {
    for (const input of ["", "{", "null", "{}", '{"action":null}', '{"action":"tool","args":[]}']) {
      expect(() => parseAgentAction(input)).not.toThrow();
    }
  });

  it("keeps the model's `thought`, the only window into WHY a tool ran", () => {
    expect(parseAgentAction('{"action":"tool","tool":"t","thought":"because"}')).toMatchObject({ thought: "because" });
  });

  it("dedupes citations", () => {
    const action = parseAgentAction('{"action":"answer","answer":"a","citedChunkIds":["c1","c1","c2"]}');
    expect(action.kind === "answer" && action.citedChunkIds).toEqual(["c1", "c2"]);
  });
});
