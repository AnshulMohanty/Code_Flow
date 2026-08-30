import { Card } from "../../components/ui/Card";
import type {
  DegradationNotice,
  DegradationReason,
  PipelineRunStatus,
  PipelineStageId,
  PipelineStatusReason,
  StageStatus,
} from "@codeflow/shared-types";
import { PIPELINE_STAGES, type PipelineState, type StageView } from "../../lib/pipeline";

interface PipelinePanelProps {
  state: PipelineState;
  jobId?: string | null;
}

/**
 * The live pipeline panel — CodeFlow's centerpiece. Renders the staged analysis as a
 * streaming chain-of-thought: a horizontal "reactor rail" of stage nodes (connector fills as
 * stages settle; the active node pulses) above a reasoning FEED that appends one entry per
 * stage. Each entry's `detail` + `preview` render GENERICALLY from the event payload (no
 * per-stage hardcoding). The terminal state + reason are surfaced prominently + honestly.
 */
export function PipelinePanel({ state, jobId }: PipelinePanelProps) {
  const { stages, runStatus, runStatusReason, stageCount } = state;
  const settled = stages.filter((s) => isSettled(s.status)).length;
  const runningIndex = stages.findIndex((s) => s.status === "running");
  const fillPct = runStatus ? 100 : Math.round((settled / stageCount) * 100);
  const banner = terminalBanner(runStatus, runStatusReason, state.skippedStages);
  // V3-P0: degradations the headline banner does NOT already explain (today: the database
  // being down). These can fire on an otherwise-healthy run, so they get their own notices
  // rather than being folded into — and hidden by — the terminal banner.
  const notices = uncoveredDegradations(state.degradations, state.skippedStages, runStatusReason);
  const activity = stages.filter((s) => s.status !== "pending");

  return (
    <Card className="pipeline-panel" aria-live="polite">
      <div className="pipeline-head">
        <div>
          <p className="eyebrow">Live pipeline</p>
          <h2>
            {runStatus
              ? (banner?.title ?? "Analysis finished")
              : runningIndex >= 0
                ? `Reasoning · ${stages[runningIndex].label}`
                : `Analyzing ${stageCount} stages`}
          </h2>
        </div>
        <span className={`pipeline-counter${runStatus ? " is-terminal" : ""}`} aria-hidden="true">
          {Math.min(settled, stageCount)}/{stageCount}
        </span>
      </div>

      {banner ? (
        <div className={`pipeline-banner pipeline-banner--${banner.tone}`} role="status">
          <strong>{banner.title}</strong>
          <span>{banner.body}</span>
        </div>
      ) : null}

      {notices.map((notice) => (
        <div
          key={notice.reason}
          className="pipeline-banner pipeline-banner--warning"
          role="status"
          data-degradation={notice.reason}
        >
          <strong>{DEGRADATION_TITLES[notice.reason]}</strong>
          <span>{notice.detail}</span>
        </div>
      ))}

      {/* Reactor rail — connector fills as stages settle; the running node pulses. */}
      <ol className="pipeline-rail" style={{ ["--fill" as string]: `${fillPct}%` }}>
        {stages.map((stage) => (
          <li
            key={stage.stage}
            className={`pipeline-node is-${visualStatus(stage.status)}`}
            data-stage={stage.stage}
            title={`${stage.label}: ${stage.status}`}
          >
            <span className="pipeline-node__glyph" aria-hidden="true">
              <StageGlyph status={stage.status} />
            </span>
            <span className="pipeline-node__label">{stage.label}</span>
            <span className="pipeline-node__meta">
              {stage.durationMs != null ? `${stage.durationMs}ms` : statusWord(stage.status)}
            </span>
          </li>
        ))}
      </ol>

      {/* Chain-of-thought feed — one entry per stage that has reported, generic preview slot. */}
      <ol className="pipeline-feed">
        {activity.map((stage) => (
          <li key={stage.stage} className={`pipeline-feed__item is-${visualStatus(stage.status)}`}>
            <div className="pipeline-feed__line">
              <span className="pipeline-feed__stage">{stage.label}</span>
              <span className={`badge badge-${badgeTone(stage.status)}`}>{statusWord(stage.status)}</span>
              {stage.status === "running" ? <span className="pipeline-feed__dots" aria-hidden="true" /> : null}
            </div>
            {stage.detail ? <p className="pipeline-feed__detail">{stage.detail}</p> : null}
            {stage.preview ? <StagePreview preview={stage.preview} /> : null}
          </li>
        ))}
        {activity.length === 0 ? <li className="pipeline-feed__waiting">Waiting for the first stage…</li> : null}
      </ol>

      {jobId ? <small className="debug-id">Job ID: {jobId}</small> : null}
    </Card>
  );
}

