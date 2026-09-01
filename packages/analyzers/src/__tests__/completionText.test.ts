import { describe, expect, it } from "vitest";
import { stripCodeFence, stripTrailingCodeFence } from "../llm/completionText.js";

/**
 * The pattern these replaced was cubic: ```` ``` ```` plus 250 spaces took 31 ms, 1 000 took
 * 322 ms, and 4 000 did not finish in twenty seconds. `indexOf` is one pass, measured at 0.1 ms
 * for a 200 000-character completion, so a two-second budget cannot flake and cannot be met by
 * the pattern that was removed.
 */
const PATHOLOGICAL_LENGTH = 200_000;
const REDOS_BUDGET_MS = 2_000;

function elapsed(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("stripCodeFence", () => {
  it("takes the body of a fenced block and trims it", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence("```\ntext\n```")).toBe("text");
    expect(stripCodeFence("```JSON\n1\n```")).toBe("1");
    expect(stripCodeFence("prose ```json\n{}\n``` more")).toBe("{}");
  });

  it("consumes a `json` tag and leaves any other tag in the body", () => {
    // The pattern this replaced spelled out `(?:json)?` and nothing else, so a `ts` tag stayed
    // in the captured text. Preserved rather than quietly improved.
    expect(stripCodeFence("```json{}```")).toBe("{}");
    expect(stripCodeFence("```ts\nconst a = 1;\n```")).toBe("ts\nconst a = 1;");
  });

  it("returns the input unchanged when there is no complete fence", () => {
    expect(stripCodeFence("no fence")).toBe("no fence");
    expect(stripCodeFence("```json")).toBe("```json");
    expect(stripCodeFence("a ``` b")).toBe("a ``` b");
  });

  it("stops at the FIRST closing fence", () => {
    expect(stripCodeFence("``` a ``` b ``` c")).toBe("a");
    expect(stripCodeFence("```\n\n```")).toBe("");
  });

  it("stays linear on an unterminated fence followed by whitespace", () => {
    const hostile = "```" + " ".repeat(PATHOLOGICAL_LENGTH);
    let result = "";
    expect(elapsed(() => {
      result = stripCodeFence(hostile);
    })).toBeLessThan(REDOS_BUDGET_MS);
    expect(result).toBe(hostile);
  });
});

describe("stripTrailingCodeFence", () => {
  it("drops a trailing fence and the whitespace before it", () => {
    expect(stripTrailingCodeFence("abc```")).toBe("abc");
    expect(stripTrailingCodeFence("abc  ```")).toBe("abc");
    expect(stripTrailingCodeFence("```")).toBe("");
    expect(stripTrailingCodeFence("   ```")).toBe("");
    expect(stripTrailingCodeFence("``````")).toBe("```");
  });

  it("leaves text that does not end in a fence alone", () => {
    expect(stripTrailingCodeFence("abc")).toBe("abc");
    expect(stripTrailingCodeFence("abc``` ")).toBe("abc``` ");
  });

  it("stays linear on a long whitespace run with no fence", () => {
    const hostile = " ".repeat(PATHOLOGICAL_LENGTH);
    expect(elapsed(() => stripTrailingCodeFence(hostile))).toBeLessThan(REDOS_BUDGET_MS);
  });
});
