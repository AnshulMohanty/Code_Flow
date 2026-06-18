import { Button } from "../../components/ui/Button";

export function GraphToolbar() {
  return (
    <div className="graph-toolbar" aria-label="Graph toolbar placeholder">
      <Button type="button" variant="ghost">Fit</Button>
      <Button type="button" variant="ghost">Layers</Button>
      <Button type="button" variant="ghost">Risk</Button>
      {/* TODO: Replace with real graph controls when 2D/3D graph rendering is migrated. */}
    </div>
  );
}
