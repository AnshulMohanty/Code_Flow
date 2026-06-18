import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DashboardShell } from "./DashboardShell";
import { StructureMap } from "./StructureMap";
import { buildDashboard } from "../../lib/dashboard";
import { mockAnalysisResult, mockBigResult } from "../../lib/mockAnalysis";
import { useAppStore } from "../../store/appStore";

function seed(result = mockAnalysisResult()) {
  useAppStore.setState({ dashboard: buildDashboard(result), selectedFileId: null, analysisLoaded: true });
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ dashboard: null, selectedFileId: null, analysisLoaded: false });
});

describe("DashboardShell — views + navigation", () => {
  beforeEach(() => seed());

  it("opens on Start Here with the AI reading order", () => {
    render(<DashboardShell />);
    expect(screen.getByText("Where do I begin?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /src\/index\.ts/ })).toBeInTheDocument();
  });

  it("reading step → drill-down opens that file", () => {
    render(<DashboardShell />);
    fireEvent.click(screen.getByRole("button", { name: /src\/index\.ts/ }));
    expect(screen.getByRole("heading", { name: "src/index.ts" })).toBeInTheDocument();
    expect(screen.getByText(/not cyclomatic/i)).toBeInTheDocument();
  });

  it("structure file → drill-down", () => {
    render(<DashboardShell />);
    fireEvent.click(screen.getByRole("tab", { name: "Structure" }));
    const authRow = screen.getAllByTestId("structure-file").find((el) => el.textContent?.includes("auth.ts"))!;
    fireEvent.click(authRow);
    expect(screen.getByRole("heading", { name: "src/auth.ts" })).toBeInTheDocument();
    expect(screen.getByText("AuthService")).toBeInTheDocument();
  });

  it("neighbour link → drill-down (every link resolves to a real node)", () => {
    render(<DashboardShell />);
    // Open src/index.ts, then follow its import to src/auth.ts.
    fireEvent.click(screen.getByRole("button", { name: /src\/index\.ts/ }));
    fireEvent.click(screen.getByRole("button", { name: "src/auth.ts" }));
    expect(screen.getByRole("heading", { name: "src/auth.ts" })).toBeInTheDocument();
  });

  it("shows complexity as a relative rank + proxy note, not a raw absolute", () => {
    render(<DashboardShell />);
    fireEvent.click(screen.getByRole("tab", { name: "Structure" }));
    const authRow = screen.getAllByTestId("structure-file").find((el) => el.textContent?.includes("auth.ts"))!;
    fireEvent.click(authRow);

    expect(screen.getByText(/rank #1 of 3/)).toBeInTheDocument();
    expect(screen.getByText(/Relative structural proxy/i)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Complexity rank 1 of 3/ })).toBeInTheDocument();
    // The raw absolute proxy score (69) is NOT surfaced as a bare number.
    expect(screen.queryByText("69")).toBeNull();
  });
});

describe("DashboardShell — honest degradation", () => {
  it("Start Here shows the deterministic fallback + 'at capacity' note on a partial run", () => {
    const partial = mockAnalysisResult();
    delete (partial as { ai?: unknown }).ai;
    seed(partial);

    render(<DashboardShell />);
    expect(screen.getByRole("note")).toHaveTextContent(/at capacity/i);
    // Fallback still surfaces a reading path (key files), never a blank panel.
    expect(screen.getByRole("button", { name: /src\/index\.ts/ })).toBeInTheDocument();
  });
});

describe("StructureMap — render cap is render-only (show all)", () => {
  it("caps the painted rows but never truncates the underlying list", () => {
    const model = buildDashboard(mockBigResult(30));
    render(<StructureMap model={model} onOpenFile={() => {}} />);

    expect(screen.getAllByTestId("structure-file")).toHaveLength(20); // capped view
    expect(model.fileList).toHaveLength(30); // underlying data intact

    fireEvent.click(screen.getByRole("button", { name: /Show all \(30\)/ }));
    expect(screen.getAllByTestId("structure-file")).toHaveLength(30); // full data available
  });
});
