import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { STAGES, WORKED_STAGES } from "@/lib/crm/config";

export const dynamic = "force-dynamic";

/**
 * Pipeline stages. Deliberately the same strings Notion uses — one vocabulary
 * end to end, so a stage set here and a stage set in Notion are the same value
 * and the two-way sync has nothing to translate.
 */
export { STAGES as CRM_STATUSES } from "@/lib/crm/config";

export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/offices/[id]">,
) {
  const { id } = await ctx.params;

  const office = await prisma.office.findUnique({
    where: { realEstateNumber: id },
    include: {
      brokers: { orderBy: { cardIssueDate: "desc" }, take: 500 },
      changes: { orderBy: { detectedAt: "desc" }, take: 50 },
    },
  });

  if (!office) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(office);
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/offices/[id]">,
) {
  const { id } = await ctx.params;
  const body = (await request.json()) as { status?: string; ownerNote?: string };

  const data: { status?: string; ownerNote?: string | null; contactedAt?: Date } = {};

  if (body.status != null) {
    if (!(STAGES as readonly string[]).includes(body.status)) {
      return Response.json({ error: "invalid status" }, { status: 400 });
    }
    data.status = body.status;
    // Reaching any outreach stage counts as a touch; the batch engine and the
    // target actuals both key off contactedAt.
    if ((WORKED_STAGES as readonly string[]).includes(body.status)) {
      data.contactedAt = new Date();
    }
  }

  if (body.ownerNote !== undefined) {
    data.ownerNote = body.ownerNote?.trim() || null;
  }

  if (Object.keys(data).length === 0) {
    return Response.json({ error: "nothing to update" }, { status: 400 });
  }

  const office = await prisma.office.update({
    where: { realEstateNumber: id },
    data,
    select: { realEstateNumber: true, status: true, ownerNote: true, contactedAt: true },
  });

  return Response.json(office);
}
