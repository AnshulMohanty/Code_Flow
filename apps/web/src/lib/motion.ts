import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * THE MOTION LAYER — reveal-on-scroll, count-up, and magnetic pull.
 *
 * These are the three behaviours the design depends on and the components did not have: the page was
 * correct but static, and a page whose numbers are its argument should count them out rather than
 * arrive with them already written.
 *
 * THREE RULES THIS FILE ENCODES, because each one is a correctness property and not a preference:
 *
 * 1. THE FINAL STATE IS THE DEFAULT. Every hook returns the finished value when it cannot animate —
 *    no `IntersectionObserver` (jsdom, old Safari), no `requestAnimationFrame`, no `matchMedia`, or
 *    a reader who asked for reduced motion. Animation that hides content until JS runs is the one
 *    failure mode that turns a decoration into a blank page, so absence reveals rather than hides.
 *
 * 2. UNKNOWN MEANS DO NOT MOVE. `prefersReducedMotion()` answers `true` when it cannot ask. A
 *    browser that will not tell us gets the still version, which is never wrong; guessing the other
 *    way animates at someone who explicitly asked us not to.
 *
 * 3. A COUNT-UP ONLY EVER COUNTS A MEASURED NUMBER. `useCountUp` takes `number | null` and passes
 *    `null` straight through. Section 03 renders an em-dash with a reason when a figure was not
 *    measured (see siteModel.ts), and animating a zero up to a fabricated value would be exactly the
 *    lie the em-dash exists to prevent.
 */

/**
 * Does this reader want reduced motion? `true` whenever we cannot tell.
 *
 * Read at effect time rather than cached at module load: a user can flip the OS setting mid-session,
 * and every caller re-reads it on the next mount.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

/** A pointing device that can hover precisely — a mouse or trackpad, not a finger. */
export function hasFinePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(pointer: fine)").matches;
  } catch {
    return false;
  }
}

export interface RevealOptions {
  /**
   * How much of the element must be on screen before it reveals. The default is deliberately small:
   * a tall section that needs to be 40% visible reveals late enough to be noticed as a delay.
   */
  threshold?: number;
  /** Shrinks the viewport from the bottom so an element reveals slightly before it is fully in. */
  rootMargin?: string;
  /**
   * Observe the element's PARENT instead of the element. Required for the `clip` variant: Chromium's
   * IntersectionObserver measures the CLIPPED box, and a heading clipped to nothing has no area to
   * intersect — so it would wait for ever. Its parent is never clipped and sits in the same place.
   */
  observeParent?: boolean;
}

/**
 * REVEAL-ON-SCROLL. Returns a ref to attach and whether it has been seen.
 *
 * Reveals ONCE and then disconnects. A section that re-hides when it leaves the viewport flickers on
 * every scroll reversal, and a reader scrolling back up is re-reading, not being re-introduced.
 *
 * `revealed` starts `true` when there is nothing to observe with — see rule 1. That is what keeps the
 * static-site contract (`shell.test.tsx`) true: the shell paints its content with no observer, no
 * backend and no JS motion at all.
 */
