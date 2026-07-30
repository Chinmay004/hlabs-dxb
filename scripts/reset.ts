/**
 * Clear every table the sync owns, so the next `npm run sync` rebuilds the
 * mirror from scratch.
 *
 *   npm run db:reset -- --yes
 *
 * Use when the derivation logic changes in a way that old rows can't be
 * upserted into, or to reset `firstSeenAt` so "newly discovered" means
 * something again. Requires --yes; there is no interactive prompt because this
 * also runs from scheduled contexts.
 *
 * Note this also wipes the CRM overlay (status / ownerNote / contactedAt),
 * since those live on the same rows.
 */
import { prisma } from "../lib/db";

async function main() {
  if (!process.argv.includes("--yes")) {
    console.error(
      "Refusing to wipe the registry mirror without --yes.\n" +
        "  npm run db:reset -- --yes",
    );
    process.exit(1);
  }

  const before = {
    offices: await prisma.office.count(),
    brokers: await prisma.broker.count(),
    officeChanges: await prisma.officeChange.count(),
    brokerChanges: await prisma.brokerChange.count(),
    dailyStats: await prisma.dailyStat.count(),
    syncRuns: await prisma.syncRun.count(),
  };

  console.log("Clearing:", before);

  // Order matters: children before parents, since the FKs are RESTRICT/CASCADE.
  await prisma.officeChange.deleteMany();
  await prisma.brokerChange.deleteMany();
  await prisma.broker.deleteMany();
  await prisma.office.deleteMany();
  await prisma.dailyStat.deleteMany();
  await prisma.syncRun.deleteMany();
  await prisma.syncState.deleteMany();

  console.log("Done. Run `npm run sync` to rebuild.");
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
