"use client";

import { useEffect, useState } from "react";

/**
 * Who is sitting at the keyboard.
 *
 * There is no auth on this dashboard — it is an internal tool behind a shared
 * URL — but every research and outreach write is attributed, because "who
 * looked at this firm" is half the value of the log. A name in localStorage is
 * the honest version of that: it is a label, not a credential, and it is not
 * treated as one anywhere on the server.
 */
export const ACTOR_KEY = "hlabs-crm-actor";
const ACTOR_EVENT = "hlabs-crm-actor-change";

export function getActor(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTOR_KEY)?.trim() || null;
}

export function setActor(name: string) {
  window.localStorage.setItem(ACTOR_KEY, name.trim());
  window.dispatchEvent(new Event(ACTOR_EVENT));
}

/** Subscribe to changes so every row's "claim" button agrees on the name. */
export function useActor(): string | null {
  const [actor, setLocal] = useState<string | null>(null);

  useEffect(() => {
    const read = () => setLocal(getActor());
    read();
    window.addEventListener(ACTOR_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(ACTOR_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);

  return actor;
}

export function ActorPicker() {
  const actor = useActor();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);

  // Render nothing definite until the effect in useActor has run, or the server
  // HTML and the first client paint disagree and React logs a hydration error.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) return <span className="text-[11px] text-muted">…</span>;

  if (!actor || editing) {
    return (
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          setActor(draft);
          setEditing(false);
          setDraft("");
        }}
      >
        <input
          className="field !w-[130px] !py-1"
          placeholder="Your name"
          value={draft}
          autoFocus={editing}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          className="rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/15 px-2 py-1 text-[11px] font-medium text-[color:var(--accent)]"
        >
          Set
        </button>
      </form>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(actor);
        setEditing(true);
      }}
      className="rounded border border-[color:var(--border)] px-2 py-1 text-[11px] text-muted hover:border-[color:var(--accent)] hover:text-[color:var(--foreground)]"
      title="Everything you log is recorded under this name. Click to change."
    >
      Working as <span className="text-[color:var(--foreground)]">{actor}</span>
    </button>
  );
}
