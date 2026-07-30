import { prisma } from "@/lib/db";
import {
  BATCH_STATUS,
  CRM_CONFIG,
  DELAY_STATUS,
  STAGE_NEW,
  STAGE_QUEUED,
  TERMINAL_STAGES,
  WORKED_STAGES,
} from "./config";
import {
  addWorkingDays,
  isoWeekKey,
  nextWorkingDay,
  startOfDay,
  workingDaysBetween,
} from "./dates";

/**
 * Batch engine.
 *
 * Three jobs, run in this order on every sync:
 *
 *   1. refreshBatchProgress  — recount how much of each open batch is actually
 *                              worked, and close the ones that are finished.
 *   2. recomputeDelays       — turn due dates into delay state, including the
 *                              cascade where one late batch pushes the next.
 *   3. topUpBatchQueue       — cut new batches so the team always has a few
 *                              days of work queued ahead of them.
 *
 * The order matters: a batch that finished this morning must be closed before
 * delays are computed, or it shows as overdue; and delays must settle before
 * new batches are cut, because a new batch's start date depends on how backed
 * up the lane already is.
 */

export type BatchKind = "BROKERAGE" | "BROKER";

export interface BatchEngineResult {
  created: number;
  closed: number;
  delayed: number;
  progressUpdated: number;
}

/** A lead counts as worked once it has been contacted or moved past outreach. */
function workedWhere() {
  return {
    OR: [
      { contactedAt: { not: null } },
      { status: { in: [...WORKED_STAGES] } },
    ],
  };
}

// ---------------------------------------------------------------- 1. progress

export async function refreshBatchProgress(): Promise<{
  closed: number;
  progressUpdated: number;
}> {
  const open = await prisma.batch.findMany({
    where: { status: { notIn: [BATCH_STATUS.completed, BATCH_STATUS.cancelled] } },
    select: { id: true, kind: true, size: true, worked: true, status: true },
  });

  let closed = 0;
  let progressUpdated = 0;
  const now = new Date();

  for (const batch of open) {
    const worked =
      batch.kind === "BROKERAGE"
        ? await prisma.office.count({ where: { batchId: batch.id, ...workedWhere() } })
        : await prisma.broker.count({ where: { batchId: batch.id, ...workedWhere() } });

    const isDone = batch.size > 0 && worked >= batch.size;

    if (worked === batch.worked && !isDone) continue;

    await prisma.batch.update({
      where: { id: batch.id },
      data: {
        worked,
        ...(isDone
          ? { status: BATCH_STATUS.completed, completedDate: now }
          : // Any progress at all means somebody has picked it up.
            worked > 0 && batch.status === BATCH_STATUS.queued
            ? { status: BATCH_STATUS.inProgress }
            : {}),
      },
    });

    progressUpdated++;
    if (isDone) closed++;
  }

  return { closed, progressUpdated };
}

// ------------------------------------------------------------------ 2. delays

/**
 * Recompute delay state for every batch.
 *
 * `daysOverdue` is working days past the due date. `cascadeDelayDays` carries
 * the delay of the previous unfinished batch in the same lane forward, so a
 * batch that is itself only one day late but sits behind a batch that is four
 * days late reports the full five — which is the number that actually tells you
 * how far behind the team is.
 */
