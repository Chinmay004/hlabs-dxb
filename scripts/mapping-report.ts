/**
 * Measure how well the open-data datasets actually join to each other.
 *
 *   npx tsx scripts/mapping-report.ts
 *
 * DLD zeroes most identifier columns in the data rows (AREA_ID, PROPERTY_ID,
 * USAGE_ID and friends all come back as 0), so every cross-dataset link has to
 * be built on names or on the handful of keys that survive. Which of those
 * links are trustworthy is an empirical question, not a design decision - this
 * script answers it with match rates before anyone builds analysis on top.
 *
 * Read the output as: a join below ~80% needs normalisation before use; a join
 * near 0% means the key is masked or the datasets do not overlap in scope.
 */
import { prisma } from "../lib/db";

function pct(part: number, whole: number): string {
  if (!whole) return "n/a";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function line(label: string, matched: number, total: number, note = "") {
  const bar = "█".repeat(Math.round((total ? matched / total : 0) * 24)).padEnd(24, "·");
  console.log(
    `  ${label.padEnd(46)} ${bar} ${String(matched).padStart(8)} / ${String(total).padEnd(8)} ${pct(matched, total).padStart(7)}  ${note}`,
  );
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║  DLD open-data join coverage                                                         ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════════════╝");

  // ---- inventory -------------------------------------------------------
  const counts = {
    offices: await prisma.office.count(),
    brokers: await prisma.broker.count(),
    odBrokers: await prisma.openDataBroker.count(),
    projects: await prisma.project.count(),
    projectLookup: await prisma.projectLookup.count(),
    developers: await prisma.developer.count(),
    lands: await prisma.land.count(),
    buildings: await prisma.building.count(),
    units: await prisma.unit.count(),
    transactions: await prisma.transaction.count(),
    rents: await prisma.rent.count(),
    valuations: await prisma.valuation.count(),
    areas: await prisma.areaLookup.count(),
  };
  console.log("\n── inventory ──");
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(20)} ${v.toLocaleString().padStart(12)}`);
  }

  // ---- 1. brokerage / broker identity ----------------------------------
  console.log("\n── 1. brokerages and brokers ──");

  const [odToBroker] = await prisma.$queryRaw<Array<{ matched: bigint; total: bigint }>>`
    SELECT COUNT(*) FILTER (WHERE b."cardNumber" IS NOT NULL)::bigint AS matched,
           COUNT(*)::bigint AS total
    FROM od_brokers o LEFT JOIN brokers b ON b."cardNumber" = o."brokerNumber"
  `;
  line("od_brokers.brokerNumber -> brokers.cardNumber", Number(odToBroker.matched), Number(odToBroker.total),
    "the rest are lapsed cards the registry drops");

  const [odToOffice] = await prisma.$queryRaw<Array<{ matched: bigint; total: bigint }>>`
    SELECT COUNT(*) FILTER (WHERE f."realEstateNumber" IS NOT NULL)::bigint AS matched,
           COUNT(*)::bigint AS total
    FROM od_brokers o LEFT JOIN offices f ON f."realEstateNumber" = o."realEstateNumber"
  `;
  line("od_brokers.realEstateNumber -> offices", Number(odToOffice.matched), Number(odToOffice.total));

  const expired = await prisma.openDataBroker.count({ where: { isExpired: true } });
  line("od_brokers with an expired licence", expired, counts.odBrokers, "churn analysis base");

  // ---- 2. developers and projects --------------------------------------
  console.log("\n── 2. developers and projects ──");

  const [projToDev] = await prisma.$queryRaw<Array<{ matched: bigint; total: bigint }>>`
    SELECT COUNT(*) FILTER (WHERE d."developerNumber" IS NOT NULL)::bigint AS matched,
           COUNT(*)::bigint AS total
    FROM projects p LEFT JOIN developers d ON d."developerNumber" = p."developerNumber"
  `;
  line("projects.developerNumber -> developers", Number(projToDev.matched), Number(projToDev.total));

  const [projByName] = await prisma.$queryRaw<Array<{ matched: bigint; total: bigint }>>`
    SELECT COUNT(*) FILTER (WHERE d."nameEn" IS NOT NULL)::bigint AS matched,
           COUNT(*)::bigint AS total
    FROM projects p
    LEFT JOIN developers d ON UPPER(TRIM(d."nameEn")) = UPPER(TRIM(p."developerNameEn"))
  `;
  line("projects.developerNameEn -> developers (name)", Number(projByName.matched), Number(projByName.total));

  const [projInLookup] = await prisma.$queryRaw<Array<{ matched: bigint; total: bigint }>>`
    SELECT COUNT(*) FILTER (WHERE l."projectId" IS NOT NULL)::bigint AS matched,
           COUNT(*)::bigint AS total
    FROM projects p
    LEFT JOIN lookup_projects l ON UPPER(TRIM(l."nameEn")) = UPPER(TRIM(p."nameEn"))
  `;
  line("projects -> projects-lookup (name)", Number(projInLookup.matched), Number(projInLookup.total),
    `lookup holds ${counts.projectLookup}`);

  // ---- 3. the physical chain: land -> building -> deal ------------------
  console.log("\n── 3. land, buildings and the parcel key ──");

  const [landToProj] = await prisma.$queryRaw<Array<{ matched: bigint; total: bigint }>>`
    SELECT COUNT(*) FILTER (WHERE p."projectNumber" IS NOT NULL)::bigint AS matched,
           COUNT(*)::bigint AS total
    FROM lands l LEFT JOIN projects p ON p."projectNumber" = l."projectNumber"
    WHERE l."projectNumber" IS NOT NULL
  `;
  line("lands.projectNumber -> projects", Number(landToProj.matched), Number(landToProj.total),
    "projects table is year-windowed");

  // EXISTS, not a LEFT JOIN: parcelId is not unique in lands (a parcel can
  // carry many land records), so joining counts join output, not source rows.
  const [bldToLand] = await prisma.$queryRaw<Array<{ matched: bigint; total: bigint }>>`
    SELECT COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM lands l WHERE l."parcelId" = b."parcelId"))::bigint AS matched,
           COUNT(*)::bigint AS total
    FROM buildings b WHERE b."parcelId" IS NOT NULL
  `;
  line("buildings.parcelId -> lands.parcelId", Number(bldToLand.matched), Number(bldToLand.total));

  const [txToLand] = await prisma.$queryRaw<Array<{ matched: bigint; total: bigint }>>`
    SELECT COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM lands l WHERE l."parcelId" = t."parcelId"))::bigint AS matched,
           COUNT(*)::bigint AS total
    FROM transactions t WHERE t."parcelId" IS NOT NULL
  `;
  line("transactions.parcelId -> lands.parcelId", Number(txToLand.matched), Number(txToLand.total));

  const txWithParcel = await prisma.transaction.count({ where: { NOT: { parcelId: null } } });
  line("transactions carrying a parcelId at all", txWithParcel, counts.transactions);

  const [rentToLand] = await prisma.$queryRaw<Array<{ matched: bigint; total: bigint }>>`
    SELECT COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM lands l WHERE l."parcelId" = r."parcelId"))::bigint AS matched,
           COUNT(*)::bigint AS total
    FROM rents r WHERE r."parcelId" IS NOT NULL
  `;
  line("rents.parcelId -> lands.parcelId", Number(rentToLand.matched), Number(rentToLand.total));

  const rentWithParcel = await prisma.rent.count({ where: { NOT: { parcelId: null } } });
  line("rents carrying a parcelId at all", rentWithParcel, counts.rents);

  // ---- 4. names as keys -------------------------------------------------
  console.log("\n── 4. names as join keys (areas and projects) ──");

  // The normalised name set is materialised once. A correlated EXISTS with
  // UPPER(TRIM(...)) on both sides re-scans the lookup table per row, which on
  // 647k rents means 647k sequential scans and a report that never finishes.
  const [txArea] = await prisma.$queryRaw<Array<{ matched: bigint; total: bigint }>>`
    WITH known AS MATERIALIZED (
      SELECT DISTINCT UPPER(TRIM("nameEn")) AS n FROM lookup_areas WHERE "nameEn" IS NOT NULL
    )
    SELECT COUNT(*) FILTER (WHERE UPPER(TRIM(t."areaEn")) IN (SELECT n FROM known))::bigint AS matched,
           COUNT(*)::bigint AS total
    FROM transactions t WHERE t."areaEn" IS NOT NULL
  `;
  line("transactions.areaEn -> area lookup", Number(txArea.matched), Number(txArea.total));

  const [rentArea] = await prisma.$queryRaw<Array<{ matched: bigint; total: bigint }>>`
    WITH known AS MATERIALIZED (
      SELECT DISTINCT UPPER(TRIM("nameEn")) AS n FROM lookup_areas WHERE "nameEn" IS NOT NULL
    )
    SELECT COUNT(*) FILTER (WHERE UPPER(TRIM(r."areaEn")) IN (SELECT n FROM known))::bigint AS matched,
           COUNT(*)::bigint AS total
    FROM rents r WHERE r."areaEn" IS NOT NULL
  `;
  line("rents.areaEn -> area lookup", Number(rentArea.matched), Number(rentArea.total));

  const [txRentArea] = await prisma.$queryRaw<Array<{ shared: bigint }>>`
    SELECT COUNT(*)::bigint AS shared FROM (
      SELECT DISTINCT UPPER(TRIM("areaEn")) a FROM transactions WHERE "areaEn" IS NOT NULL
      INTERSECT
      SELECT DISTINCT UPPER(TRIM("areaEn")) a FROM rents WHERE "areaEn" IS NOT NULL
    ) x
  `;
  const txAreas = await prisma.transaction.findMany({ distinct: ["areaEn"], select: { areaEn: true } });
  const rentAreas = await prisma.rent.findMany({ distinct: ["areaEn"], select: { areaEn: true } });
  console.log(
    `  areas: ${txAreas.length} in transactions, ${rentAreas.length} in rents, ${Number(txRentArea.shared)} shared`,
  );

  const [txProj] = await prisma.$queryRaw<Array<{ matched: bigint; total: bigint }>>`
    WITH known AS MATERIALIZED (
      SELECT DISTINCT UPPER(TRIM("nameEn")) AS n FROM lookup_projects WHERE "nameEn" IS NOT NULL
    )
    SELECT COUNT(*) FILTER (WHERE UPPER(TRIM(t."projectEn")) IN (SELECT n FROM known))::bigint AS matched,
           COUNT(*)::bigint AS total
    FROM transactions t WHERE t."projectEn" IS NOT NULL
  `;
  line("transactions.projectEn -> projects-lookup", Number(txProj.matched), Number(txProj.total));

  const txWithProject = await prisma.transaction.count({ where: { NOT: { projectEn: null } } });
  line("transactions naming a project at all", txWithProject, counts.transactions,
    "the rest are secondary-market, no project");

  // ---- 5. what the joins unlock ----------------------------------------
  console.log("\n── 5. worked example: residential flat yield by area ──");
  console.log("  Both sides constrained to residential flats. Without the usage");
  console.log("  filter, industrial areas produce absurd yields (>70%) because a");
  console.log("  warehouse lease gets divided by an apartment sale price.\n");

  const yields = await prisma.$queryRaw<
    Array<{ area: string; deals: bigint; median_price: number; leases: bigint; median_rent: number; gross_yield: number }>
  >`
    WITH sales AS (
      SELECT UPPER(TRIM("areaEn")) AS area,
             COUNT(*)::bigint AS deals,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "transValueAed")::float8 AS median_price
      FROM transactions
      WHERE "isPrimaryUnit" AND "groupId" = 1
        AND "propSubTypeEn" = 'Flat' AND "usageEn" = 'Residential'
        AND "transValueAed" > 100000 AND "areaEn" IS NOT NULL
      GROUP BY 1 HAVING COUNT(*) >= 50
    ),
    leases AS (
      SELECT UPPER(TRIM("areaEn")) AS area,
             COUNT(*)::bigint AS leases,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "annualAmountAed")::float8 AS median_rent
      FROM rents
      WHERE "annualAmountAed" BETWEEN 10000 AND 2000000
        AND "propSubTypeEn" = 'Flat' AND "usageEn" = 'Residential'
        AND "areaEn" IS NOT NULL
      GROUP BY 1 HAVING COUNT(*) >= 50
    )
    SELECT s.area, s.deals, s.median_price, l.leases, l.median_rent,
           (l.median_rent / NULLIF(s.median_price, 0) * 100)::float8 AS gross_yield
    FROM sales s JOIN leases l USING (area)
    WHERE (l.median_rent / NULLIF(s.median_price, 0) * 100) BETWEEN 1 AND 15
    ORDER BY gross_yield DESC NULLS LAST
    LIMIT 15
  `;

  if (yields.length) {
    console.log(
      `  ${"area".padEnd(34)}${"deals".padStart(7)}${"med. price".padStart(13)}${"leases".padStart(8)}${"med. rent".padStart(12)}${"yield".padStart(8)}`,
    );
    for (const y of yields) {
      console.log(
        `  ${y.area.slice(0, 33).padEnd(34)}${String(y.deals).padStart(7)}${Math.round(y.median_price).toLocaleString().padStart(13)}${String(y.leases).padStart(8)}${Math.round(y.median_rent).toLocaleString().padStart(12)}${(y.gross_yield?.toFixed(2) ?? "—").padStart(7)}%`,
      );
    }
  } else {
    console.log("  (needs both transactions and rents loaded)");
  }

  console.log("");
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
