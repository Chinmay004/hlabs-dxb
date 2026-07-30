import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  DldStats,
  fetchAllBrokers,
  fetchAllOffices,
  fetchBrokersForOffice,
  mapLimit,
  type DldBroker,
  type DldOffice,
} from "./client";
import {
  normalizeBroker,
  normalizeOffice,
  type BrokerRow,
  type OfficeRow,
} from "./normalize";
import { recomputeDailyStats, recomputeLeadScores, recomputeRollups } from "./derive";

/**
 * A full crawl of both endpoints is ~45 requests and finishes in a couple of
 * minutes, so we always take a complete snapshot rather than trying to guess a
 * delta. The registry exposes no date filter or sort, so there is no cheaper
 * correct option - and a full snapshot is what lets us detect disappearances
 * (licences dropped) as well as additions.
 *
 * "New" is then derived two ways, which is the distinction that matters for
 * lead gen:
 *
 *   issueDate      - what the registry says. For a broker card this moves on
 *                    every annual renewal, so on its own it over-counts badly.
 *   firstSeenAt    - the first sync in which we ever saw this row. Combined
 *                    with the card-number high-water mark this isolates
 *                    genuinely first-time licences from renewals.
 */

export type SyncKind = "FULL" | "INCREMENTAL" | "BACKFILL";
export type SyncTrigger = "MANUAL" | "SCHEDULED" | "API";

const HIGH_WATER_CARD_KEY = "max_card_number";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Bulk paging over /brokers/ drops a few rows per page and repeats a few
 * others, so a single crawl lands a fraction short of the reported total. The
 * per-office lookup (`?officeNumber=`) has no such drift, so we re-pull rosters
 * office by office for the brokerages we actually sell to. Everything licensed
 * inside this window gets an exact roster every run.
 *
 * This is the slow part of a sync — roughly one second per brokerage after
 * concurrency — so the window is deliberately narrow. The weekly `--deep` run
 * covers everything else. All three are env-tunable.
 */
const RECONCILE_WINDOW_DAYS = envInt("RECONCILE_WINDOW_DAYS", 180);

/** Ceiling on per-office reconcile requests so one run can't sprawl. */
const RECONCILE_MAX_OFFICES = envInt("RECONCILE_MAX_OFFICES", 1200);

/** Parallel per-office requests. The gateway is fine at this rate. */
const RECONCILE_CONCURRENCY = envInt("RECONCILE_CONCURRENCY", 12);

/** Office fields whose change is worth an audit row. */
const OFFICE_TRACKED = [
  "nameEn",
  "licenseNumber",
  "issueDate",
  "expiryDate",
  "phone",
  "website",
  "contactEmail",
  "contactMobile",
  "contactNameEn",
  "rank",
  "whatsapp",
  "instagramUrl",
] as const;

/** Broker fields whose change is worth an audit row. `realEstateNumber` moving
 *  means the broker switched agency - one of the strongest signals we have. */
const BROKER_TRACKED = [
  "nameEn",
  "cardIssueDate",
  "cardExpiryDate",
  "email",
  "mobile",
  "realEstateNumber",
  "cardRank",
] as const;

