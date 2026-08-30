import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmProvider,
  ModelTask,
  RoutingHint,
} from "./llmClient.js";

/**
 * MODEL ROUTING (V3-P5 task 1) — behind the existing provider abstraction.
 *
 * THE OBSERVATION. Not every call in this system needs the same model. A specialist summarising a
 * three-file, low-coupling community is doing something a small fast model does well; the SUPERVISOR
 * composing a global reading order from a bounded blackboard is the one call where reasoning quality
 * shows up in the output a user reads. Paying frontier prices for the first is waste, and paying
 * small-model prices for the second is a worse product.
 *
 * THE IMPLEMENTATION CHOICE THAT MATTERS: `createRoutedLlmClient` **is itself an `LlmClient`**. It
 * does not sit beside the abstraction or above it — it implements it and delegates. So the fan-out,
 * the agent loop, the synthesize stage and every test that injects a client are all unchanged, and
 * routing can be added or removed at the composition root without touching a single call site. A
 * router exposed as a new interface would have meant editing every consumer to know about tiers.
 *
 * ROUTED BY WHAT: the caller states the KIND of work and, for community work, the P4 complexity
 * score. Both are already computed deterministically and for free — `complexityOf` is pure — so
 * routing costs nothing and is reproducible. Routing by inspecting the prompt (length, keywords)
 * was the obvious alternative and is worse: prompt length is a proxy for the wrong thing, and a
 * keyword heuristic would silently mis-route the day a prompt is reworded.
 *
 * WHAT IT REPORTS. `model` on the result of a routed call is the model that actually ran, and the
 * router records a decision log. Without that, a cost review of a mixed-tier run is guesswork.
 */

/**
 * `ModelTask` and `RoutingHint` live in `./llmClient.js`, with the request contract they belong to —
 * see the note there on why that placement is what lets a router BE an `LlmClient`.
 *
 * Which task maps to which tier is a POLICY, and policy lives here.
 */
export type { ModelTask, RoutingHint } from "./llmClient.js";

export type ModelTier = "fast" | "frontier";

export interface RoutingDecision {
  task: ModelTask;
  tier: ModelTier;
  /** The community complexity that informed it, when the call was community work. */
  complexity?: number;
  model: string;
  provider: LlmProvider;
  reason: string;
}

/** Kept as an alias for readability at call sites. `LlmCompletionRequest` already carries the
 *  optional hint, so an un-hinted call still works and takes the default tier for its task. */
export type RoutedCompletionRequest = LlmCompletionRequest;

export interface ModelRouterOptions {
  /** The cheap, fast model. */
  fast: LlmClient;
  /** The strong model. May be the SAME client as `fast` — see `createRoutedLlmClient`. */
  frontier: LlmClient;
  /**
   * Complexity at or above which a `specialist` call escalates to the frontier tier. Defaults to
   * the same threshold P4 uses to route a community hard, so "hard enough for best-of-N" and "hard
   * enough for the better model" are ONE decision rather than two that can drift apart.
   */
  escalateAtComplexity?: number;
  /** Called for every decision, so a mixed-tier run is auditable. */
  onDecision?(decision: RoutingDecision): void;
}

/**
 * The default tier per task, stated as a table because that is what it is.
 *
 * `supervisor` and `synthesis` are frontier because their output is the artefact a user reads.
 * `specialist` is fast BY DEFAULT and escalates on complexity — most communities are small.
 * `agent-turn` is frontier: a wrong tool choice costs a whole extra turn, so the cheaper model is
 * not actually cheaper. `judge` is frontier because a judge is a measurement instrument and a cheap
 * one measures its own limitations. `classification` is fast, which is the entire point of having
 * a fast tier.
 */
const DEFAULT_TIERS: Record<ModelTask, ModelTier> = {
  specialist: "fast",
  supervisor: "frontier",
  synthesis: "frontier",
  "agent-turn": "frontier",
  judge: "frontier",
  classification: "fast",
};

/** Mirrors `HARD_COMMUNITY_COMPLEXITY` from @codeflow/config. Duplicated as a default rather than
 *  imported so this module stays dependency-free; the caller passes the real constant. */
const DEFAULT_ESCALATE_AT = 0.6;

/**
 * Decide the tier. Pure and deterministic — no model, no clock, no RNG.
 */
export function routeTier(hint: RoutingHint | undefined, escalateAt = DEFAULT_ESCALATE_AT): { tier: ModelTier; reason: string } {
  if (!hint) {
    // An un-hinted call is treated as frontier, not fast. Defaulting DOWN would silently downgrade
    // every call site that had not been updated yet — a quality regression nobody asked for and
    // nobody would see in a diff.
    return { tier: "frontier", reason: "no routing hint (defaults to frontier, never down)" };
  }
  const base = DEFAULT_TIERS[hint.task] ?? "frontier";
  if (hint.task === "specialist" && typeof hint.complexity === "number" && hint.complexity >= escalateAt) {
    return { tier: "frontier", reason: `specialist on a complex community (${hint.complexity.toFixed(2)} >= ${escalateAt})` };
  }
  return { tier: base, reason: `default tier for task "${hint.task}"` };
}

/**
 * A routing `LlmClient`. Reports the FRONTIER client's identity as its own `provider`/`model`,
 * because that is what a cache key must be scoped by: two tiers sharing one cache key would let a
 * fast-model completion be served to a frontier-model call. Individual results still report the
 * model that actually ran.
 */
export function createRoutedLlmClient(options: ModelRouterOptions): LlmClient & { decisions: RoutingDecision[] } {
  const escalateAt = options.escalateAtComplexity ?? DEFAULT_ESCALATE_AT;
  const decisions: RoutingDecision[] = [];

  return {
    provider: options.frontier.provider,
    // Scoped so a cache key cannot collide across tiers. The `+fast:` segment names the other tier
    // explicitly rather than hashing it, because a cache key you cannot read is a cache key you
    // cannot debug.
    model:
      options.fast.model === options.frontier.model
        ? options.frontier.model
        : `${options.frontier.model}+fast:${options.fast.model}`,
    decisions,
    async complete(request: RoutedCompletionRequest): Promise<LlmCompletionResult> {
      const { tier, reason } = routeTier(request.routing, escalateAt);
      const client = tier === "fast" ? options.fast : options.frontier;
      const decision: RoutingDecision = {
        task: request.routing?.task ?? "synthesis",
        tier,
        ...(request.routing?.complexity !== undefined ? { complexity: request.routing.complexity } : {}),
        model: client.model,
        provider: client.provider,
        reason,
      };
      decisions.push(decision);
      options.onDecision?.(decision);
      // The hint is STRIPPED before delegating: it is routing metadata, and a provider adapter that
      // received an unknown field would either ignore it or reject the request.
      const { routing: _routing, ...forwarded } = request;
      return client.complete(forwarded);
    },
  };
}

/**
 * Build a router from whatever is configured, honestly.
 *
 * Returns the single client UNWRAPPED when only one is available. That matters: wrapping one client
 * in a router that always picks it would report a two-tier model string, scope every cache key to a
 * routing setup that does not exist, and invalidate the existing cache for no benefit.
 */
export function maybeRouted(
  fast: LlmClient | null | undefined,
  frontier: LlmClient | null | undefined,
  options: Omit<ModelRouterOptions, "fast" | "frontier"> = {},
): LlmClient | null {
  if (!frontier && !fast) return null;
  if (!fast || !frontier) return (frontier ?? fast) as LlmClient;
  if (fast.provider === frontier.provider && fast.model === frontier.model) return frontier;
  return createRoutedLlmClient({ fast, frontier, ...options });
}
