/**
 * Recompute everything derived from the mirror without re-crawling the gateway.
 *
 *   npm run db:rederive
 *
 * Use after changing rollup, lead-score or daily-stat logic. Takes seconds,
 * where a full sync takes ~15 minutes.
 */
import { prisma } from "../lib/db";
import {
  recomputeDailyStats,
  recomputeLeadScores,
  recomputeRollups,
} from "../lib/dld/derive";

async function main() {
  console.log("Recomputing rollups ...");
  await recomputeRollups();
  console.log("Recomputing lead scores ...");
  await recomputeLeadScores();
  console.log("Rebuilding daily stats ...");
  await recomputeDailyStats();
  console.log("Done.");
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