interface ChangeRow {
  id: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

function asComparable(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export interface SyncProgress {
  (message: string): void;
}

export interface SyncResult {
  runId: string;
  status: "SUCCESS" | "FAILED" | "PARTIAL";
  durationMs: number;
  officesSeen: number;
  officesNew: number;
  officesUpdated: number;
  officesDeactivated: number;
  brokersSeen: number;
  brokersNew: number;
  brokersUpdated: number;
  brokersDeactivated: number;
  requestCount: number;
  errorCount: number;
  error?: string;
  newOfficeNumbers: string[];
  newBrokerCards: string[];
}

export async function runSync(options: {
  kind?: SyncKind;
  trigger?: SyncTrigger;
  onProgress?: SyncProgress;
  /** Reconcile every brokerage, not just recently licensed ones. Slow (~10k
   *  requests); worth running weekly to close gaps on older firms. */
  deep?: boolean;
} = {}): Promise<SyncResult> {
  const kind = options.kind ?? "FULL";
  const trigger = options.trigger ?? "MANUAL";
  const log = options.onProgress ?? (() => {});
  const stats = new DldStats();
  const started = Date.now();
  const notes: string[] = [];

  const note = (m: string) => {
    notes.push(`[${new Date().toISOString()}] ${m}`);
    log(m);
  };

  const run = await prisma.syncRun.create({
    data: { kind, trigger, status: "RUNNING" },
  });

  const result: SyncResult = {
    runId: run.id,
    status: "SUCCESS",
    durationMs: 0,
    officesSeen: 0,
    officesNew: 0,
    officesUpdated: 0,
    officesDeactivated: 0,
    brokersSeen: 0,
    brokersNew: 0,
    brokersUpdated: 0,
    brokersDeactivated: 0,
    requestCount: 0,
    errorCount: 0,
    newOfficeNumbers: [],
    newBrokerCards: [],
  };

  try {
    const syncedAt = new Date();

    // ---------------------------------------------------------------- offices
    note("Crawling /offices/ ...");
    const officesRaw = await fetchAllOffices({
      stats,
      onProgress: ({ page, pageRows, unique, total }) =>
        note(`  offices page ${page}: +${pageRows} rows, ${unique}/${total} unique`),
    });
    note(`Fetched ${officesRaw.rows.length} unique offices (registry reports ${officesRaw.reportedTotal}).`);

    const offices = (officesRaw.rows as DldOffice[])
      .map(normalizeOffice)
      .filter((o) => o.realEstateNumber);

    const officeOutcome = await upsertOffices(offices, syncedAt, run.id, note);
    result.officesSeen = offices.length;
    result.officesNew = officeOutcome.created.length;
    result.officesUpdated = officeOutcome.updated;
    result.newOfficeNumbers = officeOutcome.created;

    // ---------------------------------------------------------------- brokers
    note("Crawling /brokers/ ...");
    const brokersRaw = await fetchAllBrokers({
      stats,
      onProgress: ({ page, pageRows, unique, total }) =>
        note(`  brokers page ${page}: +${pageRows} rows, ${unique}/${total} unique`),
    });
    note(`Fetched ${brokersRaw.rows.length} unique brokers (registry reports ${brokersRaw.reportedTotal}).`);

    const brokers = (brokersRaw.rows as DldBroker[])
      .map(normalizeBroker)
      .filter((b) => b.cardNumber);

    // The registry can reference an office on a broker row that never showed up
    // in the /offices/ listing (paging drops a couple every crawl). Insert those
    // stubs first so the foreign key holds.
    await backfillMissingOffices(brokers, syncedAt, note);

    const brokerOutcome = await upsertBrokers(brokers, syncedAt, run.id, note);
    result.brokersSeen = brokers.length;
    result.brokersNew = brokerOutcome.created.length;
    result.brokersUpdated = brokerOutcome.updated;
    result.newBrokerCards = brokerOutcome.created;

    // ------------------------------------------------- per-office reconcile
    const reconciled = await reconcileOfficeRosters({
      deep: options.deep ?? false,
      syncedAt,
      runId: run.id,
      stats,
      note,
      // Most of what reconcile pulls back was already in the bulk crawl; only
      // the cards missing from it are genuinely additional observations.
      alreadySeen: new Set(brokers.map((b) => b.cardNumber)),
    });
    result.brokersSeen += reconciled.seen;
    result.brokersNew += reconciled.created;
    result.brokersUpdated += reconciled.updated;
    result.newBrokerCards.push(...reconciled.createdCards);

    // ------------------------------------------------- deactivate disappeared
    if (kind === "FULL") {
      const [offGone, brkGone] = await Promise.all([
        prisma.office.updateMany({
          where: { isActive: true, lastSeenAt: { lt: syncedAt } },
          data: { isActive: false, deactivatedAt: syncedAt },
        }),
        prisma.broker.updateMany({
          where: { isActive: true, lastSeenAt: { lt: syncedAt } },
          data: { isActive: false, deactivatedAt: syncedAt },
        }),
      ]);
      result.officesDeactivated = offGone.count;
      result.brokersDeactivated = brkGone.count;
      if (offGone.count || brkGone.count) {
        note(`Deactivated ${offGone.count} offices and ${brkGone.count} brokers no longer in the registry.`);
      }
    }

    // ------------------------------------------------------------- derivation
    note("Recomputing rollups ...");
    await recomputeRollups();
    note("Recomputing lead scores ...");
    await recomputeLeadScores();
    note("Rebuilding daily stats ...");
    await recomputeDailyStats();

    await updateHighWaterMark(brokers);

    result.requestCount = stats.requests;
    result.errorCount = stats.errors;
    result.durationMs = Date.now() - started;

    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: result.status,
        finishedAt: new Date(),
        durationMs: result.durationMs,
        officesSeen: result.officesSeen,
        officesNew: result.officesNew,
        officesUpdated: result.officesUpdated,
        officesDeactivated: result.officesDeactivated,
        brokersSeen: result.brokersSeen,
        brokersNew: result.brokersNew,
        brokersUpdated: result.brokersUpdated,
        brokersDeactivated: result.brokersDeactivated,
        requestCount: stats.requests,
        errorCount: stats.errors,
        log: notes.slice(-400) as unknown as Prisma.InputJsonValue,
      },
    });

