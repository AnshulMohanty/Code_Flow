import { describe, expect, it } from "vitest";
import { Bm25Index } from "../bm25.js";
import { tokenizeCode } from "../tokenize.js";
import { reciprocalRankFusion } from "../rrf.js";
import { mmrSelect, normalizeScores } from "../mmr.js";
import {
  createCrossEncoderReranker,
  createIdentityReranker,
  createLexicalOverlapReranker,
  type CrossEncoderSession,
} from "../reranker.js";

// The pure stages of hybrid retrieval, tested directly. Every one of these is deterministic
// with no I/O, which is why they are unit tests rather than something mocked at a boundary.

describe("tokenizeCode", () => {
  it("splits on punctuation so a punctuation-glued identifier still matches", () => {
    expect(tokenizeCode("foo.bar(baz)")).toEqual(["foo", "bar", "baz"]);
  });

  it("keeps the whole identifier AND its camelCase parts", () => {
    // Both are wanted: the sub-tokens let "jwt header" hit a symbol nobody spelled out, and the
    // whole identifier is rarer, so an exact query for it still scores highest via IDF.
    expect(tokenizeCode("parseJwtHeader")).toEqual(["parsejwtheader", "parse", "jwt", "header"]);
  });

  it("splits PascalCase and acronym boundaries", () => {
    expect(tokenizeCode("HTTPServer")).toContain("http");
    expect(tokenizeCode("HTTPServer")).toContain("server");
  });

  it("splits at digit boundaries", () => {
    expect(tokenizeCode("sha256Hash")).toContain("sha");
    expect(tokenizeCode("sha256Hash")).toContain("256");
  });

  it("drops single characters and lowercases", () => {
    expect(tokenizeCode("const x = A;")).toEqual(["const"]);
  });

  it("does NOT stem and does NOT drop keywords", () => {
    // Stemming corrupts identifiers (`routing` and `routes` are different symbols) and English
    // stopwords like `if`/`for`/`class` are keywords — removing them blinds the index.
    expect(tokenizeCode("class routing for if")).toEqual(["class", "routing", "for", "if"]);
  });

  it("returns nothing for text with no alphanumerics", () => {
    expect(tokenizeCode("!!! ... {}")).toEqual([]);
  });
});

describe("Bm25Index", () => {
  const docs = [
    { id: "a", text: "export function parseJwtHeader(token) { return decode(token); }" },
    { id: "b", text: "export function connectDatabase(url) { return pool(url); }" },
    { id: "c", text: "const token = 1; const token2 = 2; const token3 = 3;" },
  ];
  const index = Bm25Index.build(docs);

  it("finds the document containing a rare identifier", () => {
    // The case the vector arm is worst at: a rare identifier is exactly what a dense vector
    // averages away, and exactly what a developer types.
    expect(index.search("parseJwtHeader", 1).map((hit) => hit.id)).toEqual(["a"]);
  });

  it("scores a rare term above a common one (IDF is doing its job)", () => {
    const rare = index.search("connectDatabase", 3);
    expect(rare[0].id).toBe("b");
    // "token" appears in a and c, so it discriminates less.
    const common = index.search("token", 3);
    expect(common[0].score).toBeLessThan(rare[0].score);
  });

  it("normalises by length, so a long file does not beat a short focused one", () => {
    // Doc c mentions `token` three times in a long line of noise; doc a uses it in the function
    // that is actually about it. Without length normalisation c would win on raw frequency.
    const hits = index.search("token decode", 3);
    expect(hits[0].id).toBe("a");
  });

  it("floors IDF at zero, so a term in most documents cannot make a match score WORSE", () => {
    // Raw probabilistic IDF goes negative above 50% document frequency; unfloored, a document
    // containing a common word would rank below one that does not contain it at all.
    const everywhere = Bm25Index.build([
      { id: "x", text: "common word here" },
      { id: "y", text: "common word there" },
      { id: "z", text: "common word everywhere" },
    ]);
    for (const hit of everywhere.search("common", 3)) expect(hit.score).toBeGreaterThanOrEqual(0);
  });

  it("breaks ties by id ascending, so the ranking is total and reproducible", () => {
    const tied = Bm25Index.build([
      { id: "z", text: "alpha beta" },
      { id: "a", text: "alpha beta" },
      { id: "m", text: "alpha beta" },
    ]);
    expect(tied.search("alpha", 2).map((hit) => hit.id)).toEqual(["a", "m"]);
  });

  it("does not multiply a repeated query term's contribution", () => {
    const once = index.search("token", 3);
    const thrice = index.search("token token token", 3);
    expect(thrice.map((hit) => hit.score)).toEqual(once.map((hit) => hit.score));
  });

  it("returns nothing for an empty corpus, an empty query, or k <= 0", () => {
    expect(Bm25Index.build([]).search("anything", 5)).toEqual([]);
    expect(index.search("", 5)).toEqual([]);
    expect(index.search("!!!", 5)).toEqual([]);
    expect(index.search("token", 0)).toEqual([]);
  });

  it("reports corpus and vocabulary size", () => {
    expect(index.size).toBe(3);
    expect(index.vocabularySize).toBeGreaterThan(5);
    expect(Bm25Index.build([]).size).toBe(0);
  });
});

