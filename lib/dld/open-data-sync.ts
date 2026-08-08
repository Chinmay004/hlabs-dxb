/**
 * Sync engine for the open-data catalogue.
 *
 * Every dataset is described once, in DATASETS below: how to page it, how to
 * window it, and how to turn a gateway row into a Prisma row. The engine
 * handles the parts that are identical everywhere - run bookkeeping, retries,
 * replace-vs-upsert, change counting - so adding a dataset is a descriptor,
 * not another copy of this file.
 *
 * Two write modes:
 *
 *   replace   The whole scope is re-fetched and swapped in a transaction. Used
 *             where the source has no row-unique key (rents, lands, buildings,
 *             valuations, units) so an upsert would either collapse real rows
 *             or strand orphans. Scope is a month where the dataset is
 *             windowed, otherwise the whole table.
 *   upsert    Used where a real primary key exists (od_brokers.brokerNumber,
 *             developers.developerNumber) so history survives across runs.
 *
 * See lib/dld/open-data.ts for the transport and its quirks, and the schema
 * comment on this block for why joins must not use the gateway's id columns.
 */
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { parseDate, normalizePhone, normalizeUrl } from "./normalize";
import {
  currentMonth,
  fetchAll,
  fetchLookup,
  fetchPaged,
  gatewayDate,
  monthBounds,
  monthRange,
  OpenDataStats,
  stableRow,
  type OpenDataRow,
} from "./open-data";

export type SyncTrigger = "MANUAL" | "SCHEDULED" | "API";

export type DatasetName =
  | "rents"
  | "lands"
  | "buildings"
  | "units"
  | "brokers"
  | "developers"
  | "valuations"
  | "lookups";

// ---- field helpers -------------------------------------------------------

/**
 * Text cleaner. Deliberately not `normalize.clean()`, which maps "0" to null:
 * here "0" is a real land sub-number and a real parking count.
 */
