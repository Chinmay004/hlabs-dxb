/**
 * CLI for the DLD open-data catalogue.
 *
 *   npx tsx scripts/sync-open-data.ts lookups
 *   npx tsx scripts/sync-open-data.ts brokers
 *   npx tsx scripts/sync-open-data.ts rents 2026-07
 *   npx tsx scripts/sync-open-data.ts rents 2026-05 2026-07
 *   npx tsx scripts/sync-open-data.ts all 2026-07      every dataset
 *
 * Months only apply to the windowed datasets (rents, valuations); the rest are
 * whole-catalogue pulls and ignore them.
 *
 * Prefer this positional form over npm flags: PowerShell swallows the `--`
 * that npm needs to forward arguments, so `npm run x -- --from=…` silently
 * runs with no arguments at all.
 */
import { prisma } from "../lib/db";
import {
  runLookupSync,
  runOpenDataSync,
  type DatasetName,
} from "../lib/dld/open-data-sync";

const DATASETS: DatasetName[] = [
  "lookups",
  "brokers",
  "developers",
  "buildings",
  "lands",
  "units",
  "rents",
  "valuations",
];

function usage(): never {
  console.error(`Usage: npx tsx scripts/sync-open-data.ts <dataset|all> [fromMonth] [toMonth]

  datasets: ${DATASETS.join(", ")}
  months:   YYYY-MM, windowed datasets only (rents, valuations)`);
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const scheduled = argv.includes("--scheduled");
  const positional = argv.filter((a) => !a.startsWith("--"));

  const target = positional[0];
  if (!target) usage();

  const months = positional.filter((a) => /^\d{4}-\d{2}$/.test(a));
  const fromMonth = months[0];
  const toMonth = months[1] ?? months[0];

  const targets: DatasetName[] =
    target === "all"
      ? DATASETS
      : DATASETS.includes(target as DatasetName)
        ? [target as DatasetName]
        : usage();

  const trigger = scheduled ? ("SCHEDULED" as const) : ("MANUAL" as const);
  const failures: Array<{ dataset: string; error: string }> = [];

  for (const dataset of targets) {
    console.log(`\n═══ ${dataset} ═══`);
    try {
      const result =
        dataset === "lookups"
          ? await runLookupSync({ trigger, onProgress: console.log })
          : await runOpenDataSync(dataset, {
              trigger,
              fromMonth,
              toMonth,
              onProgress: console.log,
            });

      console.log(
        `  ✓ ${result.rowsWritten} written · ${result.rowsNew} new · ${result.rowsRemoved} removed · ` +
          `${(result.durationMs / 1000).toFixed(1)}s · ${result.requestCount} requests (${result.retryCount} retries)`,
      );
      if (Object.keys(result.perScope).length > 1) {
        console.log(`    ${JSON.stringify(result.perScope)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ ${dataset} failed: ${message}`);
      failures.push({ dataset, error: message });
      // Keep going: one dead dataset should not cost the whole catalogue.
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} dataset(s) failed:`);
    for (const f of failures) console.error(`  ${f.dataset}: ${f.error.slice(0, 200)}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(process.exitCode ?? 0))
  .catch(async (error) => {
    console.error("\nOpen-data sync failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
