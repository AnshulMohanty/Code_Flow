import type { AgentAction, ToolArgs } from "./contracts.js";

/**
 * Parsing the model's action — one of the THREE untrusted external boundaries the V3-P0 contract
 * rule names (API request bodies, parsed LLM JSON, loaded dataset files). So this is real runtime
 * validation, not a cast.
 *
 * Every check below exists because the alternative is not a crash but a WRONG ANSWER: a tool name
 * that is not a string reaches the tool registry as `undefined` and silently becomes "no such
 * tool"; `citedChunkIds` arriving as a bare string instead of an array iterates as characters and
 * grounds nothing; an `answered: true` with no answer text produces a confident empty response.
 *
 * FORGIVING ABOUT SHAPE, STRICT ABOUT CONTENT. Prompted tool-calling is less reliable than native
 * tool-calling (see contracts.ts for why this codebase uses it anyway), so the parser tolerates
 * code fences, leading prose and trailing commentary — the things a model does that are stylistic.
 * It tolerates nothing about the fields themselves.
 */

/** Strip a ```json fence, and otherwise find the outermost JSON object in the text. */
export function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : raw;

  const start = candidate.indexOf("{");
  if (start === -1) return null;
  // Walk to the MATCHING brace rather than taking the last `}` in the string: a model that adds a
  // sentence containing a brace after the JSON would otherwise produce an unparseable slice.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const char = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse one action. Never throws — an unparseable output is a legitimate turn outcome the loop
 * handles (bounded retry, then an honest refusal), not an exception for a caller to catch.
 */
export function parseAgentAction(raw: string): AgentAction {
  const json = extractJsonObject(raw);
  if (json === null) {
    return { kind: "unparseable", raw, reason: "no JSON object found in the model output" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { kind: "unparseable", raw, reason: `JSON parse failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unparseable", raw, reason: "the parsed value is not a JSON object" };
  }

  const record = parsed as Record<string, unknown>;
  const action = typeof record.action === "string" ? record.action.toLowerCase() : "";
  const thought = typeof record.thought === "string" ? record.thought.trim() : undefined;

  if (action === "tool") {
    const tool = typeof record.tool === "string" ? record.tool.trim() : "";
    if (!tool) {
      return { kind: "unparseable", raw, reason: 'action "tool" requires a non-empty string `tool`' };
    }
    // Args default to an empty object rather than being required: several tools legitimately take
    // none (`what_changed`), and a model omitting `{}` is a formatting slip, not a wrong decision.
    const args: ToolArgs =
      record.args && typeof record.args === "object" && !Array.isArray(record.args) ? (record.args as ToolArgs) : {};
    return { kind: "tool", tool, args, ...(thought ? { thought } : {}) };
  }

  if (action === "answer") {
    const answer = typeof record.answer === "string" ? record.answer.trim() : "";
    // `answered` defaults to whether there IS an answer, rather than to `true`. A model that
    // returns an empty answer with `answered` omitted has refused, and defaulting to true would
    // turn that into a confident blank response.
    const answered = typeof record.answered === "boolean" ? record.answered && answer !== "" : answer !== "";
    return {
      kind: "answer",
      answer,
      answered,
      citedChunkIds: stringArray(record.citedChunkIds ?? record.chunkIds ?? record.citations),
      citedFileIds: stringArray(record.citedFileIds ?? record.fileIds ?? record.files),
      ...(thought ? { thought } : {}),
    };
  }

  return {
    kind: "unparseable",
    raw,
    reason: `unknown action "${String(record.action)}" — expected "tool" or "answer"`,
  };
}

/**
 * Coerce a citation list to strings.
 *
 * Accepts both `["a", "b"]` and `[{ chunkId: "a" }, { fileId: "b" }]`, because both are shapes
 * models actually produce and the difference is stylistic. A bare STRING is deliberately NOT
 * accepted as a one-element list: it would iterate as characters and quietly ground nothing.
 */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      out.push(entry.trim());
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      for (const key of ["chunkId", "id", "fileId", "file"]) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.trim()) {
          out.push(candidate.trim());
          break;
        }
      }
    }
  }
  return [...new Set(out)];
}
