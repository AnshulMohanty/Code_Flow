import type { EmbeddingClientLike, EmbeddingSpace } from "./contracts.js";

// The embedding-space homogeneity guard (P12/P13), the one shared helper used by the eval
// harness, the production query path, the RAG index build, and now both store adapters:
// cosine across two embedding spaces is meaningless, so a query/index/dataset built with a
// different model+dim must FAIL LOUD rather than return a confident wrong ranking.
//
// V3-P2 moved this from `@codeflow/analyzers/rag/homogeneity.ts` down into the retrieval
// package, because the stores need it and analyzers depends on retrieval (not the reverse).
// `@codeflow/analyzers` re-exports it, so there is still one definition.

/**
 * Throw if `client` would produce vectors in a different space than `space`
 * (`{ embeddingModel, embeddingDim }` — `Rag`, `EvalDataset` and `VectorStore.space` all
 * satisfy it). `context` names the space for the error message.
 */
export function assertEmbeddingSpace(client: EmbeddingClientLike, space: EmbeddingSpace, context: string): void {
  if (client.model !== space.embeddingModel || client.dimension !== space.embeddingDim) {
    throw new Error(
      `Embedding client (provider ${client.provider}, model ${client.model}, dim ${client.dimension}) does not match ` +
        `the ${context} (model ${space.embeddingModel}, dim ${space.embeddingDim}). Cosine across embedding spaces is meaningless.`,
    );
  }
}

/**
 * Throw if a vector's length is not the store's dimension.
 *
 * This is the same guard one level lower down. `assertEmbeddingSpace` compares CONFIGURED
 * spaces at a boundary; this checks the ACTUAL data, which is what catches a provider that
 * quietly returned a truncated vector, or a caller passing a query embedding from the wrong
 * client. A wrong-length vector is not a runtime error in cosine — the loop just stops at the
 * shorter length and returns a plausible number — so nothing downstream would ever notice.
 */
export function assertVectorDimension(vector: readonly number[], space: EmbeddingSpace, context: string): void {
  if (vector.length !== space.embeddingDim) {
    throw new Error(
      `${context}: vector has ${vector.length} dimensions but the index space (model ${space.embeddingModel}) ` +
        `is ${space.embeddingDim}-dimensional. Cosine over mismatched dimensions silently truncates.`,
    );
  }
}
