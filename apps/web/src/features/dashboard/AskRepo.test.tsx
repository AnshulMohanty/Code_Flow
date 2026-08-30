import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskRepo } from "./AskRepo";
import { askRepo, ApiClientError, type AskResponse } from "../../lib/apiClient";

vi.mock("../../lib/apiClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/apiClient")>();
  return { ...actual, askRepo: vi.fn() };
});
const mockAsk = vi.mocked(askRepo);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function ask(question = "How does auth work?") {
  fireEvent.change(screen.getByLabelText(/Your question/i), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
}

describe("AskRepo", () => {
  it("renders a grounded answer with clickable citations → drill-down", async () => {
    const answer: AskResponse = {
      answer: "Auth is handled by AuthService.",
      answered: true,
      citations: [{ fileId: "src/auth.ts", startLine: 1, endLine: 10 }],
      retrievedChunkIds: ["src/auth.ts#1-10"],
    };
    mockAsk.mockResolvedValue(answer);
    const onOpenFile = vi.fn();
    render(<AskRepo jobId="job-1" onOpenFile={onOpenFile} />);

    ask();
    expect(await screen.findByText("Auth is handled by AuthService.")).toBeInTheDocument();
    const citation = screen.getByRole("button", { name: "src/auth.ts:1-10" });
    fireEvent.click(citation);
    expect(onOpenFile).toHaveBeenCalledWith("src/auth.ts");
    expect(mockAsk).toHaveBeenCalledWith("job-1", "How does auth work?");
  });

  it("renders the honest no-answer state", async () => {
    mockAsk.mockResolvedValue({ answer: "I couldn't find that in the repo.", answered: false, citations: [], retrievedChunkIds: [] });
    render(<AskRepo jobId="job-1" onOpenFile={vi.fn()} />);
    ask("what is xyzzy?");
    expect(await screen.findByText("I couldn't find that in the repo.")).toBeInTheDocument();
  });

  it("renders the 'at capacity' state honestly", async () => {
    mockAsk.mockResolvedValue({ answer: "Demo at capacity — try again later.", answered: false, citations: [], retrievedChunkIds: [], atCapacity: true });
    render(<AskRepo jobId="job-1" onOpenFile={vi.fn()} />);
    ask();
    expect(await screen.findByText(/Demo at capacity/)).toBeInTheDocument();
  });

  it("renders a 'slow down' message on 429", async () => {
    mockAsk.mockRejectedValue(new ApiClientError("Too many requests", { status: 429 }));
    render(<AskRepo jobId="job-1" onOpenFile={vi.fn()} />);
    ask();
    expect(await screen.findByText(/Slow down/i)).toBeInTheDocument();
  });

  it("renders the no-index unavailable state", async () => {
    mockAsk.mockResolvedValue({ answer: "Q&A is unavailable for this analysis.", answered: false, citations: [], retrievedChunkIds: [], unavailable: true });
    render(<AskRepo jobId="job-1" onOpenFile={vi.fn()} />);
    ask();
    expect(await screen.findByText("Q&A is unavailable for this analysis.")).toBeInTheDocument();
  });

  it("disables Ask on the mock-data path (no jobId)", () => {
    render(<AskRepo jobId={null} onOpenFile={vi.fn()} />);
    expect(screen.getByText(/Run a live analysis to ask questions/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
  });
});