function text(value: unknown): string | null {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v || v === "-" || v === "null" || v === "undefined") return null;
  return v;
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: unknown): number | null {
  const parsed = num(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function bool(value: unknown): boolean | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n === 1;
  const s = String(value).trim().toLowerCase();
  if (s === "yes" || s === "true") return true;
  if (s === "no" || s === "false") return false;
  return null;
}

function date(value: unknown): Date | null {
  return parseDate(typeof value === "string" ? value : null);
}

function hashRow(row: OpenDataRow): string {
  return createHash("sha256").update(JSON.stringify(stableRow(row))).digest("hex");
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

// ---- dataset descriptors -------------------------------------------------

interface DatasetSpec {
  /** Gateway command. */
  command: "rents" | "lands" | "buildings" | "units" | "brokers" | "developers" | "valuations";
  /** Prisma delegate name. */
  table: "rent" | "land" | "building" | "unit" | "openDataBroker" | "developer" | "valuation";
  /** Windowed datasets are fetched and replaced one calendar month at a time. */
  windowed: boolean;
  mode: "replace" | "upsert";
  /** Parameters other than paging; dates are filled in for windowed sets. */
  params: (window?: { from: Date; to: Date }) => Record<string, unknown>;
  /** Page instead of single-shot, with this natural key for dedupe. */
  paging?: { pageSize: number; key: (row: OpenDataRow) => string };
  map: (row: OpenDataRow, sourceMonth: string) => Record<string, unknown>;
  /** Primary key field name, upsert mode only. */
  pk?: string;
}

const DATASETS: Record<Exclude<DatasetName, "lookups">, DatasetSpec> = {
  rents: {
    command: "rents",
    table: "rent",
    windowed: true,
    mode: "replace",
    params: (w) => ({
      P_FROM_DATE: w ? gatewayDate(w.from) : "",
      P_TO_DATE: w ? gatewayDate(w.to) : "",
      // 0 = registration date, which is the only one guaranteed to fall in the
      // window we asked for.
      P_DATE_TYPE: "0",
      P_IS_FREE_HOLD: "",
      P_VERSION: "",
      P_AREA_ID: "",
      P_USAGE_ID: "",
      P_PROP_TYPE_ID: "",
    }),
    map: (r, sourceMonth) => ({
      contractNumber: text(r.CONTRACT_NUMBER),
      versionNumber: int(r.VERSION_NUMBER),
      versionEn: text(r.VERSION_EN),
      registrationDate: date(r.REGISTRATION_DATE),
      startDate: date(r.START_DATE),
      endDate: date(r.END_DATE),
      contractAmountAed: num(r.CONTRACT_AMOUNT),
      annualAmountAed: num(r.ANNUAL_AMOUNT),
      areaEn: text(r.AREA_EN),
      areaAr: text(r.AREA_AR),
      propTypeEn: text(r.PROP_TYPE_EN),
      propSubTypeEn: text(r.PROP_SUB_TYPE_EN),
      usageEn: text(r.USAGE_EN),
      rooms: text(r.ROOMS),
      parking: text(r.PARKING),
      actualArea: num(r.ACTUAL_AREA),
      isFreeHold: bool(r.IS_FREE_HOLD),
      isFreeHoldEn: text(r.IS_FREE_HOLD_EN),
      projectEn: text(r.PROJECT_EN),
      masterProjectEn: text(r.MASTER_PROJECT_EN),
      nearestMetroEn: text(r.NEAREST_METRO_EN),
      nearestMallEn: text(r.NEAREST_MALL_EN),
      nearestLandmarkEn: text(r.NEAREST_LANDMARK_EN),
      propertyId: int(r.PROPERTY_ID),
      parcelId: text(r.PARCEL_ID),
      landPropertyId: int(r.LAND_PROPERTY_ID),
      totalProperties: int(r.TOTAL_PROPERTIES) ?? 1,
      sourceMonth,
      sourceHash: hashRow(r),
      rawSource: stableRow(r) as Prisma.InputJsonValue,
    }),
  },

  lands: {
    command: "lands",
    table: "land",
    windowed: false,
    mode: "replace",
    params: () => ({
      P_PROJECT: "",
      P_MASTER_PROJECT: "",
      P_LAND_TYPE_ID: "",
      P_AREA_ID: "",
      P_ZONE_ID: "",
      P_IS_FREE_HOLD: "",
      P_PROP_SB_TYPE_ID: "",
    }),
    // 260k rows is too much for one response; paging was verified to produce
    // zero overlap between consecutive pages on this command.
    paging: {
      pageSize: 25_000,
      key: (r) =>
        `${r.PARCEL_ID}|${r.LAND_NUMBER}|${r.LAND_SUB_NUMBER}|${r.AREA_EN}|${r.PROJECT_NUMBER}`,
    },
    map: (r) => ({
      parcelId: text(r.PARCEL_ID),
      landNumber: text(r.LAND_NUMBER),
      landSubNumber: int(r.LAND_SUB_NUMBER),
      municipalityNumber: text(r.MUNICIPALITY_NUMBER),
      dmZipCode: text(r.DM_ZIP_CODE),
      projectNumber: text(r.PROJECT_NUMBER),
      projectEn: text(r.PROJECT_EN),
      masterProjectEn: text(r.MASTER_PROJECT_EN),
      landTypeEn: text(r.LAND_TYPE_EN),
      propSubTypeEn: text(r.PROP_SUB_TYPE_EN),
      areaEn: text(r.AREA_EN),
      areaAr: text(r.AREA_AR),
      zoneEn: text(r.ZONE_EN),
      actualArea: num(r.ACTUAL_AREA),
      isFreeHold: bool(r.IS_FREE_HOLD),
      isOffplanEn: text(r.IS_OFFPLAN_EN),
      isRegistered: bool(r.IS_REGISTERED),
      preRegistrationNumber: text(r.PRE_REGISTRATION_NUMBER),
      separatedFrom: text(r.SEPARATED_FROM),
      sourceHash: hashRow(r),
      rawSource: stableRow(r) as Prisma.InputJsonValue,
    }),
  },

  buildings: {
    command: "buildings",
    table: "building",
    windowed: false,
    mode: "replace",
    // Blank dates return the whole catalogue (9,845). Supplying a range
    // returns nothing, so the date filter is left empty deliberately.
    params: () => ({
      P_FROM_DATE: "",
      P_TO_DATE: "",
      P_IS_FREE_HOLD: "",
      P_AREA_ID: "",
      P_ZONE_ID: "",
      P_IS_LEASE_HOLD: "",
      P_IS_OFFPLAN: "",
    }),
    map: (r) => ({
      buildingNumber: text(r.BUILDING_NUMBER),
      parcelId: text(r.PARCEL_ID),
      landNumber: text(r.LAND_NUMBER),
      landSubNumber: int(r.LAND_SUB_NUMBER),
      projectNumber: text(r.PROJECT_NUMBER),
      projectEn: text(r.PROJECT_EN),
      masterProjectEn: text(r.MASTER_PROJECT_EN),
      areaEn: text(r.AREA_EN),
      zoneEn: text(r.ZONE_EN),
      propSubTypeEn: text(r.PROP_SUB_TYPE_EN),
      landTypeEn: text(r.LAND_TYPE_EN),
      floors: int(r.FLOORS),
      buildingLevels: int(r.BLD_LEVELS),
      flats: int(r.FLATS),
      shops: int(r.SHOPS),
      offices: int(r.OFFICES),
      rooms: int(r.ROOMS),
      carParks: int(r.CAR_PARKS),
      elevators: int(r.ELEVATORS),
      swimmingPools: int(r.SWIMMING_POOLS),
      actualArea: num(r.ACTUAL_AREA),
      builtUpArea: num(r.BUILT_UP_AREA),
      commonArea: num(r.COMMON_AREA),
      actualCommonArea: num(r.ACTUAL_COMMON_AREA),
      creationDate: date(r.CREATION_DATE),
      isFreeHold: bool(r.IS_FREE_HOLD),
      isLeaseHold: bool(r.IS_LEASE_HOLD),
      isRegistered: bool(r.IS_REGISTERED),
      isOffplanEn: text(r.IS_OFFPLAN_EN),
      preRegistrationNumber: text(r.PRE_REGISTRATION_NUMBER),
      sourceHash: hashRow(r),
      rawSource: stableRow(r) as Prisma.InputJsonValue,
    }),
  },

  units: {
    command: "units",
    table: "unit",
    windowed: false,
    mode: "replace",
    params: () => ({
      P_AREA_ID: "",
      P_ZONE_ID: "",
      P_IS_FREE_HOLD: "",
      P_IS_LEASE_HOLD: "",
      P_IS_OFFPLAN: "",
    }),
    map: (r) => ({
      parcelId: text(r.PARCEL_ID),
      areaEn: text(r.AREA_EN),
      zoneEn: text(r.ZONE_EN),
      projectEn: text(r.PROJECT_EN),
      propSubTypeEn: text(r.PROP_SUB_TYPE_EN),
      actualArea: num(r.ACTUAL_AREA),
      isFreeHold: bool(r.IS_FREE_HOLD),
      isLeaseHold: bool(r.IS_LEASE_HOLD),
      isOffplanEn: text(r.IS_OFFPLAN_EN),
      sourceHash: hashRow(r),
      rawSource: stableRow(r) as Prisma.InputJsonValue,
    }),
  },

  brokers: {
    command: "brokers",
    table: "openDataBroker",
    windowed: false,
    mode: "upsert",
    pk: "brokerNumber",
    params: () => ({ P_GENDER: "" }),
    map: (r) => {
      const end = date(r.LICENSE_END_DATE);
      return {
        brokerNumber: String(r.BROKER_NUMBER ?? "").trim(),
        nameEn: text(r.BROKER_EN),
        nameAr: text(r.BROKER_AR),
        genderEn: text(r.GENDER_EN),
        licenseStartDate: date(r.LICENSE_START_DATE),
        licenseEndDate: end,
        phone: normalizePhone(text(r.PHONE)),
        fax: text(r.FAX),
        webpage: normalizeUrl(text(r.WEBPAGE)),
        realEstateNumber: text(r.REAL_ESTATE_NUMBER),
        officeNameEn: text(r.REAL_ESTATE_EN),
        officeNameAr: text(r.REAL_ESTATE_AR),
        isExpired: end ? end.getTime() < Date.now() : false,
        sourceHash: hashRow(r),
        rawSource: stableRow(r) as Prisma.InputJsonValue,
      };
    },
  },

  developers: {
    command: "developers",
    table: "developer",
    windowed: false,
    mode: "upsert",
    pk: "developerNumber",
    // Blank dates return nothing; the window has to span the whole register.
    params: () => ({
      P_FROM_DATE: "01/01/1990",
      P_TO_DATE: gatewayDate(new Date(Date.now() + 365 * 24 * 3600 * 1000)),
      P_NAME: "",
    }),
    map: (r) => ({
      developerNumber: String(r.DEVELOPER_NUMBER ?? "").trim(),
      nameEn: text(r.DEVELOPER_EN),
      nameAr: text(r.DEVELOPER_AR),
      registrationDate: date(r.REGISTRATION_DATE),
      licenseNumber: text(r.LICENSE_NUMBER),
      licenseIssueDate: date(r.LICENSE_ISSUE_DATE),
      licenseExpiryDate: date(r.LICENSE_EXPIRY_DATE),
      licenseSourceEn: text(r.LICENSE_SOURCE_EN),
      licenseTypeEn: text(r.LICENSE_TYPE_EN),
      legalStatusEn: text(r.LEGAL_STATUS_EN),
      chamberOfCommerceNo: text(r.CHAMBER_OF_COMMERCE_NO),
      phone: normalizePhone(text(r.PHONE)),
      fax: text(r.FAX),
      webpage: normalizeUrl(text(r.WEBPAGE)),
      sourceHash: hashRow(r),
      rawSource: stableRow(r) as Prisma.InputJsonValue,
    }),
  },

  valuations: {
    command: "valuations",
    table: "valuation",
    windowed: true,
    mode: "replace",
    params: (w) => ({
      P_FROM_DATE: w ? gatewayDate(w.from) : "",
      P_TO_DATE: w ? gatewayDate(w.to) : "",
      P_AREA_ID: "",
      P_PROP_TYPE_ID: "",
    }),
    map: (r, sourceMonth) => ({
      procedureYear: int(r.PROCEDURE_YEAR),
      procedureNumber: text(r.PROCEDURE_NUMBER),
      instanceDate: date(r.INSTANCE_DATE),
      propertyId: int(r.PROPERTY_ID),
      propertyTypeEn: text(r.PROPERTY_TYPE_EN),
      propSubTypeEn: text(r.PROP_SUB_TYPE_EN),
      areaEn: text(r.AREA_EN),
      areaAr: text(r.AREA_AR),
      actualArea: num(r.ACTUAL_AREA),
      procedureArea: num(r.PROCEDURE_AREA),
      actualWorthAed: num(r.ACTUAL_WORTH),
      propertyTotalValueAed: num(r.PROPERTY_TOTAL_VALUE),
      rowStatusCode: text(r.ROW_STATUS_CODE),
      sourceMonth,
      sourceHash: hashRow(r),
      rawSource: stableRow(r) as Prisma.InputJsonValue,
    }),
  },
};

// ---- run bookkeeping -----------------------------------------------------

/**
 * Close out runs left RUNNING by a crash or a Ctrl-C.
 *
 * The registry sync has four such rows, which is why its history reads as if
 * syncs are still in flight days later. Anything older than the cutoff cannot
 * still be running, so it is recorded as failed before a new run starts.
 */
export async function reapStuckRuns(olderThanHours = 4): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3600 * 1000);
  const { count } = await prisma.openDataSyncRun.updateMany({
    where: { status: "RUNNING", startedAt: { lt: cutoff } },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      error: `Marked failed by the reaper: still RUNNING after ${olderThanHours}h, so the process is gone.`,
    },
  });
  return count;
}

