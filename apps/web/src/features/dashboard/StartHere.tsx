import { Card } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import type { StartHere as StartHereModel } from "../../lib/dashboard";

interface StartHereProps {
  startHere: StartHereModel;
  onOpenFile: (fileId: string) => void;
}

/**
 * View 1 — the onboarding guide. Renders the AI synthesis (summary + ranked reading path +
 * key concepts) when available; on a partial/budget-exhausted run it degrades HONESTLY to the
 * deterministic key-files fallback with a clear note — never a blank panel. Reading steps open
 * the file in drill-down.
 */
export function StartHere({ startHere, onOpenFile }: StartHereProps) {
  const { available, summary, readingOrder, keyConcepts, fallbackNote } = startHere;

  return (
    <Card className="dash-view dash-start">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">Start here</p>
          <h2>Where do I begin?</h2>
        </div>
        <Badge tone={available ? "success" : "warning"}>{available ? "AI guide" : "Fallback"}</Badge>
      </div>

      {available ? (
        summary ? <p className="dash-start__summary">{summary}</p> : null
      ) : (
        <p className="dash-start__note" role="note">
          {fallbackNote}
        </p>
      )}

      {readingOrder.length ? (
        <ol className="dash-reading">
          {readingOrder.map((step) => (
            <li key={step.fileId}>
              <button type="button" className="dash-reading__step" onClick={() => onOpenFile(step.fileId)}>
                <span className="dash-reading__order">{step.order}</span>
                <span className="dash-reading__body">
                  <span className="dash-reading__file">{step.fileId}</span>
                  <span className="dash-reading__reason">{step.reason}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="dash-empty">No reading order available for this run.</p>
      )}

      {keyConcepts && keyConcepts.length ? (
        <div className="dash-concepts">
          <h3>Key concepts</h3>
          <div className="chip-row">
            {keyConcepts.map((concept) => (
              <span className="chip" key={concept}>
                {concept}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
