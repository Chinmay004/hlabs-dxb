/**
 * CLI entry point for the registry sync.
 *
 *   npm run sync                  full crawl + reconcile of recent brokerages
 *   npm run sync -- --scheduled   same, tagged as a scheduled run
 *   npm run sync:deep             also reconcile rosters for every brokerage
 *
 * Exits non-zero on failure so Task Scheduler / cron surfaces the error.
 */
import { runSync } from "../lib/dld/sync";
import { prisma } from "../lib/db";

async function main() {
  const scheduled = process.argv.includes("--scheduled");
  const deep = process.argv.includes("--deep");

  const result = await runSync({
    kind: "FULL",
    trigger: scheduled ? "SCHEDULED" : "MANUAL",
    deep,
    onProgress: (m) => console.log(m),
  });

  console.log("\n─────────────────────────────────────────");
  console.log(`run          ${result.runId}`);
  console.log(`duration     ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`requests     ${result.requestCount} (${result.errorCount} errors)`);
  console.log(
    `offices      ${result.officesSeen} seen · ${result.officesNew} new · ${result.officesUpdated} changed · ${result.officesDeactivated} gone`,
  );
  console.log(
    `brokers      ${result.brokersSeen} seen · ${result.brokersNew} new · ${result.brokersUpdated} changed · ${result.brokersDeactivated} gone`,
  );

  if (result.newOfficeNumbers.length) {
    const preview = result.newOfficeNumbers.slice(0, 25).join(", ");
    console.log(`\nNew brokerages: ${preview}${result.newOfficeNumbers.length > 25 ? " ..." : ""}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("\nSync failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
