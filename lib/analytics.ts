import { prisma } from "@/lib/db";

export type Granularity = "day" | "week" | "month";

/** `daily_stats.date` is a bare DATE; compare against plain YYYY-MM-DD strings
 *  so the driver's local timezone can never shift the bound by a day. */
function toIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// A type alias rather than an interface: only aliases get an implicit index
// signature, which is what lets these rows satisfy the chart's generic Row.
export type TimeseriesPoint = {
  bucket: string;
  officesIssued: number;
  officesDiscovered: number;
  officesExpiring: number;
  officesIssuedNoBrokers: number;
  brokerCardsIssued: number;
  brokersNew: number;
  brokersDiscovered: number;
  brokerCardsExpiring: number;
};

/**
 * Reads the pre-aggregated daily_stats table and rolls it up. Restricted to
 * dates at or before today by default, because the table also spans forward to
 * the furthest licence expiry - useful for the renewal pipeline, noise on a
 * "what opened recently" chart.
 */
export async function getTimeseries(opts: {
  from: Date;
  to: Date;
  granularity?: Granularity;
}): Promise<TimeseriesPoint[]> {
  const granularity = opts.granularity ?? "day";
  const truncUnit = granularity === "day" ? "day" : granularity;

  const rows = await prisma.$queryRawUnsafe<
    Array<Record<string, string | number | Date>>
  >(
    `
    SELECT
      to_char(date_trunc($3, "date"), 'YYYY-MM-DD')     AS bucket,
      SUM("officesIssued")::int                          AS "officesIssued",
      SUM("officesDiscovered")::int                      AS "officesDiscovered",
      SUM("officesExpiring")::int                        AS "officesExpiring",
      SUM("officesIssuedNoBrokers")::int                 AS "officesIssuedNoBrokers",
      SUM("brokerCardsIssued")::int                      AS "brokerCardsIssued",
      SUM("brokersNew")::int                             AS "brokersNew",
      SUM("brokersDiscovered")::int                      AS "brokersDiscovered",
      SUM("brokerCardsExpiring")::int                    AS "brokerCardsExpiring"
    FROM daily_stats
    WHERE "date" >= $1::date AND "date" <= $2::date
    GROUP BY 1
    ORDER BY 1
    `,
    toIsoDay(opts.from),
    toIsoDay(opts.to),
    truncUnit,
  );

  return rows as unknown as TimeseriesPoint[];
}

export interface Overview {
  totalOffices: number;
  activeOffices: number;
  totalBrokers: number;
  activeBrokers: number;

  officesIssued7d: number;
  officesIssued30d: number;
  officesIssued90d: number;
  officesIssuedPrev30d: number;

  /// First-time broker cards. Zero until the second sync — see Broker.isNewCard.
  brokersNew7d: number;
  brokersNew30d: number;
  brokersNewPrev30d: number;
  /// Total cards stamped, renewals included. Always populated.
  brokerCardsIssued30d: number;

  officesDiscovered7d: number;
  brokersDiscovered7d: number;

  /// Completed syncs. Below 2, the new-vs-renewal split has no history to work
  /// from and the UI says so instead of showing a misleading zero.
  syncCount: number;

  hotLeads: number;
  emptyNewOffices: number;
  officesExpiring30d: number;
  brokerCardsExpiring30d: number;

  contactableOffices: number;
  officesWithoutWebsite: number;

  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
}

