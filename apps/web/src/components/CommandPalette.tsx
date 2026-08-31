import { useEffect, useMemo, useRef, useState } from "react";

/**
 * ⌘K — THE COMMAND PALETTE.
 *
 * A dev-native touch, and the design puts a `⌘K` affordance in both navs. What it searches is what
 * exists: the real modules of the loaded analysis, plus the handful of navigation actions the caller
 * supplies. It never offers a command that would not work — an "Analyze" entry with no repository
 * typed, or a module from a repository that is not loaded, would be a menu of dead ends.
 *
 * FILTERING IS A SUBSTRING MATCH on the file path, deliberately not fuzzy: a fuzzy matcher on file
 * paths ranks `src/a/b/c.ts` above `src/c.ts` for the query "c" often enough to be annoying, and a
 * palette a user cannot predict is slower than a list.
 */

export interface PaletteItem {
  id: string;
  label: string;
  /** Right-aligned kind tag: "module", "go", "action". */
  kind: string;
  run(): void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose(): void;
  items: readonly PaletteItem[];
  placeholder?: string;
}

/** Results rendered. Bounded because a repository can have thousands of modules. */
const MAX_RESULTS = 40;

export function CommandPalette({ open, onClose, items, placeholder }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Focus on open, so ⌘K is a single gesture rather than "open, then click the box".
      inputRef.current?.focus();
    }
  }, [open]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle === "" ? items : items.filter((item) => item.label.toLowerCase().includes(needle));
    return matched.slice(0, MAX_RESULTS);
  }, [items, query]);

  useEffect(() => {
    // Keep the highlight inside the list when the query shrinks it.
    if (active >= results.length) setActive(0);
  }, [results.length, active]);

  if (!open) return null;

  const choose = (index: number) => {
    const item = results[index];
    if (!item) return;
    item.run();
    onClose();
  };

  return (
    <div
      className="palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        // Close on a click OUTSIDE the panel only. Mousedown rather than click so a drag that starts
        // inside and ends outside does not dismiss the palette.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          value={query}
          placeholder={placeholder ?? "Search modules and actions…"}
          aria-label="Search modules and actions"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((current) => (results.length === 0 ? 0 : (current + 1) % results.length));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((current) => (results.length === 0 ? 0 : (current - 1 + results.length) % results.length));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(active);
            }
          }}
        />
        {results.length === 0 ? (
          <p className="palette-empty">
            {items.length === 0
              ? "Nothing to search yet — analyse a repository first."
              : `No module or action matches “${query.trim()}”.`}
          </p>
        ) : (
          <div className="palette-list" role="listbox" aria-label="Results">
            {results.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className="palette-item"
                data-active={index === active}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
              >
                <span className="palette-item-label">{item.label}</span>
                <span className="palette-item-kind">{item.kind}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The ⌘K / Ctrl-K binding. A hook rather than a listener inside the palette, because the palette is
 * not mounted while closed and a component that is not there cannot listen for the key that opens it.
 */
export function usePaletteHotkey(onOpen: () => void): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen]);
}
