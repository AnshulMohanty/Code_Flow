// The embedding-space homogeneity guard (P12/P13), hoisted to one shared helper used by both
// the eval harness and the production query path: cosine across two embedding spaces is
// meaningless, so a query/index/dataset built with a different model+dim must FAIL LOUD.

export interface EmbeddingSpace {
  embeddingModel: string;
  embeddingDim: number;
}

export interface EmbeddingClientLike {
  provider: string;
  model: string;
  dimension: number;
}

/**
 * Throw if `client` would produce vectors in a different space than `space`
 * (`{ embeddingModel, embeddingDim }` — `Rag` and `EvalDataset` both satisfy it). `context`
 * names the space for the error message.
 */
export function assertEmbeddingSpace(client: EmbeddingClientLike, space: EmbeddingSpace, context: string): void {
  if (client.model !== space.embeddingModel || client.dimension !== space.embeddingDim) {
    throw new Error(
      `Embedding client (provider ${client.provider}, model ${client.model}, dim ${client.dimension}) does not match ` +
        `the ${context} (model ${space.embeddingModel}, dim ${space.embeddingDim}). Cosine across embedding spaces is meaningless.`,
    );
  }
}
