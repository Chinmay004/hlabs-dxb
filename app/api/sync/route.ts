import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { runSync } from "@/lib/dld/sync";

export const dynamic = "force-dynamic";
// A full crawl takes a couple of minutes; keep the handler alive for it.
// 300s is the ceiling on Vercel's hobby plan. If the reconcile stage pushes a
// run past it, lower RECONCILE_MAX_OFFICES or raise RECONCILE_CONCURRENCY.
export const maxDuration = 300;

export async function GET() {
  const runs = await prisma.syncRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 40,
    select: {
      id: true,
      kind: true,
      status: true,
      trigger: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
      officesSeen: true,
      officesNew: true,
      officesUpdated: true,
      officesDeactivated: true,
      brokersSeen: true,
      brokersNew: true,
      brokersUpdated: true,
      brokersDeactivated: true,
      requestCount: true,
      errorCount: true,
      error: true,
    },
  });

  return Response.json({ runs });
}

/**
 * Kick off a sync. Guarded by SYNC_SECRET when one is configured so the
 * scheduled job (and nothing else) can trigger a crawl of a third-party API.
 */
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

  // Refuse to stack crawls; two concurrent full syncs would fight over the
  // lastSeenAt watermark and could deactivate live rows.
  const running = await prisma.syncRun.findFirst({
    where: { status: "RUNNING", startedAt: { gt: new Date(Date.now() - 30 * 60_000) } },
  });
  if (running) {
    return Response.json(
      { error: "a sync is already running", runId: running.id },
      { status: 409 },
    );
  }

  try {
    const result = await runSync({ kind: "FULL", trigger: "API" });
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
