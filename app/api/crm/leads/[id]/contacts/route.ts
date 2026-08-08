import type { NextRequest } from "next/server";

import { addContact, removeContact } from "@/lib/crm/leads";
import { CONTACT_CONFIDENCE } from "@/lib/crm/research";

export const dynamic = "force-dynamic";

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ error: message }, { status: 400 });
}

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/crm/leads/[id]/contacts">,
) {
  const { id } = await ctx.params;
  const body = (await request.json()) as Record<string, string | boolean | undefined>;

  const confidence = typeof body.confidence === "string" ? body.confidence : undefined;
  if (confidence && !(CONTACT_CONFIDENCE as readonly string[]).includes(confidence)) {
    return Response.json({ error: "invalid confidence" }, { status: 400 });
  }

  try {
    const contact = await addContact(
      id,
      {
        name: body.name as string | undefined,
        title: body.title as string | undefined,
        linkedinUrl: body.linkedinUrl as string | undefined,
        email: body.email as string | undefined,
        phone: body.phone as string | undefined,
        whatsapp: body.whatsapp as string | undefined,
        source: body.source as string | undefined,
        confidence,
        isPrimary: body.isPrimary === true,
      },
      typeof body.actor === "string" ? body.actor.trim() || null : null,
    );
    return Response.json({ ok: true, id: contact.id });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/crm/leads/[id]/contacts">,
) {
  const { id } = await ctx.params;
  const contactId = request.nextUrl.searchParams.get("contactId");
  if (!contactId) {
    return Response.json({ error: "contactId is required" }, { status: 400 });
  }

  try {
    await removeContact(id, contactId, request.headers.get("x-actor")?.trim() || null);
    return Response.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
