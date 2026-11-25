import { useEffect, useRef, useState } from "react";
import { hasFinePointer, prefersReducedMotion } from "../lib/motion";

/**
 * THE TRAILING RING — the design's cursor accent.
 *
 * A ring that lags the pointer and swells over anything interactive. It is drawn BESIDE the native
 * cursor, not instead of it: hiding the system cursor to replace it with a div is the version of
 * this effect that breaks text selection, drag handles and every accessibility tool that draws its
 * own pointer, and buys nothing the ring does not already give.
 *
 * It renders NOTHING at all without a fine pointer or under reduced motion — on a touch screen there
 * is no pointer to trail, and a reader who asked for stillness should not get a second moving object
 * on the page. Both are checked in an effect rather than at render, because the first render happens
 * before we know and mounting the elements only to hide them leaves two stray nodes in the DOM.
 *
 * The position is written straight to `style.transform` inside a rAF loop. Routing 60 pointer
 * positions a second through React state would re-render the whole page on every mouse move, which
 * is a real cost paid for a decoration.
 *
 * MAGNETIC BUTTONS ride on the same listener. Any element marked `data-magnetic` leans toward the
 * pointer (the design's 16% / 28% pull, bounded to 8px) — delegated here rather than wired per
 * button, so it has exactly the same gate as the ring: a fine pointer and no reduced motion.
 */
export function Cursor() {
  const ringRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(hasFinePointer() && !prefersReducedMotion());
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const ring = ringRef.current;
    const dot = dotRef.current;
    if (!ring || !dot) return;

    // Start off-screen so the ring does not flash at the origin before the first pointer event.
    let targetX = -100;
    let targetY = -100;
    let ringX = targetX;
    let ringY = targetY;
    let frame = 0;

    let magnet: HTMLElement | null = null;
    const releaseMagnet = () => {
      if (magnet) magnet.style.translate = "";
      magnet = null;
    };

    const onMove = (event: PointerEvent) => {
      targetX = event.clientX;
      targetY = event.clientY;
      ring.dataset.on = "true";
      dot.dataset.on = "true";
      dot.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;
      const pull = (event.target as Element | null)?.closest?.("[data-magnetic]") as HTMLElement | null;
      if (magnet && magnet !== pull) releaseMagnet();
      if (pull && !(pull as HTMLButtonElement).disabled) {
        magnet = pull;
        const rect = pull.getBoundingClientRect();
        const clamp = (n: number) => Math.max(-8, Math.min(8, n));
        const dx = clamp((event.clientX - (rect.left + rect.width / 2)) * 0.16);
        const dy = clamp((event.clientY - (rect.top + rect.height / 2)) * 0.28);
        pull.style.translate = `${dx.toFixed(1)}px ${dy.toFixed(1)}px`;
      }
      // "Interactive" is asked of the DOM rather than tracked in state, so it is right for anything
      // clickable — including elements this component has never heard of.
      const over = (event.target as Element | null)?.closest?.("a, button, input, [role='button'], [tabindex]");
      ring.dataset.over = over ? "true" : "false";
    };

    const tick = () => {
      // The design's lag: 14% of the remaining distance per frame — a trail, not a spring.
      ringX += (targetX - ringX) * 0.14;
      ringY += (targetY - ringY) * 0.14;
      ring.style.transform = `translate3d(${ringX.toFixed(2)}px, ${ringY.toFixed(2)}px, 0)`;
      frame = requestAnimationFrame(tick);
    };

    const onLeaveWindow = () => {
      ring.dataset.on = "false";
      dot.dataset.on = "false";
      releaseMagnet();
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeaveWindow);
    frame = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeaveWindow);
      releaseMagnet();
      cancelAnimationFrame(frame);
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div className="cursor" aria-hidden="true">
      <div className="cursor-ring" ref={ringRef} />
      <div className="cursor-dot" ref={dotRef} />
    </div>
  );
}
