import { useEffect, useState } from "react";

/**
 * THE TOAST — one short confirmation at the bottom of the screen ("⌗ cURL copied").
 *
 * An event on `window` rather than a context: the things that raise a toast (a copy button in the
 * HUD, the CLI line in the footer) sit in different subtrees, and threading a provider through both
 * surfaces for a two-second message is more machinery than the message is worth.
 *
 * `role="status"`, so a screen reader hears the confirmation without focus moving — a copy that
 * succeeded silently is indistinguishable from one that did nothing.
 */

const EVENT = "codeflow:toast";
const VISIBLE_MS = 2400;

export function showToast(message: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: message }));
}

/** Copy text and confirm it with a toast. Reports a failure rather than swallowing it. */
export async function copyWithToast(text: string, confirmation: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) throw new Error("no clipboard");
    await navigator.clipboard.writeText(text);
    showToast(confirmation);
    return true;
  } catch {
    showToast("Copy failed — select the text and copy it by hand");
    return false;
  }
}

export function Toast() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let timer = 0;
    const onToast = (event: Event) => {
      setMessage((event as CustomEvent<string>).detail);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setMessage(null), VISIBLE_MS);
    };
    window.addEventListener(EVENT, onToast);
    return () => {
      window.removeEventListener(EVENT, onToast);
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div className="toast-region" role="status" aria-live="polite">
      {message ? <div className="toast">{message}</div> : null}
    </div>
  );
}
