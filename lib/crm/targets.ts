import { prisma } from "@/lib/db";
import { BATCH_STATUS, CRM_CONFIG, MEETING_STAGES, REPLIED_STAGES } from "./config";
import {
  addDays,
  daysBetween,
  endOfMonth,
  isoDate,
  isoWeekKey,
  isWeekend,
  monthKey,
  startOfDay,
  startOfIsoWeek,
  startOfMonth,
} from "./dates";

/**
 * Target engine.
 *
 * Keeps a rolling window of Daily / Weekly / Monthly target rows, then counts
 * the actuals out of the lead tables. Targets themselves are set by humans in
 * Notion; we only ever seed a default on a brand-new row and never overwrite a
 * number somebody typed.
 */

type PeriodSpec = {
  periodKey: string;
  kind: "DAILY" | "WEEKLY" | "MONTHLY";
  startDate: Date;
  endDate: Date;
};

/** Working days in an inclusive range — the basis for scaling daily targets up. */
function workingDaysInRange(start: Date, end: Date): number {
  let n = 0;
  for (let d = startOfDay(start); d <= end; d = addDays(d, 1)) {
    if (!isWeekend(d)) n++;
  }
  return n;
}

function periodsToMaintain(today: Date): PeriodSpec[] {
  const specs: PeriodSpec[] = [];

  // Daily: a fortnight back for reporting, plus the configured horizon forward.
  for (let i = -14; i <= CRM_CONFIG.targetHorizonDays; i++) {
    const day = addDays(today, i);
    if (isWeekend(day)) continue;
    specs.push({
      periodKey: isoDate(day),
      kind: "DAILY",
      startDate: day,
      endDate: day,
    });
  }

  // Weekly: last 4 and next 4.
  for (let i = -4; i <= 4; i++) {
    const anchor = addDays(startOfIsoWeek(today), i * 7);
    specs.push({
      periodKey: isoWeekKey(anchor),
      kind: "WEEKLY",
      startDate: anchor,
      endDate: addDays(anchor, 6),
    });
  }

  // Monthly: last 3 and next 3.
  for (let i = -3; i <= 3; i++) {
    const anchor = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + i, 1),
    );
    specs.push({
      periodKey: monthKey(anchor),
      kind: "MONTHLY",
      startDate: startOfMonth(anchor),
      endDate: endOfMonth(anchor),
    });
  }

  return specs;
}

/** Create any missing period rows with sensible default targets. */
export async function ensureTargetPeriods(now = new Date()): Promise<number> {
  const today = startOfDay(now);
  const specs = periodsToMaintain(today);

  const existing = await prisma.target.findMany({
    where: { periodKey: { in: specs.map((s) => s.periodKey) } },
    select: { periodKey: true },
  });
  const have = new Set(existing.map((e) => e.periodKey));

  const missing = specs.filter((s) => !have.has(s.periodKey));
  if (missing.length === 0) return 0;

  await prisma.target.createMany({
    data: missing.map((s) => {
      // Weekly and monthly targets are the daily figure scaled by the number of
      // working days they contain, so the three horizons stay consistent.
      const days =
        s.kind === "DAILY" ? 1 : workingDaysInRange(s.startDate, s.endDate);
      return {
        periodKey: s.periodKey,
        kind: s.kind,
        startDate: s.startDate,
        endDate: s.endDate,
        targetTouches: CRM_CONFIG.defaultDailyTouches * days,
        targetBatches: CRM_CONFIG.defaultDailyBatches * days,
        targetReplies: CRM_CONFIG.defaultDailyReplies * days,
        targetMeetings: CRM_CONFIG.defaultDailyMeetings * days,
        status: "Upcoming",
      };
    }),
    skipDuplicates: true,
  });

  return missing.length;
}

/**
 * Grade a period against how much of it has elapsed. A month that is 10% done
 * with 10% attainment is On Track; the same numbers on the last day are Behind.
 */
function gradeStatus(
  actual: number,
  target: number,
  start: Date,
  end: Date,
  today: Date,
): string {
  if (today < start) return "Upcoming";

  const total = Math.max(1, daysBetween(start, end) + 1);
  const elapsed = Math.min(total, Math.max(0, daysBetween(start, today) + 1));
  const finished = today > end;

  if (target <= 0) return finished ? "Hit" : "On Track";

  const attainment = actual / target;
  if (finished) return attainment >= 1 ? "Hit" : "Missed";

  const expected = elapsed / total;
  if (attainment >= expected * 0.95) return "On Track";
  if (attainment >= expected * 0.7) return "At Risk";
  return "Behind";
}

/** Recount actuals for every maintained period and re-grade it. */
export async function recomputeTargetActuals(now = new Date()): Promise<number> {
  const today = startOfDay(now);

  const targets = await prisma.target.findMany({
    orderBy: { startDate: "asc" },
  });

  let updated = 0;

  for (const t of targets) {
    // endDate is a DATE column; push to end-of-day so same-day rows are counted.
    const from = startOfDay(t.startDate);
    const to = addDays(startOfDay(t.endDate), 1);

    const contactedIn = { gte: from, lt: to };

    const [
      touchesOffices,
      touchesBrokers,
      repliesOffices,
      repliesBrokers,
      meetingsOffices,
      meetingsBrokers,
      batchesDone,
    ] = await Promise.all([
      prisma.office.count({ where: { contactedAt: contactedIn } }),
      prisma.broker.count({ where: { contactedAt: contactedIn } }),
      prisma.office.count({
        where: { contactedAt: contactedIn, status: { in: [...REPLIED_STAGES] } },
      }),
      prisma.broker.count({
        where: { contactedAt: contactedIn, status: { in: [...REPLIED_STAGES] } },
      }),
      prisma.office.count({
        where: { contactedAt: contactedIn, status: { in: [...MEETING_STAGES] } },
      }),
      prisma.broker.count({
        where: { contactedAt: contactedIn, status: { in: [...MEETING_STAGES] } },
      }),
      prisma.batch.count({
        where: {
          status: BATCH_STATUS.completed,
          completedDate: contactedIn,
        },
      }),
    ]);

    const actualTouches = touchesOffices + touchesBrokers;
    const actualReplies = repliesOffices + repliesBrokers;
    const actualMeetings = meetingsOffices + meetingsBrokers;

    const status = gradeStatus(
      actualTouches,
      t.targetTouches,
      t.startDate,
      t.endDate,
      today,
    );

    if (
      t.actualTouches === actualTouches &&
      t.actualReplies === actualReplies &&
      t.actualMeetings === actualMeetings &&
      t.actualBatches === batchesDone &&
      t.status === status
    ) {
      continue;
    }

    await prisma.target.update({
      where: { id: t.id },
      data: {
        actualTouches,
        actualReplies,
        actualMeetings,
        actualBatches: batchesDone,
        status,
      },
    });
    updated++;
  }

  return updated;
}

export async function runTargetEngine(now = new Date()) {
  const created = await ensureTargetPeriods(now);
  const updated = await recomputeTargetActuals(now);
  return { created, updated };
}