/** Stage-agnostic preview slot: renders whatever flat key→value `preview` the event carried. */
function StagePreview({ preview }: { preview: NonNullable<StageView["preview"]> }) {
  const entries = Object.entries(preview).filter(([, value]) => value != null && value !== "");
  if (entries.length === 0) return null;
  return (
    <dl className="pipeline-preview">
      {entries.map(([key, value]) => (
        <div className="pipeline-preview__chip" key={key}>
          <dt>{key}</dt>
          <dd>{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function StageGlyph({ status }: { status: StageView["status"] }) {
  if (status === "completed") {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
        <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "skipped") {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
        <path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "running") {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" focusable="false" className="pipeline-spin">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="10" strokeLinecap="round" />
      </svg>
    );
  }
  return <span className="pipeline-node__dot" />;
}

interface Banner {
  tone: "success" | "warning" | "danger";
  title: string;
  body: string;
}

/** Short headline per degradation reason; the `detail` from the server carries the specifics
 *  (including the env var that would fix it), so this stays a label and never duplicates it. */
const DEGRADATION_TITLES: Record<DegradationReason, string> = {
  "no-chat-provider": "Onboarding guide unavailable",
  "no-embedding-provider": "Ask-the-repo unavailable",
  "mongo-unavailable": "Results are not being saved",
  "redis-unavailable": "Shared limits unavailable",
  "budget-exhausted": "Demo at capacity",
};

/**
 * Degradations that still need saying after the terminal banner has spoken.
 *
 * The banner already explains unconfigured AI providers and budget exhaustion, so repeating
 * them would be noise. Anything else — a database that is down, so nothing is persisted — is
 * NOT covered by it and would otherwise be invisible.
 */
export function uncoveredDegradations(
  degradations: DegradationNotice[] | undefined,
  skippedStages: PipelineStageId[] | undefined,
  reason: PipelineStatusReason | undefined,
): DegradationNotice[] {
  if (!degradations?.length) return [];
  const covered = new Set<DegradationReason>();
  if (skippedStages?.length) {
    covered.add("no-chat-provider");
    covered.add("no-embedding-provider");
  }
  if (reason === "budget-exhausted") covered.add("budget-exhausted");
  return degradations.filter((notice) => !covered.has(notice.reason));
}

/** "Synthesize" / "Synthesize and Index for Q&A" — reuses the canonical stage labels. */
function listStages(stages: PipelineStageId[]): string {
  const labels = stages.map((id) => PIPELINE_STAGES.find((entry) => entry.stage === id)?.label ?? id);
  if (labels.length <= 1) return labels[0] ?? "an AI stage";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** Honest terminal copy keyed on the typed reason — never a silent stall. */
function terminalBanner(
  status: PipelineRunStatus | null,
  reason?: PipelineStatusReason,
  skippedStages?: PipelineStageId[],
): Banner | null {
  if (!status) return null;
  // A run with unconfigured AI stages still reports "completed" — say so plainly rather
  // than claiming every stage finished.
  if (skippedStages?.length) {
    return {
      tone: "warning",
      title: "Deterministic analysis complete",
      body: `No AI provider is configured, so ${listStages(skippedStages)} did not run. Everything below is the full deterministic analysis; the onboarding guide and Ask-the-repo need a provider key.`,
    };
  }
  if (status === "completed") {
    return { tone: "success", title: "Analysis complete", body: "All stages finished. Explore the results below." };
  }
  if (reason === "budget-exhausted") {
    return {
      tone: "warning",
      title: "Demo at capacity",
      body: "An AI stage was skipped to stay within today's budget. The deterministic analysis is complete and usable.",
    };
  }
  if (reason === "repo-too-large") {
    return {
      tone: "danger",
      title: "Repository too large",
      body: "This repository exceeds the demo size cap, so analysis was stopped before parsing.",
    };
  }
  if (status === "partial") {
    return {
      tone: "warning",
      title: "Partial analysis",
      body: "An AI stage didn't complete, but every deterministic stage finished — the results below are intact.",
    };
  }
  if (status === "aborted") {
    return { tone: "warning", title: "Analysis cancelled", body: "The run was cancelled before all stages finished." };
  }
  return { tone: "danger", title: "Analysis failed", body: "A required stage failed; results are incomplete." };
}

function isSettled(status: StageStatus | "pending"): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

/** Collapse to the visual buckets the CSS styles. `skipped` is DISTINCT from `pending`:
 *  one is a terminal "this will never run", the other is "not yet". */
function visualStatus(status: StageStatus | "pending"): "done" | "running" | "failed" | "skipped" | "pending" {
  if (status === "completed") return "done";
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "pending";
}

function statusWord(status: StageStatus | "pending"): string {
  switch (status) {
    case "completed":
      return "done";
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

function badgeTone(status: StageStatus | "pending"): "success" | "warning" | "danger" | "info" | "neutral" {
  switch (status) {
    case "completed":
      return "success";
    case "running":
      return "info";
    case "failed":
      return "danger";
    case "skipped":
      return "warning";
    default:
      return "neutral";
  }
}
