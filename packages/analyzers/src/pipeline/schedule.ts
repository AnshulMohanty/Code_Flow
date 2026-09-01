import type { AnalysisSliceKey, PipelineStage, PipelineStageId } from "@codeflow/shared-types";

/**
 * DAG-LAYERED SCHEDULING (V3-P5 task 1).
 *
 * WHAT THE DAG ACTUALLY LOOKS LIKE, measured from the code rather than assumed:
 *
 *   ingest → orient → map-structure → inventory → connect → analyze → ┬ synthesize
 *                                                                     └ rag
 *
 * The deterministic chain is genuinely LINEAR, and that is not a missed opportunity — each stage
 * consumes the slice the previous one produced (map-structure reads `orientation`, inventory reads
 * `structure`, connect reads both, analyze reads `graph`). Parallelising a chain whose every link is
 * a real data dependency would either produce wrong output or require duplicating work.
 *
 * The ONE independent pair is `synthesize` and `rag` — and they happen to be the two AI stages, i.e.
 * the two slowest and the only provider-bound ones. So the honest summary is: there is exactly one
 * parallel layer in this pipeline, and it is the layer worth having. A four-way fan-out over the
 * parse chain would have looked more impressive on a diagram and been slower and wrong.
 *
 * DEPENDENCIES ARE DECLARED, NOT INFERRED. `STAGE_READS` states what each stage reads from
 * `ctx.prior`, and `stage.owns` already states what it writes; the layering is Kahn's algorithm over
 * those. Inferring reads (by grepping, or by proxying `ctx.prior`) would be clever and fragile — a
 * stage that starts reading a new slice must declare it, and the contract test below fails if the
 * declaration and the code disagree about a slice nobody produces.
 *
 * DETERMINISM IS PRESERVED, and this is the part that matters most given the invariant. Within a
 * layer, stages run concurrently but:
 *   - every stage sees the SAME `ctx.prior` snapshot (taken before the layer starts),
 *   - slices are assigned AFTER the layer settles, in declared order,
 *   - per-stage records are ordered by declaration, not by completion.
 * So the RESULT is byte-identical to the sequential run — asserted by a test that runs both and
 * compares. What is NOT deterministic is the ORDER progress EVENTS arrive in within a layer, and
 * that is deliberate: an event stream is a live UI signal, and buffering it to preserve an order
 * nobody depends on would delay feedback for no benefit.
 */

/**
 * What each stage READS from `ctx.prior`. Declared here so the schedule is derivable without
 * executing anything.
 *
 * Note what is NOT in this map: `ctx.repoPath` and `ctx.commitSha`. Those are ambient context that
 * Ingest bootstraps rather than slices, so every non-Ingest stage depends on Ingest by construction.
 * That is modelled as `INGEST_FIRST` rather than by inventing a fake slice, because a fake slice
 * would show up in the coverage partition and in the cache logic.
 */
export const STAGE_READS: Record<PipelineStageId, readonly AnalysisSliceKey[]> = {
  ingest: [],
  orient: [],
  "map-structure": ["orientation"],
  inventory: ["structure"],
  connect: ["structure", "inventory"],
  analyze: ["graph"],
  synthesize: ["graph", "metrics", "orientation", "structure", "inventory"],
  rag: ["graph", "structure", "inventory"],
};

/** Ingest bootstraps `ctx.repoPath`/`ctx.commitSha`, which is an ambient dependency for everything
 *  else rather than a slice. Modelled explicitly instead of as a phantom slice. */
const INGEST_FIRST: PipelineStageId = "ingest";

export interface StageLayer {
  /** 0-based layer index. */
  index: number;
  stages: PipelineStage[];
}

export interface SchedulePlan {
  layers: StageLayer[];
  /** Stages per layer, e.g. [1,1,1,1,1,1,2] — the shape a reader wants to see. */
  shape: number[];
  /** True when at least one layer holds more than one stage (i.e. layering can help at all). */
  hasParallelism: boolean;
  /** The one number worth quoting: how many stage-slots could overlap. */
  maxLayerWidth: number;
}

