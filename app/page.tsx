import Link from "next/link";
import { prisma } from "@/lib/db";
import {
  getActivityBreakdown,
  getOverview,
  getSizeDistribution,
  getTierDistribution,
  getTimeseries,
} from "@/lib/analytics";
import { BarChart } from "./components/charts";
import {
  BarList,
  Card,
  Ext,
  Pill,
  SectionTitle,
  Stat,
  TierBadge,
} from "./components/ui";
import { fmtAge, fmtDate, fmtDateTime, isoDay, lastNDays } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Maps a size band from getSizeDistribution back to the filter that produced it. */
const SIZE_BAND_QUERY: Record<string, string> = {
  "0 (shell)": "maxBrokers=0",
  "1-3": "minBrokers=1&maxBrokers=3",
  "4-10": "minBrokers=4&maxBrokers=10",
  "11-25": "minBrokers=11&maxBrokers=25",
  "26-60": "minBrokers=26&maxBrokers=60",
  "61-150": "minBrokers=61&maxBrokers=150",
  "150+": "minBrokers=151",
};

export default async function DashboardPage() {
  const { from, to } = lastNDays(180);

  const [overview, series, sizes, tiers, activities, freshest] = await Promise.all([
    getOverview(),
    getTimeseries({ from, to, granularity: "day" }),
    getSizeDistribution(),
    getTierDistribution(),
    getActivityBreakdown(),
    prisma.office.findMany({
      where: { isActive: true, issueDate: { not: null } },
      orderBy: { issueDate: "desc" },
      take: 12,
      select: {
        realEstateNumber: true,
        nameEn: true,
        issueDate: true,
        activeBrokerCount: true,
        contactEmail: true,
        contactMobile: true,
        leadTier: true,
      },
    }),
  ]);

  const recent = series.slice(-90);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Dubai brokerage &amp; broker registry
          </h1>
          <p className="mt-1 text-xs text-muted">
            {overview.activeOffices.toLocaleString()} active brokerages ·{" "}
            {overview.activeBrokers.toLocaleString()} active broker cards · last
            sync{" "}
            {overview.lastSyncAt ? (
              <>
                {fmtDateTime(overview.lastSyncAt)}{" "}
                <span
                  style={{
                    color:
                      overview.lastSyncStatus === "SUCCESS"
                        ? "var(--success)"
                        : "var(--danger)",
                  }}
                >
                  ({overview.lastSyncStatus?.toLowerCase()})
                </span>
              </>
            ) : (
              "never"
            )}
          </p>
        </div>
        <Link
          href="/sync"
          className="card px-3 py-1.5 text-xs transition-colors hover:border-[color:var(--accent)]"
        >
          Run sync
        </Link>
      </div>

      {/* ------------------------------------------------------------ KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat
          label="New brokerages 7d"
          value={overview.officesIssued7d}
          tone="hot"
          sub="RERA licence issued"
          href={`/brokerages?issuedFrom=${isoDay(-7)}&sort=issueDate`}
        />
        <Stat
          label="New brokerages 30d"
          value={overview.officesIssued30d}
          previous={overview.officesIssuedPrev30d}
          sub={`vs ${overview.officesIssuedPrev30d} prior 30d`}
          href={`/brokerages?issuedFrom=${isoDay(-30)}&sort=issueDate`}
        />
        <Stat
          label="New brokers 30d"
          value={overview.brokersNew30d}
          previous={
            overview.syncCount >= 3 ? overview.brokersNewPrev30d : undefined
          }
          sub={
            overview.syncCount < 2
              ? "needs a 2nd sync"
              : `${overview.brokerCardsIssued30d.toLocaleString()} cards incl. renewals`
          }
          href={`/brokers?foundFrom=${isoDay(-30)}&newOnly=1&sort=firstSeenAt`}
        />
        <Stat
          label="Hot leads"
          value={overview.hotLeads}
          tone="good"
          sub="tier A / A+"
          href="/leads"
        />
        <Stat
          label="Empty new firms"
          value={overview.emptyNewOffices}
          tone="warn"
          sub="licensed 90d, 0 brokers"
          href={`/brokerages?issuedFrom=${isoDay(-90)}&maxBrokers=0&sort=issueDate`}
        />
        <Stat
          label="Licences expiring 30d"
          value={overview.officesExpiring30d}
          sub={`${overview.brokerCardsExpiring30d.toLocaleString()} broker cards too`}
          href={`/brokerages?expiringBefore=${isoDay(30)}&sort=expiryDate&dir=asc`}
        />
        <Stat
          label="No website"
          value={overview.officesWithoutWebsite}
          sub={`${overview.contactableOffices.toLocaleString()} reachable`}
          href="/brokerages?hasWebsite=no&hasEmail=yes"
        />
      </div>

      {/* ----------------------------------------------------------- chart */}
      <Card>
        <SectionTitle hint="Daily, last 90 days, by RERA licence date. Broker-card volume is an order of magnitude larger and would flatten this — see Daily for that.">
          Brokerages licensed
        </SectionTitle>
        <BarChart
          rows={recent}
          series={[
            { key: "officesIssued", label: "Brokerages licensed", color: "#4f8cff" },
            { key: "brokersNew", label: "New brokers", color: "#35c98a" },
          ]}
          stacked={false}
          height={230}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* -------------------------------------------------- newest firms */}
        <Card className="lg:col-span-2">
          <SectionTitle
            hint="Straight off the registry, newest licence first."
            action={
              <Link
                href="/brokerages?sort=issueDate"
                className="text-xs text-[color:var(--accent)] hover:underline"
              >
                All brokerages →
              </Link>
            }
          >
            Most recently licensed brokerages
          </SectionTitle>

          <div className="-mx-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-[12.5px]">
              <thead>
                <tr className="border-y border-[color:var(--border)] text-left text-[10px] uppercase tracking-wider text-muted">
                  <th className="px-4 py-2 font-medium">Brokerage</th>
                  <th className="px-2 py-2 font-medium">Licensed</th>
                  <th className="px-2 py-2 text-right font-medium">Brokers</th>
                  <th className="px-2 py-2 font-medium">Contact</th>
                  <th className="px-4 py-2 font-medium">Tier</th>
                </tr>
              </thead>
              <tbody>
                {freshest.map((o) => (
                  <tr
                    key={o.realEstateNumber}
                    className="border-b border-[color:var(--border)]/60"
                  >
                    <td className="max-w-[280px] px-4 py-2">
                      <Link
                        href={`/brokerages/${o.realEstateNumber}`}
                        className="block truncate hover:text-[color:var(--accent)]"
                        title={o.nameEn ?? ""}
                      >
                        {o.nameEn ?? `#${o.realEstateNumber}`}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted">
                      {fmtDate(o.issueDate)}{" "}
                      <span className="text-[10px] opacity-70">
                        {fmtAge(o.issueDate)}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {o.activeBrokerCount === 0 ? (
                        <Pill tone="warn">0</Pill>
                      ) : (
                        o.activeBrokerCount
                      )}
                    </td>
                    <td className="max-w-[200px] truncate px-2 py-2 text-muted">
                      {o.contactEmail ?? o.contactMobile ?? "—"}
                    </td>
                    <td className="px-4 py-2">
                      <TierBadge tier={o.leadTier} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* ------------------------------------------------- distributions */}
        <div className="space-y-4">
          <Card>
            <SectionTitle hint="Active brokerages by headcount.">
              Firm size
            </SectionTitle>
            <BarList
              rows={sizes.map((s) => ({
                label: s.band,
                value: s.n,
                href: `/brokerages?${SIZE_BAND_QUERY[s.band] ?? ""}`,
              }))}
            />
          </Card>

          <Card>
            <SectionTitle hint="Lead score bands across active firms.">
              Lead tiers
            </SectionTitle>
            <BarList
              rows={tiers.map((t) => ({
                label: t.tier,
                value: t.n,
                href: `/brokerages?tier=${encodeURIComponent(t.tier)}`,
              }))}
              color="var(--success)"
            />
          </Card>
        </div>
      </div>

      <Card>
        <SectionTitle hint="What active brokerages are licensed to do — the shape of the addressable market.">
          Licensed activities
        </SectionTitle>
        <div className="grid gap-x-8 gap-y-1.5 md:grid-cols-2">
          <BarList
            rows={activities.slice(0, 8).map((a) => ({ label: a.name, value: a.n }))}
            color="#7b6cf6"
          />
          <BarList
            rows={activities.slice(8, 16).map((a) => ({ label: a.name, value: a.n }))}
            color="#7b6cf6"
          />
        </div>
      </Card>

      <p className="pb-4 text-[11px] leading-relaxed text-muted">
        Source:{" "}
        <Ext href="https://gateway.dubailand.gov.ae">
          Dubai Land Department public gateway
        </Ext>
        . Brokerage licence dates are exact for the full history. Broker cards
        are not: the registry publishes only a card&apos;s current term, so “cards
        issued” counts annual renewals too. “New brokers” isolates first-time
        licences by card number against a watermark we record ourselves, which
        means it is exact but only from the second sync onward.
        {overview.syncCount < 2
          ? " One sync has run so far, so that column is still empty."
          : ""}
      </p>
    </div>
  );
}
