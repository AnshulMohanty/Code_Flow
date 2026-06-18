import { useState, type FormEvent } from "react";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { askRepo, ApiClientError, type AskResponse } from "../../lib/apiClient";

interface AskRepoProps {
  /** The analysis job id the Ask endpoint is keyed on; null on the mock-data path. */
  jobId: string | null;
  /** Open a cited file in drill-down (reuses the dashboard selected-file context). */
  onOpenFile: (fileId: string) => void;
}

type AskState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "answer"; response: AskResponse }
  | { kind: "rate-limited" }
  | { kind: "error"; message: string };

/**
 * Ask-the-repo chat panel. A question → the Ask endpoint → a GROUNDED answer with inline
 * citations (each clickable → drill-down). Renders the honest no-answer, no-index, and
 * "at capacity" states, and a 429 "slow down". Against the real/mock endpoint.
 */
export function AskRepo({ jobId, onOpenFile }: AskRepoProps) {
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<AskState>({ kind: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || !jobId) return;
    setState({ kind: "loading" });
    try {
      const response = await askRepo(jobId, trimmed);
      setState({ kind: "answer", response });
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 429) {
        setState({ kind: "rate-limited" });
        return;
      }
      setState({ kind: "error", message: error instanceof Error ? error.message : "Ask failed." });
    }
  }

  return (
    <Card className="dash-view dash-ask">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">Ask the repo</p>
          <h2>Questions, answered from the code</h2>
        </div>
      </div>

      {jobId ? (
        <form className="dash-ask__form" onSubmit={handleSubmit}>
          <label htmlFor="ask-input">Your question</label>
          <div className="input-row">
            <input
              id="ask-input"
              type="text"
              value={question}
              placeholder="e.g. How does authentication work?"
              onChange={(event) => setQuestion(event.target.value)}
            />
            <Button type="submit" variant="primary" disabled={state.kind === "loading" || !question.trim()}>
              {state.kind === "loading" ? "Asking…" : "Ask"}
            </Button>
          </div>
          <small className="dash-ask__hint">Answers are grounded only in this repo's indexed code, cited to file + line.</small>
        </form>
      ) : (
        <EmptyState
          title="Run a live analysis to ask questions"
          message="Q&A needs a built search index. Analyze a public repository (not mock data) to enable Ask."
        />
      )}

      <AnswerView state={state} onOpenFile={onOpenFile} />
    </Card>
  );
}

function AnswerView({ state, onOpenFile }: { state: AskState; onOpenFile: (fileId: string) => void }) {
  if (state.kind === "idle" || state.kind === "loading") return null;

  if (state.kind === "rate-limited") {
    return (
      <p className="dash-ask__note dash-ask__note--warn" role="status">
        Slow down — too many questions in a short window. Please try again shortly.
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="dash-ask__note dash-ask__note--danger" role="alert">
        {state.message}
      </p>
    );
  }

  const { response } = state;
  if (response.atCapacity) {
    return (
      <p className="dash-ask__note dash-ask__note--warn" role="status">
        {response.answer}
      </p>
    );
  }
  if (response.unavailable) {
    return (
      <p className="dash-ask__note" role="status">
        {response.answer}
      </p>
    );
  }
  if (!response.answered) {
    return (
      <p className="dash-ask__note" role="status">
        {response.answer}
      </p>
    );
  }

  return (
    <div className="dash-ask__answer">
      <p className="dash-ask__prose">{response.answer}</p>
      {response.citations.length ? (
        <div className="dash-ask__sources">
          <h3>Sources</h3>
          <ul className="dash-links">
            {response.citations.map((c) => (
              <li key={`${c.fileId}#${c.startLine}-${c.endLine}`}>
                <button type="button" className="dash-links__link" onClick={() => onOpenFile(c.fileId)}>
                  {c.fileId}:{c.startLine}-{c.endLine}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="dash-empty">Answered, but with no specific code citation.</p>
      )}
    </div>
  );
}
