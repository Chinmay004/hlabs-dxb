export const DAY = 86_400_000;

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 10);
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 16).replace("T", " ");
}

export function fmtNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US");
}

export function daysSince(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor((Date.now() - date.getTime()) / DAY);
}

export function daysUntil(d: Date | string | null | undefined): number | null {
  const since = daysSince(d);
  return since == null ? null : -since;
}

/** "3d ago", "2mo ago" — compact enough for a dense table cell. */
export function fmtAge(d: Date | string | null | undefined): string {
  const days = daysSince(d);
  if (days == null) return "—";
  if (days < 0) return `in ${fmtSpan(-days)}`;
  if (days === 0) return "today";
  return `${fmtSpan(days)} ago`;
}

export function fmtSpan(days: number): string {
  if (days < 31) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function isoDay(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
}

/** Percentage change, or null when there's no baseline to compare against. */
export function pctChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

export const TIER_COLOR: Record<string, string> = {
  "A+": "#35c98a",
  A: "#7bd88f",
  B: "#f0b429",
  C: "#e08b4a",
  D: "#6b7688",
};

/**
 * A trailing window ending now. Lives here rather than inline in a component so
 * the React purity lint rule is satisfied — `Date.now()` inside a render body is
 * flagged even in a server component, where it is in fact evaluated once per
 * request.
 */
export function lastNDays(n: number): { from: Date; to: Date } {
  const to = new Date();
  return { from: new Date(to.getTime() - n * DAY), to };
}
