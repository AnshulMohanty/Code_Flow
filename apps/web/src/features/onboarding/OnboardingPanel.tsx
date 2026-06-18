import { EmptyState } from "../../components/ui/EmptyState";

export function OnboardingPanel() {
  return (
    <EmptyState
      title="Analyze a repository to begin"
      message="Enter a public GitHub repo above and run the analysis. The live pipeline streams here, then the dashboard opens with your onboarding guide, structure map, and per-file insight."
    />
  );
}
