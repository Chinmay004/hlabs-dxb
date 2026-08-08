import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { isNotionConfigured } from "@/lib/notion/client";
import { runNotionSync, type NotionSyncKind } from "@/lib/notion/sync";

export const dynamic = "force-dynamic";
// A full cycle over ~400 leads takes a few minutes at Notion's rate limit.
// 300s is the ceiling on Vercel's hobby plan; lower NOTION_PUSH_LIMIT if a run
// no longer fits, since the push is idempotent and resumes on the next call.
export const maxDuration = 300;

export async function GET() {
  const runs = await prisma.notionSyncRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 30,
  });
  return Response.json({ configured: isNotionConfigured(), runs });
}

/**
 * Trigger a CRM sync. This is the deployment path — a platform cron (Vercel
 * Cron, GitHub Actions, or any scheduler that can make an HTTP call) hits this
 * instead of running the CLI. Same code, same guarantees.
 *
 * Auth: `SYNC_SECRET` via the `x-sync-secret` header or a `secret` query param.
 * Vercel Cron also sends `Authorization: Bearer $CRON_SECRET`, which is accepted
 * when `CRON_SECRET` is set.
 */
export async function POST(request: NextRequest) {
  if (!isNotionConfigured()) {
    return Response.json(
      { error: "NOTION_TOKEN is not set. See docs/NOTION_INTEGRATION.md." },
      { status: 503 },
    );
  }

  const secret = process.env.SYNC_SECRET;
  const cronSecret = process.env.CRON_SECRET;

  if (secret || cronSecret) {
    const provided =
      request.headers.get("x-sync-secret") ??
      request.nextUrl.searchParams.get("secret");
    const bearer = request.headers.get("authorization");

    const ok =
      (secret && provided === secret) ||
      (cronSecret && bearer === `Bearer ${cronSecret}`);

    if (!ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Two concurrent runs would fight over batch state and could double-create
  // pages, so refuse rather than queue.
  const running = await prisma.notionSyncRun.findFirst({
    where: {
      status: "RUNNING",
      startedAt: { gt: new Date(Date.now() - 30 * 60_000) },
    },
  });
  if (running) {
    return Response.json(
      { error: "a CRM sync is already running", runId: running.id },
      { status: 409 },
    );
  }

  const kindParam = request.nextUrl.searchParams.get("kind");
  const kind: NotionSyncKind =
    kindParam === "PULL" || kindParam === "PUSH" ? kindParam : "FULL";

  try {
    const result = await runNotionSync({ kind, trigger: "API" });
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
