import { useState } from "react";
import { API_BASE_URL } from "../lib/apiClient";
import { formatStat, NOT_MEASURED, type RunNumbers } from "../lib/siteModel";

/**
 * THE HUD — `p50 <x>ms · $<y> measured · copy as cURL`.
 *
 * Three dev-native facts in mono, and each one is either measured or an em-dash:
 *
 *   p50   the server's measured answer latency, from `/api/meta`. Absent before anyone has asked a
 *         question on that server, which is a real state and not a zero.
 *   $     this run's measured cost. The word beside it is `measured` or `estimated` and it is NOT
 *         decoration: `TokenUsage.measured` is false when a provider reported no usage, and a
 *         dollar figure that hid that would be exactly the dishonesty the cost pipeline exists to
 *         prevent. An unpriced run shows the em-dash, because "unpriced" is not "free".
 *   cURL  the real request that produces this view. Copied, not shown — a wall of curl in the
 *         chrome would push the content down, and the value of the affordance is that it works.
 */

export interface HudProps {
  numbers: RunNumbers;
  /** The job id the cURL should address. Null before an analysis exists — the button is then hidden
   *  rather than shown copying a URL with `undefined` in it. */
  jobId: string | null;
}

export function Hud({ numbers, jobId }: HudProps) {
  const cost = numbers.costPerIndex;
  const p50 = numbers.p50AnswerMs;

  return (
    <div className="hud">
      <span title={p50.value === null ? p50.absentReason : "Server-measured p50 over recent answers"}>
        p50 {p50.value === null ? NOT_MEASURED : `${formatStat(p50)}ms`}
      </span>
      <span className="hud-sep">·</span>
      <span title={cost.value === null ? cost.absentReason : "Read back from the provider's own usage counters"}>
        {formatStat(cost)}{" "}
        {cost.value === null ? (
          <span className="hud-measured">{cost.absentReason ? "unpriced" : "not measured"}</span>
        ) : cost.measured === false ? (
          <span className="hud-estimated">estimated</span>
        ) : (
          <span className="hud-measured">measured</span>
        )}
      </span>
      {jobId ? <CopyCurl jobId={jobId} /> : null}
    </div>
  );
}

/**
 * "copy as cURL" — the real request, against the real base URL this build talks to.
 *
 * A GET of the result endpoint, because that is the request this view is a rendering of. Offering a
 * cURL that did something else would be a nice gesture attached to a lie.
 */
export function CopyCurl({ jobId }: { jobId: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const command = `curl -s '${API_BASE_URL}/api/result/${jobId}' | jq .`;

  return (
    <button
      type="button"
      className="chip-btn"
      onClick={() => {
        // `navigator.clipboard` is absent in insecure contexts and in jsdom. The failure is REPORTED
        // on the button rather than swallowed, because a copy button that silently does nothing is
        // worse than one that says it could not.
        const clipboard = navigator.clipboard;
        if (clipboard) {
          void clipboard
            .writeText(command)
            .then(() => setState("copied"))
            .catch(() => setState("failed"));
        } else {
          setState("failed");
        }
        window.setTimeout(() => setState("idle"), 2000);
      }}
      title={command}
    >
      {state === "copied" ? "copied" : state === "failed" ? "copy failed" : "copy as cURL"}
    </button>
  );
}
