import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runBatchEngine } from "@/lib/crm/batches";
import { runTargetEngine } from "@/lib/crm/targets";
import { BATCH_STATUS, STAGE_NEW, STAGE_QUEUED } from "@/lib/crm/config";
import {
  NOTION_DB,
  NotionStats,
  notion,
  queryAll,
  withNotion,
} from "./client";
import {
  assertOwnership,
  checkbox,
  date,
  dateTime,
  email,
  multiSelect,
  number,
  payloadHash,
  phone,
  readDate,
  readNumber,
  readPeople,
  readSelect,
  readText,
  relation,
  richText,
  select,
  title,
  url,
} from "./mapping";

/**
 * Notion CRM sync.
 *
 * Order of operations, and why:
 *
 *   1. PULL   Read human-owned fields out of Notion first. If we pushed first,
 *             a stage the team set this morning would be overwritten by the
 *             stale value still sitting in Postgres.
 *   2. ENGINE Run batching and targets against the freshly pulled truth, so
 *             batch progress reflects work done since the last sync.
 *   3. PUSH   Write system-owned fields back out.
 *
 * Getting this order wrong silently destroys the team's work, which is why it
 * is spelled out here and in docs/CRM_PROTOCOL.md.
 */

export type NotionSyncKind = "FULL" | "PUSH" | "PULL";
export type NotionSyncTrigger = "MANUAL" | "SCHEDULED" | "API";

export interface NotionSyncResult {
  runId: string;
  status: "SUCCESS" | "FAILED";
  durationMs: number;
  batchesCreated: number;
  pushedOffices: number;
  pushedBrokers: number;
  pushedBatches: number;
  pushedTargets: number;
  pulledOffices: number;
  pulledBrokers: number;
  pulledBatches: number;
  skipped: number;
  requestCount: number;
  errorCount: number;
  error?: string;
}

/** How many lead rows to push per run. Keeps a scheduled run bounded. */
const PUSH_LIMIT = Number(process.env.NOTION_PUSH_LIMIT ?? 400);

/** Collapse the registry's long activity names onto the Notion select options. */
function activityLabel(a: unknown[]): string[] {
  const names = (a as Array<{ nameEn?: string }> | null) ?? [];
  const map: Array<[RegExp, string]> = [
    [/buying|selling/i, "Buying & Selling"],
    [/leasing/i, "Leasing"],
    [/management|supervision/i, "Management"],
    [/mortgage/i, "Mortgage Broker"],
    [/consultan/i, "Consultancy"],
    [/valuation/i, "Valuation"],
    [/development/i, "Development"],
  ];
  const out = new Set<string>();
  for (const item of names) {
    const label = item?.nameEn ?? "";
    const hit = map.find(([re]) => re.test(label));
    out.add(hit ? hit[1] : "Other");
  }
  return [...out];
}

// ------------------------------------------------------------------ 1. PULL

async function pullBrokerages(stats: NotionStats): Promise<number> {
  const pages = await queryAll(NOTION_DB.brokerages, { stats });
  let updated = 0;

  for (const page of pages) {
    const props = (page.properties ?? {}) as Record<string, Record<string, unknown>>;
    const reraNo = readText(props, "RERA No");
    if (!reraNo) continue;

    const owner = readPeople(props, "Owner");
    const lastContacted = readDate(props, "Last Contacted");
    const stage = readSelect(props, "Stage") ?? STAGE_NEW;

    const data: Prisma.OfficeUpdateInput = {
      status: stage,
      ownerNotionId: owner.id,
      ownerName: owner.name,
      channel: readSelect(props, "Channel"),
      contactedAt: lastContacted,
      touchpoints: readNumber(props, "Touchpoints") ?? 0,
      nextAction: readText(props, "Next Action"),
      nextActionDate: readDate(props, "Next Action Date"),
      clientPotential: readSelect(props, "Client Potential"),
      lostReason: readSelect(props, "Lost Reason"),
      dealValueAed: readNumber(props, "Deal Value (AED)"),
      ownerNote: readText(props, "Notes"),
      notionPageId: page.id as string,
    };

    const res = await prisma.office.updateMany({
      where: { realEstateNumber: reraNo },
      data: data as Prisma.OfficeUpdateManyMutationInput,
    });
    if (res.count > 0) updated++;
  }

  return updated;
}