/**
 * Cheap connectivity probe.
 *
 * The three failed scheduled runs all died on `getaddrinfo ENOTFOUND` seconds
 * after starting, because the machine was not on the network yet. Waiting for
 * DNS to come back costs nothing and turns a hard failure into a slow start.
 */
export async function waitForGateway(options: {
  attempts?: number;
  onProgress?: (message: string) => void;
} = {}): Promise<boolean> {
  const attempts = options.attempts ?? 6;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(`${"https://gateway.dubailand.gov.ae"}/offices/?consumer-id=x&pageSize=1`, {
        method: "HEAD",
        signal: AbortSignal.timeout(20_000),
      });
      // Any HTTP answer proves DNS and the route are up; the status is moot.
      if (res) return true;
    } catch {
      if (attempt === attempts) return false;
      const backoff = Math.min(60_000, 5_000 * 2 ** (attempt - 1));
      options.onProgress?.(
        `  gateway unreachable, waiting ${(backoff / 1000).toFixed(0)}s (attempt ${attempt}/${attempts})`,
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  return false;
}

// ---- the engine ----------------------------------------------------------

export interface SyncResult {
  runId: string;
  dataset: DatasetName;
  rowsSeen: number;
  rowsWritten: number;
  rowsNew: number;
  rowsRemoved: number;
  reportedTotal: number;
  requestCount: number;
  retryCount: number;
  errorCount: number;
  durationMs: number;
  perScope: Record<string, number>;
}

export async function runOpenDataSync(
  dataset: Exclude<DatasetName, "lookups">,
  options: {
    trigger?: SyncTrigger;
    fromMonth?: string;
    toMonth?: string;
    onProgress?: (message: string) => void;
  } = {},
): Promise<SyncResult> {
  const spec = DATASETS[dataset];
  const trigger = options.trigger ?? "MANUAL";
  const onProgress = options.onProgress;

  const fromMonth = spec.windowed ? (options.fromMonth ?? currentMonth()) : null;
  const toMonth = spec.windowed ? (options.toMonth ?? fromMonth ?? currentMonth()) : null;

  if (spec.windowed) {
    if (!/^\d{4}-\d{2}$/.test(fromMonth!) || !/^\d{4}-\d{2}$/.test(toMonth!)) {
      throw new Error("months must be YYYY-MM");
    }
    if (fromMonth! > toMonth!) throw new Error(`fromMonth ${fromMonth} is after toMonth ${toMonth}`);
  }

  await reapStuckRuns();

  // Two runs of the same dataset must never overlap. `replace` reads the
  // current rows, deletes them, then inserts; if a second run interleaves,
  // both see an empty table, both delete nothing and both insert - which is
  // exactly how lands ended up with 521,460 rows for a 260,730-row source.
  const active = await prisma.openDataSyncRun.findFirst({
    where: { dataset, status: "RUNNING" },
    orderBy: { startedAt: "desc" },
  });
  if (active) {
    throw new Error(
      `${dataset} sync ${active.id} is already running (started ${active.startedAt.toISOString()}). ` +
        `Wait for it, or clear it with reapStuckRuns() if the process is gone.`,
    );
  }

  const run = await prisma.openDataSyncRun.create({
    data: { dataset, trigger, fromMonth, toMonth },
  });
  const started = Date.now();
  const stats = new OpenDataStats();
  const perScope: Record<string, number> = {};

  let rowsSeen = 0;
  let rowsWritten = 0;
  let rowsNew = 0;
  let rowsRemoved = 0;
  let reportedTotal = 0;

  const delegate = prisma[spec.table] as unknown as {
    findMany: (args: unknown) => Promise<Array<{ sourceHash: string }>>;
    deleteMany: (args?: unknown) => Promise<{ count: number }>;
    createMany: (args: unknown) => Promise<{ count: number }>;
    upsert: (args: unknown) => Promise<unknown>;
    count: (args?: unknown) => Promise<number>;
  };

  try {
    if (!(await waitForGateway({ onProgress }))) {
      throw new Error("gateway is unreachable - no network route to gateway.dubailand.gov.ae");
    }

    const scopes = spec.windowed ? monthRange(fromMonth!, toMonth!) : ["all"];

    for (const scope of scopes) {
      const window = spec.windowed ? monthBounds(scope) : undefined;
      onProgress?.(`${dataset}: fetching ${scope} ...`);

      const params = spec.params(window);
      const fetched = spec.paging
        ? await fetchPaged(spec.command, params, { ...spec.paging, stats, onProgress })
        : await fetchAll(spec.command, params, { stats, onProgress });

      const rows = fetched.rows.map((row) => spec.map(row, scope));
      perScope[scope] = rows.length;
      rowsSeen += rows.length;
      reportedTotal += fetched.reportedTotal;

      if (fetched.reportedTotal && rows.length !== fetched.reportedTotal) {
        onProgress?.(
          `  ${scope}: NOTE got ${rows.length} rows, gateway reported ${fetched.reportedTotal}`,
        );
      }

      if (rows.length === 0) {
        onProgress?.(`  ${scope}: no rows returned, leaving existing data untouched`);
        continue;
      }

      const syncedAt = new Date();

      if (spec.mode === "replace") {
        const scopeWhere = spec.windowed ? { sourceMonth: scope } : {};
        const before = await delegate.findMany({
          where: scopeWhere,
          select: { sourceHash: true },
        });
        const counts = new Map<string, number>();
        for (const row of before) counts.set(row.sourceHash, (counts.get(row.sourceHash) ?? 0) + 1);
        let unchanged = 0;
        for (const row of rows) {
          const left = counts.get(row.sourceHash as string) ?? 0;
          if (left > 0) {
            counts.set(row.sourceHash as string, left - 1);
            unchanged += 1;
          }
        }
        rowsNew += rows.length - unchanged;
        rowsRemoved += before.length - unchanged;

        onProgress?.(`  ${scope}: replacing ${before.length} rows with ${rows.length} ...`);
        await prisma.$transaction(
          async (tx) => {
            const scoped = tx[spec.table] as unknown as typeof delegate;
            await scoped.deleteMany({ where: scopeWhere });
            for (const batch of chunks(rows, 1000)) {
              await scoped.createMany({
                data: batch.map((row) => ({ ...row, syncedAt })),
              });
            }
          },
          { timeout: 600_000 },
        );
      } else {
        const pk = spec.pk!;
        const valid = rows.filter((row) => row[pk]);
        onProgress?.(`  ${scope}: upserting ${valid.length} rows ...`);
        for (const batch of chunks(valid, 500)) {
          await prisma.$transaction(
            async (tx) => {
              const scoped = tx[spec.table] as unknown as typeof delegate;
              for (const row of batch) {
                await scoped.upsert({
                  where: { [pk]: row[pk] },
                  create: { ...row, syncedAt },
                  update: { ...row, syncedAt },
                });
              }
            },
            { timeout: 300_000 },
          );
        }
        rowsNew += valid.length;
      }

      rowsWritten += rows.length;
    }

    const durationMs = Date.now() - started;
    await prisma.openDataSyncRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        durationMs,
        rowsSeen,
        rowsWritten,
        rowsNew,
        rowsRemoved,
        reportedTotal,
        requestCount: stats.requests,
        retryCount: stats.retries,
        errorCount: stats.errors,
        bytesFetched: BigInt(stats.bytes),
        log: { perScope, mode: spec.mode, windowed: spec.windowed },
      },
    });

    return {
      runId: run.id,
      dataset,
      rowsSeen,
      rowsWritten,
      rowsNew,
      rowsRemoved,
      reportedTotal,
      requestCount: stats.requests,
      retryCount: stats.retries,
      errorCount: stats.errors,
      durationMs,
      perScope,
    };
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await prisma.openDataSyncRun.update({
      where: { id: run.id },
      data: {
        status: rowsWritten > 0 ? "PARTIAL" : "FAILED",
        finishedAt: new Date(),
        durationMs: Date.now() - started,
        rowsSeen,
        rowsWritten,
        rowsNew,
        rowsRemoved,
        reportedTotal,
        requestCount: stats.requests,
        retryCount: stats.retries,
        errorCount: Math.max(1, stats.errors),
        bytesFetched: BigInt(stats.bytes),
        error: message.slice(0, 10_000),
        log: { perScope },
      },
    });
    throw error;
  }
}

