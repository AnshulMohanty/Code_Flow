import { PipelinePanel } from "../features/analysis/PipelinePanel";
import { DashboardShell } from "../features/dashboard/DashboardShell";
import { OnboardingPanel } from "../features/onboarding/OnboardingPanel";
import { RepoInput } from "../features/repo-input/RepoInput";
import { useAppStore } from "../store/appStore";

export function AppShell() {
  const analysisLoaded = useAppStore((state) => state.analysisLoaded);
  const isAnalyzing = useAppStore((state) => state.isAnalyzing);
  const currentJobId = useAppStore((state) => state.currentJobId);
  const pipeline = useAppStore((state) => state.pipeline);
  // Show the live pipeline panel while analyzing, and keep it after a terminal run that did
  // NOT produce a dashboard (partial-without-result / failed) so the reason stays visible.
  const showPipeline = (isAnalyzing || pipeline.runStatus != null) && !analysisLoaded;

  return (
    <main className="app-shell">
      <header className="shell-header">
        <div>
          <p className="eyebrow">CodeFlow</p>
          <h1>Understand any codebase, fast</h1>
          <p className="shell-copy">
            Paste a public GitHub repo. CodeFlow clones it, runs the staged analysis pipeline live,
            and hands you an onboarding guide, a structure map, and per-file insight.
          </p>
        </div>
        <div className="privacy-note">
          <strong>Public repos only</strong>
          <span>Code is cloned on the server for analysis — public repositories only.</span>
        </div>
      </header>

      <RepoInput />

      {showPipeline ? <PipelinePanel state={pipeline} jobId={currentJobId} /> : null}

      {analysisLoaded ? <DashboardShell /> : !showPipeline ? <OnboardingPanel /> : null}
    </main>
  );
}
