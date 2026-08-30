import type { AgentOutput, Sandbox, TaskSpec, VerificationResult, Verifier } from "../contracts.js";
import { exactReward } from "../reward.js";

/**
 * The three GROUNDING passes, wrapped as reusable verifiers (V3-P0 §0.5).
 *
 * These checks already existed and are already enforced in production — inside the synthesize
 * stage, inside the RAG stage, and inside `answerQuestion`. That is where they must stay:
 * grounding has to be enforced at the point of production, not merely measured afterwards.
 * What was missing is a way for the EVAL and the ARENA to apply the same rule to an arbitrary
 * output, without re-implementing it a fourth time and letting the four copies drift.
 *
 * All three are `exact: true` — pure set/range arithmetic, no model, no network.
 */

export const FILE_GROUNDING_VERIFIER_ID = "grounding.fileIds";
export const LINE_RANGE_VERIFIER_ID = "grounding.lineRanges";
export const CITATION_VERIFIER_ID = "grounding.citations";

/**
 * PASS 1 — every claimed fileId must be a real graph node.
 *
 * The failure it catches: a model inventing a plausible path (`src/services/authService.ts`)
 * that does not exist. Plausibility is exactly what makes it dangerous, and a path is either
 * in the node set or it is not, so nothing here needs judgement.
 */
export function createFileGroundingVerifier(): Verifier {
  return {
    id: FILE_GROUNDING_VERIFIER_ID,
    supports: () => true, // any output with fileIds can be grounded
    async verify(_task: TaskSpec, output: AgentOutput, sandbox: Sandbox): Promise<VerificationResult> {
      const claimed = [...new Set([...(output.fileIds ?? []), ...(output.citations ?? []).map((c) => c.fileId)])];
      const ungrounded = claimed.filter((fileId) => !sandbox.hasFile(fileId));
      // No claims at all is trivially grounded: an output that cites nothing has invented
      // nothing. Whether it SHOULD have cited something is a different verifier's question.
      const score = claimed.length === 0 ? 1 : (claimed.length - ungrounded.length) / claimed.length;
      return {
        verifierId: FILE_GROUNDING_VERIFIER_ID,
        passed: ungrounded.length === 0,
        reward: exactReward(
          score,
          { grounded: score },
          ungrounded.length
            ? [`${ungrounded.length} fileId(s) are not in the repository: ${ungrounded.join(", ")}`]
            : [`all ${claimed.length} fileId(s) exist`],
        ),
        exact: true,
      };
    },
  };
}

/**
 * PASS 2 — every cited line range must lie inside the file it names.
 *
 * The failure it catches: a citation to real file `src/a.ts` at lines 900-950 when the file is
 * 40 lines long. The fileId check above passes; the citation is still fabricated. Line counts
 * come from `inventory.loc`, which is the ONE place real LOC is produced.
 */
export function createLineRangeVerifier(): Verifier {
  return {
    id: LINE_RANGE_VERIFIER_ID,
    supports: () => true,
    async verify(_task: TaskSpec, output: AgentOutput, sandbox: Sandbox): Promise<VerificationResult> {
      const loc = sandbox.result.inventory?.loc ?? {};
      const ranged = (output.citations ?? []).filter(
        (citation) => citation.startLine !== undefined && citation.endLine !== undefined,
      );

      const bad: string[] = [];
      for (const citation of ranged) {
        const start = citation.startLine as number;
        const end = citation.endLine as number;
        if (start < 1 || end < start) {
          bad.push(`${citation.fileId}#${start}-${end} (impossible range)`);
          continue;
        }
        const lines = loc[citation.fileId];
        // A file with no recorded LOC (non-source, or unparsed) cannot be range-checked. That
        // is reported as unverifiable rather than silently passed or silently failed.
        if (lines === undefined) continue;
        if (end > lines) bad.push(`${citation.fileId}#${start}-${end} (file has ${lines} lines)`);
      }

      const checkable = ranged.filter((citation) => loc[citation.fileId] !== undefined || (citation.startLine ?? 1) < 1);
      const score = ranged.length === 0 ? 1 : (ranged.length - bad.length) / ranged.length;
      const notes = bad.length ? [`${bad.length} citation(s) out of range: ${bad.join("; ")}`] : [];
      if (ranged.length > checkable.length) {
        notes.push(`${ranged.length - checkable.length} citation(s) had no recorded LOC and could not be range-checked`);
      }

      return {
        verifierId: LINE_RANGE_VERIFIER_ID,
        passed: bad.length === 0,
        reward: exactReward(score, { inRange: score }, notes.length ? notes : ["all cited ranges are inside their files"]),
        exact: true,
      };
    },
  };
}

/**
 * PASS 3 — every citation must come from the chunks that were actually retrieved.
 *
 * The failure it catches: an answer citing a real file at real lines that the model never
 * received — i.e. it answered from parametric memory rather than from the repository. This is
 * the pass that makes "grounded in THIS repo" mean something stronger than "the path exists".
 *
 * `retrievedChunks` is passed in rather than read off the sandbox, because what was retrieved
 * is a property of the QUERY, not of the frozen world.
 */
export function createCitationVerifier(
  retrievedChunks: ReadonlyArray<{ fileId: string; startLine: number; endLine: number }>,
): Verifier {
  return {
    id: CITATION_VERIFIER_ID,
    supports: () => true,
    async verify(_task: TaskSpec, output: AgentOutput): Promise<VerificationResult> {
      const citations = output.citations ?? [];
      const outside = citations.filter(
        (citation) =>
          !retrievedChunks.some(
            (chunk) =>
              chunk.fileId === citation.fileId &&
              (citation.startLine === undefined || citation.startLine >= chunk.startLine) &&
              (citation.endLine === undefined || citation.endLine <= chunk.endLine),
          ),
      );
      const score = citations.length === 0 ? 1 : (citations.length - outside.length) / citations.length;
      return {
        verifierId: CITATION_VERIFIER_ID,
        passed: outside.length === 0,
        reward: exactReward(
          score,
          { fromRetrieved: score },
          outside.length
            ? [
                `${outside.length} citation(s) were never retrieved (answered from outside the evidence): ` +
                  outside.map((citation) => `${citation.fileId}#${citation.startLine}-${citation.endLine}`).join(", "),
              ]
            : [`all ${citations.length} citation(s) came from retrieved chunks`],
        ),
        exact: true,
      };
    },
  };
}