    note(`Done in ${(result.durationMs / 1000).toFixed(1)}s.`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.status = "FAILED";
    result.error = message;
    result.durationMs = Date.now() - started;

    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        durationMs: result.durationMs,
        error: message,
        requestCount: stats.requests,
        errorCount: stats.errors + 1,
        log: notes.slice(-400) as unknown as Prisma.InputJsonValue,
      },
    });

    throw err;
  }
}

// ------------------------------------------------------------------ reconcile

/**
 * Re-pull broker rosters one office at a time, which is the only way to get an
 * exact list. Targets the brokerages we care about commercially - recently
 * licensed, or ones the bulk crawl found no brokers for at all - unless `deep`
 * asks for the whole registry.
 */
async function reconcileOfficeRosters(args: {
  deep: boolean;
  syncedAt: Date;
  runId: string;
  stats: DldStats;
  note: (m: string) => void;
  /** Card numbers the bulk crawl already reported, so `seen` counts only extras. */
  alreadySeen: Set<string>;
}): Promise<{ seen: number; created: number; updated: number; createdCards: string[] }> {
  const { deep, syncedAt, runId, stats, note, alreadySeen } = args;
  const empty = { seen: 0, created: 0, updated: 0, createdCards: [] as string[] };

  const cutoff = new Date(Date.now() - RECONCILE_WINDOW_DAYS * 86_400_000);

  const targets = await prisma.office.findMany({
    where: deep
      ? { isActive: true }
      : {
          isActive: true,
          OR: [
            { issueDate: { gte: cutoff } },
            { activeBrokerCount: 0 },
            { firstSeenAt: { gte: syncedAt } },
          ],
        },
    select: { realEstateNumber: true },
    orderBy: { issueDate: "desc" },
    take: deep ? undefined : RECONCILE_MAX_OFFICES,
  });

  if (targets.length === 0) return empty;

  note(
    `Reconciling rosters for ${targets.length} ${deep ? "(deep: all active)" : "priority"} brokerages ...`,
  );

  const collected = new Map<string, BrokerRow>();
  let done = 0;

  await mapLimit(targets, RECONCILE_CONCURRENCY, async (t) => {
    try {
      const rows = await fetchBrokersForOffice(t.realEstateNumber, { stats });
      for (const r of rows) {
        const n = normalizeBroker(r);
        if (n.cardNumber) collected.set(n.cardNumber, n);
      }
    } catch {
      // One unreachable office must not sink the run; the next sync retries it.
      stats.errors++;
    }
    done++;
    if (done % 250 === 0) note(`  reconciled ${done}/${targets.length} offices`);
  });

  if (collected.size === 0) return empty;

  const rows = [...collected.values()];
  const outcome = await upsertBrokers(rows, syncedAt, runId, note);

  const extras = rows.filter((r) => !alreadySeen.has(r.cardNumber)).length;
  note(
    `Reconcile checked ${rows.length} cards across ${targets.length} brokerages: ` +
      `${extras} the bulk crawl missed, ${outcome.created.length} new to us.`,
  );

  return {
    seen: extras,
    created: outcome.created.length,
    updated: outcome.updated,
    createdCards: outcome.created,
  };
}

// --------------------------------------------------------------------- upsert

