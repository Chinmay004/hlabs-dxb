import type { NextRequest } from "next/server";

import { logOutreach, updateOutreach } from "@/lib/crm/leads";
import { OUTREACH_CHANNELS, OUTREACH_OUTCOMES } from "@/lib/crm/research";

export const dynamic = "force-dynamic";

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ error: message }, { status: 400 });
}

const isChannel = (v: unknown) =>
  typeof v === "string" && (OUTREACH_CHANNELS as readonly string[]).includes(v);
const isOutcome = (v: unknown) =>
  typeof v === "string" && (OUTREACH_OUTCOMES as readonly string[]).includes(v);

/** Log a new attempt. One row per attempt — never overwrite an older one. */
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/crm/leads/[id]/outreach">,
) {
  const { id } = await ctx.params;
  const body = (await request.json()) as Record<string, string | undefined>;

  if (!isChannel(body.channel)) {
    return Response.json({ error: "invalid channel" }, { status: 400 });
  }
  if (body.outcome != null && !isOutcome(body.outcome)) {
    return Response.json({ error: "invalid outcome" }, { status: 400 });
  }

  try {
    const row = await logOutreach(
      id,
      {
        channel: body.channel as string,
        contactId: body.contactId,
        outcome: body.outcome,
        sentAt: body.sentAt,
        followUpAt: body.followUpAt,
        message: body.message,
        notes: body.notes,
      },
      body.actor?.trim() || null,
    );
    return Response.json({ ok: true, id: row.id });
  } catch (err) {
    return fail(err);
  }
}

/** Update how an existing attempt turned out. */
export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/crm/leads/[id]/outreach">,
) {
  const { id } = await ctx.params;
  const body = (await request.json()) as Record<string, string | undefined>;

  if (!body.outreachId) {
    return Response.json({ error: "outreachId is required" }, { status: 400 });
  }
  if (body.outcome != null && !isOutcome(body.outcome)) {
    return Response.json({ error: "invalid outcome" }, { status: 400 });
  }

  try {
    await updateOutreach(
      id,
      body.outreachId,
      { outcome: body.outcome, followUpAt: body.followUpAt, notes: body.notes },
      body.actor?.trim() || null,
    );
    return Response.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
