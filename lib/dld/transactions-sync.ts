import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { parseDate } from "./normalize";
import {
  fetchTransactionsForMonth,
  monthRange,
  TransactionGatewayStats,
  type DldTransaction,
  type TransactionFilters,
} from "./transactions-client";

export type TransactionSyncTrigger = "MANUAL" | "SCHEDULED" | "API";

/**
 * Local text cleaner.
 *
 * Deliberately not `normalize.clean()`: that maps "0" to null, which is right
 * for a placeholder phone number and wrong here, where "0" is a real parking
 * count and a real building age.
 */
function text(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v || v === "-" || v === "null" || v === "undefined") return null;
  return v;
}

function num(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: number | string | null | undefined): number | null {
  const parsed = num(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function bool(value: number | null | undefined): boolean | null {
  if (value == null) return null;
  return value === 1;
}

/**
 * Content hash of one row.
 *
 * Not an identity - byte-identical rows genuinely occur inside multi-unit
 * transactions. It exists so a re-sync can report how much of a month actually
 * moved rather than claiming every row changed.
 */
function sourceHash(raw: DldTransaction): string {
  const stable: Record<string, unknown> = { ...raw };
  // Both describe the response, not the transaction: RN is the row's position
  // and TOTAL the window's grand total. Hashing either would make every
  // refetch look like a change.
  delete stable.RN;
  delete stable.TOTAL;
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/**
 * Recompute deal grouping across the whole table: unit counts, how many
 * monetary legs each deal has, and the single row per deal whose value may be
 * summed.
 *
 * This has to be global, not per-month. DLD's month window filters on
 * registration, but `instanceDate` can fall outside it - a transaction dated
 * 30 April shows up in the May pull - so the rows of one deal can land in two
 * different `sourceMonth` batches. Marking primaries a month at a time gave 40
 * deals two primary rows each and silently inflated the total.
 *
 * The primary is the highest-valued row in the group. That only bites for the
 * deals the source publishes with several monetary legs (see
 * `dealValueVariants`), where picking whichever row arrived first would make
 * the total depend on gateway ordering.
 *
 * Returns the deal count.
 */
export async function recomputeDealGrouping(): Promise<number> {
  await prisma.$executeRaw`
    WITH grouped AS (
      SELECT "transactionNumber",
             "instanceDate",
             COUNT(*)::int                          AS units,
             COUNT(DISTINCT "transValueAed")::int   AS variants
      FROM transactions
      GROUP BY "transactionNumber", "instanceDate"
    ),
    winners AS (
      SELECT DISTINCT ON ("transactionNumber", "instanceDate") id
      FROM transactions
      ORDER BY "transactionNumber",
               "instanceDate",
               "transValueAed" DESC NULLS LAST,
               id
    )
    UPDATE transactions t
    SET "unitCount"         = grouped.units,
        "dealValueVariants" = GREATEST(grouped.variants, 1),
        "isPrimaryUnit"     = (t.id IN (SELECT id FROM winners))
    FROM grouped
    WHERE t."transactionNumber" = grouped."transactionNumber"
      AND t."instanceDate" IS NOT DISTINCT FROM grouped."instanceDate"
  `;

  return prisma.transaction.count({ where: { isPrimaryUnit: true } });
}

function normalizeTransaction(
  raw: DldTransaction,
  sourceMonth: string,
): Prisma.TransactionCreateManyInput {
  return {
    transactionNumber: text(raw.TRANSACTION_NUMBER) ?? "UNKNOWN",
    instanceDate: parseDate(raw.INSTANCE_DATE),

    groupId: int(raw.GROUP_ID),
    groupEn: text(raw.GROUP_EN),
    groupAr: text(raw.GROUP_AR),
    procedureId: int(raw.PROCEDURE_ID),
    procedureEn: text(raw.PROCEDURE_EN),
    procedureAr: text(raw.PROCEDURE_AR),

    isOffplan: bool(raw.IS_OFFPLAN),
    isOffplanEn: text(raw.IS_OFFPLAN_EN),
    isFreeHold: bool(raw.IS_FREE_HOLD),
    isFreeHoldEn: text(raw.IS_FREE_HOLD_EN),

    usageId: int(raw.USAGE_ID),
    usageEn: text(raw.USAGE_EN),
    usageAr: text(raw.USAGE_AR),

    areaId: int(raw.AREA_ID),
    areaEn: text(raw.AREA_EN),
    areaAr: text(raw.AREA_AR),

    propertyId: int(raw.PROPERTY_ID),
    parcelId: text(raw.PARCEL_ID),
    propertyTypeId: int(raw.PROPERTY_TYPE_ID),
    propTypeEn: text(raw.PROP_TYPE_EN),
    propTypeAr: text(raw.PROP_TYPE_AR),
    propertySubTypeId: int(raw.PROPERTY_SUB_TYPE_ID),
    propSubTypeEn: text(raw.PROP_SB_TYPE_EN),
    propSubTypeAr: text(raw.PROP_SB_TYPE_AR),

    transValueAed: num(raw.TRANS_VALUE),
    procedureArea: num(raw.PROCEDURE_AREA),
    actualArea: num(raw.ACTUAL_AREA),

    roomsEn: text(raw.ROOMS_EN),
    roomsAr: text(raw.ROOMS_AR),
    parking: text(raw.PARKING),
    buildingAge: int(raw.BUILDING_AGE),

    projectEn: text(raw.PROJECT_EN),
    projectAr: text(raw.PROJECT_AR),
    masterProjectEn: text(raw.MASTER_PROJECT_EN),
    masterProjectAr: text(raw.MASTER_PROJECT_AR),

    nearestMetroEn: text(raw.NEAREST_METRO_EN),
    nearestMallEn: text(raw.NEAREST_MALL_EN),
    nearestLandmarkEn: text(raw.NEAREST_LANDMARK_EN),

    totalBuyer: int(raw.TOTAL_BUYER) ?? 0,
    totalSeller: int(raw.TOTAL_SELLER) ?? 0,

    sourceMonth,
    sourceHash: sourceHash(raw),
    rawSource: raw as unknown as Prisma.InputJsonValue,
  };
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Pull transactions for a range of calendar months into the mirror.
 *
 * Defaults to the current month, which is what the scheduled run wants: the
 * window is re-fetched on every run because DLD backfills late registrations
 * for a few weeks, and the content hash makes re-writing an unchanged row free.
 */
export async function runTransactionSync(options: {
  trigger?: TransactionSyncTrigger;
  fromMonth?: string;
  toMonth?: string;
  filters?: TransactionFilters;
  onProgress?: (message: string) => void;
} = {}) {
  const trigger = options.trigger ?? "MANUAL";
  const fromMonth = options.fromMonth ?? currentMonth();
  const toMonth = options.toMonth ?? fromMonth;

  if (!/^\d{4}-\d{2}$/.test(fromMonth) || !/^\d{4}-\d{2}$/.test(toMonth)) {
    throw new Error("months must be YYYY-MM");
  }
  if (fromMonth > toMonth) {
    throw new Error(`fromMonth ${fromMonth} is after toMonth ${toMonth}`);
  }

  const activeRun = await prisma.transactionSyncRun.findFirst({
    where: {
      status: "RUNNING",
      startedAt: { gte: new Date(Date.now() - 4 * 60 * 60 * 1000) },
    },
    orderBy: { startedAt: "desc" },
  });
  if (activeRun) {
    throw new Error(`Transaction sync ${activeRun.id} is already running`);
  }

  const run = await prisma.transactionSyncRun.create({
    data: { trigger, fromMonth, toMonth },
  });
  const started = Date.now();
  const stats = new TransactionGatewayStats();
  const months = monthRange(fromMonth, toMonth);
  const perMonth: Record<string, number> = {};

  let seen = 0;
  let created = 0;
  let updated = 0;
  let deals = 0;

  try {
    for (const month of months) {
      options.onProgress?.(`Transactions: fetching ${month} ...`);

      const { rows: raw, reportedTotal } = await fetchTransactionsForMonth(month, {
        filters: options.filters,
        stats,
        onProgress: options.onProgress,
      });

      const rows = raw.map((row) => normalizeTransaction(row, month));
      perMonth[month] = rows.length;
      seen += rows.length;

      if (reportedTotal && rows.length !== reportedTotal) {
        options.onProgress?.(
          `  ${month}: WARNING got ${rows.length} rows, gateway reported ${reportedTotal}`,
        );
      }

      // Change reporting only. A multiset comparison, because content hashes
      // repeat legitimately within multi-unit transactions.
      const before = await prisma.transaction.findMany({
        where: { sourceMonth: month },
        select: { sourceHash: true },
      });
      const beforeCounts = new Map<string, number>();
      for (const row of before) {
        beforeCounts.set(row.sourceHash, (beforeCounts.get(row.sourceHash) ?? 0) + 1);
      }
      let unchanged = 0;
      for (const row of rows) {
        const left = beforeCounts.get(row.sourceHash) ?? 0;
        if (left > 0) {
          beforeCounts.set(row.sourceHash, left - 1);
          unchanged += 1;
        }
      }
      // Rows the gateway now returns that we did not hold, and rows we held
      // that it no longer returns (a correction shows up as one of each).
      created += rows.length - unchanged;
      updated += before.length - unchanged;

      const syncedAt = new Date();
      options.onProgress?.(`  ${month}: replacing ${before.length} rows with ${rows.length} ...`);

      // Replace the month wholesale. The source has no row-unique key, so an
      // upsert would either collapse real units or strand orphans; a
      // delete-then-insert makes the mirror exactly what the gateway returned
      // and keeps a re-run idempotent.
      await prisma.$transaction(async (tx) => {
        await tx.transaction.deleteMany({ where: { sourceMonth: month } });
        for (const batch of chunks(rows, 1000)) {
          await tx.transaction.createMany({
            data: batch.map((row) => ({ ...row, syncedAt })),
          });
        }
      }, { timeout: 300_000 });
    }

    // Global, and only once every month has landed - a deal's rows can span two
    // source months. See recomputeDealGrouping.
    options.onProgress?.("Transactions: recomputing deal grouping ...");
    deals = await recomputeDealGrouping();

    const durationMs = Date.now() - started;
    await prisma.transactionSyncRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        durationMs,
        transactionsSeen: seen,
        transactionsNew: created,
        transactionsUpdated: updated,
        dealsSeen: deals,
        requestCount: stats.requests,
        errorCount: stats.errors,
        log: {
          months,
          perMonth,
          notes: [
            "Rows are units, not deals: a multi-unit transaction emits one row per unit and repeats the whole deal value on each.",
            "DLD open data carries no broker attribution; these rows cannot be joined to offices or brokers.",
          ],
        },
      },
    });

    return {
      runId: run.id,
      fromMonth,
      toMonth,
      months,
      perMonth,
      transactionsSeen: seen,
      transactionsNew: created,
      transactionsUpdated: updated,
      dealsSeen: deals,
      requestCount: stats.requests,
      errorCount: stats.errors,
      durationMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await prisma.transactionSyncRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        durationMs: Date.now() - started,
        transactionsSeen: seen,
        requestCount: stats.requests,
        errorCount: Math.max(1, stats.errors),
        error: message.slice(0, 10_000),
      },
    });
    throw error;
  }
}