async function upsertOffices(
  rows: OfficeRow[],
  syncedAt: Date,
  runId: string,
  note: (m: string) => void,
): Promise<{ created: string[]; updated: number }> {
  const existing = await prisma.office.findMany({
    select: {
      realEstateNumber: true,
      nameEn: true,
      licenseNumber: true,
      issueDate: true,
      expiryDate: true,
      phone: true,
      website: true,
      contactEmail: true,
      contactMobile: true,
      contactNameEn: true,
      rank: true,
      whatsapp: true,
      instagramUrl: true,
    },
  });

  const prev = new Map(existing.map((e) => [e.realEstateNumber, e]));
  const created: string[] = [];
  const changes: ChangeRow[] = [];
  let updated = 0;

  for (const row of rows) {
    const before = prev.get(row.realEstateNumber);
    if (!before) {
      created.push(row.realEstateNumber);
      continue;
    }
    let dirty = false;
    for (const field of OFFICE_TRACKED) {
      const oldValue = asComparable((before as Record<string, unknown>)[field]);
      const newValue = asComparable((row as unknown as Record<string, unknown>)[field]);
      if (oldValue !== newValue) {
        changes.push({ id: row.realEstateNumber, field, oldValue, newValue });
        dirty = true;
      }
    }
    if (dirty) updated++;
  }

  const CHUNK = 400;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await writeOfficeChunk(rows.slice(i, i + CHUNK), syncedAt);
  }
  note(`Offices: ${created.length} new, ${updated} changed, ${rows.length} total.`);

  await writeChanges("office_changes", changes, runId);

  return { created, updated };
}

async function writeOfficeChunk(chunk: OfficeRow[], syncedAt: Date) {
  if (chunk.length === 0) return;

  const values: Prisma.Sql[] = chunk.map(
    (o) => Prisma.sql`(
      ${o.realEstateNumber}, ${o.licenseNumber}, ${o.nameEn}, ${o.nameAr},
      ${o.issueDate}, ${o.expiryDate}, ${o.phone}, ${o.fax}, ${o.website},
      ${o.contactNameEn}, ${o.contactNameAr}, ${o.contactMobile}, ${o.contactEmail},
      ${o.logo}, ${o.rankId}, ${o.rank}, ${o.awardsCount},
      ${o.youtubeUrl}, ${o.facebookUrl}, ${o.instagramUrl}, ${o.twitterUrl},
      ${o.linkedinUrl}, ${o.whatsapp},
      ${JSON.stringify(o.activities)}::jsonb,
      ${syncedAt}, ${syncedAt}, true, ${syncedAt}
    )`,
  );

  await prisma.$executeRaw`
    INSERT INTO offices (
      "realEstateNumber", "licenseNumber", "nameEn", "nameAr",
      "issueDate", "expiryDate", "phone", "fax", "website",
      "contactNameEn", "contactNameAr", "contactMobile", "contactEmail",
      "logo", "rankId", "rank", "awardsCount",
      "youtubeUrl", "facebookUrl", "instagramUrl", "twitterUrl",
      "linkedinUrl", "whatsapp", "activities",
      "firstSeenAt", "lastSeenAt", "isActive", "updatedAt"
    )
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("realEstateNumber") DO UPDATE SET
      "licenseNumber" = EXCLUDED."licenseNumber",
      "nameEn"        = EXCLUDED."nameEn",
      "nameAr"        = EXCLUDED."nameAr",
      "issueDate"     = EXCLUDED."issueDate",
      "expiryDate"    = EXCLUDED."expiryDate",
      "phone"         = EXCLUDED."phone",
      "fax"           = EXCLUDED."fax",
      "website"       = EXCLUDED."website",
      "contactNameEn" = EXCLUDED."contactNameEn",
      "contactNameAr" = EXCLUDED."contactNameAr",
      "contactMobile" = EXCLUDED."contactMobile",
      "contactEmail"  = EXCLUDED."contactEmail",
      "logo"          = EXCLUDED."logo",
      "rankId"        = EXCLUDED."rankId",
      "rank"          = EXCLUDED."rank",
      "awardsCount"   = EXCLUDED."awardsCount",
      "youtubeUrl"    = EXCLUDED."youtubeUrl",
      "facebookUrl"   = EXCLUDED."facebookUrl",
      "instagramUrl"  = EXCLUDED."instagramUrl",
      "twitterUrl"    = EXCLUDED."twitterUrl",
      "linkedinUrl"   = EXCLUDED."linkedinUrl",
      "whatsapp"      = EXCLUDED."whatsapp",
      "activities"    = EXCLUDED."activities",
      "lastSeenAt"    = EXCLUDED."lastSeenAt",
      "isActive"      = true,
      "deactivatedAt" = NULL,
      "updatedAt"     = EXCLUDED."updatedAt"
  `;
}

