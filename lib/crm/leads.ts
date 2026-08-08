/**
 * Every write the research/outreach workspace makes goes through this module.
 *
 * Two rules hold for all of them:
 *
 *   1. The child write, the rollup recompute and the activity-log append happen
 *      in ONE transaction. A contact that exists but never bumped `contactsFound`
 *      makes the queue lie about coverage, and a state change with no log entry
 *      is unattributable the moment someone else edits the row.
 *
 *   2. Rollups are always recomputed from the children, never incremented. An
 *      increment drifts the first time a request is retried or a row is deleted;
 *      a recount of a handful of rows is cheap and cannot drift.
 *
 * None of these fields go anywhere near Notion — see the note on the Office
 * model in schema.prisma.
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import {
  OUTREACH_OPEN,
  RESEARCH_ENRICHED,
  RESEARCH_IN_PROGRESS,
  RESEARCH_NOT_STARTED,
  RESEARCH_PARTIAL,
  type ActivityType,
} from "./research";

type Tx = Prisma.TransactionClient;

/** Trim to null so empty form fields never become empty strings in the DB. */
export function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function parseDate(v: unknown): Date | null {
  const s = clean(v);
  if (!s) return null;
  // Bare dates from <input type="date"> are anchored to UTC deliberately: the
  // whole CRM stores UTC calendar days, and a local-timezone parse here would
  // land follow-ups on the wrong day for half the year. See CRM_PROTOCOL §7.3.
  const iso = s.length === 10 ? `${s}T00:00:00.000Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function logActivity(
  tx: Tx,
  entry: {
    officeId: string;
    type: ActivityType;
    summary: string;
    meta?: Prisma.InputJsonValue;
    actor: string | null;
  },
) {
  await tx.leadActivity.create({
    data: {
      officeId: entry.officeId,
      type: entry.type,
      summary: entry.summary,
      meta: entry.meta,
      actor: entry.actor,
    },
  });
}

/**
 * Recount the denormalised counters on Office from its children.
 *
 * `nextFollowUpAt` is the earliest pending chase across all still-open attempts.
 * Closed outcomes are excluded, otherwise a "Not Interested" from March would
 * keep a firm on the follow-up list forever.
 */
export async function recomputeLeadRollups(tx: Tx, officeId: string) {
  const [contactsFound, outreachCount, latest, nextFollowUp] = await Promise.all([
    tx.leadContact.count({ where: { officeId } }),
    tx.outreach.count({ where: { officeId } }),
    tx.outreach.findFirst({
      where: { officeId },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true, channel: true, outcome: true },
    }),
    tx.outreach.findFirst({
      where: {
        officeId,
        followUpAt: { not: null },
        outcome: { in: [...OUTREACH_OPEN] },
      },
      orderBy: { followUpAt: "asc" },
      select: { followUpAt: true },
    }),
  ]);

  await tx.office.update({
    where: { realEstateNumber: officeId },
    data: {
      contactsFound,
      outreachCount,
      lastOutreachAt: latest?.sentAt ?? null,
      lastOutreachChannel: latest?.channel ?? null,
      lastOutreachOutcome: latest?.outcome ?? null,
      nextFollowUpAt: nextFollowUp?.followUpAt ?? null,
    },
  });
}

/**
 * Move a lead out of the open research states once a usable contact lands.
 *
 * Only ever advances from "Not Started"/"Researching" — an explicit
 * `Nothing Found` or `Do Not Contact` is a human judgement and is never
 * overridden by a side effect. A contact with a name and a reachable channel
 * counts as Enriched; anything less is Partial.
 */
function autoAdvance(
  current: string,
  hasNamedContact: boolean,
): string | null {
  if (current !== RESEARCH_NOT_STARTED && current !== RESEARCH_IN_PROGRESS) {
    return null;
  }
  const next = hasNamedContact ? RESEARCH_ENRICHED : RESEARCH_PARTIAL;
  return next === current ? null : next;
}

// ------------------------------------------------------------------ research

export async function setResearch(
  officeId: string,
  input: {
    researchStatus?: string;
    researchNotes?: string | null;
    assignedTo?: string | null;
  },
  actor: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.office.findUniqueOrThrow({
      where: { realEstateNumber: officeId },
      select: { researchStatus: true, assignedTo: true, researchedAt: true },
    });

    const data: Prisma.OfficeUpdateInput = {};

    if (input.researchStatus && input.researchStatus !== before.researchStatus) {
      data.researchStatus = input.researchStatus;
      // Stamp who closed it out and when, the first time it leaves "Not Started".
      if (input.researchStatus !== RESEARCH_NOT_STARTED) {
        data.researchedAt = new Date();
        data.researchedBy = actor;
      } else {
        data.researchedAt = null;
        data.researchedBy = null;
      }
    }

    if (input.researchNotes !== undefined) {
      data.researchNotes = clean(input.researchNotes);
    }

    if (input.assignedTo !== undefined) {
      const next = clean(input.assignedTo);
      data.assignedTo = next;
      data.assignedAt = next ? new Date() : null;
    }

    if (Object.keys(data).length === 0) return;

    await tx.office.update({ where: { realEstateNumber: officeId }, data });

    if (data.researchStatus) {
      await logActivity(tx, {
        officeId,
        type: "RESEARCH_STATUS",
        summary: `${before.researchStatus} → ${String(data.researchStatus)}`,
        meta: { from: before.researchStatus, to: String(data.researchStatus) },
        actor,
      });
    }

    if (input.assignedTo !== undefined && clean(input.assignedTo) !== before.assignedTo) {
      const next = clean(input.assignedTo);
      await logActivity(tx, {
        officeId,
        type: "ASSIGNED",
        summary: next ? `Assigned to ${next}` : "Unassigned",
        meta: { from: before.assignedTo, to: next },
        actor,
      });
    }
  });
}

// ------------------------------------------------------------------ contacts

export async function addContact(
  officeId: string,
  input: {
    name?: string;
    title?: string;
    linkedinUrl?: string;
    email?: string;
    phone?: string;
    whatsapp?: string;
    source?: string;
    confidence?: string;
    isPrimary?: boolean;
  },
  actor: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const name = clean(input.name);
    const linkedinUrl = clean(input.linkedinUrl);
    const email = clean(input.email);
    const phone = clean(input.phone);
    const whatsapp = clean(input.whatsapp);

    if (!name && !linkedinUrl && !email && !phone && !whatsapp) {
      throw new Error("A contact needs at least a name or one reachable channel.");
    }

    if (input.isPrimary) {
      await tx.leadContact.updateMany({
        where: { officeId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const existing = await tx.leadContact.count({ where: { officeId } });

    const contact = await tx.leadContact.create({
      data: {
        officeId,
        name,
        title: clean(input.title),
        linkedinUrl,
        email,
        phone,
        whatsapp,
        source: clean(input.source),
        confidence: clean(input.confidence) ?? "Medium",
        // First contact on a firm is the one to lead with unless told otherwise.
        isPrimary: input.isPrimary === true || existing === 0,
        foundBy: actor,
      },
    });

    await logActivity(tx, {
      officeId,
      type: "CONTACT_ADDED",
      summary: `${name ?? "Unnamed contact"}${input.title ? ` — ${clean(input.title)}` : ""}`,
      meta: { contactId: contact.id, linkedinUrl, email, phone },
      actor,
    });

    const office = await tx.office.findUniqueOrThrow({
      where: { realEstateNumber: officeId },
      select: { researchStatus: true },
    });

    const advanced = autoAdvance(
      office.researchStatus,
      Boolean(name) && Boolean(linkedinUrl || email || phone || whatsapp),
    );

    if (advanced) {
      await tx.office.update({
        where: { realEstateNumber: officeId },
        data: { researchStatus: advanced, researchedAt: new Date(), researchedBy: actor },
      });
      await logActivity(tx, {
        officeId,
        type: "RESEARCH_STATUS",
        summary: `${office.researchStatus} → ${advanced} (contact found)`,
        meta: { from: office.researchStatus, to: advanced, automatic: true },
        actor,
      });
    }

    await recomputeLeadRollups(tx, officeId);
    return contact;
  });
}

export async function removeContact(
  officeId: string,
  contactId: string,
  actor: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const contact = await tx.leadContact.findFirst({
      where: { id: contactId, officeId },
      select: { id: true, name: true },
    });
    if (!contact) throw new Error("Contact not found on this brokerage.");

    await tx.leadContact.delete({ where: { id: contactId } });

    await logActivity(tx, {
      officeId,
      type: "CONTACT_REMOVED",
      summary: contact.name ?? "Unnamed contact",
      meta: { contactId },
      actor,
    });

    await recomputeLeadRollups(tx, officeId);
  });
}

// ------------------------------------------------------------------ outreach

export async function logOutreach(
  officeId: string,
  input: {
    channel: string;
    contactId?: string;
    outcome?: string;
    sentAt?: string;
    followUpAt?: string;
    message?: string;
    notes?: string;
  },
  actor: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const channel = clean(input.channel);
    if (!channel) throw new Error("An outreach attempt needs a channel.");

    const contactId = clean(input.contactId);
    if (contactId) {
      const owned = await tx.leadContact.count({ where: { id: contactId, officeId } });
      if (owned === 0) throw new Error("That contact does not belong to this brokerage.");
    }

    const row = await tx.outreach.create({
      data: {
        officeId,
        contactId,
        channel,
        outcome: clean(input.outcome) ?? "Sent",
        sentAt: parseDate(input.sentAt) ?? new Date(),
        followUpAt: parseDate(input.followUpAt),
        message: clean(input.message),
        notes: clean(input.notes),
        actor,
      },
    });

    await logActivity(tx, {
      officeId,
      type: "OUTREACH_LOGGED",
      summary: `${channel} — ${row.outcome}`,
      meta: { outreachId: row.id, channel, outcome: row.outcome },
      actor,
    });

    await recomputeLeadRollups(tx, officeId);
    return row;
  });
}

export async function updateOutreach(
  officeId: string,
  outreachId: string,
  input: { outcome?: string; followUpAt?: string | null; notes?: string },
  actor: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.outreach.findFirst({
      where: { id: outreachId, officeId },
      select: { id: true, outcome: true, channel: true },
    });
    if (!before) throw new Error("Outreach not found on this brokerage.");

    const outcome = clean(input.outcome);
    const data: Prisma.OutreachUpdateInput = {};

    if (outcome && outcome !== before.outcome) {
      data.outcome = outcome;
      // First time it stops being a bare "Sent", record when they came back.
      if (!OUTREACH_OPEN.includes(outcome)) data.respondedAt = new Date();
    }
    if (input.followUpAt !== undefined) data.followUpAt = parseDate(input.followUpAt);
    if (input.notes !== undefined) data.notes = clean(input.notes);

    if (Object.keys(data).length === 0) return;

    await tx.outreach.update({ where: { id: outreachId }, data });

    if (data.outcome) {
      await logActivity(tx, {
        officeId,
        type: "OUTREACH_OUTCOME",
        summary: `${before.channel}: ${before.outcome} → ${String(data.outcome)}`,
        meta: { outreachId, from: before.outcome, to: String(data.outcome) },
        actor,
      });
    }

    await recomputeLeadRollups(tx, officeId);
  });
}

export async function addNote(officeId: string, note: string, actor: string | null) {
  const summary = clean(note);
  if (!summary) throw new Error("Empty note.");
  await prisma.leadActivity.create({
    data: { officeId, type: "NOTE", summary, actor },
  });
}
