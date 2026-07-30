"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const go = (p: number) => {
    const sp = new URLSearchParams(searchParams.toString());
    if (p <= 1) sp.delete("page");
    else sp.set("page", String(p));
    startTransition(() => router.push(`${pathname}?${sp.toString()}`));
  };

  const setSize = (size: string) => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("pageSize", size);
    sp.delete("page");
    startTransition(() => router.push(`${pathname}?${sp.toString()}`));
  };

  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-[12px]">
      <span className="text-muted">
        {pending ? (
          "Loading…"
        ) : (
          <>
            <span className="tabular-nums text-[color:var(--foreground)]">
              {first.toLocaleString()}–{last.toLocaleString()}
            </span>{" "}
            of{" "}
            <span className="tabular-nums text-[color:var(--foreground)]">
              {total.toLocaleString()}
            </span>
          </>
        )}
      </span>

      <div className="flex items-center gap-2">
        <select
          className="field !w-auto"
          value={pageSize}
          onChange={(e) => setSize(e.target.value)}
        >
          {[25, 50, 100, 200, 500].map((s) => (
            <option key={s} value={s}>
              {s} / page
            </option>
          ))}
        </select>

        <button
          type="button"
          disabled={page <= 1}
          onClick={() => go(page - 1)}
          className="rounded border border-[color:var(--border)] px-2.5 py-1 disabled:opacity-30"
        >
          ← Prev
        </button>
        <span className="tabular-nums text-muted">
          {page} / {pageCount}
        </span>
        <button
          type="button"
          disabled={page >= pageCount}
          onClick={() => go(page + 1)}
          className="rounded border border-[color:var(--border)] px-2.5 py-1 disabled:opacity-30"
        >
          Next →
        </button>
      </div>
    </div>
  );
}

/** Clickable column header that toggles asc/desc on the given sort key. */
export function SortHeader({
  label,
  sortKey,
  align = "left",
  defaultDir = "desc",
}: {
  label: string;
  sortKey: string;
  align?: "left" | "right";
  defaultDir?: "asc" | "desc";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const activeSort = searchParams.get("sort");
  const activeDir = searchParams.get("dir") ?? "desc";
  const isActive = activeSort === sortKey;

  const click = () => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("sort", sortKey);
    sp.set("dir", isActive && activeDir === defaultDir
      ? defaultDir === "desc" ? "asc" : "desc"
      : defaultDir);
    sp.delete("page");
    router.push(`${pathname}?${sp.toString()}`);
  };

  return (
    <button
      type="button"
      onClick={click}
      className={`flex w-full items-center gap-1 text-[10px] font-medium uppercase tracking-wider transition-colors hover:text-[color:var(--foreground)] ${
        align === "right" ? "justify-end" : ""
      }`}
      style={{ color: isActive ? "var(--foreground)" : "var(--muted)" }}
    >
      {label}
      <span className="opacity-70">
        {isActive ? (activeDir === "asc" ? "↑" : "↓") : "↕"}
      </span>
    </button>
  );
}