/** Refresh the three lookup dictionaries. Small, fast, no windowing. */
export async function runLookupSync(
  options: { trigger?: SyncTrigger; onProgress?: (message: string) => void } = {},
): Promise<SyncResult> {
  const run = await prisma.openDataSyncRun.create({
    data: { dataset: "lookups", trigger: options.trigger ?? "MANUAL" },
  });
  const started = Date.now();
  const stats = new OpenDataStats();
  const perScope: Record<string, number> = {};

  try {
    const areas = await fetchLookup("carea-lookup", { stats, onProgress: options.onProgress });
    const projects = await fetchLookup("projects-lookup", { stats, onProgress: options.onProgress });
    const ejari = await fetchLookup("ejari-property-types", { stats, onProgress: options.onProgress });

    perScope["carea-lookup"] = areas.length;
    perScope["projects-lookup"] = projects.length;
    perScope["ejari-property-types"] = ejari.length;

    const now = new Date();
    await prisma.$transaction(
      async (tx) => {
        if (areas.length) {
          await tx.areaLookup.deleteMany({});
          await tx.areaLookup.createMany({
            data: areas
              .filter((a) => a.AREA_ID != null)
              .map((a) => ({
                areaId: String(a.AREA_ID),
                nameEn: text(a.NAME_EN),
                nameAr: text(a.NAME_AR),
                syncedAt: now,
              })),
            skipDuplicates: true,
          });
        }
        if (projects.length) {
          await tx.projectLookup.deleteMany({});
          await tx.projectLookup.createMany({
            data: projects
              .filter((p) => p.ID != null)
              .map((p) => ({
                projectId: String(p.ID),
                nameEn: text(p.NAME_EN),
                nameAr: text(p.NAME_AR),
                syncedAt: now,
              })),
            skipDuplicates: true,
          });
        }
        if (ejari.length) {
          await tx.ejariPropertyType.deleteMany({});
          await tx.ejariPropertyType.createMany({
            data: ejari
              .filter((e) => e.ID != null)
              .map((e) => ({
                typeId: String(e.ID),
                nameEn: text(e.NAME_EN),
                nameAr: text(e.NAME_AR),
                syncedAt: now,
              })),
            skipDuplicates: true,
          });
        }
      },
      { timeout: 120_000 },
    );

    const total = areas.length + projects.length + ejari.length;
    const durationMs = Date.now() - started;
    await prisma.openDataSyncRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        durationMs,
        rowsSeen: total,
        rowsWritten: total,
        rowsNew: total,
        reportedTotal: total,
        requestCount: stats.requests,
        retryCount: stats.retries,
        errorCount: stats.errors,
        bytesFetched: BigInt(stats.bytes),
        log: { perScope },
      },
    });

    return {
      runId: run.id,
      dataset: "lookups",
      rowsSeen: total,
      rowsWritten: total,
      rowsNew: total,
      rowsRemoved: 0,
      reportedTotal: total,
      requestCount: stats.requests,
      retryCount: stats.retries,
      errorCount: stats.errors,
      durationMs,
      perScope,
    };
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await prisma.openDataSyncRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        durationMs: Date.now() - started,
        error: message.slice(0, 10_000),
      },
    });
    throw error;
  }
}
