import Link from "next/link";
import { prisma } from "@/lib/db";
import { getTimeseries, type Granularity } from "@/lib/analytics";
import { BarChart } from "../components/charts";
import { Card, Empty, SectionTitle } from "../components/ui";
import { FilterBar } from "../components/filter-bar";
import { isoDay } from "@/lib/format";

export const dynamic = "force-dynamic";

const GRANULARITIES: Granularity[] = ["day", "week", "month"];

export default async function DailyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const granularity = (GRANULARITIES.includes(one("granularity") as Granularity)
    ? one("granularity")
    : "day") as Granularity;

  const from = new Date(one("from") ?? isoDay(-90));
  const to = new Date(one("to") ?? isoDay(0));

  const [series, syncCount] = await Promise.all([
    getTimeseries({ from, to, granularity }),
    prisma.syncRun.count({ where: { status: "SUCCESS" } }),
  ]);

  // Newest first reads better as a log; the chart keeps chronological order.
  const rows = [...series].reverse();

  const totals = series.reduce(
    (acc, r) => ({
      officesIssued: acc.officesIssued + r.officesIssued,
      brokersNew: acc.brokersNew + r.brokersNew,
      brokerCardsIssued: acc.brokerCardsIssued + r.brokerCardsIssued,
      officesIssuedNoBrokers:
        acc.officesIssuedNoBrokers + r.officesIssuedNoBrokers,
      officesDiscovered: acc.officesDiscovered + r.officesDiscovered,
      brokersDiscovered: acc.brokersDiscovered + r.brokersDiscovered,
    }),
    {
      officesIssued: 0,
      brokersNew: 0,
      brokerCardsIssued: 0,
      officesIssuedNoBrokers: 0,
      officesDiscovered: 0,
      brokersDiscovered: 0,
    },
  );

  const nonZero = series.filter((r) => r.officesIssued > 0).length;
  const avgPerActiveDay = nonZero ? totals.officesIssued / nonZero : 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Date-wise registrations
        </h1>
        <p className="mt-1 text-xs text-muted">
          How many brokerages and brokers were licensed on each date. Click a row
          to open that day&apos;s list.
        </p>
      </div>

      <FilterBar
        fields={[
          { name: "from", label: "From", type: "date", width: "150px" },
          { name: "to", label: "To", type: "date", width: "150px" },
          {
            name: "granularity",
            label: "Bucket",
            type: "select",
            width: "120px",
            options: [
              { value: "day", label: "Day" },
              { value: "week", label: "Week" },
              { value: "month", label: "Month" },
            ],
          },
        ]}
        presets={[
          { label: "Last 30 days", params: { from: isoDay(-30), to: isoDay(0) } },
          { label: "Last 90 days", params: { from: isoDay(-90), to: isoDay(0) } },
          {
            label: "Last 12 months",
            params: { from: isoDay(-365), to: isoDay(0), granularity: "month" },
          },
          {
            label: "All time (monthly)",
            params: { from: "2007-01-01", to: isoDay(0), granularity: "month" },
          },
        ]}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <SummaryTile
          label="Brokerages licensed"
          value={totals.officesIssued}
          sub={`${avgPerActiveDay.toFixed(1)} per active ${granularity}`}
        />
        <SummaryTile
          label="New brokers"
          value={totals.brokersNew}
          sub={syncCount < 2 ? "needs a 2nd sync" : undefined}
        />
        <SummaryTile
          label="Cards issued (incl. renewals)"
          value={totals.brokerCardsIssued}
        />
        <SummaryTile
          label="New firms with 0 brokers"
          value={totals.officesIssuedNoBrokers}
        />
        <SummaryTile
          label="Discovered by our sync"
          value={totals.officesDiscovered}
          sub={`${totals.brokersDiscovered.toLocaleString()} brokers`}
        />
      </div>

      <Card>
        <SectionTitle hint={`Bucketed by ${granularity}.`}>
          Registrations over time
        </SectionTitle>
        <BarChart
          rows={series}
          series={[
            { key: "officesIssued", label: "Brokerages", color: "#4f8cff" },
            {
              key: "brokerCardsIssued",
              label: "Broker cards (incl. renewals)",
              color: "#3a4356",
            },
            { key: "brokersNew", label: "New brokers", color: "#35c98a" },
          ]}
          stacked={false}
          height={250}
        />
      </Card>

      <Card className="!p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-[12.5px]">
            <thead className="sticky top-12 bg-[color:var(--surface)]">
              <tr className="border-b border-[color:var(--border)] text-left text-[10px] uppercase tracking-wider text-muted">
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-3 py-2.5 text-right font-medium">
                  Brokerages licensed
                </th>
                <th className="px-3 py-2.5 text-right font-medium">
                  …of which empty
                </th>
                <th className="px-3 py-2.5 text-right font-medium">
                  Cards issued
                </th>
                <th className="px-3 py-2.5 text-right font-medium">
                  New brokers
                </th>
                <th className="px-3 py-2.5 text-right font-medium">
                  Cards expiring
                </th>
                <th className="px-4 py-2.5 text-right font-medium">
                  Sync discovered
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <Empty>No days in this range.</Empty>
                  </td>
                </tr>
              ) : null}

              {rows.map((r) => {
                const dayEnd =
                  granularity === "day"
                    ? r.bucket
                    : granularity === "week"
                      ? isoDayAfter(r.bucket, 6)
                      : monthEnd(r.bucket);

                const quiet =
                  r.officesIssued === 0 && r.brokerCardsIssued === 0;

                return (
                  <tr
                    key={r.bucket}
                    className="border-b border-[color:var(--border)]/50 hover:bg-[color:var(--surface-2)]/60"
                    style={{ opacity: quiet ? 0.45 : 1 }}
                  >
                    <td className="whitespace-nowrap px-4 py-2 font-medium tabular-nums">
                      {r.bucket}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.officesIssued > 0 ? (
                        <Link
                          href={`/brokerages?issuedFrom=${r.bucket}&issuedTo=${dayEnd}&sort=issueDate`}
                          className="font-semibold text-[color:var(--accent)] hover:underline"
                        >
                          {r.officesIssued}
                        </Link>
                      ) : (
                        <span className="text-muted">0</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">
                      {r.officesIssuedNoBrokers || "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">
                      {r.brokerCardsIssued > 0 ? (
                        <Link
                          href={`/brokers?issuedFrom=${r.bucket}&issuedTo=${dayEnd}&sort=cardIssueDate`}
                          className="hover:underline"
                        >
                          {r.brokerCardsIssued}
                        </Link>
                      ) : (
                        "0"
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.brokersNew > 0 ? (
                        <Link
                          href={`/brokers?issuedFrom=${r.bucket}&issuedTo=${dayEnd}&newOnly=1&sort=cardIssueDate`}
                          className="font-semibold text-[color:var(--success)] hover:underline"
                        >
                          {r.brokersNew}
                        </Link>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">
                      {r.brokerCardsExpiring || "—"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted">
                      {r.officesDiscovered || r.brokersDiscovered
                        ? `${r.officesDiscovered} / ${r.brokersDiscovered}`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="space-y-2 pb-4 text-[11px] leading-relaxed text-muted">
        <p>
          <strong className="text-[color:var(--foreground)]">
            Brokerages licensed
          </strong>{" "}
          is exact for the full history — a brokerage&apos;s issue date is its
          original licence date and never moves.
        </p>
        <p>
          <strong className="text-[color:var(--foreground)]">Cards issued</strong>{" "}
          counts every broker card the registry stamped that day, renewals
          included — on a typical day most of them are renewals.{" "}
          <strong className="text-[color:var(--foreground)]">New brokers</strong>{" "}
          counts only cards whose number cleared the highest we had ever seen,
          which is the one reliable new-vs-renewal test: the registry publishes
          only a card&apos;s current term, and card numbers are not chronological
          enough to reconstruct original dates from.
          {syncCount < 2 ? (
            <>
              {" "}
              <span className="text-[color:var(--warn)]">
                Only one sync has run, so there is no watermark yet and this
                column reads zero everywhere. It starts filling in after the next
                sync.
              </span>
            </>
          ) : null}
        </p>
        <p>
          <strong className="text-[color:var(--foreground)]">
            Sync discovered
          </strong>{" "}
          is brokerages / brokers our own crawl saw for the first time that day.
          The registry publishes with a lag, so this trails the licence date by a
          day or two.
        </p>
      </div>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: number;
  sub?: string;
}) {
  return (
    <div className="card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">
        {value.toLocaleString()}
      </div>
      {sub ? <div className="mt-0.5 text-[10px] text-muted">{sub}</div> : null}
    </div>
  );
}

function isoDayAfter(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function monthEnd(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
}
