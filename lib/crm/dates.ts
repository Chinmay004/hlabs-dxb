import { CRM_CONFIG } from "./config";

/**
 * Date helpers for batching and targets.
 *
 * Everything works in UTC calendar days on purpose. The registry publishes
 * naive Dubai wall-clock which we store against UTC (see lib/dld/derive.ts), so
 * staying in UTC keeps batch days, target periods and licence dates all on the
 * same calendar. Never introduce a local-timezone `getDate()` here.
 */

export const DAY_MS = 86_400_000;

/** Midnight UTC on the day containing `d`. */
export function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

/** Whole calendar days from `a` to `b`, both normalised to midnight UTC. */
export function daysBetween(a: Date, b: Date): number {
  return Math.round(
    (startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS,
  );
}

export function isWeekend(d: Date): boolean {
  return CRM_CONFIG.weekendDays.includes(d.getUTCDay());
}

/** The next working day at or after `d`. */
export function nextWorkingDay(d: Date): Date {
  let cur = startOfDay(d);
  let guard = 0;
  while (isWeekend(cur) && guard++ < 14) cur = addDays(cur, 1);
  return cur;
}

/** Advance by `n` working days, skipping the configured weekend. */
export function addWorkingDays(d: Date, n: number): Date {
  let cur = startOfDay(d);
  let left = n;
  let guard = 0;
  while (left > 0 && guard++ < 400) {
    cur = addDays(cur, 1);
    if (!isWeekend(cur)) left--;
  }
  return cur;
}

/** Working days from `a` to `b`. Negative when `b` is before `a`. */
export function workingDaysBetween(a: Date, b: Date): number {
  const from = startOfDay(a);
  const to = startOfDay(b);
  if (from.getTime() === to.getTime()) return 0;

  const sign = to > from ? 1 : -1;
  let count = 0;
  let cur = from;
  let guard = 0;

  while (cur.getTime() !== to.getTime() && guard++ < 2000) {
    cur = addDays(cur, sign);
    if (!isWeekend(cur)) count++;
  }
  return count * sign;
}

export function isoDate(d: Date): string {
  return startOfDay(d).toISOString().slice(0, 10);
}

/** ISO-8601 week key, e.g. 2026-W31. Weeks start Monday. */
export function isoWeekKey(d: Date): string {
  const date = startOfDay(d);
  // Thursday of the current week determines the ISO year.
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = addDays(date, 3 - day);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  const firstMonday = addDays(firstThursday, -firstDay);
  const week = Math.floor(daysBetween(firstMonday, thursday) / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function startOfIsoWeek(d: Date): Date {
  const date = startOfDay(d);
  const day = (date.getUTCDay() + 6) % 7;
  return addDays(date, -day);
}

export function monthKey(d: Date): string {
  return startOfDay(d).toISOString().slice(0, 7);
}

export function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function endOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}