/**
 * Compute the layers. Pure, deterministic, and total.
 *
 * Kahn's algorithm over the declared reads, with two properties chosen for safety over cleverness:
 *
 *   1. A dependency on a slice NOBODY in this run produces is IGNORED rather than treated as
 *      unsatisfiable. That is required, not lax: the pipeline legitimately runs without the AI
 *      stages (no keys configured), so `synthesize`'s read of `metrics` must not deadlock a run
 *      where `analyze` was omitted — and a stage whose input is genuinely missing already fails
 *      loudly at run time with a better message than a scheduler could give.
 *   2. A CYCLE (which would be a programming error in `STAGE_READS`) does not hang: the remaining
 *      stages are emitted as one final layer and `assertAcyclic` is available to fail loudly in a
 *      test. Silently hanging a production pipeline on a bad declaration would be the worst outcome.
 *
 * Order within a layer is the stages' DECLARED order, so the plan is reproducible.
 */
export function computeLayers(stages: readonly PipelineStage[]): SchedulePlan {
  const producedBy = new Map<AnalysisSliceKey, PipelineStageId>();
  for (const stage of stages) {
    for (const key of stage.owns) producedBy.set(key, stage.id);
  }
  const present = new Set(stages.map((stage) => stage.id));
  const ingestPresent = present.has(INGEST_FIRST);

  /** The stage ids this stage must wait for — only those actually in this run. */
  const dependenciesOf = (stage: PipelineStage): Set<PipelineStageId> => {
    const deps = new Set<PipelineStageId>();
    for (const key of STAGE_READS[stage.id] ?? []) {
      const producer = producedBy.get(key);
      // Rule 1: an unproduced slice is not a dependency (see the doc comment).
      if (producer && producer !== stage.id) deps.add(producer);
    }
    if (ingestPresent && stage.id !== INGEST_FIRST) deps.add(INGEST_FIRST);
    return deps;
  };

  const remaining = [...stages];
  const done = new Set<PipelineStageId>();
  const layers: StageLayer[] = [];

  while (remaining.length > 0) {
    const ready = remaining.filter((stage) => [...dependenciesOf(stage)].every((dep) => done.has(dep)));
    if (ready.length === 0) {
      // Rule 2: a cycle. Emit the rest as one layer rather than looping forever.
      layers.push({ index: layers.length, stages: [...remaining] });
      break;
    }
    layers.push({ index: layers.length, stages: ready });
    for (const stage of ready) {
      done.add(stage.id);
      remaining.splice(remaining.indexOf(stage), 1);
    }
  }

  const shape = layers.map((layer) => layer.stages.length);
  const maxLayerWidth = shape.length === 0 ? 0 : Math.max(...shape);
  return { layers, shape, hasParallelism: maxLayerWidth > 1, maxLayerWidth };
}

/**
 * Fail loudly on a cyclic or self-referential declaration. For tests and for a boot-time check —
 * NOT called by `computeLayers`, which must stay total.
 */
export function assertAcyclic(stages: readonly PipelineStage[]): void {
  const plan = computeLayers(stages);
  const scheduled = plan.layers.reduce((sum, layer) => sum + layer.stages.length, 0);
  if (scheduled !== stages.length) {
    throw new Error(`Stage schedule is not a DAG: ${stages.length - scheduled} stage(s) could not be ordered.`);
  }
  // A layer that is wider than the number of stages that could genuinely be independent usually
  // means a missing declaration, so surface the shape in the error rather than only the count.
  for (const layer of plan.layers) {
    const owned = new Set<AnalysisSliceKey>();
    for (const stage of layer.stages) {
      for (const key of stage.owns) {
        if (owned.has(key)) throw new Error(`Two stages in layer ${layer.index} both own the slice "${key}".`);
        owned.add(key);
      }
    }
    // A stage must not read a slice written by a stage in its OWN layer — that is the invariant that
    // makes concurrent execution within a layer safe.
    for (const stage of layer.stages) {
      for (const key of STAGE_READS[stage.id] ?? []) {
        if (owned.has(key) && !stage.owns.includes(key)) {
          throw new Error(
            `Stage "${stage.id}" is in layer ${layer.index} but reads "${key}", which another stage in the same layer owns.`,
          );
        }
      }
    }
  }
}

/**
 * Human-readable plan, for a log line at boot. Names the layers with more than one stage, since
 * those are the only ones layering changes anything for.
 */
export function describeSchedule(plan: SchedulePlan): string {
  const widened = plan.layers.filter((layer) => layer.stages.length > 1);
  const base = `${plan.layers.length} layer(s), shape [${plan.shape.join(",")}], max width ${plan.maxLayerWidth}`;
  if (widened.length === 0) return `${base} — fully sequential (no independent stages in this run)`;
  return (
    `${base} — parallel: ` +
    widened.map((layer) => `layer ${layer.index} { ${layer.stages.map((stage) => stage.id).join(" ∥ ")} }`).join(", ")
  );
}
