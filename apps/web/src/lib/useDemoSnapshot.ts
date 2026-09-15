import { useEffect, useState } from "react";
import { loadDemoSnapshot, type DemoSnapshot } from "./demoSnapshot";

/**
 * Load the bundled demo snapshot, once, without blocking anything.
 *
 * WHY IT IS A HOOK AND NOT A TOP-LEVEL IMPORT: the snapshot is ~900 KB of JSON. Importing it at
 * module scope would put it in the entry bundle, so every visitor would download a demo most of them
 * never open — on a page whose entire argument is that it paints instantly. As a dynamic import it
 * becomes its own Vite chunk, fetched from the same static CDN after first paint. Still one round
 * trip, still there before a sleeping backend could possibly answer, and free to everyone who
 * scrolls past.
 *
 * `null` is a SUPPORTED result, not a failure: a build with no generated snapshot renders the same
 * honest empty state it always did. See demoSnapshot.ts on why a build must never be able to satisfy
 * this by inventing one.
 */
export function useDemoSnapshot(): DemoSnapshot | null {
  const [snapshot, setSnapshot] = useState<DemoSnapshot | null>(null);

  useEffect(() => {
    let live = true;
    void loadDemoSnapshot().then((loaded) => {
      if (live) setSnapshot(loaded);
    });
    return () => {
      live = false;
    };
  }, []);

  return snapshot;
}