export async function getOverview(): Promise<Overview> {
  const now = new Date();
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const daysAhead = (n: number) => new Date(now.getTime() + n * 86_400_000);

  const [counts, lastSync] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, number>>>(
      `
      SELECT
        (SELECT COUNT(*) FROM offices)::int                                        AS "totalOffices",
        (SELECT COUNT(*) FROM offices WHERE "isActive")::int                       AS "activeOffices",
        (SELECT COUNT(*) FROM brokers)::int                                        AS "totalBrokers",
        (SELECT COUNT(*) FROM brokers WHERE "isActive")::int                       AS "activeBrokers",

        (SELECT COUNT(*) FROM offices WHERE "isActive" AND "issueDate" >= $1)::int AS "officesIssued7d",
        (SELECT COUNT(*) FROM offices WHERE "isActive" AND "issueDate" >= $2)::int AS "officesIssued30d",
        (SELECT COUNT(*) FROM offices WHERE "isActive" AND "issueDate" >= $3)::int AS "officesIssued90d",
        (SELECT COUNT(*) FROM offices WHERE "isActive" AND "issueDate" >= $4 AND "issueDate" < $2)::int
                                                                                   AS "officesIssuedPrev30d",

        (SELECT COUNT(*) FROM brokers WHERE "isActive" AND "isNewCard" AND "firstSeenAt" >= $1)::int
                                                                                   AS "brokersNew7d",
        (SELECT COUNT(*) FROM brokers WHERE "isActive" AND "isNewCard" AND "firstSeenAt" >= $2)::int
                                                                                   AS "brokersNew30d",
        (SELECT COUNT(*) FROM brokers WHERE "isActive" AND "isNewCard" AND "firstSeenAt" >= $4 AND "firstSeenAt" < $2)::int
                                                                                   AS "brokersNewPrev30d",
        (SELECT COUNT(*) FROM brokers WHERE "isActive" AND "cardIssueDate" >= $2)::int
                                                                                   AS "brokerCardsIssued30d",
        (SELECT COUNT(*) FROM sync_runs WHERE "status" = 'SUCCESS')::int            AS "syncCount",

        (SELECT COUNT(*) FROM offices WHERE "firstSeenAt" >= $1)::int              AS "officesDiscovered7d",
        (SELECT COUNT(*) FROM brokers WHERE "firstSeenAt" >= $1)::int              AS "brokersDiscovered7d",

        (SELECT COUNT(*) FROM offices WHERE "isActive" AND "leadTier" IN ('A+','A'))::int
                                                                                   AS "hotLeads",
        (SELECT COUNT(*) FROM offices WHERE "isActive" AND "activeBrokerCount" = 0 AND "issueDate" >= $3)::int
                                                                                   AS "emptyNewOffices",
        (SELECT COUNT(*) FROM offices WHERE "isActive" AND "expiryDate" BETWEEN $5 AND $6)::int
                                                                                   AS "officesExpiring30d",
        (SELECT COUNT(*) FROM brokers WHERE "isActive" AND "cardExpiryDate" BETWEEN $5 AND $6)::int
                                                                                   AS "brokerCardsExpiring30d",

        (SELECT COUNT(*) FROM offices WHERE "isActive" AND ("contactEmail" IS NOT NULL OR "contactMobile" IS NOT NULL))::int
                                                                                   AS "contactableOffices",
        (SELECT COUNT(*) FROM offices WHERE "isActive" AND "website" IS NULL)::int AS "officesWithoutWebsite"
      `,
      daysAgo(7),
      daysAgo(30),
      daysAgo(90),
      daysAgo(60),
      now,
      daysAhead(30),
    ),
    prisma.syncRun.findFirst({
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, finishedAt: true, status: true },
    }),
  ]);

  return {
    ...(counts[0] as unknown as Omit<Overview, "lastSyncAt" | "lastSyncStatus">),
    lastSyncAt: lastSync?.finishedAt ?? lastSync?.startedAt ?? null,
    lastSyncStatus: lastSync?.status ?? null,
  };
}

