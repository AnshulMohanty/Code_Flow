/**
 * Unwrapping a model completion, linearly.
 *
 * Five call sites across three packages each carried their own copy of
 *   /```(?:json)?\s*([\s\S]*?)\s*```/i
 * which is CUBIC: `\s*`, the lazy `([\s\S]*?)` and the trailing `\s*` can all claim the same run
 * of whitespace, so every length of the first run retries the whole tail at every length of the
 * last. Measured on that pattern: ```` ``` ```` followed by 250 spaces took 31 ms, 1 000 took
 * 322 ms, and 4 000 did not finish in twenty seconds.
 *
 * The input is a completion, so it is not attacker-controlled directly — but it is written by a
 * model that was shown untrusted repository content, and the grounding rules in this codebase
 * assume the parse of a hostile completion terminates. Two `indexOf` calls answer the same
 * question in one pass, and the answer is identical: the old pattern took the text between the
 * first fence and the next one, with surrounding whitespace stripped.
 */

const FENCE = "```";
const JSON_TAG = "json";

/**
 * The body of the first fenced block, or the text unchanged when there is no complete fence.
 *
 * Matches the pattern it replaces on every input, including the cases worth naming: a `json`
 * language tag is consumed and any other tag is not (so ```` ```ts ```` leaves `ts` in the body,
 * as before); an unterminated fence returns the input untouched; and the body is trimmed.
 */
export function stripCodeFence(text: string): string {
  const open = text.indexOf(FENCE);
  if (open === -1) return text;
  let body = open + FENCE.length;
  if (text.slice(body, body + JSON_TAG.length).toLowerCase() === JSON_TAG) {
    body += JSON_TAG.length;
  }
  // `indexOf` with a start index never returns less than it, so `close > body` or `close === -1`.
  const close = text.indexOf(FENCE, body);
  if (close === -1) return text;
  return text.slice(body, close).trim();
}

/**
 * Drop a trailing fence and the whitespace before it — what `.replace(/\s*```$/, "")` did.
 *
 * That pattern is quadratic for the ordinary reason: `\s*` starts an attempt at every position in
 * a whitespace run and backtracks to nothing each time, because the fence it needs is not there.
 * `endsWith` decides in one comparison whether there is anything to do at all.
 *
 * Kept separate from `stripCodeFence` because it strips MARKERS rather than requiring a matched
 * pair: a completion that opens a fence and never closes it still has to parse.
 */
export function stripTrailingCodeFence(text: string): string {
  if (!text.endsWith(FENCE)) return text;
  return text.slice(0, text.length - FENCE.length).trimEnd();
}
