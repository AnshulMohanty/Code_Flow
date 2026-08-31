import { useCallback, useEffect, useState } from "react";
import { MarketingSite } from "./site/MarketingSite";
import { Workbench } from "./workbench/Workbench";
import { useAnalysis } from "./lib/useAnalysis";
import { useMeta } from "./lib/useMeta";

/**
 * TWO SURFACES, ONE RUN.
 *
 * The marketing site (paper/light) and the workbench (dark) are different views of the SAME analysis
 * state: `useAnalysis` lives here and is passed down, so a run started on the landing page is the run
 * the workbench opens onto. Duplicating the driver per surface would let the two disagree about what
 * is happening, which is the bug a user notices first.
 *
 * The surface is reflected in the URL hash so a workbench view survives a reload and can be linked.
 * Nothing else is in the URL: a repo in the query string would make a shared link start an analysis
 * on someone else's behalf.
 */

type Surface = "site" | "workbench";

export function App() {
  const meta = useMeta();
  const { state, ask, analyze, askQuestion } = useAnalysis();
  const [surface, setSurface] = useState<Surface>(() => readSurface());

  // Keep the hash and the surface in step, in both directions, so Back works.
  useEffect(() => {
    const onHashChange = () => setSurface(readSurface());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const go = useCallback((next: Surface) => {
    setSurface(next);
    // `replaceState` for the site, `pushState` for the workbench: entering a tool is a navigation a
    // user expects Back to undo; returning to the marketing page is not a separate destination.
    if (next === "workbench") window.location.hash = "workbench";
    else if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    window.scrollTo({ top: 0 });
  }, []);

  // Starting an analysis from the landing page moves the user to the workbench, which is where the
  // run is actually watchable. The card on the marketing page still fills in — it is the same state.
  const analyzeAndOpen = useCallback(
    (input: { owner: string; repo: string }) => {
      void analyze(input);
      go("workbench");
    },
    [analyze, go],
  );

  if (surface === "workbench") {
    return (
      <Workbench
        meta={meta}
        analysis={state}
        ask={ask}
        onAnalyze={(input) => void analyze(input)}
        onAsk={(question) => void askQuestion(question)}
        onExit={() => go("site")}
      />
    );
  }

  return (
    <MarketingSite
      meta={meta}
      analysis={state}
      ask={ask}
      onAnalyze={analyzeAndOpen}
      onAsk={(question) => void askQuestion(question)}
      onOpenWorkbench={() => go("workbench")}
    />
  );
}

function readSurface(): Surface {
  if (typeof window === "undefined") return "site";
  return window.location.hash.replace(/^#/, "") === "workbench" ? "workbench" : "site";
}
