import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepoField } from "./RepoField";
import { analyzeBlockedReason } from "../lib/useWake";
import type { WakeState } from "../lib/useWake";

/**
 * GATING A REAL ANALYSIS ON THE BACKEND BEING AWAKE.
 *
 * Analysing a fresh repository needs the API and the queue. On a free tier the API sleeps, so a
 * click during the first thirty seconds of a visit produces a request that appears to hang and may
 * then fail anyway — the worst of both, because the user cannot tell a slow product from a broken
 * one. A disabled button that SAYS what it is waiting for, and points at something that works
 * meanwhile, is the honest version of the same thirty seconds.
 *
 * What must NOT happen is the gate quietly becoming permanent, or the wording implying an error when
 * the page is simply passing through a state. Both are asserted below.
 */

function wakeState(status: WakeState["status"]): WakeState {
  return { status, attempts: 1, reachable: status === "ready" };
}

describe("analyzeBlockedReason — one definition, two surfaces", () => {
  it("returns null once the backend has answered", () => {
    expect(analyzeBlockedReason(wakeState("ready"))).toBeNull();
  });

  it("while waking, says how long and names something that works right now", () => {
    const reason = analyzeBlockedReason(wakeState("waking"))!;
    expect(reason).toMatch(/30 seconds/);
    expect(reason).toMatch(/demo repository/i);
  });

  it("when offline, does NOT promise it is coming — that would be the spinner again in words", () => {
    const reason = analyzeBlockedReason(wakeState("offline"))!;
    expect(reason).toMatch(/did not answer/i);
    expect(reason).not.toMatch(/warming|30 seconds/i);
    // Still points at what works, so it is a redirection rather than a dead end.
    expect(reason).toMatch(/demo repositories below still work/i);
  });
});

describe("RepoField honours the gate", () => {
  it("disables the button and explains, rather than letting a click hang", () => {
    const onAnalyze = vi.fn();
    render(<RepoField onAnalyze={onAnalyze} notReady={analyzeBlockedReason(wakeState("waking"))} />);

    const button = screen.getByRole("button", { name: /Warming up/i });
    expect(button).toBeDisabled();
    expect(screen.getByText(/Warming the analysis engine/i)).toBeInTheDocument();
  });

  it("does not announce the wait as an error — nothing has gone wrong", () => {
    // role="alert" is for failures. A page passing through a known state is not one, and saying so
    // in an alert would be its own small lie.
    render(<RepoField onAnalyze={vi.fn()} notReady={analyzeBlockedReason(wakeState("waking"))} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(document.querySelector('[data-not-ready="true"]')).toBeInTheDocument();
  });

  it("refuses a submit even if the form is submitted directly", () => {
    // Belt and braces with `disabled`: a form can still submit on Enter in some browsers when its
    // submit button is disabled, and an enqueue against a sleeping backend is the hang this prevents.
    const onAnalyze = vi.fn();
    const { container } = render(
      <RepoField onAnalyze={onAnalyze} notReady={analyzeBlockedReason(wakeState("offline"))} />,
    );
    fireEvent.change(screen.getByLabelText(/GitHub repository/i), { target: { value: "acme/repo" } });
    fireEvent.submit(container.querySelector("form")!);
    expect(onAnalyze).not.toHaveBeenCalled();
  });

  it("enables and analyses normally once the backend is ready", () => {
    const onAnalyze = vi.fn();
    render(<RepoField onAnalyze={onAnalyze} notReady={analyzeBlockedReason(wakeState("ready"))} />);

    const button = screen.getByRole("button", { name: /^Analyze$/ });
    expect(button).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/GitHub repository/i), { target: { value: "acme/repo" } });
    fireEvent.click(button);
    expect(onAnalyze).toHaveBeenCalledWith({ owner: "acme", repo: "repo" });
  });

  it("keeps a real API error distinguishable from the warming state", () => {
    // Two different messages in the same slot. An error must still read as an error.
    render(<RepoField onAnalyze={vi.fn()} error="The analysis queue is currently unavailable." notReady={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/queue is currently unavailable/i);
  });
});
