"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Triggers a crawl of a third-party government API, so it asks first — an
 * accidental double-click would double the load on the gateway. The route also
 * refuses to stack concurrent runs server-side.
 */
export function SyncButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "confirm" | "running">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const run = async () => {
    setState("running");
    setMessage("Crawling the registry — this takes a few minutes.");
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setMessage(`Failed: ${body.error ?? res.statusText}`);
      } else {
        setMessage(
          `Done in ${(body.durationMs / 1000).toFixed(0)}s — ${body.officesNew} new brokerages, ${body.brokersNew} new brokers.`,
        );
        router.refresh();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setState("idle");
    }
  };

  if (state === "running") {
    return (
      <div className="flex items-center gap-3">
        <span className="rounded border border-[color:var(--border)] px-3 py-1.5 text-xs text-muted">
          Syncing…
        </span>
        {message ? <span className="text-xs text-muted">{message}</span> : null}
      </div>
    );
  }

  if (state === "confirm") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">
          Run a full crawl of the DLD gateway now?
        </span>
        <button
          type="button"
          onClick={run}
          className="rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/15 px-3 py-1.5 font-medium text-[color:var(--accent)]"
        >
          Yes, sync
        </button>
        <button
          type="button"
          onClick={() => setState("idle")}
          className="rounded border border-[color:var(--border)] px-3 py-1.5 text-muted"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => setState("confirm")}
        className="rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/15 px-3 py-1.5 text-xs font-medium text-[color:var(--accent)]"
      >
        Run sync now
      </button>
      {message ? <span className="text-xs text-muted">{message}</span> : null}
    </div>
  );
}
