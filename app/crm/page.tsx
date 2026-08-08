import type { Prisma } from "@prisma/client";

import { FilterBar, type FieldDef } from "../components/filter-bar";
import { Card, Empty, Stat } from "../components/ui";
import { Pagination } from "../components/pagination";
import { prisma } from "@/lib/db";
import {
  OUTREACH_OPEN,
  RESEARCH_ACTIONABLE,
  RESEARCH_CLOSED,
  RESEARCH_ENRICHED,
  RESEARCH_IN_PROGRESS,
  RESEARCH_NOTHING_FOUND,
  RESEARCH_NOT_STARTED,
  RESEARCH_STATUSES,
} from "@/lib/crm/research";
import { ActorPicker } from "./actor";
import { COLSPAN, LeadRow, type LeadSummary } from "./lead-row";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The research and outreach workspace.
 *
 * Ordered by lead score descending by default — the queue is the worklist, and
 * the best firm nobody has touched should always be the first thing an intern
 * sees on opening the page.
 */
export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  const research = one(sp.research) ?? "";
  const assignee = one(sp.assignee) ?? "";
  const tier = one(sp.tier) ?? "";
  const outreach = one(sp.outreach) ?? "";
  const q = one(sp.q)?.trim() ?? "";
  const minScore = Number(one(sp.minScore) ?? "");

  const page = Math.max(1, Number(one(sp.page) ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(25, Number(one(sp.pageSize) ?? 50) || 50));

  const now = new Date();

  // Only live licences are worth a person's time; a dropped licence in the queue
  // is pure noise for whoever is working it.
  const where: Prisma.OfficeWhereInput = { isActive: true };

  if (research) where.researchStatus = research;
  if (tier) where.leadTier = tier;
  if (Number.isFinite(minScore) && minScore > 0) where.leadScore = { gte: minScore };
  if (q) where.nameEn = { contains: q, mode: "insensitive" };

  if (assignee === "unassigned") where.assignedTo = null;
  else if (assignee) where.assignedTo = assignee;

  if (outreach === "none") where.outreachCount = 0;
  else if (outreach === "sent") where.outreachCount = { gt: 0 };
  else if (outreach === "awaiting") where.lastOutreachOutcome = { in: [...OUTREACH_OPEN] };
  else if (outreach === "due") where.nextFollowUpAt = { lte: now };

  const active = { isActive: true } as const;

  const [
    total,
    rows,
    totalActive,
    notStarted,
    researching,
    enriched,
    nothingFound,
    covered,
    outreached,
    awaiting,
    dueFollowUps,
    assigneeRows,
  ] = await Promise.all([
    prisma.office.count({ where }),
    prisma.office.findMany({
      where,
      // Score first, then the newest licence as a tiebreak so equal-scoring
      // firms come out in a stable, sensible order rather than by primary key.
      orderBy: [{ leadScore: "desc" }, { issueDate: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        realEstateNumber: true,
        nameEn: true,
        leadScore: true,
        leadTier: true,
        activeBrokerCount: true,
        status: true,
        researchStatus: true,
        assignedTo: true,
        contactsFound: true,
        outreachCount: true,
        lastOutreachAt: true,
        lastOutreachOutcome: true,
        nextFollowUpAt: true,
      },
    }),
    prisma.office.count({ where: active }),
    prisma.office.count({ where: { ...active, researchStatus: RESEARCH_NOT_STARTED } }),
    prisma.office.count({ where: { ...active, researchStatus: RESEARCH_IN_PROGRESS } }),
    prisma.office.count({ where: { ...active, researchStatus: RESEARCH_ENRICHED } }),
    prisma.office.count({ where: { ...active, researchStatus: RESEARCH_NOTHING_FOUND } }),
    prisma.office.count({ where: { ...active, researchStatus: { in: [...RESEARCH_CLOSED] } } }),
    prisma.office.count({ where: { ...active, outreachCount: { gt: 0 } } }),
    prisma.office.count({
      where: { ...active, lastOutreachOutcome: { in: [...OUTREACH_OPEN] } },
    }),
    prisma.office.count({ where: { ...active, nextFollowUpAt: { lte: now } } }),
    prisma.office.findMany({
      where: { assignedTo: { not: null } },
      distinct: ["assignedTo"],
      select: { assignedTo: true },
      orderBy: { assignedTo: "asc" },
    }),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const coveredPct = totalActive === 0 ? 0 : (covered / totalActive) * 100;

  // Ready to work: research is done and a contact exists, but nobody has
  // reached out yet. This is the number that should never sit at zero.
  const readyForOutreach = await prisma.office.count({
    where: {
      ...active,
      researchStatus: { in: [...RESEARCH_ACTIONABLE] },
      outreachCount: 0,
    },
  });

  const fields: FieldDef[] = [
    { name: "q", label: "Search", type: "text", placeholder: "Brokerage name", width: "190px" },
    {
      name: "research",
      label: "Research",
      type: "select",
      width: "160px",
      options: [
        { value: "", label: "Any" },
        ...RESEARCH_STATUSES.map((s) => ({ value: s, label: s })),
      ],
    },
    {
      name: "outreach",
      label: "Outreach",
      type: "select",
      width: "150px",
      options: [
        { value: "", label: "Any" },
        { value: "none", label: "Not contacted" },
        { value: "sent", label: "Contacted" },
        { value: "awaiting", label: "Awaiting reply" },
        { value: "due", label: "Follow-up due" },
      ],
    },
    {
      name: "assignee",
      label: "Assignee",
      type: "select",
      width: "150px",
      options: [
        { value: "", label: "Anyone" },
        { value: "unassigned", label: "Unassigned" },
        ...assigneeRows
          .map((r) => r.assignedTo)
          .filter((v): v is string => Boolean(v))
          .map((v) => ({ value: v, label: v })),
      ],
    },
    {
      name: "tier",
      label: "Tier",
      type: "select",
      width: "100px",
      options: [
        { value: "", label: "Any" },
        ...["A+", "A", "B", "C", "D"].map((t) => ({ value: t, label: t })),
      ],
    },
    { name: "minScore", label: "Min score", type: "number", width: "100px" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Outreach CRM</h1>
          <p className="mt-1 text-xs text-muted">
            Research queue, best leads first. Research state is tracked
            separately from the pipeline stage, so a firm that was searched and
            came up empty is recorded as covered rather than sliding back into
            the queue.
          </p>
        </div>
        <ActorPicker />
      </div>

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 xl:grid-cols-7">
        <Stat
          label="Covered"
          value={`${coveredPct.toFixed(1)}%`}
          sub={`${covered.toLocaleString()} of ${totalActive.toLocaleString()} live firms`}
          tone="good"
        />
        <Stat
          label="Not started"
          value={notStarted}
          sub="nobody has looked"
          href="/crm?research=%E2%9A%AA%20Not%20Started"
        />
        <Stat
          label="Researching"
          value={researching}
          sub="claimed right now"
          tone="hot"
          href="/crm?research=%F0%9F%94%8D%20Researching"
        />
        <Stat
          label="Enriched"
          value={enriched}
          sub="decision-maker found"
          tone="good"
          href="/crm?research=%E2%9C%85%20Enriched"
        />
        <Stat
          label="Nothing found"
          value={nothingFound}
          sub="searched, came up empty"
          href="/crm?research=%F0%9F%9A%AB%20Nothing%20Found"
        />
        <Stat
          label="Ready to contact"
          value={readyForOutreach}
          sub="enriched, not yet messaged"
          tone={readyForOutreach > 0 ? "warn" : "default"}
          href="/crm?research=%E2%9C%85%20Enriched&outreach=none"
        />
        <Stat
          label="Follow-ups due"
          value={dueFollowUps}
          sub={`${awaiting.toLocaleString()} awaiting reply`}
          tone={dueFollowUps > 0 ? "warn" : "default"}
          href="/crm?outreach=due"
        />
      </div>

      <div>
        <FilterBar
          fields={fields}
          presets={[
            { label: "Fresh queue", params: { research: RESEARCH_NOT_STARTED } },
            { label: "Ready to contact", params: { research: RESEARCH_ENRICHED, outreach: "none" } },
            { label: "Follow-ups due", params: { outreach: "due" } },
            { label: "Awaiting reply", params: { outreach: "awaiting" } },
            { label: "Unassigned", params: { assignee: "unassigned" } },
            { label: "Dead ends", params: { research: RESEARCH_NOTHING_FOUND } },
          ]}
        />

        <Card className="!p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-[12.5px]">
              <thead>
                <tr className="border-b border-[color:var(--border)] text-left text-[10px] uppercase tracking-wider text-muted">
                  <th className="px-4 py-2 font-medium">Brokerage</th>
                  <th className="px-2 py-2 text-right font-medium">Score</th>
                  <th className="px-2 py-2 text-right font-medium">Brokers</th>
                  <th className="px-2 py-2 font-medium">Research</th>
                  <th className="px-2 py-2 text-right font-medium">Contacts</th>
                  <th className="px-2 py-2 font-medium">Outreach</th>
                  <th className="px-2 py-2 font-medium">Follow-up</th>
                  <th className="px-2 py-2 font-medium">Assignee</th>
                  <th className="px-4 py-2 font-medium">Stage</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={COLSPAN}>
                      <Empty>Nothing matches these filters.</Empty>
                    </td>
                  </tr>
                ) : null}
                {rows.map((r) => {
                  const lead: LeadSummary = {
                    ...r,
                    lastOutreachAt: r.lastOutreachAt?.toISOString() ?? null,
                    nextFollowUpAt: r.nextFollowUpAt?.toISOString() ?? null,
                  };
                  return <LeadRow key={r.realEstateNumber} lead={lead} />;
                })}
              </tbody>
            </table>
          </div>

          <div className="border-t border-[color:var(--border)]">
            <Pagination
              page={page}
              pageCount={pageCount}
              total={total}
              pageSize={pageSize}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