async function pullBrokers(stats: NotionStats): Promise<number> {
  const pages = await queryAll(NOTION_DB.brokers, { stats });
  let updated = 0;

  for (const page of pages) {
    const props = (page.properties ?? {}) as Record<string, Record<string, unknown>>;
    const cardNo = readText(props, "Card No");
    if (!cardNo) continue;

    const owner = readPeople(props, "Owner");

    const res = await prisma.broker.updateMany({
      where: { cardNumber: cardNo },
      data: {
        status: readSelect(props, "Stage") ?? STAGE_NEW,
        ownerNotionId: owner.id,
        ownerName: owner.name,
        channel: readSelect(props, "Channel"),
        contactedAt: readDate(props, "Last Contacted"),
        touchpoints: readNumber(props, "Touchpoints") ?? 0,
        nextAction: readText(props, "Next Action"),
        nextActionDate: readDate(props, "Next Action Date"),
        clientPotential: readSelect(props, "Client Potential"),
        lostReason: readSelect(props, "Lost Reason"),
        ownerNote: readText(props, "Notes"),
        notionPageId: page.id as string,
      },
    });
    if (res.count > 0) updated++;
  }

  return updated;
}

async function pullBatches(stats: NotionStats): Promise<number> {
  const pages = await queryAll(NOTION_DB.batches, { stats });
  let updated = 0;

  for (const page of pages) {
    const props = (page.properties ?? {}) as Record<string, Record<string, unknown>>;
    const code = readText(props, "Batch Code");
    if (!code) continue;

    const assigned = readPeople(props, "Assigned To");
    const status = readSelect(props, "Status");

    // Delayed is a computed state — never let a stale Notion value re-assert it,
    // otherwise a batch the team finished would flip back to Delayed each sync.
    const humanStatus =
      status && status !== BATCH_STATUS.delayed ? status : undefined;

    const res = await prisma.batch.updateMany({
      where: { code },
      data: {
        ...(humanStatus ? { status: humanStatus } : {}),
        assignedNotionUserId: assigned.id,
        assignedName: assigned.name ?? readText(props, "Assigned Name"),
        notes: readText(props, "Notes"),
        notionPageId: page.id as string,
      },
    });
    if (res.count > 0) updated++;
  }

  return updated;
}

async function pullTargets(stats: NotionStats): Promise<number> {
  const pages = await queryAll(NOTION_DB.targets, { stats });
  let updated = 0;

  for (const page of pages) {
    const props = (page.properties ?? {}) as Record<string, Record<string, unknown>>;
    const periodKey = readText(props, "Period");
    if (!periodKey) continue;

    const res = await prisma.target.updateMany({
      where: { periodKey },
      data: {
        targetTouches: readNumber(props, "Target Touches") ?? 0,
        targetBatches: readNumber(props, "Target Batches") ?? 0,
        targetReplies: readNumber(props, "Target Replies") ?? 0,
        targetMeetings: readNumber(props, "Target Meetings") ?? 0,
        notes: readText(props, "Notes"),
        notionPageId: page.id as string,
      },
    });
    if (res.count > 0) updated++;
  }

  return updated;
}

// ------------------------------------------------------------------ 2. PUSH

/**
 * Create or update one Notion page, skipping the write entirely when the
 * payload hash matches what we last pushed.
 */
async function upsertPage(args: {
  databaseId: string;
  existingPageId: string | null;
  existingHash: string | null;
  props: Record<string, unknown>;
  stats: NotionStats;
  label: string;
}): Promise<{ pageId: string | null; hash: string; skipped: boolean }> {
  const hash = payloadHash(args.props);

  if (args.existingPageId && args.existingHash === hash) {
    return { pageId: args.existingPageId, hash, skipped: true };
  }

  if (args.existingPageId) {
    await withNotion(
      `update ${args.label}`,
      () =>
        notion().pages.update({
          page_id: args.existingPageId!,
          properties: args.props as never,
        }),
      args.stats,
    );
    return { pageId: args.existingPageId, hash, skipped: false };
  }

  const created = await withNotion(
    `create ${args.label}`,
    () =>
      notion().pages.create({
        parent: { database_id: args.databaseId },
        properties: args.props as never,
      }),
    args.stats,
  );

  return { pageId: (created as { id: string }).id, hash, skipped: false };
}

