/**
 * Preflight the Notion connection.
 *
 *   npm run crm:check
 *
 * Verifies the token works and that every CRM database is actually shared with
 * the integration. Notion returns `object_not_found` for "not shared" and for
 * "wrong id" alike, so this checks each database by name and says which it is.
 */
import { NOTION_DB, isNotionConfigured, notion } from "../lib/notion/client";
import { prisma } from "../lib/db";

async function main() {
  if (!isNotionConfigured()) {
    console.error("NOTION_TOKEN is not set. See docs/NOTION_INTEGRATION.md.");
    process.exit(1);
  }

  const client = notion();

  try {
    const me = await client.users.me({});
    const name = "name" in me ? me.name : "(unnamed)";
    console.log(`Token OK — authenticated as "${name}" (${me.type}).\n`);
  } catch (err) {
    console.error(
      "Token rejected. Check NOTION_TOKEN is the Internal Integration Secret " +
        "(starts with ntn_) and has not been revoked.\n",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }

  let failures = 0;

  for (const [key, id] of Object.entries(NOTION_DB)) {
    try {
      const db = await client.databases.retrieve({ database_id: id });
      const titleProp = "title" in db ? db.title : [];
      const label =
        Array.isArray(titleProp) && titleProp.length > 0
          ? titleProp.map((t) => ("plain_text" in t ? t.plain_text : "")).join("")
          : "(untitled)";
      const props = "properties" in db ? Object.keys(db.properties).length : 0;
      console.log(`  ✓ ${key.padEnd(12)} ${label} — ${props} properties`);
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ ${key.padEnd(12)} ${id}`);
      console.log(`      ${msg.split("\n")[0]}`);
    }
  }

  if (failures > 0) {
    console.error(
      `\n${failures} database(s) unreachable.\n\n` +
        "Almost always this means the integration has not been given access.\n" +
        "Open the 'Homeey DXB CRM' page in Notion -> ··· menu -> Connections ->\n" +
        "add your integration. Sharing the parent page cascades to all five.\n",
    );
    process.exit(1);
  }

  const [offices, brokers, batches, targets] = await Promise.all([
    prisma.office.count({ where: { batchId: { not: null } } }),
    prisma.broker.count({ where: { batchId: { not: null } } }),
    prisma.batch.count(),
    prisma.target.count(),
  ]);

  console.log(
    `\nAll databases reachable. Ready to push ${batches} batches, ` +
      `${offices} brokerages, ${brokers} brokers, ${targets} targets.`,
  );
  console.log("Run `npm run crm` to sync.");
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
