import type { Reward } from "./contracts.js";

/**
 * Build a `Reward`. The scalar is what an optimizer reads; the components are kept because a
 * single number cannot say WHY something scored badly, and a reward you cannot decompose is a
 * reward you cannot debug.
 *
 * Every value is clamped to [0,1] here rather than trusted from the caller: a component that
 * silently exceeds 1 would make a mean score exceed 1, and a score above the maximum reads as
 * a broken metric rather than an excellent result.
 */
export function exactReward(score: number, components: Record<string, number>, notes: string[] = []): Reward {
  const clamped: Record<string, number> = {};
  for (const [key, value] of Object.entries(components)) clamped[key] = clamp01(value);
  return { score: clamp01(score), components: clamped, notes };
}

/** Mean of the given rewards' scalars. 0 for an empty set — grading nothing is not a pass. */
export function meanScore(rewards: Reward[]): number {
  if (rewards.length === 0) return 0;
  return rewards.reduce((sum, reward) => sum + reward.score, 0) / rewards.length;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? 1 : value;
}
