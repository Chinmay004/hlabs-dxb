/**
 * Run the batch and target engines without touching Notion.
 *
 *   npm run crm:engines
 *
 * Useful for testing scheduling logic, and as the local-only mode when the
 * Notion integration is not configured yet.
 */
import { prisma } from "../lib/db";
import { recomputeBrokerLeadScores } from "../lib/dld/derive";
import { runBatchEngine } from "../lib/crm/batches";
import { runTargetEngine } from "../lib/crm/targets";

async function main() {
  console.log("Scoring brokers ...");
  await recomputeBrokerLeadScores();

  console.log("Running batch engine ...");
  const batch = await runBatchEngine();
  console.log("  ", batch);

  console.log("Running target engine ...");
  const target = await runTargetEngine();
  console.log("  ", target);

  const batches = await prisma.batch.findMany({
    orderBy: { assignedDate: "asc" },
    select: {
      code: true,
      kind: true,
      status: true,
      size: true,
      worked: true,
      priorityBand: true,
      avgLeadScore: true,
      assignedDate: true,
      dueDate: true,
      delayStatus: true,
      daysOverdue: true,
      cascadeDelayDays: true,
    },
  });

  console.log("\nBatches:");
  console.table(
    batches.map((b) => ({
      code: b.code,
      kind: b.kind,
      status: b.status,
      "size/worked": `${b.worked}/${b.size}`,
      band: b.priorityBand,
      avgScore: b.avgLeadScore,
      assigned: b.assignedDate.toISOString().slice(0, 10),
      due: b.dueDate.toISOString().slice(0, 10),
      delay: b.delayStatus,
      overdue: b.daysOverdue,
      cascade: b.cascadeDelayDays,
    })),
  );

  const targets = await prisma.target.findMany({
    where: { kind: { in: ["WEEKLY", "MONTHLY"] } },
    orderBy: { startDate: "asc" },
    take: 8,
    select: {
      periodKey: true,
      kind: true,
      targetTouches: true,
      actualTouches: true,
      actualBatches: true,
      status: true,
    },
  });
  console.log("\nTargets (weekly/monthly sample):");
  console.table(targets);
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
