import Link from "next/link";
import type { ReactNode } from "react";
import { TIER_COLOR, fmtNumber, pctChange } from "@/lib/format";

/**
 * A translucent wash of `color`, for badge and pill backgrounds.
 *
 * Mixing toward `transparent` rather than baking an alpha hex is what lets the
 * same call work in both themes: the tint is resolved against whatever surface
 * it lands on, so a 12% success green reads as a pale mint on the light card
 * and a dim glow on the dark one.
 */
function tint(color: string, pct = 12): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`card p-4 ${className}`}>{children}</div>;
}

export function SectionTitle({
  children,
  hint,
  action,
}: {
  children: ReactNode;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight">{children}</h2>
        {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  previous,
  href,
  tone = "default",
}: {
  label: string;
  value: number | string;
  sub?: string;
  /** When given, renders a period-over-period delta chip. */
  previous?: number;
  href?: string;
  tone?: "default" | "good" | "warn" | "hot";
}) {
  const delta =
    previous != null && typeof value === "number" ? pctChange(value, previous) : null;

  const toneColor =
    tone === "good"
      ? "var(--success)"
      : tone === "warn"
        ? "var(--warn)"
        : tone === "hot"
          ? "var(--accent)"
          : "var(--foreground)";

  const body = (
    <>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span
          className="text-2xl font-semibold tabular-nums leading-none"
          style={{ color: toneColor }}
        >
          {typeof value === "number" ? fmtNumber(value) : value}
        </span>
        {delta != null ? (
          <span
            className="rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums"
            style={{
              color: delta >= 0 ? "var(--success)" : "var(--danger)",
              background: tint(delta >= 0 ? "var(--success)" : "var(--danger)"),
            }}
          >
            {delta >= 0 ? "+" : ""}
            {delta.toFixed(0)}%
          </span>
        ) : null}
      </div>
      {sub ? <div className="mt-1 text-[11px] text-muted">{sub}</div> : null}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="card block p-3.5 transition-colors hover:border-[color:var(--accent)]"
      >
        {body}
      </Link>
    );
  }
  return <div className="card p-3.5">{body}</div>;
}

export function TierBadge({ tier }: { tier: string }) {
  const color = TIER_COLOR[tier] ?? TIER_COLOR.D;
  return (
    <span
      className="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
      style={{ color, background: tint(color, 15) }}
    >
      {tier}
    </span>
  );
}

export function Pill({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "accent";
  title?: string;
}) {
  const map = {
    neutral: "var(--muted)",
    good: "var(--success)",
    warn: "var(--warn)",
    bad: "var(--danger)",
    accent: "var(--accent)",
  } as const;
  const color = map[tone];
  const background = tint(color);
  return (
    <span
      title={title}
      className="inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{ color, background }}
    >
      {children}
    </span>
  );
}

/**
 * Horizontal bars for categorical breakdowns (size bands, activities, tiers).
 * Server component on purpose — it has no interactivity, and keeping it out of
 * the client bundle means callers can pass a per-row `href` they computed
 * server-side rather than a callback (which cannot cross that boundary).
 */
export function BarList({
  rows,
  color = "var(--accent)",
}: {
  rows: Array<{ label: string; value: number; hint?: string; href?: string }>;
  color?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));

  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const inner = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-[12px]">
              <span className="truncate" title={r.label}>
                {r.label}
              </span>
              <span className="tabular-nums font-medium text-muted">
                {r.value.toLocaleString()}
                {r.hint ? (
                  <span className="ml-1 text-[10px] opacity-70">{r.hint}</span>
                ) : null}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-sm bg-[color:var(--surface-2)]">
              <div
                className="h-full rounded-sm"
                style={{ width: `${(r.value / max) * 100}%`, background: color }}
              />
            </div>
          </>
        );

        return r.href ? (
          <Link key={r.label} href={r.href} className="block hover:opacity-80">
            {inner}
          </Link>
        ) : (
          <div key={r.label}>{inner}</div>
        );
      })}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-12 text-center text-sm text-muted">{children}</div>
  );
}

/** External link that degrades to a dash when the value is missing. */
export function Ext({
  href,
  children,
  label,
}: {
  href: string | null | undefined;
  children?: ReactNode;
  label?: string;
}) {
  if (!href) return <span className="text-muted">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[color:var(--accent)] hover:underline"
      title={href}
    >
      {children ?? label ?? href.replace(/^https?:\/\//, "").slice(0, 30)}
    </a>
  );
}
