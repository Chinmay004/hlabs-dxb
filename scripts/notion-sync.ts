/**
 * CLI entry point for the Notion CRM sync.
 *
 *   npm run crm                  full pull -> engines -> push
 *   npm run crm -- --scheduled   same, tagged as a scheduled run
 *   npm run crm -- --pull        pull only (read Notion, run engines, no writes)
 *   npm run crm -- --push        push only (skip reading Notion first)
 *
 * `--push` is unsafe as a routine: skipping the pull means any change the team
 * made since the last run is invisible to the engines. Use it only to repair a
 * Notion database you have just rebuilt.
 */
import { runNotionSync } from "../lib/notion/sync";
import { isNotionConfigured } from "../lib/notion/client";
import { prisma } from "../lib/db";

async function main() {
  if (!isNotionConfigured()) {
    console.error(
      "\nNOTION_TOKEN is not set — nothing to sync.\n\n" +
        "  1. Create an internal integration: https://www.notion.so/my-integrations\n" +
        "  2. Open the 'Homeey DXB CRM' page in Notion -> ... -> Connections -> add it\n" +
        "  3. Put the secret in .env as NOTION_TOKEN=ntn_...\n\n" +
        "Full instructions: docs/NOTION_INTEGRATION.md\n",
    );
    process.exit(1);
  }

  const argv = process.argv;
  const kind = argv.includes("--pull")
    ? "PULL"
    : argv.includes("--push")
      ? "PUSH"
      : "FULL";

  const result = await runNotionSync({
    kind,
    trigger: argv.includes("--scheduled") ? "SCHEDULED" : "MANUAL",
    onProgress: (m) => console.log(m),
  });

  console.log("\n─────────────────────────────────────────");
  console.log(`run          ${result.runId}`);
  console.log(`duration     ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`requests     ${result.requestCount} (${result.errorCount} errors)`);
  console.log(`batches      ${result.batchesCreated} created`);
  console.log(
    `pulled       ${result.pulledOffices} brokerages · ${result.pulledBrokers} brokers · ${result.pulledBatches} batches`,
  );
  console.log(
    `pushed       ${result.pushedOffices} brokerages · ${result.pushedBrokers} brokers · ${result.pushedBatches} batches · ${result.pushedTargets} targets`,
  );
  console.log(`skipped      ${result.skipped} unchanged`);
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("\nNotion sync failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
