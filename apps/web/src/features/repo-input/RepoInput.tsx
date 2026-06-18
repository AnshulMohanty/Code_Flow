import { Card } from "../../components/ui/Card";
import { PublicRepoInput } from "./PublicRepoInput";

// CodeFlow is public-hosted only — there is a single analysis mode, so the input is
// just the public repo form (the private/local mode + mode selector were removed).
export function RepoInput() {
  return (
    <Card className="repo-input">
      <PublicRepoInput />
    </Card>
  );
}
