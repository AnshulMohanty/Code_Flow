import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasFinePointer, prefersReducedMotion, useCountUp, useReveal } from "./motion";

/**
 * THE ONLY THING WORTH TESTING ABOUT MOTION is what happens when it cannot run.
 *
 * Animation that hides content until JS reveals it is the one decoration that can turn into a blank
 * page, so these tests pin the three fallbacks the design depends on: no `matchMedia`, no
 * `IntersectionObserver`, and a figure that was never measured.
 *
 * jsdom supplies neither `matchMedia` nor `IntersectionObserver`, so this file needs no stubbing to
 * exercise the absent case — which is also why `shell.test.tsx` still paints a full page.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("motion degrades to the finished page", () => {
  it("treats an unknown motion preference as REDUCED", () => {
    // jsdom has no matchMedia. Guessing "animate" here would move the page at a reader who may have
    // explicitly asked us not to; guessing "still" is never wrong.
    expect(prefersReducedMotion()).toBe(true);
    expect(hasFinePointer()).toBe(false);
  });

  it("treats a THROWING matchMedia as reduced rather than crashing the render", () => {
    vi.stubGlobal("matchMedia", () => {
      throw new Error("unsupported media feature");
    });
    expect(prefersReducedMotion()).toBe(true);
    expect(hasFinePointer()).toBe(false);
  });

  it("reveals immediately when there is no IntersectionObserver to wait for", () => {
    const { result } = renderHook(() => useReveal<HTMLDivElement>());
    // Not "eventually true" — true on the FIRST render, so the element is never once hidden.
    expect(result.current.revealed).toBe(true);
  });

  it("passes an UNMEASURED figure through untouched — an em-dash never counts up", () => {
    const { result } = renderHook(() => useCountUp(null));
    expect(result.current).toBeNull();
  });

  it("lands on the exact measured value rather than an interpolated one", () => {
    const { result } = renderHook(() => useCountUp(12481));
    expect(result.current).toBe(12481);
  });

  it("does not count while it is inactive, and does not invent a zero either", () => {
    const { result } = renderHook(() => useCountUp(412, { active: false }));
    expect(result.current).toBe(412);
  });
});