/** How the active brokerages break down by size band. */
export async function getSizeDistribution() {
  return prisma.$queryRawUnsafe<Array<{ band: string; n: number; sortKey: number }>>(`
    SELECT band, COUNT(*)::int AS n, MIN(sort_key)::int AS "sortKey"
    FROM (
      SELECT
        CASE
          WHEN "activeBrokerCount" = 0 THEN '0 (shell)'
          WHEN "activeBrokerCount" BETWEEN 1 AND 3 THEN '1-3'
          WHEN "activeBrokerCount" BETWEEN 4 AND 10 THEN '4-10'
          WHEN "activeBrokerCount" BETWEEN 11 AND 25 THEN '11-25'
          WHEN "activeBrokerCount" BETWEEN 26 AND 60 THEN '26-60'
          WHEN "activeBrokerCount" BETWEEN 61 AND 150 THEN '61-150'
          ELSE '150+'
        END AS band,
        CASE
          WHEN "activeBrokerCount" = 0 THEN 0
          WHEN "activeBrokerCount" BETWEEN 1 AND 3 THEN 1
          WHEN "activeBrokerCount" BETWEEN 4 AND 10 THEN 2
          WHEN "activeBrokerCount" BETWEEN 11 AND 25 THEN 3
          WHEN "activeBrokerCount" BETWEEN 26 AND 60 THEN 4
          WHEN "activeBrokerCount" BETWEEN 61 AND 150 THEN 5
          ELSE 6
        END AS sort_key
      FROM offices WHERE "isActive"
    ) t
    GROUP BY band
    ORDER BY "sortKey"
  `);
}

export async function getTierDistribution() {
  return prisma.$queryRawUnsafe<Array<{ tier: string; n: number }>>(`
    SELECT "leadTier" AS tier, COUNT(*)::int AS n
    FROM offices WHERE "isActive"
    GROUP BY 1
    ORDER BY CASE "leadTier" WHEN 'A+' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 ELSE 4 END
  `);
}

/** Licensed activities across active brokerages - tells us what to pitch. */
export async function getActivityBreakdown() {
  return prisma.$queryRawUnsafe<Array<{ name: string; n: number }>>(`
    SELECT TRIM(a->>'nameEn') AS name, COUNT(*)::int AS n
    FROM offices o, LATERAL jsonb_array_elements(COALESCE(o."activities", '[]'::jsonb)) a
    WHERE o."isActive" AND a->>'nameEn' IS NOT NULL
    GROUP BY 1
    ORDER BY n DESC
    LIMIT 20
  `);
}

/**
 * Brokers who moved between brokerages. A broker leaving means the losing firm
 * has a seat to fill and the winning firm is expanding - both are openings.
 */
export async function getRecentMoves(limit = 50) {
  return prisma.$queryRawUnsafe<
    Array<{
      cardNumber: string;
      brokerName: string | null;
      fromOffice: string | null;
      toOffice: string | null;
      fromNumber: string | null;
      toNumber: string | null;
      detectedAt: Date;
    }>
  >(
    `
    SELECT
      c."cardNumber",
      b."nameEn"          AS "brokerName",
      fo."nameEn"         AS "fromOffice",
      too."nameEn"        AS "toOffice",
      c."oldValue"        AS "fromNumber",
      c."newValue"        AS "toNumber",
      c."detectedAt"
    FROM broker_changes c
    JOIN brokers b        ON b."cardNumber" = c."cardNumber"
    LEFT JOIN offices fo  ON fo."realEstateNumber" = c."oldValue"
    LEFT JOIN offices too ON too."realEstateNumber" = c."newValue"
    WHERE c."field" = 'realEstateNumber'
    ORDER BY c."detectedAt" DESC
    LIMIT $1
    `,
    limit,
  );
}

/** Recent registry edits, newest first, for the activity feed. */
export async function getRecentChanges(limit = 100) {
  return prisma.$queryRawUnsafe<
    Array<{
      kind: string;
      entityId: string;
      entityName: string | null;
      field: string;
      oldValue: string | null;
      newValue: string | null;
      detectedAt: Date;
    }>
  >(
    `
    (
      SELECT 'office' AS kind, c."realEstateNumber" AS "entityId", o."nameEn" AS "entityName",
             c."field", c."oldValue", c."newValue", c."detectedAt"
      FROM office_changes c JOIN offices o ON o."realEstateNumber" = c."realEstateNumber"
    )
    UNION ALL
    (
      SELECT 'broker' AS kind, c."cardNumber" AS "entityId", b."nameEn" AS "entityName",
             c."field", c."oldValue", c."newValue", c."detectedAt"
      FROM broker_changes c JOIN brokers b ON b."cardNumber" = c."cardNumber"
    )
    ORDER BY "detectedAt" DESC
    LIMIT $1
    `,
    limit,
  );
}
