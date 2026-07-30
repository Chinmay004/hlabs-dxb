/**
 * Clear stored Notion page links so the next sync re-creates the pages.
 *
 *   npm run crm:relink -- --brokerages
 *   npm run crm:relink -- --brokers --batches --targets
 *   npm run crm:relink -- --all
 *
 * Use after rebuilding a Notion database, when every page ID we stored has
 * become a dangling reference.
 *
 * Always clears `notionPageId` and `notionHash` together. A fresh page id left
 * beside a stale hash makes the sync believe the row is already up to date, so
 * it never writes it and the page stays empty forever.
 */
import { prisma } from "../lib/db";

async function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes("--all");
  const want = (flag: string) => all || argv.includes(flag);

  if (argv.length === 0) {
    console.error(
      "Nothing selected. Pass one or more of: --brokerages --brokers --batches --targets --all",
    );
    process.exit(1);
  }

  const cleared: Record<string, number> = {};

  if (want("--brokerages")) {
    const r = await prisma.office.updateMany({
      where: { notionPageId: { not: null } },
      data: { notionPageId: null, notionHash: null, notionSyncedAt: null },
    });
    cleared.brokerages = r.count;
  }

  if (want("--brokers")) {
    const r = await prisma.broker.updateMany({
      where: { notionPageId: { not: null } },
      data: { notionPageId: null, notionHash: null, notionSyncedAt: null },
    });
    cleared.brokers = r.count;
  }

  if (want("--batches")) {
    const r = await prisma.batch.updateMany({
      where: { notionPageId: { not: null } },
      data: { notionPageId: null, notionHash: null, notionSyncedAt: null },
    });
    cleared.batches = r.count;
  }

  if (want("--targets")) {
    const r = await prisma.target.updateMany({
      where: { notionPageId: { not: null } },
      data: { notionPageId: null, notionHash: null, notionSyncedAt: null },
    });
    cleared.targets = r.count;
  }

  console.log("Cleared Notion links:", cleared);
  console.log("Run `npm run crm` to re-create the pages.");
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
