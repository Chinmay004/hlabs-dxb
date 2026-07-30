import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../lib/db";

/**
 * Exports one calendar year of DLD-registered projects as the intake payload
 * for crmbackend's `db:seed:dld` (src/scripts/seed-dld-projects.ts).
 *
 * "Registered in year N" means the DLD **adoption date** falls in N. That is
 * the registration timestamp, and it is the only one of the four date
 * selectors that means "this project became a thing this year" — the gateway
 * also returns projects whose start/end/completion date lands in the window,
 * which is why `sourceYear` is 815 rows while 2026 registrations are 202.
 *
 * Deliberately flat and DLD-native. Resolution of legal developer names to CRM
 * brands, cadastral areas to marketing communities, and DLD status strings to
 * the ProjectStatus enum all happen in the seeder, where the CRM catalogue is
 * available to match against.
 *
 *   npm run projects:export -- --year=2026
 */

const CANCELLED_STATUSES = new Set(["CANCELLED"]);

function day(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function num(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function main() {
  const yearArg = process.argv.find((arg) => arg.startsWith("--year="));
  const year = yearArg ? Number(yearArg.slice("--year=".length)) : new Date().getUTCFullYear();
  if (!Number.isInteger(year)) throw new Error(`Bad --year: ${yearArg}`);

  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const outPath = resolve(
    outArg ? outArg.slice("--out=".length) : `tmp/dld-crm-payload-${year}.json`,
  );

  const rows = await prisma.project.findMany({
    where: { adoptionDate: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } },
    orderBy: [{ adoptionDate: "desc" }, { projectNumber: "asc" }],
  });

  // Cancelled registrations are excluded rather than imported and hidden: they
  // are not products, and a cancelled row would still occupy the unique
  // dld_project_number slot if the number is ever reissued.
  const usable = rows.filter((row) => !CANCELLED_STATUSES.has(row.status ?? ""));

  const projects = usable.map((row) => ({
    dld_project_number: row.projectNumber,
    name_en: row.nameEn,
    name_ar: row.nameAr,
    developer: {
      dld_number: row.developerNumber,
      legal_name: row.developerNameEn,
    },
    area_en: row.areaEn,
    zone_en: row.zoneEn,
    master_project_en: row.masterProjectEn,
    dld_status: row.status,
    registered_on: day(row.adoptionDate),
    construction_start: day(row.startDate),
    expected_completion: day(row.endDate),
    actual_completion: day(row.completionDate),
    percent_completed: num(row.percentCompleted),
    project_value_aed: num(row.projectValueAed),
    escrow_account: row.escrowAccountNumber,
    units: {
      residential_units: row.totalUnits,
      villas: row.totalVillas,
      buildings: row.totalBuildings,
      lands: row.totalLands,
      total_inventory: row.totalInventory,
    },
    // Construction spec ("3B+G+M+6+Roof (2 Towers)"), not marketing copy. Kept
    // in the payload as raw material for the manual/AI description pass; the
    // seeder deliberately does NOT write it to Project.description.
    dld_description: row.descriptionEn,
  }));

  const payload = {
    generated_at: new Date().toISOString(),
    source: "Dubai Land Department open-data projects gateway",
    criteria: `DLD adoption (registration) date in calendar year ${year}`,
    year,
    counts: {
      registered: rows.length,
      exported: projects.length,
      excluded_cancelled: rows.length - projects.length,
    },
    projects,
  };

  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");

  console.log(`year          ${year}`);
  console.log(`registered    ${rows.length}`);
  console.log(`exported      ${projects.length}`);
  console.log(`excluded      ${rows.length - projects.length} cancelled`);
  console.log(`written to    ${outPath}`);
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("\nExport failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