export async function recomputeDelays(): Promise<number> {
  const today = startOfDay(new Date());
  let delayed = 0;

  for (const kind of ["BROKERAGE", "BROKER"] as BatchKind[]) {
    const batches = await prisma.batch.findMany({
      where: { kind, status: { not: BATCH_STATUS.cancelled } },
      orderBy: [{ assignedDate: "asc" }, { code: "asc" }],
      select: {
        id: true,
        status: true,
        dueDate: true,
        completedDate: true,
        daysOverdue: true,
        cascadeDelayDays: true,
        delayStatus: true,
        blockedByBatchId: true,
      },
    });

    // Carried delay from the most recent unfinished batch before this one.
    let carriedDelay = 0;
    let carrierId: string | null = null;

    for (const b of batches) {
      let daysOverdue = 0;
      let delayStatus: string = DELAY_STATUS.onTrack;

      if (b.status === BATCH_STATUS.completed) {
        const late = b.completedDate
          ? workingDaysBetween(b.dueDate, b.completedDate)
          : 0;
        delayStatus = late > 0 ? DELAY_STATUS.doneLate : DELAY_STATUS.doneOnTime;
        daysOverdue = 0;
      } else {
        const past = workingDaysBetween(b.dueDate, today);
        if (past > 0) {
          daysOverdue = past;
          delayStatus =
            past >= CRM_CONFIG.criticalOverdueDays
              ? DELAY_STATUS.critical
              : DELAY_STATUS.overdue;
        } else if (past === 0) {
          delayStatus = DELAY_STATUS.dueToday;
        } else {
          delayStatus = DELAY_STATUS.onTrack;
        }
      }

      const cascade = b.status === BATCH_STATUS.completed ? 0 : carriedDelay;
      const blockedBy = cascade > 0 ? carrierId : null;

      const changed =
        b.daysOverdue !== daysOverdue ||
        b.cascadeDelayDays !== cascade ||
        b.delayStatus !== delayStatus ||
        b.blockedByBatchId !== blockedBy;

      if (changed) {
        await prisma.batch.update({
          where: { id: b.id },
          data: {
            daysOverdue,
            cascadeDelayDays: cascade,
            delayStatus,
            blockedByBatchId: blockedBy,
            // Surface the delay in the human-facing status too, but never
            // overwrite a status a human deliberately set to Completed.
            ...(daysOverdue > 0 && b.status !== BATCH_STATUS.completed
              ? { status: BATCH_STATUS.delayed }
              : {}),
          },
        });
      }

      if (daysOverdue > 0) delayed++;

      // This batch becomes the carrier for everything after it.
      if (b.status !== BATCH_STATUS.completed) {
        const total = daysOverdue + cascade;
        if (total > carriedDelay) {
          carriedDelay = total;
          carrierId = b.id;
        }
      }
    }
  }

  return delayed;
}

// ------------------------------------------------------------------ 3. top up

interface Candidate {
  id: string;
  leadScore: number;
  leadTier: string;
}

async function pickCandidates(kind: BatchKind, take: number): Promise<Candidate[]> {
  const minScore =
    kind === "BROKERAGE"
      ? CRM_CONFIG.minLeadScoreBrokerage
      : CRM_CONFIG.minLeadScoreBroker;

  // Unbatched, still active, not already worked or written off, worth the time.
  const common = {
    batchId: null,
    isActive: true,
    leadScore: { gte: minScore },
    status: { in: [STAGE_NEW, STAGE_QUEUED] },
    contactedAt: null,
  };

  if (kind === "BROKERAGE") {
    const rows = await prisma.office.findMany({
      where: common,
      orderBy: [{ leadScore: "desc" }, { issueDate: "desc" }],
      take,
      select: { realEstateNumber: true, leadScore: true, leadTier: true },
    });
    return rows.map((r) => ({
      id: r.realEstateNumber,
      leadScore: r.leadScore,
      leadTier: r.leadTier,
    }));
  }

  const rows = await prisma.broker.findMany({
    where: { ...common, isNewCard: true },
    orderBy: [{ leadScore: "desc" }, { firstSeenAt: "desc" }],
    take,
    select: { cardNumber: true, leadScore: true, leadTier: true },
  });
  return rows.map((r) => ({
    id: r.cardNumber,
    leadScore: r.leadScore,
    leadTier: r.leadTier,
  }));
}

function dominantTier(rows: Candidate[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.leadTier, (counts.get(r.leadTier) ?? 0) + 1);
  let best = "Mixed";
  let bestN = 0;
  for (const [tier, n] of counts) {
    if (n > bestN) {
      best = tier;
      bestN = n;
    }
  }
  // Only call it a tier batch if that tier actually dominates.
  return bestN >= rows.length * 0.6 ? best : "Mixed";
}

async function nextBatchCode(kind: BatchKind, when: Date): Promise<string> {
  const prefix = kind === "BROKERAGE" ? "BRG" : "BRK";
  const week = isoWeekKey(when);
  const existing = await prisma.batch.count({
    where: { kind, code: { startsWith: `${prefix}-${week}-` } },
  });
  return `${prefix}-${week}-${String(existing + 1).padStart(2, "0")}`;
}

