import { describe, expect, it } from "vitest";
import type { AnalysisResult, DegradationReason } from "@codeflow/shared-types";
import {
  AI_UNAVAILABLE_COPY,
  MAP_ONLY_COPY,
  aiAvailability,
  degradationCopy,
  effectiveChoice,
  mentionsEnvVar,
  modeBadge,
  ragCoverageNote,
  visitorBanners,
  visitorWarnings,
  withAiFor,
} from "./aiMode";
import type { MetaState } from "./useMeta";

/**
 * The copy a visitor reads about the two modes. Every reason has its own sentence, none of them
 * names an environment variable, and the two the owner specified are word for word.
 */

const ALL_REASONS: DegradationReason[] = [
  "no-chat-provider",
  "no-embedding-provider",
  "mongo-unavailable",
  "redis-unavailable",
  "budget-exhausted",
  "map-only",
  "ai-unavailable",
];

function result(overrides: Partial<AnalysisResult>): AnalysisResult {
  return { id: "a", repository: { provider: "github", owner: "o", name: "r" }, warnings: [], ...overrides } as AnalysisResult;
}

function meta(facts: Record<string, unknown> | null, status: MetaState["status"] = "ready"): MetaState {
  if (status === "loading") return { status, facts: null, error: null };
  if (status === "error") return { status, facts: null, error: "HTTP 500" };
  return { status: "ready", error: null, facts: { analyzerVersion: "1", build: null, answerLatency: { p50Ms: null, p95Ms: null, sampleCount: 0, scope: "p" }, indexed: [], serverTime: "", ...facts } as never };
}

describe("banner copy per degradation reason", () => {
  it("states Map only exactly as specified", () => {
    expect(degradationCopy("map-only").text).toBe(
      "Map only — no AI was used. Switch to Map + AI to add the guide and Q&A.",
    );
    expect(MAP_ONLY_COPY).toBe(degradationCopy("map-only").text);
  });

  it("states an unavailable AI exactly as specified, and that the map is complete", () => {
    expect(degradationCopy("ai-unavailable").text).toBe(
      "AI is unavailable right now (limit or credit reached). The map is complete.",
    );
    expect(AI_UNAVAILABLE_COPY).toBe(degradationCopy("ai-unavailable").text);
  });

  it("gives EVERY reason its own sentence, none naming an environment variable", () => {
    const texts = ALL_REASONS.map((reason) => degradationCopy(reason).text);
    expect(new Set(texts).size).toBe(ALL_REASONS.length);
    for (const text of texts) {
      expect(mentionsEnvVar(text)).toBe(false);
      expect(text).not.toMatch(/API_KEY|MONGO|REDIS_URL|env/i);
    }
  });

  it("names the budget cap as capacity, not as a failure", () => {
    expect(degradationCopy("budget-exhausted").text).toMatch(/at capacity/i);
    expect(degradationCopy("budget-exhausted").text).toMatch(/map is complete/i);
  });
});

describe("visitorBanners", () => {
  it("de-duplicates by reason and NEVER renders the worker's detail string", () => {
    const banners = visitorBanners(
      result({
        degradations: [
          { reason: "ai-unavailable", detail: "Provider returned 402: set ANTHROPIC_API_KEY" },
          { reason: "ai-unavailable", detail: "again" },
          { reason: "map-only", detail: "withAi=false" },
        ],
      }),
    );
    expect(banners.map((banner) => banner.reason)).toEqual(["map-only", "ai-unavailable"]);
    for (const banner of banners) expect(banner.text).not.toMatch(/ANTHROPIC|402|withAi/);
  });

  it("still says something for a deterministic-only run that names no reason", () => {
    const banners = visitorBanners(result({ runMode: "deterministic-only", degradations: [] }));
    expect(banners).toHaveLength(1);
    expect(banners[0].text).toMatch(/map is complete/i);
  });

  it("says nothing for a full run", () => {
    expect(visitorBanners(result({ runMode: "full", degradations: [] }))).toEqual([]);
  });
});

describe("operator text is filtered, visitor text is kept verbatim", () => {
  it("drops a warning that names an env var", () => {
    expect(
      visitorWarnings(["Synthesis skipped — set ANTHROPIC_API_KEY or GEMINI_API_KEY.", "3 files skipped (binary)."]),
    ).toEqual(["3 files skipped (binary)."]);
  });

  it("does not mistake ordinary capitals for an env var", () => {
    expect(mentionsEnvVar("Q&A index built with RAG over 412 chunks")).toBe(false);
    expect(mentionsEnvVar("LLM_PRICING is unset")).toBe(true);
  });
});

describe("availability and the request", () => {
  it("AI off on the server ⇒ Map only is forced, whatever was picked", () => {
    const availability = aiAvailability(meta({ ai: { enabled: false, provider: null, chatModel: null, embeddingModel: null } }));
    expect(availability.enabled).toBe(false);
    expect(effectiveChoice("map-ai", availability)).toBe("map-only");
    expect(withAiFor("map-only", availability)).toBe(false);
    expect(modeBadge("map-only", availability)?.label).toBe("Map only");
  });

  it("an older server (no `ai`) behaves as before: no switch, no withAi, no badge", () => {
    const availability = aiAvailability(meta({}));
    expect(availability.offerSwitch).toBe(false);
    expect(withAiFor(effectiveChoice(null, availability), availability)).toBeUndefined();
    expect(modeBadge("map-ai", availability)).toBeNull();
  });

  it("meta not answered yet ⇒ the switch is offered and the server decides", () => {
    const availability = aiAvailability(meta(null, "loading"));
    expect(availability.offerSwitch).toBe(true);
    expect(effectiveChoice(null, availability)).toBe("map-ai");
    expect(modeBadge("map-ai", availability)?.label).toBe("Map + AI");
  });
});

describe("Q&A coverage when the index was capped", () => {
  it("states the cut in one line, with real counts", () => {
    const capped = result({
      ai: {
        rag: {
          chunks: [],
          embeddingModel: "e",
          embeddingDim: 3,
          capped: { chunkCap: 4000, totalChunks: 9120, indexedFiles: 1284, totalFiles: 3102 },
        },
      } as never,
    });
    expect(ragCoverageNote(capped)).toBe("Q&A covers the 1,284 most-connected of 3,102 files.");
  });

  it("says nothing when the index is complete", () => {
    const full = result({ ai: { rag: { chunks: [], embeddingModel: "e", embeddingDim: 3 } } as never });
    expect(ragCoverageNote(full)).toBeNull();
    expect(ragCoverageNote(null)).toBeNull();
  });
});