export function useReveal<T extends HTMLElement>(options: RevealOptions = {}): {
  ref: RefObject<T>;
  revealed: boolean;
} {
  const ref = useRef<T>(null);
  const unobservable = typeof IntersectionObserver === "undefined" || prefersReducedMotion();
  const [revealed, setRevealed] = useState(unobservable);

  useEffect(() => {
    if (unobservable) {
      setRevealed(true);
      return;
    }
    const element = options.observeParent ? (ref.current?.parentElement ?? ref.current) : ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRevealed(true);
          observer.disconnect();
        }
      },
      { threshold: options.threshold ?? 0.12, rootMargin: options.rootMargin ?? "0px 0px -8% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [unobservable, options.threshold, options.rootMargin, options.observeParent]);

  return { ref, revealed };
}

/**
 * `useReveal`, packaged as props to SPREAD ONTO AN ELEMENT THAT ALREADY EXISTS.
 *
 * Deliberately not a `<Reveal>` wrapper component: every place this is used is a grid child, a flex
 * child or a full-bleed section, and an extra `<div>` around any of those changes the layout it was
 * asked only to animate. Reveal is a property of an element, so it is expressed as that element's
 * own attributes.
 *
 * `clip` is for display type (uncovered from its baseline), `up` for everything else.
 */
export function useRevealAttrs<T extends HTMLElement>(
  variant: "up" | "clip" = "up",
  options: RevealOptions = {},
): { ref: RefObject<T>; "data-reveal": string; "data-revealed": boolean } {
  const { ref, revealed } = useReveal<T>({ observeParent: variant === "clip", ...options });
  return { ref, "data-reveal": variant, "data-revealed": revealed };
}

export interface CountUpOptions {
  durationMs?: number;
  /** Count only once this is true — so a figure below the fold counts when it is read, not before. */
  active?: boolean;
}

/**
 * COUNT-UP for a measured figure. `null` in, `null` out — always.
 *
 * Eases out over `durationMs` and lands EXACTLY on the target: the last frame assigns `target`
 * rather than the interpolated value, because a stat that settles on 12,480 when the analysis
 * measured 12,481 is a wrong number on screen for the sake of an animation.
 */
export function useCountUp(target: number | null, options: CountUpOptions = {}): number | null {
  const { durationMs = 1100, active = true } = options;
  const still =
    prefersReducedMotion() || typeof requestAnimationFrame !== "function" || typeof performance === "undefined";
  const [value, setValue] = useState<number | null>(still ? target : null);

  useEffect(() => {
    if (target === null || !active || still) {
      setValue(target);
      return;
    }
    let frame = 0;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - startedAt) / durationMs);
      // easeOutCubic — fast first, so the figure is readable for most of the animation.
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(t >= 1 ? target : target * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, active, still, durationMs]);

  return value;
}

/**
 * MAGNETIC PULL on a button — it leans toward the pointer inside its own bounds.
 *
 * Transform only, and never more than `maxPx`, so the element's hit area does not move out from
 * under the cursor that is chasing it. Disabled outright without a fine pointer: on touch there is
 * no hover to lean into, and the listener would only cost battery.
 */
export function useMagnetic<T extends HTMLElement>(maxPx = 8): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (prefersReducedMotion() || !hasFinePointer()) return;

    const onMove = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      // The design's pull: 16% of the horizontal offset, 28% of the vertical, bounded so the hit
      // area never leaves the pointer. Written to `translate`, not `transform`, so a hover lift in
      // CSS (`transform: translateY(-1px)`) composes with it instead of being overwritten.
      const clamp = (n: number) => Math.max(-maxPx, Math.min(maxPx, n));
      const dx = clamp((event.clientX - (rect.left + rect.width / 2)) * 0.16);
      const dy = clamp((event.clientY - (rect.top + rect.height / 2)) * 0.28);
      element.style.translate = `${dx.toFixed(1)}px ${dy.toFixed(1)}px`;
    };
    const onLeave = () => {
      element.style.translate = "";
    };

    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerleave", onLeave);
    return () => {
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerleave", onLeave);
      onLeave();
    };
  }, [maxPx]);

  return ref;
}

/**
 * TYPE-OUT for a REAL string — an answer, or the honest reason there is none.
 *
 * `active: false` shows nothing (the card's rail has not finished, so the answer is not "spoken"
 * yet); `active: true` types the text three characters per 16ms, the design's cadence. Under reduced
 * motion, or where timers cannot be trusted to animate, the whole text appears at once. A changed
 * `text` restarts from the beginning, because a half-typed old answer under a new question would be
 * a sentence nobody wrote.
 */
export function useTypewriter(text: string, active: boolean): { shown: string; done: boolean } {
  const still = prefersReducedMotion();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!active || still) return;
    setCount(0);
    let current = 0;
    const timer = window.setInterval(() => {
      current = Math.min(text.length, current + 3);
      setCount(current);
      if (current >= text.length) window.clearInterval(timer);
    }, 16);
    return () => window.clearInterval(timer);
  }, [text, active, still]);

  if (!active) return { shown: "", done: false };
  if (still) return { shown: text, done: true };
  return { shown: text.slice(0, count), done: count >= text.length };
}
