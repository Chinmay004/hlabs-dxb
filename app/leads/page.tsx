import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, Ext, Pill, SectionTitle, TierBadge } from "../components/ui";
import { fmtAge, fmtDate, isoDay } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Opinionated call sheet rather than another filterable grid: three segments we
 * actually pitch differently, each capped at a workable number of accounts for
 * one person to get through.
 */
const SEGMENTS = [
  {
    id: "just-opened",
    title: "Just opened",
    hint: "Licensed in the last 45 days. They are buying everything right now — CRM, listings, portal feeds, branding.",
    pitch: "Brokerage setup bundle",
    where: {
      isActive: true,
      issueDate: { gte: new Date(Date.now() - 45 * 86_400_000) },
    },
    orderBy: [{ issueDate: "desc" as const }],
    href: `/brokerages?issuedFrom=${isoDay(-45)}&sort=issueDate`,
  },
  {
    id: "shells",
    title: "Licensed but empty",
    hint: "Licensed in the last 6 months with zero brokers registered. The owner has a licence and no team yet — recruitment and agent-onboarding tooling.",
    pitch: "Agent recruitment + onboarding",
    where: {
      isActive: true,
      activeBrokerCount: 0,
      issueDate: { gte: new Date(Date.now() - 180 * 86_400_000) },
    },
    orderBy: [{ issueDate: "desc" as const }],
    href: `/brokerages?issuedFrom=${isoDay(-180)}&maxBrokers=0&sort=issueDate`,
  },
  {
    id: "invisible",
    title: "No digital presence",
    hint: "Small firms with a contactable owner, no website and no Instagram. The gap is the entire pitch.",
    pitch: "Web presence + lead gen",
    where: {
      isActive: true,
      website: null,
      instagramUrl: null,
      contactEmail: { not: null },
      activeBrokerCount: { gt: 0, lte: 10 },
    },
    orderBy: [{ leadScore: "desc" as const }],
    href: "/brokerages?hasWebsite=no&hasInstagram=no&hasEmail=yes&maxBrokers=10",
  },
  {
    id: "hiring",
    title: "Hiring fast",
    hint: "Added three or more brokers in the last 30 days. Growing headcount means budget and an onboarding problem.",
    pitch: "Scale-up tooling",
    where: { isActive: true, newBrokers30d: { gte: 3 } },
    orderBy: [{ newBrokers30d: "desc" as const }],
    href: "/brokerages?sort=newBrokers30d",
  },
  {
    id: "renewal",
    title: "Licence renewing soon",
    hint: "Office licence expires within 45 days. They are already in a paperwork-and-vendor mindset.",
    pitch: "Renewal-window upsell",
    where: {
      isActive: true,
      expiryDate: {
        gte: new Date(),
        lte: new Date(Date.now() + 45 * 86_400_000),
      },
    },
    orderBy: [{ expiryDate: "asc" as const }],
    href: `/brokerages?expiringBefore=${isoDay(45)}&sort=expiryDate&dir=asc`,
  },
] as const;

export default async function LeadsPage() {
  const segments = await Promise.all(
    SEGMENTS.map(async (s) => {
      const [count, rows] = await Promise.all([
        prisma.office.count({ where: s.where }),
        prisma.office.findMany({
          where: s.where,
          orderBy: [...s.orderBy],
          take: 15,
          select: {
            realEstateNumber: true,
            nameEn: true,
            issueDate: true,
            expiryDate: true,
            activeBrokerCount: true,
            newBrokers30d: true,
            contactEmail: true,
            contactMobile: true,
            phone: true,
            website: true,
            leadScore: true,
            leadTier: true,
          },
        }),
      ]);
      return { ...s, count, rows };
    }),
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Lead segments</h1>
        <p className="mt-1 text-xs text-muted">
          Five ways into the market, each with a different pitch. Top 15 shown —
          follow the link for the full list or export it.
        </p>
      </div>

      {segments.map((s) => (
        <Card key={s.id} className="!p-0">
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4">
            <SectionTitle hint={s.hint}>
              {s.title}{" "}
              <span className="ml-1 font-normal text-muted">
                ({s.count.toLocaleString()})
              </span>
            </SectionTitle>
            <div className="flex items-center gap-2">
              <Pill tone="accent">{s.pitch}</Pill>
              <Link
                href={s.href}
                className="text-xs text-[color:var(--accent)] hover:underline"
              >
                See all →
              </Link>
              <a
                href={`/api/export?type=offices&${s.href.split("?")[1] ?? ""}`}
                className="text-xs text-muted hover:text-[color:var(--foreground)]"
              >
                ↓ CSV
              </a>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-[12.5px]">
              <thead>
                <tr className="border-y border-[color:var(--border)] text-left text-[10px] uppercase tracking-wider text-muted">
                  <th className="px-4 py-2 font-medium">Brokerage</th>
                  <th className="px-2 py-2 font-medium">Licensed</th>
                  <th className="px-2 py-2 text-right font-medium">Brokers</th>
                  <th className="px-2 py-2 font-medium">Email</th>
                  <th className="px-2 py-2 font-medium">Mobile</th>
                  <th className="px-2 py-2 font-medium">Web</th>
                  <th className="px-4 py-2 text-right font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {s.rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted">
                      Nothing in this segment right now.
                    </td>
                  </tr>
                ) : null}
                {s.rows.map((o) => (
                  <tr
                    key={o.realEstateNumber}
                    className="border-b border-[color:var(--border)]/50 hover:bg-[color:var(--surface-2)]/50"
                  >
                    <td className="max-w-[300px] px-4 py-2">
                      <Link
                        href={`/brokerages/${o.realEstateNumber}`}
                        className="line-clamp-1 hover:text-[color:var(--accent)]"
                        title={o.nameEn ?? ""}
                      >
                        {o.nameEn ?? `#${o.realEstateNumber}`}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted">
                      {s.id === "renewal" ? (
                        <>exp {fmtDate(o.expiryDate)}</>
                      ) : (
                        <>
                          {fmtDate(o.issueDate)}{" "}
                          <span className="text-[10px]">
                            {fmtAge(o.issueDate)}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {o.activeBrokerCount}
                      {o.newBrokers30d > 0 ? (
                        <span className="ml-1 text-[10px] text-[color:var(--success)]">
                          +{o.newBrokers30d}
                        </span>
                      ) : null}
                    </td>
                    <td className="max-w-[230px] px-2 py-2">
                      {o.contactEmail ? (
                        <a
                          href={`mailto:${o.contactEmail}`}
                          className="line-clamp-1 text-[color:var(--accent)] hover:underline"
                        >
                          {o.contactEmail}
                        </a>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                      {o.contactMobile ?? o.phone ?? (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {o.website ? (
                        <Ext href={o.website} label="site" />
                      ) : (
                        <Pill tone="warn">none</Pill>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <span className="mr-1.5 tabular-nums font-semibold">
                        {o.leadScore}
                      </span>
                      <TierBadge tier={o.leadTier} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}
