import { RAG_MIN_SIMILARITY, RAG_TOP_K } from "@codeflow/config";
import {
  hybridSearch,
  type ChunkTextStore,
  type Reranker,
  type VectorStore,
} from "@codeflow/retrieval";
import type { EmbeddingClient } from "@codeflow/analyzers";
import { assertEmbeddingSpace } from "@codeflow/retrieval";
import type { AgentTool, ToolArgs, ToolContext, ToolResult } from "../contracts.js";

/**
 * `search_code` — V3-P2's hybrid retrieval, as a tool (V3-P3 task 1).
 *
 * THE IMPORTANT PROPERTY: the similarity floor still lives INSIDE this tool, in
 * `hybridSearch`, evaluated on the vector arm's real cosine. An agent cannot argue its way past
 * it, cannot retry around it, and cannot reach the chunks below it — a refusal from this tool is
 * a fact the agent has to work with, which is precisely what keeps the honest-no-answer behaviour
 * intact once a model is driving the loop. There is no `minSimilarity` argument for the model to
 * set, deliberately: exposing one would be exposing the refusal gate as a tunable.
 *
 * `k` IS capped rather than trusted, for the same reason. A model that asks for 200 chunks is
 * asking to blow the context window, and the cap is a constant rather than a suggestion.
 */

export interface SearchToolDeps {
  vectorStore: VectorStore;
  textStore: ChunkTextStore;
  embeddingClient: EmbeddingClient;
  /** Optional; `hybridSearch` runs the fused order unchanged when absent. */
  reranker?: Reranker;
  /** Default result count. */
  k?: number;
  /** Hard ceiling on a model-requested `k`. */
  maxK?: number;
  minSimilarity?: number;
}

const DEFAULT_MAX_K = 10;

export function createSearchTool(deps: SearchToolDeps): AgentTool {
  const defaultK = deps.k ?? RAG_TOP_K;
  const maxK = deps.maxK ?? DEFAULT_MAX_K;
  const minSimilarity = deps.minSimilarity ?? RAG_MIN_SIMILARITY;

  return {
    id: "search_code",
    description:
      "search_code(query, k?) — semantic + keyword search over the repository's indexed code. " +
      "Returns code chunks with file + line ranges, which are the ONLY things you may cite with line numbers. " +
      "Returns nothing when the repository has no relevant code; that is a real answer, not a reason to retry.",
    // No triggers: this is the general-purpose tool and is always a candidate (see `curateTools`).
    args: ["query", "k"],
    async run(args: ToolArgs, context: ToolContext): Promise<ToolResult> {
      const rawQuery = args.query ?? args.q ?? args.text;
      const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
      if (!query) return { text: "search_code needs a `query` argument.", empty: true };

      const ragIndex = context.result.ai?.rag;
      if (!ragIndex) {
        return { text: "This analysis has no searchable code index (the RAG stage did not run).", empty: true };
      }

      // Same guard as the single-shot path: a query embedded in a different space than the index
      // produces a confident, meaningless ranking.
      assertEmbeddingSpace(deps.embeddingClient, ragIndex, "RAG index");

      const requestedK = typeof args.k === "number" && Number.isFinite(args.k) ? Math.floor(args.k) : defaultK;
      const k = Math.max(1, Math.min(requestedK, maxK));

      let vectors: number[][];
      try {
        ({ vectors } = await deps.embeddingClient.embed({ texts: [query], inputType: "query" }));
      } catch (error) {
        // Surfaced as a tool ERROR rather than as "found nothing": the agent must not read a
        // provider outage as evidence that the repository contains nothing relevant.
        return { text: "search_code failed to embed the query.", error: error instanceof Error ? error.message : String(error) };
      }

      const found = await hybridSearch(
        {
          ragIndex,
          vectorStore: deps.vectorStore,
          textStore: deps.textStore,
          ...(deps.reranker ? { reranker: deps.reranker } : {}),
        },
        { text: query, vector: vectors[0], k, minSimilarity },
      );

      if (found.trace.refused || found.chunks.length === 0) {
        return {
          text:
            `No code in this repository is relevant to "${query}" ` +
            `(best similarity ${found.trace.topVectorScore.toFixed(3)}, below the ${minSimilarity} floor). ` +
            "Do not guess an answer from outside the repository.",
          empty: true,
        };
      }

      const rendered = found.chunks
        .map(
          (chunk) =>
            `--- chunk ${chunk.id} (file ${chunk.fileId}, lines ${chunk.startLine}-${chunk.endLine}` +
            `${chunk.symbolName ? `, symbol ${chunk.symbolName}` : ""})\n${chunk.text}`,
        )
        .join("\n");

      return {
        text: `${found.chunks.length} chunk(s) for "${query}":\n${rendered}`,
        chunks: found.chunks,
        fileIds: [...new Set(found.chunks.map((chunk) => chunk.fileId))].sort(),
        empty: false,
      };
    },
  };
}
