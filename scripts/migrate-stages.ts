/**
 * One-time migration from the original CRM status vocabulary to the Notion
 * pipeline stages.
 *
 *   npm run db:migrate-stages
 *
 * The CRM unified on Notion's stage names so there is exactly one pipeline
 * vocabulary end to end. Rows created before that change still carry the old
 * uppercase values, and `prisma db push` does not rewrite existing data when a
 * column default changes — hence this script.
 *
 * Idempotent: anything already on a Notion stage name is left alone, so it is
 * safe to run again.
 */
import { prisma } from "../lib/db";
import { STAGES } from "../lib/crm/config";

const LEGACY_TO_STAGE: Record<string, string> = {
  NEW: "🆕 New Lead",
  QUEUED: "🎯 Queued",
  CONTACTED: "📞 Contacted",
  REPLIED: "💬 Replied",
  MEETING: "🤝 Meeting Booked",
  WON: "✅ Won",
  LOST: "❌ Lost",
  IGNORE: "😴 Nurture",
};

async function main() {
  const valid = new Set<string>(STAGES);
  let migrated = 0;

  for (const [legacy, stage] of Object.entries(LEGACY_TO_STAGE)) {
    const [offices, brokers] = await Promise.all([
      prisma.office.updateMany({ where: { status: legacy }, data: { status: stage } }),
      prisma.broker.updateMany({ where: { status: legacy }, data: { status: stage } }),
    ]);
    const n = offices.count + brokers.count;
    if (n > 0) {
      console.log(`  ${legacy} -> ${stage}: ${n} rows`);
      migrated += n;
    }
  }

  // Anything that is neither legacy nor a known stage would silently drop out of
  // every batch query, so surface it rather than leaving it stranded.
  const strays = await prisma.office.groupBy({
    by: ["status"],
    _count: { status: true },
  });
  const unknown = strays.filter((s) => !valid.has(s.status));
  if (unknown.length > 0) {
    console.warn(
      "\nWARNING — statuses that match no known stage (these leads will never be batched):",
    );
    for (const u of unknown) console.warn(`  ${u.status}: ${u._count.status}`);
  }

  console.log(`\nMigrated ${migrated} rows.`);
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