async function pushBatches(stats: NotionStats, syncedAt: Date) {
  // Push every batch that is still live, plus recently closed ones so the team
  // can see what completed. Ancient history stays put.
  const batches = await prisma.batch.findMany({
    where: {
      OR: [
        { status: { notIn: [BATCH_STATUS.completed, BATCH_STATUS.cancelled] } },
        { completedDate: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      ],
    },
    orderBy: { assignedDate: "asc" },
    include: { blockedBy: { select: { notionPageId: true } } },
  });

  let pushed = 0;
  let skipped = 0;

  for (const b of batches) {
    const props: Record<string, unknown> = {
      "Batch Code": title(b.code),
      Type: select(b.kind === "BROKERAGE" ? "Brokerage" : "Broker"),
      "Delay Status": select(b.delayStatus),
      Size: number(b.size),
      Worked: number(b.worked),
      "Assigned Date": date(b.assignedDate),
      "Due Date": date(b.dueDate),
      "Completed Date": date(b.completedDate),
      "Days Overdue": number(b.daysOverdue),
      "Cascade Delay Days": number(b.cascadeDelayDays),
      "Priority Band": select(b.priorityBand),
      "Avg Lead Score": number(b.avgLeadScore),
      "Blocked By": relation([b.blockedBy?.notionPageId ?? null]),
      "Synced At": dateTime(syncedAt),
    };

    // Status is the one shared field: push it only when the engine forced a
    // state the human cannot have set themselves.
    if (b.status === BATCH_STATUS.delayed || b.status === BATCH_STATUS.completed) {
      props.Status = select(b.status);
    }

    assertOwnership("batches", props);

    const { pageId, hash, skipped: wasSkipped } = await upsertPage({
      databaseId: NOTION_DB.batches,
      existingPageId: b.notionPageId,
      existingHash: b.notionHash,
      props,
      stats,
      label: `batch ${b.code}`,
    });

    if (wasSkipped) {
      skipped++;
      continue;
    }

    await prisma.batch.update({
      where: { id: b.id },
      data: { notionPageId: pageId, notionHash: hash, notionSyncedAt: syncedAt },
    });
    pushed++;
  }

  return { pushed, skipped };
}

async function pushBrokerages(stats: NotionStats, syncedAt: Date) {
  // Only leads that are actually in play: batched, or already being worked.
  const offices = await prisma.office.findMany({
    where: {
      isActive: true,
      OR: [{ batchId: { not: null } }, { notionPageId: { not: null } }],
    },
    orderBy: [{ leadScore: "desc" }],
    take: PUSH_LIMIT,
    include: { batch: { select: { notionPageId: true } } },
  });

  let pushed = 0;
  let skipped = 0;

  for (const o of offices) {
    const gaps: string[] = [];
    if (!o.website) gaps.push("No Website");
    if (!o.instagramUrl) gaps.push("No Instagram");
    if (!o.whatsapp) gaps.push("No WhatsApp");

    const props: Record<string, unknown> = {
      Brokerage: title(o.nameEn ?? `#${o.realEstateNumber}`),
      "RERA No": richText(o.realEstateNumber),
      "Lead Score": number(o.leadScore),
      Tier: select(o.leadTier),
      "Licensed On": date(o.issueDate),
      "Licence Expires": date(o.expiryDate),
      Brokers: number(o.activeBrokerCount),
      "New Brokers 30d": number(o.newBrokers30d),
      "Contact Name": richText(o.contactNameEn),
      Email: email(o.contactEmail),
      Mobile: phone(o.contactMobile),
      "Office Phone": phone(o.phone),
      WhatsApp: phone(o.whatsapp),
      Website: url(o.website),
      Instagram: url(o.instagramUrl),
      LinkedIn: url(o.linkedinUrl),
      "Digital Gaps": multiSelect(gaps),
      "RERA Rank": select(o.rank),
      Activities: multiSelect(activityLabel((o.activities as unknown[]) ?? [])),
      Batch: relation([o.batch?.notionPageId ?? null]),
      "Synced At": dateTime(syncedAt),
    };

    assertOwnership("brokerages", props);

    // A brand-new page needs its opening Stage; after that it is the team's.
    if (!o.notionPageId) props.Stage = select(o.status || STAGE_QUEUED);

    const { pageId, hash, skipped: wasSkipped } = await upsertPage({
      databaseId: NOTION_DB.brokerages,
      existingPageId: o.notionPageId,
      existingHash: o.notionHash,
      props,
      stats,
      label: `brokerage ${o.realEstateNumber}`,
    });

    if (wasSkipped) {
      skipped++;
      continue;
    }

    await prisma.office.update({
      where: { realEstateNumber: o.realEstateNumber },
      data: { notionPageId: pageId, notionHash: hash, notionSyncedAt: syncedAt },
    });
    pushed++;
  }

  return { pushed, skipped };
}

async function pushBrokers(stats: NotionStats, syncedAt: Date) {
  const brokers = await prisma.broker.findMany({
    where: {
      isActive: true,
      OR: [{ batchId: { not: null } }, { notionPageId: { not: null } }],
    },
    orderBy: [{ leadScore: "desc" }],
    take: PUSH_LIMIT,
    include: {
      batch: { select: { notionPageId: true } },
      office: { select: { notionPageId: true, nameEn: true } },
    },
  });

  let pushed = 0;
  let skipped = 0;

  for (const b of brokers) {
    const props: Record<string, unknown> = {
      Broker: title(b.nameEn ?? `Card ${b.cardNumber}`),
      "Card No": richText(b.cardNumber),
      Brokerage: relation([b.office?.notionPageId ?? null]),
      "Brokerage Name": richText(b.officeNameEn ?? b.office?.nameEn),
      "New Licence": checkbox(b.isNewCard),
      "Card Issued": date(b.cardIssueDate),
      "Card Expires": date(b.cardExpiryDate),
      Discovered: date(b.firstSeenAt),
      Email: email(b.email),
      Mobile: phone(b.mobile),
      "Card Rank": richText(b.cardRank),
      "Lead Score": number(b.leadScore),
      Tier: select(b.leadTier),
      Batch: relation([b.batch?.notionPageId ?? null]),
      "Synced At": dateTime(syncedAt),
    };

    assertOwnership("brokers", props);

    if (!b.notionPageId) props.Stage = select(b.status || STAGE_QUEUED);

    const { pageId, hash, skipped: wasSkipped } = await upsertPage({
      databaseId: NOTION_DB.brokers,
      existingPageId: b.notionPageId,
      existingHash: b.notionHash,
      props,
      stats,
      label: `broker ${b.cardNumber}`,
    });

    if (wasSkipped) {
      skipped++;
      continue;
    }

    await prisma.broker.update({
      where: { cardNumber: b.cardNumber },
      data: { notionPageId: pageId, notionHash: hash, notionSyncedAt: syncedAt },
    });
    pushed++;
  }

  return { pushed, skipped };
}

async function pushTargets(stats: NotionStats, syncedAt: Date) {
  const targets = await prisma.target.findMany({ orderBy: { startDate: "asc" } });

  let pushed = 0;
  let skipped = 0;

  for (const t of targets) {
    const props: Record<string, unknown> = {
      Period: title(t.periodKey),
      Type: select(
        t.kind === "DAILY" ? "Daily" : t.kind === "WEEKLY" ? "Weekly" : "Monthly",
      ),
      Start: date(t.startDate),
      End: date(t.endDate),
      "Actual Touches": number(t.actualTouches),
      "Actual Batches": number(t.actualBatches),
      "Actual Replies": number(t.actualReplies),
      "Actual Meetings": number(t.actualMeetings),
      Status: select(t.status),
      "Synced At": dateTime(syncedAt),
    };

    assertOwnership("targets", props);

    // Seed the target numbers once, then leave them to whoever owns the goal.
    if (!t.notionPageId) {
      props["Target Touches"] = number(t.targetTouches);
      props["Target Batches"] = number(t.targetBatches);
      props["Target Replies"] = number(t.targetReplies);
      props["Target Meetings"] = number(t.targetMeetings);
    }

    const { pageId, hash, skipped: wasSkipped } = await upsertPage({
      databaseId: NOTION_DB.targets,
      existingPageId: t.notionPageId,
      existingHash: t.notionHash,
      props,
      stats,
      label: `target ${t.periodKey}`,
    });

    if (wasSkipped) {
      skipped++;
      continue;
    }

    await prisma.target.update({
      where: { id: t.id },
      data: { notionPageId: pageId, notionHash: hash, notionSyncedAt: syncedAt },
    });
    pushed++;
  }

  return { pushed, skipped };
}

// ------------------------------------------------------------------- runner

export async function runNotionSync(options: {
  kind?: NotionSyncKind;
  trigger?: NotionSyncTrigger;
  onProgress?: (message: string) => void;
} = {}): Promise<NotionSyncResult> {
  const kind = options.kind ?? "FULL";
  const trigger = options.trigger ?? "MANUAL";
  const log = options.onProgress ?? (() => {});
  const stats = new NotionStats();
  const started = Date.now();
  const notes: string[] = [];

  const note = (m: string) => {
    notes.push(`[${new Date().toISOString()}] ${m}`);
    log(m);
  };

  const run = await prisma.notionSyncRun.create({
    data: { kind, trigger, status: "RUNNING" },
  });

  const result: NotionSyncResult = {
    runId: run.id,
    status: "SUCCESS",
    durationMs: 0,
    batchesCreated: 0,
    pushedOffices: 0,
    pushedBrokers: 0,
    pushedBatches: 0,
    pushedTargets: 0,
    pulledOffices: 0,
    pulledBrokers: 0,
    pulledBatches: 0,
    skipped: 0,
    requestCount: 0,
    errorCount: 0,
  };

  try {
    const syncedAt = new Date();

    // ---- 1. PULL (must come first, see the note at the top of this file) ----
    if (kind !== "PUSH") {
      note("Pulling human-owned fields from Notion ...");
      result.pulledBatches = await pullBatches(stats);
      result.pulledOffices = await pullBrokerages(stats);
      result.pulledBrokers = await pullBrokers(stats);
      await pullTargets(stats);
      note(
        `Pulled ${result.pulledOffices} brokerages, ${result.pulledBrokers} brokers, ${result.pulledBatches} batches.`,
      );
    }

    // ---- 2. ENGINES -------------------------------------------------------
    note("Running batch engine ...");
    const batchResult = await runBatchEngine();
    result.batchesCreated = batchResult.created;
    note(
      `Batches: ${batchResult.created} created, ${batchResult.closed} closed, ${batchResult.delayed} delayed.`,
    );

    note("Running target engine ...");
    const targetResult = await runTargetEngine();
    note(`Targets: ${targetResult.created} created, ${targetResult.updated} updated.`);

    // ---- 3. PUSH ----------------------------------------------------------
    if (kind !== "PULL") {
      // Batches first: leads carry a relation to their batch page, which needs
      // to exist before the lead can point at it.
      note("Pushing batches ...");
      const b = await pushBatches(stats, syncedAt);
      result.pushedBatches = b.pushed;
      result.skipped += b.skipped;

      note("Pushing brokerages ...");
      const o = await pushBrokerages(stats, syncedAt);
      result.pushedOffices = o.pushed;
      result.skipped += o.skipped;

      note("Pushing brokers ...");
      const br = await pushBrokers(stats, syncedAt);
      result.pushedBrokers = br.pushed;
      result.skipped += br.skipped;

      note("Pushing targets ...");
      const t = await pushTargets(stats, syncedAt);
      result.pushedTargets = t.pushed;
      result.skipped += t.skipped;
    }

    result.requestCount = stats.requests;
    result.errorCount = stats.errors;
    result.durationMs = Date.now() - started;

    await prisma.notionSyncRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        durationMs: result.durationMs,
        batchesCreated: result.batchesCreated,
        pushedOffices: result.pushedOffices,
        pushedBrokers: result.pushedBrokers,
        pushedBatches: result.pushedBatches,
        pushedTargets: result.pushedTargets,
        pulledOffices: result.pulledOffices,
        pulledBrokers: result.pulledBrokers,
        pulledBatches: result.pulledBatches,
        skipped: result.skipped,
        requestCount: stats.requests,
        errorCount: stats.errors,
        log: notes.slice(-400) as unknown as Prisma.InputJsonValue,
      },
    });

    note(`Done in ${(result.durationMs / 1000).toFixed(1)}s.`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.status = "FAILED";
    result.error = message;
    result.durationMs = Date.now() - started;

    await prisma.notionSyncRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        durationMs: result.durationMs,
        error: message,
        requestCount: stats.requests,
        errorCount: stats.errors + 1,
        log: notes.slice(-400) as unknown as Prisma.InputJsonValue,
      },
    });

    throw err;
  }
}
