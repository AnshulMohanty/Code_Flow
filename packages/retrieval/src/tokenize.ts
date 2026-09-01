import { LEXICAL_MIN_TOKEN_LENGTH } from "@codeflow/config";

// The shared code tokenizer (V3-P2). Used by the BM25 lexical index and by the eval's
// deterministic bag-of-words embedder, so both see identical terms — an A/B that tokenized
// differently from production would be measuring its own tokenizer.

/**
 * Tokenizer for CODE, not prose. Three decisions, each with a reason:
 *
 *   1. Split on every non-alphanumeric character. `foo.bar(baz)` becomes three tokens; a
 *      prose tokenizer would keep punctuation-glued identifiers together and never match.
 *   2. Split camelCase and PascalCase, and keep the WHOLE identifier too. `parseJwtHeader`
 *      yields `parsejwtheader`, `parse`, `jwt`, `header` — so a query for "jwt header" hits a
 *      symbol nobody spelled out, and a query for the exact identifier still hits hardest
 *      (it matches the whole-identifier token, which is rarer, so its IDF is higher).
 *   3. Lowercase, and drop 1-character tokens. Case is not a meaningful distinction for
 *      retrieval, and single letters (`i`, `x`, `_`) are pure noise in code.
 *
 * Deliberately NO stemming and NO stopword list. Stemming an identifier corrupts it
 * (`routing` and `routes` are different symbols), and English stopwords like `in`, `if`, `for`
 * and `class` are keywords, so removing them would blind the index to control flow.
 */
export function tokenizeCode(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const whole = raw.toLowerCase();
    if (whole.length >= LEXICAL_MIN_TOKEN_LENGTH) out.push(whole);
    // Sub-tokens from camelCase / PascalCase / digit boundaries. Only emitted when the split
    // actually produces more than one part, so a plain lowercase word is not duplicated.
    const parts = raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])|(?<=[A-Z])(?=[A-Z][a-z])/);
    if (parts.length > 1) {
      for (const part of parts) {
        const token = part.toLowerCase();
        if (token.length >= LEXICAL_MIN_TOKEN_LENGTH) out.push(token);
      }
    }
  }
  return out;
}
