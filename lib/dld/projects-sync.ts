import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { clean, parseDate } from "./normalize";
import {
  fetchCurrentProjectUnion,
  ProjectGatewayStats,
  type DldProject,
  type ProjectDateType,
} from "./projects-client";

export type ProjectSyncTrigger = "MANUAL" | "SCHEDULED" | "API";

function nullableString(value: string | number | null | undefined) {
  return value == null ? null : clean(String(value));
}

function safeNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeInt(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.trunc(value ?? 0) : 0;
}

function sourceHash(raw: DldProject, dateMatchTypes: ProjectDateType[]) {
  return createHash("sha256")
    .update(JSON.stringify({ raw, dateMatchTypes }))
    .digest("hex");
}

function normalizeProject(
  raw: DldProject,
  dateMatchTypes: ProjectDateType[],
  sourceYear: number,
): Prisma.ProjectUncheckedCreateInput {
  return {
    projectNumber: String(raw.PROJECT_NUMBER).trim(),
    nameEn: clean(raw.PROJECT_EN),
    nameAr: clean(raw.PROJECT_AR),
    developerNumber: nullableString(raw.DEVELOPER_NUMBER),
    developerNameEn: clean(raw.DEVELOPER_EN),
    developerNameAr: clean(raw.DEVELOPER_AR),
    startDate: parseDate(raw.START_DATE),
    endDate: parseDate(raw.END_DATE),
    adoptionDate: parseDate(raw.ADOPTION_DATE),
    inspectionDate: parseDate(raw.INSPECTION_DATE),
    completionDate: parseDate(raw.COMPLETION_DATE),
    projectTypeEn: clean(raw.PRJ_TYPE_EN),
    projectTypeAr: clean(raw.PRJ_TYPE_AR),
    projectValueAed: safeNumber(raw.PROJECT_VALUE),
    escrowAccountNumber: nullableString(raw.ESCROW_ACCOUNT_NUMBER),
    status: clean(raw.PROJECT_STATUS),
    percentCompleted: safeNumber(raw.PERCENT_COMPLETED),
    descriptionEn: clean(raw.DESCRIPTION_EN),
    descriptionAr: clean(raw.DESCRIPTION_AR),
    areaEn: clean(raw.AREA_EN),
    areaAr: clean(raw.AREA_AR),
    zoneEn: clean(raw.ZONE_EN),
    zoneAr: clean(raw.ZONE_AR),
    masterProjectEn: clean(raw.MASTER_PROJECT_EN),
    masterProjectAr: clean(raw.MASTER_PROJECT_AR),
    totalLands: safeInt(raw.CNT_LAND),
    totalBuildings: safeInt(raw.CNT_BUILDING),
    totalVillas: safeInt(raw.CNT_VILLA),
    totalUnits: safeInt(raw.CNT_UNIT),
    totalInventory: safeInt(raw.CNT_TOTAL),
    dateMatchTypes,
    sourceYear,
    sourceHash: sourceHash(raw, dateMatchTypes),
    rawSource: raw as unknown as Prisma.InputJsonValue,
  };
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export async function runProjectSync(options: {
  trigger?: ProjectSyncTrigger;
  year?: number;
  onProgress?: (message: string) => void;
} = {}) {
  const trigger = options.trigger ?? "MANUAL";
  const sourceYear = options.year ?? new Date().getUTCFullYear();
  const activeRun = await prisma.projectSyncRun.findFirst({
    where: {
      status: "RUNNING",
      startedAt: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    },
    orderBy: { startedAt: "desc" },
  });
  if (activeRun) {
    throw new Error(`Project sync ${activeRun.id} is already running`);
  }

  const run = await prisma.projectSyncRun.create({
    data: { trigger, sourceYear },
  });
  const started = Date.now();
  const stats = new ProjectGatewayStats();

  try {
    const fetched = await fetchCurrentProjectUnion({
      year: sourceYear,
      stats,
      onProgress: options.onProgress,
    });
    const rows = fetched.rows.map(({ raw, dateMatchTypes }) =>
      normalizeProject(raw, dateMatchTypes, sourceYear),
    );
    const existing = await prisma.project.findMany({
      where: { projectNumber: { in: rows.map((row) => row.projectNumber) } },
      select: { projectNumber: true, sourceHash: true },
    });
    const oldHashes = new Map(
      existing.map((row) => [row.projectNumber, row.sourceHash]),
    );
    const projectsNew = rows.filter(
      (row) => !oldHashes.has(row.projectNumber),
    ).length;
    const projectsUpdated = rows.filter(
      (row) =>
        oldHashes.has(row.projectNumber) &&
        oldHashes.get(row.projectNumber) !== row.sourceHash,
    ).length;
    const syncedAt = new Date();

    options.onProgress?.(`Projects: writing ${rows.length} unique projects...`);
    for (const batch of chunks(rows, 100)) {
      await prisma.$transaction(
        batch.map((row) =>
          prisma.project.upsert({
            where: { projectNumber: row.projectNumber },
            create: {
              ...row,
              firstSeenAt: syncedAt,
              lastSeenAt: syncedAt,
            },
            update: {
              ...row,
              lastSeenAt: syncedAt,
            },
          }),
        ),
      );
    }

    const durationMs = Date.now() - started;
    await prisma.projectSyncRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        durationMs,
        projectsSeen: rows.length,
        projectsNew,
        projectsUpdated,
        requestCount: stats.requests,
        errorCount: stats.errors,
        log: {
          rowsByDateType: fetched.rowsByDateType,
          dateTypes: {
            1: "start",
            2: "end",
            3: "adoption",
            4: "completion",
          },
          note:
            "Union of the four DLD-required date selectors. The source only exposes the selected calendar year.",
        },
      },
    });

    return {
      runId: run.id,
      sourceYear,
      projectsSeen: rows.length,
      projectsNew,
      projectsUpdated,
      requestCount: stats.requests,
      errorCount: stats.errors,
      durationMs,
      rowsByDateType: fetched.rowsByDateType,
    };
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await prisma.projectSyncRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        durationMs: Date.now() - started,
        requestCount: stats.requests,
        errorCount: Math.max(1, stats.errors),
        error: message.slice(0, 10_000),
      },
    });
    throw error;
  }
}
