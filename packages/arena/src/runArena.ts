import type { AgentHarness, ArenaRunResult, Sandbox, TaskSpec, Verifier } from "./contracts.js";
import { meanScore } from "./reward.js";

/**
 * Run one task through an agent and grade it with every verifier that supports it.
 *
 * `passed` requires EVERY verifier that ran to pass, not the mean to clear a bar: a correct
 * answer that cites a file which does not exist is not 80% correct, it is ungrounded. Averaging
 * would let a grounding failure be paid for with accuracy elsewhere, which is precisely the
 * trade this project refuses to make.
 */
export async function runArenaTask(
  task: TaskSpec,
  agent: AgentHarness,
  sandbox: Sandbox,
  verifiers: Verifier[],
): Promise<ArenaRunResult> {
  const output = await agent.run(task, sandbox);
  const applicable = verifiers.filter((verifier) => verifier.supports(task));

  const verifications = [];
  for (const verifier of applicable) {
    verifications.push(await verifier.verify(task, output, sandbox));
  }

  return {
    task,
    agentId: agent.id,
    output,
    verifications,
    score: meanScore(verifications.map((entry) => entry.reward)),
    // No verifier ran ⇒ nothing was verified ⇒ NOT a pass. Silence is not success.
    passed: verifications.length > 0 && verifications.every((entry) => entry.passed),
  };
}

/** Run a whole task set, in order, against one agent. */
export async function runArena(
  tasks: TaskSpec[],
  agent: AgentHarness,
  sandbox: Sandbox,
  verifiers: Verifier[],
): Promise<ArenaRunResult[]> {
  const results: ArenaRunResult[] = [];
  for (const task of tasks) {
    results.push(await runArenaTask(task, agent, sandbox, verifiers));
  }
  return results;
}
