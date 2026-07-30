import { prisma } from "../lib/db";
import { runProjectSync } from "../lib/dld/projects-sync";

async function main() {
  const scheduled = process.argv.includes("--scheduled");
  const yearArg = process.argv.find((arg) => arg.startsWith("--year="));
  const year = yearArg ? Number(yearArg.slice("--year=".length)) : undefined;

  const result = await runProjectSync({
    trigger: scheduled ? "SCHEDULED" : "MANUAL",
    year: Number.isInteger(year) ? year : undefined,
    onProgress: console.log,
  });

  console.log("");
  console.log(`run          ${result.runId}`);
  console.log(`source year  ${result.sourceYear}`);
  console.log(`duration     ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`requests     ${result.requestCount} (${result.errorCount} retries/errors)`);
  console.log(
    `projects     ${result.projectsSeen} seen · ${result.projectsNew} new · ${result.projectsUpdated} changed`,
  );
  console.log(`date queries ${JSON.stringify(result.rowsByDateType)}`);
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("\nProject sync failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
