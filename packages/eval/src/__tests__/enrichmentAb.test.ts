import { describe, expect, it } from "vitest";
import {
  AB_QUESTIONS,
  buildAbChunks,
  hashingEmbed,
  runEnrichmentAb,
  summarizeAb,
} from "../enrichmentAb.js";

// V3-P2 task 2 acceptance, measured hermetically. See enrichmentAb.ts for what this A/B does
// and does NOT establish: it measures the MECHANISM (a query matching vocabulary the raw text
// lacks) with a deterministic bag-of-words embedder, not the magnitude a real embedding model
// would show. The real-model number on the golden set needs a key and is deferred.

const report = await runEnrichmentAb(3);

describe("enrichment A/B — recall@k improves, and nothing regresses", () => {
  it("mean recall@3 is strictly HIGHER with enrichment", () => {
    expect(report.enriched.meanRecallAtK).toBeGreaterThan(report.raw.meanRecallAtK);
    expect(report.recallDelta).toBeGreaterThan(0);
  });

  it("MRR improves too — the answers move UP the ranking, not just into it", () => {
    expect(report.mrrDelta).toBeGreaterThan(0);
  });

  it("loses NOTHING the raw index found — the gate that matters most", () => {
    // A change that trades one set of answers for another is not an improvement, however good
    // the mean looks. `ab5` ("padStart zero padding") exists specifically as a control that is
    // answerable from the raw bytes alone.
    expect(report.lostByEnrichment).toEqual([]);
    const control = report.enriched.perQuestion.find((entry) => entry.id === "ab5");
    expect(control?.recallAtK).toBe(1);
  });

  it("wins the questions whose answer text does not contain the query's words", () => {
    // Each of these is a real failure mode: a split-symbol body fragment with no class name
    // (ab1), a fact stated only in a doc comment above the range (ab2), a concept that exists
    // only in the file path (ab3). Measured: recall 0.500 -> 1.000, MRR 0.333 -> 0.667.
    expect(report.wonByEnrichment).toEqual(["ab1", "ab2", "ab3"]);
  });

  it("finds a method body through its enclosing class name (the split-symbol case)", () => {
    // `#10-12` is `verify(...)` + `sign(...)` + a closing brace. The words "TokenService" and
    // "refresh" appear nowhere in it — line 9, which carries the signature, landed in the
    // previous sub-chunk. Its enrichment recovers scope `refresh` and the class signature, and
    // that is the entire difference between reachable and unreachable.
    const enriched = report.enriched.perQuestion.find((entry) => entry.id === "ab1");
    const raw = report.raw.perQuestion.find((entry) => entry.id === "ab1");
    expect(enriched?.retrieved).toContain("src/auth/tokenService.ts#10-12");
    expect(raw?.retrieved).not.toContain("src/auth/tokenService.ts#10-12");
  });

  it("finds a chunk through a doc comment that sits ABOVE its line range", () => {
    const enriched = report.enriched.perQuestion.find((entry) => entry.id === "ab2");
    const raw = report.raw.perQuestion.find((entry) => entry.id === "ab2");
    expect(enriched?.recallAtK).toBe(1);
    expect(raw?.recallAtK).toBe(0);
  });

  it("finds a file through its PATH words when the code never says them", () => {
    // "session store" is only in `src/storage/sessionStore.ts`; the bodies say `rows.set`.
    const enriched = report.enriched.perQuestion.find((entry) => entry.id === "ab3");
    expect(enriched?.recallAtK).toBeGreaterThan(0);
  });

  it("promotes a Python sub-chunk from rank 3 to rank 1 (a RANKING win, not a recall one)", () => {
    // Reported as what it is. `#5-7` says `should_stop` and `attempt` but never `Policy` or
    // `retry`, so the raw arm does find it — at rank 3, behind two chunks that merely share a
    // word. The enrichment's class signature and path words move it to rank 1. Recall@3 is
    // unchanged, which is why this is asserted on reciprocal rank: claiming a recall win here
    // would be claiming something that did not happen.
    const enriched = report.enriched.perQuestion.find((entry) => entry.id === "ab4");
    const raw = report.raw.perQuestion.find((entry) => entry.id === "ab4");
    expect(raw?.recallAtK).toBe(1);
    expect(enriched?.recallAtK).toBe(1);
    expect(enriched!.reciprocalRank).toBeGreaterThan(raw!.reciprocalRank);
    expect(enriched!.reciprocalRank).toBe(1);
  });

  it("is deterministic — two runs produce a byte-identical report", async () => {
    const again = await runEnrichmentAb(3);
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
  });

  it("summarizes both arms and the delta in one line", () => {
    // The pattern allows 1.000 as well as 0.xxx — the enriched arm reaches perfect recall on
    // this corpus, and a regex that only matched a leading zero would fail on the good outcome.
    expect(summarizeAb(report)).toMatch(/recall [01]\.\d+ → [01]\.\d+ \(\+\d\.\d+\)/);
    expect(summarizeAb(report)).toContain("won 3, lost 0");
  });
});

describe("enrichment A/B — the harness itself", () => {
  it("builds chunks whose ids are `fileId#start-end`, unchanged by enrichment", () => {
    // Acceptance condition from the task: the chunk id must not change. Ids are derived from
    // ranges, and enrichment is a post-pass over ranges, so this holds by construction — pinned
    // here so a future refactor that folds enrichment INTO planning cannot break it silently.
    for (const chunk of buildAbChunks()) {
      expect(chunk.id).toBe(`${chunk.fileId}#${chunk.startLine}-${chunk.endLine}`);
    }
  });

  it("keeps every chunk's stored text byte-exact for its line range", () => {
    // The enrichment is a prefix on the EMBEDDED text only. If it leaked into `text`, every
    // citation would resolve to a line range whose content had been rewritten.
    for (const chunk of buildAbChunks()) {
      expect(chunk.enrichedText.endsWith(`\n\n${chunk.text}`)).toBe(true);
    }
  });

  it("scores every authored question", () => {
    expect(report.enriched.perQuestion).toHaveLength(AB_QUESTIONS.length);
    expect(report.raw.perQuestion).toHaveLength(AB_QUESTIONS.length);
  });
});

describe("hashingEmbed — the deterministic stand-in embedder", () => {
  it("is L2-normalised, so cosine is an angle and long chunks are not penalised", () => {
    const vector = hashingEmbed("export class TokenService {}");
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1);
  });

  it("returns a zero vector for text with no tokens (rather than NaN)", () => {
    expect(hashingEmbed("!!! ...")).toEqual(new Array(64).fill(0));
  });

  it("is deterministic across calls and process-independent (no Math.random, no clock)", () => {
    expect(hashingEmbed("refresh token")).toEqual(hashingEmbed("refresh token"));
  });

  it("scores shared vocabulary higher than unrelated text", () => {
    const query = hashingEmbed("refresh bearer token");
    const near = hashingEmbed("refresh(previous: string): string");
    const far = hashingEmbed("String(n).padStart(2, '0')");
    const cos = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);
    expect(cos(query, near)).toBeGreaterThan(cos(query, far));
  });
});