describe("reciprocalRankFusion", () => {
  it("ranks a document both arms found above one only a single arm found", () => {
    // The core behaviour: RRF trusts AGREEMENT more than either arm's own confidence, which is
    // the right bias when neither arm is reliable alone.
    const fused = reciprocalRankFusion([
      { source: "vector", ids: ["shared", "vecOnly"] },
      { source: "lexical", ids: ["shared", "lexOnly"] },
    ]);
    expect(fused[0].id).toBe("shared");
    expect(fused[0].sources).toEqual(["vector", "lexical"]);
    expect(fused[0].ranks).toEqual({ vector: 1, lexical: 1 });
  });

  it("fuses RANKS, not scores — magnitudes never enter", () => {
    // Two arms with wildly different score scales (cosine vs BM25) must fuse identically as
    // long as their ORDER is the same. That is the whole reason RRF was chosen.
    const a = reciprocalRankFusion([{ source: "v", ids: ["x", "y"] }]);
    const b = reciprocalRankFusion([{ source: "v", ids: ["x", "y"] }]);
    expect(a).toEqual(b);
    expect(a[0].score).toBeGreaterThan(a[1].score);
  });

  it("reports each arm's 1-based rank — the diagnosis for a retrieval miss", () => {
    const fused = reciprocalRankFusion([
      { source: "vector", ids: ["a", "b", "c"] },
      { source: "lexical", ids: ["c"] },
    ]);
    const c = fused.find((entry) => entry.id === "c");
    expect(c?.ranks).toEqual({ vector: 3, lexical: 1 });
  });

  it("honours a per-arm weight", () => {
    const fused = reciprocalRankFusion([
      { source: "vector", ids: ["v"], weight: 1 },
      { source: "lexical", ids: ["l"], weight: 5 },
    ]);
    expect(fused[0].id).toBe("l");
  });

  it("is deterministic with id tie-breaks, and handles empty input", () => {
    const fused = reciprocalRankFusion([
      { source: "a", ids: ["z"] },
      { source: "b", ids: ["y"] },
    ]);
    // Equal scores (both rank 1 in one arm) ⇒ id ascending.
    expect(fused.map((entry) => entry.id)).toEqual(["y", "z"]);
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([{ source: "a", ids: [] }])).toEqual([]);
  });

  it("a larger k flattens the rank curve (agreement matters more than position)", () => {
    const sharp = reciprocalRankFusion([{ source: "v", ids: ["a", "b"] }], { k: 1 });
    const flat = reciprocalRankFusion([{ source: "v", ids: ["a", "b"] }], { k: 1000 });
    const sharpGap = sharp[0].score - sharp[1].score;
    const flatGap = flat[0].score - flat[1].score;
    expect(flatGap).toBeLessThan(sharpGap);
  });
});

