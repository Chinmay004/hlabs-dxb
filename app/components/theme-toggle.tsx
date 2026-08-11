"use client";

import { useEffect, useSyncExternalStore } from "react";
import { THEME_KEY, type Theme } from "./theme";

/**
 * Three-state theme control: System / Light / Dark.
 *
 * "System" is the absence of `data-theme` on <html> — the CSS then falls
 * through to the `prefers-color-scheme` block. An explicit choice writes the
 * attribute (which outranks the media query) and persists to localStorage under
 * THEME_KEY, which `layout.tsx` replays inline before first paint. Both sides
 * read that key from `./theme`, which must stay free of `"use client"` — see
 * the note there.
 */

/**
 * localStorage is an external store, so the choice is read through
 * `useSyncExternalStore` rather than an effect. That gets three things at once:
 * React supplies "system" for the server render and swaps in the real value on
 * hydration without a mismatch, the `storage` event keeps a second tab in step,
 * and no `setState` runs inside an effect.
 */
const listeners = new Set<() => void>();

/** Set only when localStorage is unavailable, so the control still works —
 *  just for the life of this page view — in private mode. */
let memoryTheme: Theme | null = null;

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

// Must return a primitive: React compares snapshots by identity, and a fresh
// object every call would loop forever.
function getSnapshot(): Theme {
  if (memoryTheme) return memoryTheme;
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    // Blocked storage, and nothing chosen yet this page view.
    return "system";
  }
}

function getServerSnapshot(): Theme {
  return "system";
}

/**
 * Writes the choice and notifies readers. Module-scoped rather than defined in
 * the component: it touches only the store, and the DOM is left to the effect
 * so there is exactly one place that writes `data-theme`.
 */
function setTheme(next: Theme): void {
  try {
    if (next === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
    memoryTheme = null;
  } catch {
    memoryTheme = next;
  }
  // `storage` only fires in *other* tabs, so this tab is notified by hand.
  for (const l of listeners) l();
}

const OPTIONS: Array<{ value: Theme; label: string; icon: React.ReactNode }> = [
  {
    value: "system",
    label: "Match system",
    icon: (
      <>
        <rect x="2.5" y="3" width="11" height="7.5" rx="1" />
        <path d="M5.5 13h5" />
      </>
    ),
  },
  {
    value: "light",
    label: "Light",
    icon: (
      <>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1v1.5M8 13.5V15M15 8h-1.5M2.5 8H1M12.95 3.05l-1.06 1.06M4.11 11.89l-1.06 1.06M12.95 12.95l-1.06-1.06M4.11 4.11L3.05 3.05" />
      </>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: <path d="M13.5 9.4A5.8 5.8 0 0 1 6.6 2.5a5.8 5.8 0 1 0 6.9 6.9z" />,
  },
];

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Push the choice out to the DOM. Redundant on first load (the inline script
  // in layout.tsx already did it) but not on a cross-tab change, where the
  // snapshot moves without this tab having clicked anything.
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  return (
    <div
      className="flex items-center gap-0.5 rounded-md border border-[color:var(--border)] p-0.5"
      role="group"
      aria-label="Colour theme"
    >
      {OPTIONS.map((o) => {
        const active = theme === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => setTheme(o.value)}
            title={o.label}
            aria-label={o.label}
            aria-pressed={active}
            className="grid h-6 w-6 cursor-pointer place-items-center rounded transition-colors"
            style={{
              background: active ? "var(--surface-2)" : "transparent",
              color: active ? "var(--foreground)" : "var(--muted)",
            }}
          >
            <svg
              viewBox="0 0 16 16"
              width={13}
              height={13}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {o.icon}
            </svg>
          </button>
        );
      })}
    </div>
  );
}
