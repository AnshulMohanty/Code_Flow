import { useState, type FormEvent } from "react";

/**
 * THE REPO FIELD — `github.com/<owner>/<repo>` + Analyze.
 *
 * Two decisions worth naming:
 *
 * THE PLACEHOLDER IS A SHAPE, NOT AN EXAMPLE. The design shows `github.com/vercel/next.js`, which
 * is the prototype's sample repository. Shipping a real repository name as the placeholder invites a
 * click that analyses somebody else's project by accident, and — worse on this product — makes the
 * first screenshot a user sees look like a curated demo. `owner/repo` says the same thing about the
 * expected format and claims nothing.
 *
 * VALIDATION IS LOCAL AND IMMEDIATE. A malformed entry is a message under the field, not a round
 * trip and a 400. The parse is the same one the API applies, so a value this field accepts is a
 * value the API accepts.
 */

export interface RepoFieldProps {
  onAnalyze(input: { owner: string; repo: string }): void;
  busy?: boolean;
  autoFocus?: boolean;
  /** Rendered under the field. The caller's error (an API failure), separate from a parse error. */
  error?: string | null;
}

export function RepoField({ onAnalyze, busy, autoFocus, error }: RepoFieldProps) {
  const [value, setValue] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseRepo(value);
    if ("error" in parsed) {
      setParseError(parsed.error);
      return;
    }
    setParseError(null);
    onAnalyze(parsed);
  };

  return (
    <form onSubmit={submit} noValidate>
      <div className="repo-input">
        <span className="repo-input-prefix" aria-hidden="true">
          github.com/
        </span>
        <input
          value={value}
          // A SHAPE, not a real repository. See the module note.
          placeholder="owner/repo"
          aria-label="GitHub repository, as owner/repo"
          autoFocus={autoFocus}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => {
            setValue(event.target.value);
            if (parseError) setParseError(null);
          }}
        />
        <button type="submit" disabled={busy}>
          {busy ? "Analyzing…" : "Analyze"}
        </button>
      </div>
      {parseError || error ? (
        <p className="subline" role="alert" style={{ color: "var(--oxblood)" }}>
          {parseError ?? error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Parse `owner/repo`, a full GitHub URL, or a `.git` suffix into `{ owner, repo }`.
 *
 * Rejects rather than guesses. A single segment could be an owner or a repo and picking one would
 * send a request nobody asked for; saying so costs the user one keystroke.
 */
export function parseRepo(raw: string): { owner: string; repo: string } | { error: string } {
  const trimmed = raw.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (trimmed === "") return { error: "Enter a repository as owner/repo." };

  const withoutHost = trimmed
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?github\.com\//i, "")
    .replace(/^git@github\.com:/i, "");

  const parts = withoutHost.split("/").filter(Boolean);
  if (parts.length !== 2) {
    return { error: "Expected exactly owner/repo — e.g. tokio-rs/tokio, or a full github.com URL." };
  }
  const [owner, repo] = parts;
  // GitHub's own allowed characters. Checked here so a value this field accepts is one the API will
  // also accept, rather than surfacing as a 400 after a round trip.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    return { error: "That does not look like a GitHub owner/repo." };
  }
  return { owner, repo };
}