describe("mmrSelect", () => {
  const candidates = [
    { id: "fileA#1", relevance: 1.0, groupKey: "fileA" },
    { id: "fileA#2", relevance: 0.95, groupKey: "fileA" },
    { id: "fileA#3", relevance: 0.9, groupKey: "fileA" },
    { id: "fileB#1", relevance: 0.5, groupKey: "fileB" },
  ];

  it("breaks up a run of same-file chunks that pure relevance would return", () => {
    // The failure MMR exists for: the top-3 by relevance is three chunks of one file, so the
    // prompt contains one fact three times and cannot mention the other file that mattered.
    const selected = mmrSelect(candidates, 3, 0.5).map((entry) => entry.id);
    expect(selected[0]).toBe("fileA#1");
    expect(selected).toContain("fileB#1");
  });

  it("lambda = 1 is pure relevance — order preserved exactly", () => {
    expect(mmrSelect(candidates, 3, 1).map((entry) => entry.id)).toEqual(["fileA#1", "fileA#2", "fileA#3"]);
  });

  it("lambda = 0 is pure diversity — a second file before a second chunk of the first", () => {
    const selected = mmrSelect(candidates, 2, 0).map((entry) => entry.id);
    expect(selected[1]).toBe("fileB#1");
  });

  it("uses cosine redundancy when vectors are supplied (the exact mode)", () => {
    const withVectors = [
      { id: "a", relevance: 1, vector: [1, 0, 0] },
      { id: "a-dup", relevance: 0.99, vector: [1, 0, 0] }, // nearly identical
      { id: "b", relevance: 0.5, vector: [0, 1, 0] }, // orthogonal
    ];
    expect(mmrSelect(withVectors, 2, 0.5).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("treats candidates with nothing comparable as non-redundant rather than inventing similarity", () => {
    const bare = [
      { id: "a", relevance: 1 },
      { id: "b", relevance: 0.9 },
    ];
    expect(mmrSelect(bare, 2, 0.5).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("is deterministic, and safe for k <= 0 / k > candidate count", () => {
    expect(mmrSelect(candidates, 0, 0.7)).toEqual([]);
    expect(mmrSelect([], 3, 0.7)).toEqual([]);
    expect(mmrSelect(candidates, 99, 0.7)).toHaveLength(candidates.length);
    expect(mmrSelect(candidates, 3, 0.7)).toEqual(mmrSelect(candidates, 3, 0.7));
  });
});

describe("normalizeScores", () => {
  it("maps to [0, 1] over the candidate set", () => {
    expect(normalizeScores([10, 5, 0])).toEqual([1, 0.5, 0]);
  });

  it("maps an all-equal set to 1, not to 0/0", () => {
    // Zeroing the relevance term would silently leave PURE diversity, which is a very different
    // ranking arriving with no warning.
    expect(normalizeScores([3, 3, 3])).toEqual([1, 1, 1]);
    expect(normalizeScores([])).toEqual([]);
  });
});

describe("createLexicalOverlapReranker — the deterministic default", () => {
  const reranker = createLexicalOverlapReranker();

  it("declares itself deterministic, so a report never mistakes it for a real cross-encoder", () => {
    expect(reranker.kind).toBe("deterministic");
    expect(reranker.id).toBe("lexical-overlap");
  });

  it("orders by symmetric token overlap, ties broken by id", async () => {
    const ranked = await reranker.rerank("parseJwtHeader token", [
      { id: "far", text: "export function connectDatabase(url) {}" },
      { id: "near", text: "export function parseJwtHeader(token) {}" },
    ]);
    expect(ranked[0].id).toBe("near");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("normalises by the UNION, so a huge chunk cannot win on vocabulary size alone", async () => {
    const ranked = await reranker.rerank("refresh token", [
      { id: "focused", text: "refresh(token) {}" },
      { id: "huge", text: `refresh token ${"unrelated ".repeat(200)}` },
    ]);
    expect(ranked[0].id).toBe("focused");
  });

  it("scores 0 for an empty query or an untokenizable candidate, without NaN", async () => {
    expect((await reranker.rerank("", [{ id: "a", text: "x y z" }]))[0].score).toBe(0);
    expect((await reranker.rerank("query", [{ id: "a", text: "!!!" }]))[0].score).toBe(0);
    expect(await reranker.rerank("q", [])).toEqual([]);
  });

  it("is deterministic", async () => {
    const candidates = [{ id: "a", text: "alpha beta" }, { id: "b", text: "beta gamma" }];
    expect(await reranker.rerank("beta", candidates)).toEqual(await reranker.rerank("beta", candidates));
  });
});

describe("createIdentityReranker", () => {
  it("preserves the incoming order exactly (an explicit 'reranking off')", async () => {
    const ranked = await createIdentityReranker().rerank("q", [
      { id: "first", text: "a" },
      { id: "second", text: "b" },
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual(["first", "second"]);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
});

describe("createCrossEncoderReranker — integration-ready, hermetically tested", () => {
  function fakeSession(scores: Record<string, number>, calls: Array<Array<{ query: string; document: string }>> = []): CrossEncoderSession {
    return {
      model: "fake-reranker",
      async score(pairs) {
        calls.push([...pairs]);
        return pairs.map((pair) => scores[pair.document] ?? 0);
      },
    };
  }

  it("declares kind 'cross-encoder' and names the model in its id", () => {
    const reranker = createCrossEncoderReranker({ session: fakeSession({}) });
    expect(reranker.kind).toBe("cross-encoder");
    expect(reranker.id).toBe("cross-encoder:fake-reranker");
  });

  it("orders by the model's score", async () => {
    const reranker = createCrossEncoderReranker({ session: fakeSession({ low: 0.1, high: 0.9 }) });
    const ranked = await reranker.rerank("q", [{ id: "a", text: "low" }, { id: "b", text: "high" }]);
    expect(ranked.map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("batches pairs so the model is not called once per candidate", async () => {
    const calls: Array<Array<{ query: string; document: string }>> = [];
    const reranker = createCrossEncoderReranker({ session: fakeSession({}, calls), batchSize: 2 });
    await reranker.rerank("q", Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, text: `t${i}` })));
    expect(calls.map((batch) => batch.length)).toEqual([2, 2, 1]);
  });

  it("truncates a long candidate deterministically rather than letting the tokenizer do it", async () => {
    // Silent tokenizer truncation means the model scored a prefix while the caller believed it
    // scored the chunk. Doing it here at least makes it the SAME prefix every time.
    const calls: Array<Array<{ query: string; document: string }>> = [];
    const reranker = createCrossEncoderReranker({ session: fakeSession({}, calls), maxCandidateChars: 10 });
    await reranker.rerank("q", [{ id: "a", text: "x".repeat(500) }]);
    expect(calls[0][0].document).toHaveLength(10);
  });

  it("THROWS on a misaligned score array rather than attaching scores to the wrong candidates", async () => {
    const broken: CrossEncoderSession = { model: "broken", async score() { return [0.5]; } };
    const reranker = createCrossEncoderReranker({ session: broken });
    await expect(
      reranker.rerank("q", [{ id: "a", text: "a" }, { id: "b", text: "b" }]),
    ).rejects.toThrow(/returned 1 scores for 2 pairs/);
  });

  it("rejects on a model failure rather than silently falling back", async () => {
    // The fallback decision belongs to the caller (hybridSearch), where the trace can record
    // it — otherwise "broken" is indistinguishable from "had no opinion".
    const failing: CrossEncoderSession = { model: "failing", async score() { throw new Error("session closed"); } };
    await expect(
      createCrossEncoderReranker({ session: failing }).rerank("q", [{ id: "a", text: "a" }]),
    ).rejects.toThrow(/session closed/);
  });

  it("returns nothing for no candidates, without calling the model", async () => {
    const calls: Array<Array<{ query: string; document: string }>> = [];
    expect(await createCrossEncoderReranker({ session: fakeSession({}, calls) }).rerank("q", [])).toEqual([]);
    expect(calls).toEqual([]);
  });
});
