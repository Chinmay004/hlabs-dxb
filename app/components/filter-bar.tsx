"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState, useTransition } from "react";

export interface FieldDef {
  name: string;
  label: string;
  type: "text" | "date" | "number" | "select";
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  width?: string;
}

/**
 * URL-driven filter bar. Every control writes to the query string, so the page
 * stays a server component, filters survive a refresh, and any view can be
 * shared as a link or handed straight to the CSV export.
 */
export function FilterBar({
  fields,
  presets,
  exportType,
}: {
  fields: FieldDef[];
  presets?: Array<{ label: string; params: Record<string, string> }>;
  exportType?: "offices" | "brokers" | "projects" | "transactions";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  // The URL is the source of truth; `edits` only holds keystrokes that have not
  // been applied yet, so typing stays instant without the input fighting the
  // navigation. Resetting during render (rather than in an effect) is the
  // pattern React recommends for state derived from props — an effect here
  // would fire a second render pass on every URL change.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const urlKey = searchParams.toString();
  const [lastUrlKey, setLastUrlKey] = useState(urlKey);

  if (urlKey !== lastUrlKey) {
    setLastUrlKey(urlKey);
    setEdits({});
  }

  const valueOf = (name: string) => edits[name] ?? searchParams.get(name) ?? "";
  const draft: Record<string, string> = Object.fromEntries(
    fields.map((f) => [f.name, valueOf(f.name)]),
  );

  const apply = useCallback(
    (patch: Record<string, string>) => {
      const sp = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (!v) sp.delete(k);
        else sp.set(k, v);
      }
      // Any filter change invalidates the current page offset.
      sp.delete("page");
      startTransition(() => router.push(`${pathname}?${sp.toString()}`));
    },
    [pathname, router, searchParams],
  );

  const activeCount = fields.filter((f) => searchParams.get(f.name)).length;

  const exportHref = (() => {
    if (!exportType) return null;
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("type", exportType);
    sp.delete("page");
    sp.delete("pageSize");
    return `/api/export?${sp.toString()}`;
  })();

  return (
    <div className="card mb-3 p-3">
      {presets?.length ? (
        <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] uppercase tracking-wider text-muted">
            Quick views
          </span>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                const sp = new URLSearchParams();
                for (const [k, v] of Object.entries(p.params)) sp.set(k, v);
                startTransition(() => router.push(`${pathname}?${sp.toString()}`));
              }}
              className="rounded border border-[color:var(--border)] bg-[color:var(--surface-2)] px-2 py-1 text-[11px] transition-colors hover:border-[color:var(--accent)]"
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : null}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          apply(draft);
        }}
      >
        {fields.map((f) => (
          <label
            key={f.name}
            className="flex flex-col gap-1"
            style={{ width: f.width ?? "150px" }}
          >
            <span className="text-[10px] uppercase tracking-wider text-muted">
              {f.label}
            </span>
            {f.type === "select" ? (
              <select
                className="field"
                value={draft[f.name] ?? ""}
                onChange={(e) => {
                  setEdits((d) => ({ ...d, [f.name]: e.target.value }));
                  apply({ [f.name]: e.target.value });
                }}
              >
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="field"
                type={f.type}
                placeholder={f.placeholder}
                value={draft[f.name] ?? ""}
                onChange={(e) =>
                  setEdits((d) => ({ ...d, [f.name]: e.target.value }))
                }
                onBlur={() => apply({ [f.name]: draft[f.name] ?? "" })}
              />
            )}
          </label>
        ))}

        <button
          type="submit"
          className="rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/15 px-3 py-1.5 text-[12px] font-medium text-[color:var(--accent)]"
        >
          {pending ? "…" : "Apply"}
        </button>

        {activeCount > 0 ? (
          <button
            type="button"
            onClick={() => startTransition(() => router.push(pathname))}
            className="rounded border border-[color:var(--border)] px-3 py-1.5 text-[12px] text-muted hover:text-[color:var(--foreground)]"
          >
            Clear ({activeCount})
          </button>
        ) : null}

        {exportHref ? (
          <a
            href={exportHref}
            className="ml-auto rounded border border-[color:var(--border)] px-3 py-1.5 text-[12px] text-muted hover:border-[color:var(--accent)] hover:text-[color:var(--foreground)]"
          >
            ↓ Export CSV
          </a>
        ) : null}
      </form>
    </div>
  );
}

export const TRI_OPTIONS = [
  { value: "", label: "Any" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];