/**
 * Cut new batches until the queue is `queueDepth` deep.
 *
 * Start dates are laid one working day after the last scheduled batch in the
 * lane, so batches form an orderly pipeline rather than all landing today. If
 * the lane is already backed up, the new batch inherits that position — it does
 * not jump the queue.
 */
export async function topUpBatchQueue(): Promise<number> {
  let created = 0;

  for (const kind of ["BROKERAGE", "BROKER"] as BatchKind[]) {
    const depth =
      kind === "BROKERAGE"
        ? CRM_CONFIG.queueDepthBrokerage
        : CRM_CONFIG.queueDepthBroker;

    const openCount = await prisma.batch.count({
      where: {
        kind,
        status: { in: [BATCH_STATUS.queued, BATCH_STATUS.inProgress, BATCH_STATUS.delayed] },
      },
    });

    let toCreate = Math.max(0, depth - openCount);
    if (toCreate === 0) continue;

    // Schedule from the day after the latest batch already on the books.
    const last = await prisma.batch.findFirst({
      where: { kind },
      orderBy: { assignedDate: "desc" },
      select: { assignedDate: true },
    });

    let cursor = last
      ? addWorkingDays(last.assignedDate, 1)
      : nextWorkingDay(new Date());

    while (toCreate-- > 0) {
      const candidates = await pickCandidates(kind, CRM_CONFIG.batchSize);
      if (candidates.length === 0) break;

      const assignedDate = nextWorkingDay(cursor);
      const dueDate = addWorkingDays(assignedDate, CRM_CONFIG.slaDays);
      const code = await nextBatchCode(kind, assignedDate);

      const avg = Math.round(
        candidates.reduce((s, c) => s + c.leadScore, 0) / candidates.length,
      );

      const batch = await prisma.batch.create({
        data: {
          code,
          kind,
          status: BATCH_STATUS.queued,
          size: candidates.length,
          worked: 0,
          priorityBand: dominantTier(candidates),
          avgLeadScore: avg,
          assignedDate,
          dueDate,
          delayStatus: DELAY_STATUS.onTrack,
        },
      });

      const ids = candidates.map((c) => c.id);
      if (kind === "BROKERAGE") {
        await prisma.office.updateMany({
          where: { realEstateNumber: { in: ids } },
          data: { batchId: batch.id, status: STAGE_QUEUED },
        });
      } else {
        await prisma.broker.updateMany({
          where: { cardNumber: { in: ids } },
          data: { batchId: batch.id, status: STAGE_QUEUED },
        });
      }

      created++;
      cursor = addWorkingDays(assignedDate, 1);
    }
  }

  return created;
}

/**
 * Release leads whose batch was cancelled, and unbatch anything that reached a
 * terminal stage so it never gets handed out again.
 */
export async function reclaimStaleAssignments(): Promise<number> {
  const cancelled = await prisma.batch.findMany({
    where: { status: BATCH_STATUS.cancelled },
    select: { id: true },
  });
  const cancelledIds = cancelled.map((b) => b.id);

  const [o1, b1] = await Promise.all([
    prisma.office.updateMany({
      where: {
        OR: [
          { batchId: { in: cancelledIds } },
          { status: { in: [...TERMINAL_STAGES] }, batchId: { not: null } },
        ],
      },
      data: { batchId: null },
    }),
    prisma.broker.updateMany({
      where: {
        OR: [
          { batchId: { in: cancelledIds } },
          { status: { in: [...TERMINAL_STAGES] }, batchId: { not: null } },
        ],
      },
      data: { batchId: null },
    }),
  ]);

  return o1.count + b1.count;
}

export async function runBatchEngine(): Promise<BatchEngineResult> {
  await reclaimStaleAssignments();
  const { closed, progressUpdated } = await refreshBatchProgress();
  const delayed = await recomputeDelays();
  const created = await topUpBatchQueue();

  // A freshly cut batch changes the delay picture for the lane behind it.
  if (created > 0) await recomputeDelays();

  return { created, closed, delayed, progressUpdated };
}
