# `packages/eval/results/`

Drop a real `AnalysisResult` here, named after its dataset, before running the scored eval:

```
packages/eval/results/chalk.json
packages/eval/results/requests.json
```

Each file is the JSON `AnalysisResult` from a **full pipeline run** — including the AI stages —
against that dataset's pinned SHA. The scored runner grades a result you already produced; it
does not clone or analyze anything itself, because the cloner, queue and provider wiring live
in `apps/worker` and the run needs the owner's provider key.

The index **must** be built in the dataset's embedding space (`embeddingModel` / `embeddingDim`).
`runEval`'s homogeneity guard refuses to score across two embedding spaces rather than
returning a meaningless cosine.

Result files are gitignored: they are large, they are derived, and they are pinned to a key.
