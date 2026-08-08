/**
 * CLI entry point for the DLD open-data transactions sync.
 *
 *   npm run transactions:sync                 current month
 *   npx tsx scripts/sync-transactions.ts 2026-01           one month
 *   npx tsx scripts/sync-transactions.ts 2026-01 2026-07   an inclusive range
 *
 * Months may also be given as --from=YYYY-MM --to=YYYY-MM. Prefer the bare
 * positional form when invoking through npm on PowerShell, which swallows the
 * `--` separator and with it any flags meant for the script.
 *
 * Exits non-zero on failure so Task Scheduler surfaces the error.
 */
import { prisma } from "../lib/db";
import { runTransactionSync } from "../lib/dld/transactions-sync";

function parseMonths(argv: string[]): { fromMonth?: string; toMonth?: string } {
  const flag = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

  const positional = argv.filter((a) => /^\d{4}-\d{2}$/.test(a));

  const fromMonth = flag("from") ?? positional[0];
  const toMonth = flag("to") ?? positional[1] ?? fromMonth;

  return { fromMonth, toMonth };
}

async function main() {
  const scheduled = process.argv.includes("--scheduled");
  const { fromMonth, toMonth } = parseMonths(process.argv.slice(2));

  const result = await runTransactionSync({
    trigger: scheduled ? "SCHEDULED" : "MANUAL",
    fromMonth,
    toMonth,
    onProgress: console.log,
  });

  console.log("");
  console.log("─────────────────────────────────────────");
  console.log(`run          ${result.runId}`);
  console.log(`window       ${result.fromMonth} → ${result.toMonth} (${result.months.length} month(s))`);
  console.log(`duration     ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`requests     ${result.requestCount} (${result.errorCount} retries/errors)`);
  console.log(
    `rows (units) ${result.transactionsSeen} seen · ${result.transactionsNew} added · ${result.transactionsUpdated} replaced`,
  );
  console.log(`deals        ${result.dealsSeen} distinct transactions`);
  console.log(`per month    ${JSON.stringify(result.perMonth)}`);
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("\nTransaction sync failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
