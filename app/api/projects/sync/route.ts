import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { runProjectSync } from "@/lib/dld/projects-sync";

export const dynamic = "force-dynamic";
// 300s is the ceiling on Vercel's hobby plan.
export const maxDuration = 300;

export async function GET() {
  const runs = await prisma.projectSyncRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 40,
  });
  return Response.json({ runs });
}

export async function POST(request: NextRequest) {
  const secret = process.env.SYNC_SECRET;
  if (secret) {
    const provided =
      request.headers.get("x-sync-secret") ??
      request.nextUrl.searchParams.get("secret");
    if (provided !== secret) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const yearParam = request.nextUrl.searchParams.get("year");
  const year = yearParam ? Number(yearParam) : undefined;
  try {
    const result = await runProjectSync({
      trigger: "API",
      year: Number.isInteger(year) ? year : undefined,
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("already running") ? 409 : 500;
    return Response.json({ error: message }, { status });
  }
}
