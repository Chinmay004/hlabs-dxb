import type { NextRequest } from "next/server";

import { addNote, setResearch } from "@/lib/crm/leads";
import { RESEARCH_STATUSES } from "@/lib/crm/research";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Known bad input is a 400 with the reason; anything else is a real 500. */
function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ error: message }, { status: 400 });
}

/**
 * Everything the work panel needs for one lead. Fetched on expand rather than
 * joined into the queue query — the queue can be 10k rows and none of this is
 * visible until someone opens a row.
 */
export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/crm/leads/[id]">,
) {
  const { id } = await ctx.params;

  const office = await prisma.office.findUnique({
    where: { realEstateNumber: id },
    select: {
      realEstateNumber: true,
      nameEn: true,
      website: true,
      linkedinUrl: true,
      instagramUrl: true,
      contactEmail: true,
      contactMobile: true,
      phone: true,
      researchStatus: true,
      researchNotes: true,
      assignedTo: true,
      contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      outreach: {
        orderBy: { sentAt: "desc" },
        take: 50,
        include: { contact: { select: { name: true } } },
      },
      leadActivities: { orderBy: { createdAt: "desc" }, take: 40 },
    },
  });

  if (!office) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(office);
}

/** Research status, notes and assignment. */
export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/crm/leads/[id]">,
) {
  const { id } = await ctx.params;
  const body = (await request.json()) as {
    researchStatus?: string;
    researchNotes?: string;
    assignedTo?: string | null;
    actor?: string;
  };

  if (
    body.researchStatus != null &&
    !(RESEARCH_STATUSES as readonly string[]).includes(body.researchStatus)
  ) {
    return Response.json({ error: "invalid research status" }, { status: 400 });
  }

  try {
    await setResearch(
      id,
      {
        researchStatus: body.researchStatus,
        researchNotes: body.researchNotes,
        assignedTo: body.assignedTo,
      },
      body.actor?.trim() || null,
    );
    return Response.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

/** Append a free-text note to the activity timeline. */
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/crm/leads/[id]">,
) {
  const { id } = await ctx.params;
  const body = (await request.json()) as { note?: string; actor?: string };

  try {
    await addNote(id, body.note ?? "", body.actor?.trim() || null);
    return Response.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