/** Offices referenced by a broker row but absent from the /offices/ crawl. */
async function backfillMissingOffices(
  brokers: BrokerRow[],
  syncedAt: Date,
  note: (m: string) => void,
) {
  const referenced = new Set(
    brokers.map((b) => b.realEstateNumber).filter((n): n is string => !!n),
  );
  if (referenced.size === 0) return;

  const known = await prisma.office.findMany({
    where: { realEstateNumber: { in: [...referenced] } },
    select: { realEstateNumber: true },
  });
  const knownSet = new Set(known.map((k) => k.realEstateNumber));
  const missing = [...referenced].filter((n) => !knownSet.has(n));
  if (missing.length === 0) return;

  // Broker rows carry a denormalised copy of their office's name and dates, so
  // a usable stub can be built without a second round-trip.
  const byOffice = new Map<string, BrokerRow>();
  for (const b of brokers) {
    if (b.realEstateNumber && missing.includes(b.realEstateNumber) && !byOffice.has(b.realEstateNumber)) {
      byOffice.set(b.realEstateNumber, b);
    }
  }

  const stubs: OfficeRow[] = [...byOffice.values()].map((b) => ({
    realEstateNumber: b.realEstateNumber!,
    licenseNumber: b.licenseNumber,
    nameEn: b.officeNameEn,
    nameAr: b.officeNameAr,
    issueDate: b.officeIssueDate,
    expiryDate: b.officeExpiryDate,
    phone: null,
    fax: null,
    website: null,
    contactNameEn: null,
    contactNameAr: null,
    contactMobile: null,
    contactEmail: null,
    logo: null,
    rankId: b.officeRankId,
    rank: b.officeRank,
    awardsCount: 0,
    youtubeUrl: null,
    facebookUrl: null,
    instagramUrl: null,
    twitterUrl: null,
    linkedinUrl: null,
    whatsapp: null,
    activities: [],
  }));

  for (let i = 0; i < stubs.length; i += 400) {
    await writeOfficeChunk(stubs.slice(i, i + 400), syncedAt);
  }
  note(`Backfilled ${stubs.length} offices seen only on broker rows.`);
}

async function upsertBrokers(
  rows: BrokerRow[],
  syncedAt: Date,
  runId: string,
  note: (m: string) => void,
): Promise<{ created: string[]; updated: number }> {
  const existing = await prisma.broker.findMany({
    select: {
      cardNumber: true,
      nameEn: true,
      cardIssueDate: true,
      cardExpiryDate: true,
      email: true,
      mobile: true,
      realEstateNumber: true,
      cardRank: true,
    },
  });

  const prev = new Map(existing.map((e) => [e.cardNumber, e]));
  const created: string[] = [];
  const changes: ChangeRow[] = [];
  let updated = 0;

  // Card numbers are issued sequentially. Anything above the previous high-water
  // mark is a first-time licence rather than a renewal of an old card.
  const highWater = await readHighWaterMark();

  for (const row of rows) {
    const before = prev.get(row.cardNumber);
    if (!before) {
      created.push(row.cardNumber);
      continue;
    }
    let dirty = false;
    for (const field of BROKER_TRACKED) {
      const oldValue = asComparable((before as Record<string, unknown>)[field]);
      const newValue = asComparable((row as unknown as Record<string, unknown>)[field]);
      if (oldValue !== newValue) {
        changes.push({ id: row.cardNumber, field, oldValue, newValue });
        dirty = true;
      }
    }
    if (dirty) updated++;
  }

  const CHUNK = 400;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await writeBrokerChunk(rows.slice(i, i + CHUNK), syncedAt, highWater);
  }
  note(`Brokers: ${created.length} new, ${updated} changed, ${rows.length} total.`);

  await writeChanges("broker_changes", changes, runId);

  return { created, updated };
}

async function writeBrokerChunk(
  chunk: BrokerRow[],
  syncedAt: Date,
  highWater: number,
) {
  if (chunk.length === 0) return;

  const values: Prisma.Sql[] = chunk.map((b) => {
    // On the very first sync there is no watermark to compare against, so every
    // card is treated as pre-existing rather than as 34k brand-new brokers. The
    // watermark is written at the end of the run; from the next sync onward this
    // is exact.
    const numeric = Number(b.cardNumber);
    const isNewCard =
      highWater > 0 && Number.isFinite(numeric) && numeric > highWater;
    return Prisma.sql`(
      ${b.cardNumber}, ${b.nameEn}, ${b.nameAr},
      ${b.cardIssueDate}, ${b.cardExpiryDate},
      ${b.phone}, ${b.mobile}, ${b.email},
      ${b.realEstateNumber}, ${b.licenseNumber},
      ${b.officeNameEn}, ${b.officeNameAr}, ${b.officeIssueDate}, ${b.officeExpiryDate},
      ${b.photo}, ${b.cardRankId}, ${b.cardRank}, ${b.officeRankId}, ${b.officeRank},
      ${b.awardsCount}, ${isNewCard},
      ${syncedAt}, ${syncedAt}, true, ${syncedAt}
    )`;
  });

  await prisma.$executeRaw`
    INSERT INTO brokers (
      "cardNumber", "nameEn", "nameAr",
      "cardIssueDate", "cardExpiryDate",
      "phone", "mobile", "email",
      "realEstateNumber", "licenseNumber",
      "officeNameEn", "officeNameAr", "officeIssueDate", "officeExpiryDate",
      "photo", "cardRankId", "cardRank", "officeRankId", "officeRank",
      "awardsCount", "isNewCard",
      "firstSeenAt", "lastSeenAt", "isActive", "updatedAt"
    )
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("cardNumber") DO UPDATE SET
      "nameEn"           = EXCLUDED."nameEn",
      "nameAr"           = EXCLUDED."nameAr",
      "cardIssueDate"    = EXCLUDED."cardIssueDate",
      "cardExpiryDate"   = EXCLUDED."cardExpiryDate",
      "phone"            = EXCLUDED."phone",
      "mobile"           = EXCLUDED."mobile",
      "email"            = EXCLUDED."email",
      "realEstateNumber" = EXCLUDED."realEstateNumber",
      "licenseNumber"    = EXCLUDED."licenseNumber",
      "officeNameEn"     = EXCLUDED."officeNameEn",
      "officeNameAr"     = EXCLUDED."officeNameAr",
      "officeIssueDate"  = EXCLUDED."officeIssueDate",
      "officeExpiryDate" = EXCLUDED."officeExpiryDate",
      "photo"            = EXCLUDED."photo",
      "cardRankId"       = EXCLUDED."cardRankId",
      "cardRank"         = EXCLUDED."cardRank",
      "officeRankId"     = EXCLUDED."officeRankId",
      "officeRank"       = EXCLUDED."officeRank",
      "awardsCount"      = EXCLUDED."awardsCount",
      "lastSeenAt"       = EXCLUDED."lastSeenAt",
      "isActive"         = true,
      "deactivatedAt"    = NULL,
      "updatedAt"        = EXCLUDED."updatedAt"
  `;
}

/** The owning column differs per table, so the INSERT is written out twice
 *  rather than interpolating an identifier into raw SQL. */
async function writeChanges(
  table: "office_changes" | "broker_changes",
  changes: ChangeRow[],
  runId: string,
) {
  if (changes.length === 0) return;

  const now = new Date();
  const CHUNK = 500;

  for (let i = 0; i < changes.length; i += CHUNK) {
    const slice = changes.slice(i, i + CHUNK);
    const values = slice.map(
      (c) => Prisma.sql`(
        ${crypto.randomUUID()}, ${c.id}, ${c.field},
        ${c.oldValue?.slice(0, 500) ?? null}, ${c.newValue?.slice(0, 500) ?? null},
        ${now}, ${runId}
      )`,
    );

    const sql =
      table === "office_changes"
        ? Prisma.sql`
            INSERT INTO office_changes ("id", "realEstateNumber", "field", "oldValue", "newValue", "detectedAt", "syncRunId")
            VALUES ${Prisma.join(values)}`
        : Prisma.sql`
            INSERT INTO broker_changes ("id", "cardNumber", "field", "oldValue", "newValue", "detectedAt", "syncRunId")
            VALUES ${Prisma.join(values)}`;

    await prisma.$executeRaw(sql);
  }
}

// ------------------------------------------------------------ high-water mark

async function readHighWaterMark(): Promise<number> {
  const row = await prisma.syncState.findUnique({
    where: { key: HIGH_WATER_CARD_KEY },
  });
  return row ? Number(row.value) || 0 : 0;
}

async function updateHighWaterMark(brokers: BrokerRow[]) {
  const max = brokers.reduce((acc, b) => {
    const n = Number(b.cardNumber);
    return Number.isFinite(n) && n > acc ? n : acc;
  }, 0);
  if (max <= 0) return;

  const current = await readHighWaterMark();
  if (max <= current) return;

  await prisma.syncState.upsert({
    where: { key: HIGH_WATER_CARD_KEY },
    create: { key: HIGH_WATER_CARD_KEY, value: String(max) },
    update: { value: String(max) },
  });
}
