import { prisma } from "@/lib/db";
import {
  parseTransactionFilters,
  transactionOrderBy,
  transactionWhere,
} from "@/lib/filters";
import { fmtDate, fmtDateTime, fmtNumber } from "@/lib/format";
import { FilterBar, TRI_OPTIONS } from "../components/filter-bar";
import { Pagination, SortHeader } from "../components/pagination";
import { BarList, Card, Empty, Pill, SectionTitle, Stat } from "../components/ui";

export const dynamic = "force-dynamic";

function compactAed(value: unknown) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number === 0) return "—";
  return `AED ${Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(number)}`;
}

function fullAed(value: unknown) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number === 0) return "—";
  return Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(number);
}

function groupTone(group: string | null) {
  if (group === "Sales") return "good" as const;
  if (group === "Mortgage" || group === "Mortgages") return "warn" as const;
  if (group === "Gifts") return "accent" as const;
  return "neutral" as const;
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const rawSearchParams = await searchParams;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(rawSearchParams)) {
    if (typeof value === "string") search.set(key, value);
    else if (Array.isArray(value) && value[0]) search.set(key, value[0]);
  }
  const filters = parseTransactionFilters(search);
  const where = transactionWhere(filters);
  // Value and deal counts must only ever aggregate primary rows: a multi-unit
  // transaction repeats its full value on every unit row. See the schema note.
  const dealWhere = { AND: [where, { isPrimaryUnit: true }] };

  const [
    total,
    deals,
    rows,
    dealAggregate,
    unitAggregate,
    areaFacets,
    typeFacets,
    groupFacets,
    areas,
    propTypes,
    usages,
    roomOptions,
    months,
    latestSync,
    multiUnitDeals,
  ] = await Promise.all([
    prisma.transaction.count({ where }),
    prisma.transaction.count({ where: dealWhere }),
    prisma.transaction.findMany({
      where,
      orderBy: transactionOrderBy(filters),
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.transaction.aggregate({
      where: dealWhere,
      _sum: { transValueAed: true },
      _avg: { transValueAed: true },
    }),
    prisma.transaction.aggregate({ where, _avg: { actualArea: true } }),
    prisma.transaction.groupBy({
      where: dealWhere,
      by: ["areaEn"],
      _count: { areaEn: true },
      _sum: { transValueAed: true },
      orderBy: { _count: { areaEn: "desc" } },
      take: 12,
    }),
    prisma.transaction.groupBy({
      where: dealWhere,
      by: ["propSubTypeEn"],
      _count: { propSubTypeEn: true },
      orderBy: { _count: { propSubTypeEn: "desc" } },
      take: 12,
    }),
    prisma.transaction.groupBy({
      where: dealWhere,
      by: ["groupEn"],
      _count: { groupEn: true },
      _sum: { transValueAed: true },
      orderBy: { _count: { groupEn: "desc" } },
    }),
    prisma.transaction.findMany({
      distinct: ["areaEn"],
      select: { areaEn: true },
      orderBy: { areaEn: "asc" },
    }),
    prisma.transaction.findMany({
      distinct: ["propTypeEn"],
      select: { propTypeEn: true },
      orderBy: { propTypeEn: "asc" },
    }),
    prisma.transaction.findMany({
      distinct: ["usageEn"],
      select: { usageEn: true },
      orderBy: { usageEn: "asc" },
    }),
    prisma.transaction.findMany({
      distinct: ["roomsEn"],
      select: { roomsEn: true },
      orderBy: { roomsEn: "asc" },
    }),
    prisma.transaction.findMany({
      distinct: ["sourceMonth"],
      select: { sourceMonth: true },
      orderBy: { sourceMonth: "desc" },
    }),
    prisma.transactionSyncRun.findFirst({
      where: { status: "SUCCESS" },
      orderBy: { startedAt: "desc" },
    }),
    prisma.transaction.count({ where: { AND: [dealWhere, { unitCount: { gt: 1 } }] } }),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
  const coverage = months.map((m) => m.sourceMonth).filter(Boolean);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Dubai transactions
          </h1>
          <p className="mt-1 max-w-4xl text-xs leading-relaxed text-muted">
            DLD open-data sales, mortgages and gifts. Rows are <strong>units</strong>:
            a multi-unit transaction publishes one row per unit and repeats the
            whole deal&apos;s value on each, so value and deal counts here are
            measured over one row per transaction. This dataset carries{" "}
            <strong>no broker or agency attribution</strong> — deals cannot be
            traced to a brokerage.
          </p>
        </div>
        <div className="text-right text-[11px] text-muted">
          <div>
            Coverage: {coverage.length ? `${coverage.at(-1)} → ${coverage[0]}` : "—"}
          </div>
          <div>Last synced: {fmtDateTime(latestSync?.finishedAt)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat
          label="Deals"
          value={deals}
          sub={`${fmtNumber(total)} unit rows`}
        />
        <Stat
          label="Total value"
          value={compactAed(dealAggregate._sum.transValueAed)}
          sub="one row per deal"
        />
        <Stat
          label="Average deal"
          value={compactAed(dealAggregate._avg.transValueAed)}
          sub="mean consideration"
        />
        <Stat
          label="Average unit"
          value={
            unitAggregate._avg.actualArea
              ? `${Number(unitAggregate._avg.actualArea).toFixed(0)} m²`
              : "—"
          }
          sub="property size"
        />
        <Stat
          label="Multi-unit deals"
          value={multiUnitDeals}
          sub="value repeats per unit"
          tone={multiUnitDeals > 0 ? "warn" : "default"}
        />
      </div>

      <FilterBar
        exportType="transactions"
        presets={[
          { label: "Sales only", params: { groupId: "1", sort: "instanceDate" } },
          { label: "Mortgages", params: { groupId: "2", sort: "instanceDate" } },
          { label: "Gifts", params: { groupId: "3", sort: "instanceDate" } },
          {
            label: "Off-plan sales",
            params: { groupId: "1", isOffplan: "yes", sort: "instanceDate" },
          },
          {
            label: "Ready sales",
            params: { groupId: "1", isOffplan: "no", sort: "instanceDate" },
          },
          {
            label: "AED 10m+",
            params: { minValue: "10000000", sort: "transValueAed" },
          },
          { label: "Biggest first", params: { sort: "transValueAed", dir: "desc" } },
        ]}
        fields={[
          {
            name: "q",
            label: "Search",
            type: "text",
            placeholder: "txn no., project, area, procedure",
            width: "235px",
          },
          {
            name: "groupId",
            label: "Type",
            type: "select",
            width: "130px",
            options: [
              { value: "", label: "All types" },
              { value: "1", label: "Sales" },
              { value: "2", label: "Mortgages" },
              { value: "3", label: "Gifts" },
            ],
          },
          {
            name: "area",
            label: "Area",
            type: "select",
            width: "195px",
            options: [
              { value: "", label: "All areas" },
              ...areas
                .map((row) => row.areaEn)
                .filter((value): value is string => Boolean(value))
                .map((value) => ({ value, label: value })),
            ],
          },
          {
            name: "propType",
            label: "Property type",
            type: "select",
            width: "150px",
            options: [
              { value: "", label: "All" },
              ...propTypes
                .map((row) => row.propTypeEn)
                .filter((value): value is string => Boolean(value))
                .map((value) => ({ value, label: value })),
            ],
          },
          {
            name: "usage",
            label: "Usage",
            type: "select",
            width: "150px",
            options: [
              { value: "", label: "All" },
              ...usages
                .map((row) => row.usageEn)
                .filter((value): value is string => Boolean(value))
                .map((value) => ({ value, label: value })),
            ],
          },
          {
            name: "rooms",
            label: "Rooms",
            type: "select",
            width: "130px",
            options: [
              { value: "", label: "Any" },
              ...roomOptions
                .map((row) => row.roomsEn)
                .filter((value): value is string => Boolean(value))
                .map((value) => ({ value, label: value })),
            ],
          },
          { name: "project", label: "Project", type: "text", width: "175px" },
          { name: "dateFrom", label: "From", type: "date", width: "150px" },
          { name: "dateTo", label: "To", type: "date", width: "150px" },
          {
            name: "minValue",
            label: "Min AED",
            type: "number",
            width: "130px",
          },
          {
            name: "maxValue",
            label: "Max AED",
            type: "number",
            width: "130px",
          },
          {
            name: "isOffplan",
            label: "Off-plan",
            type: "select",
            width: "110px",
            options: TRI_OPTIONS,
          },
          {
            name: "isFreeHold",
            label: "Free hold",
            type: "select",
            width: "110px",
            options: TRI_OPTIONS,
          },
          {
            name: "sourceMonth",
            label: "Source month",
            type: "select",
            width: "130px",
            options: [
              { value: "", label: "All months" },
              ...coverage.map((value) => ({ value, label: value })),
            ],
          },
        ]}
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <Card>
          <SectionTitle hint="deals, by registration area">Top areas</SectionTitle>
          {areaFacets.length ? (
            <BarList
              rows={areaFacets.map((a) => ({
                label: a.areaEn ?? "—",
                value: a._count.areaEn,
                hint: compactAed(a._sum.transValueAed),
              }))}
            />
          ) : (
            <Empty>No data.</Empty>
          )}
        </Card>
        <Card>
          <SectionTitle hint="deals, by property sub type">
            Property mix
          </SectionTitle>
          {typeFacets.length ? (
            <BarList
              color="var(--success)"
              rows={typeFacets.map((t) => ({
                label: t.propSubTypeEn ?? "—",
                value: t._count.propSubTypeEn,
              }))}
            />
          ) : (
            <Empty>No data.</Empty>
          )}
        </Card>
        <Card>
          <SectionTitle hint="deals and value, by transaction type">
            Transaction types
          </SectionTitle>
          {groupFacets.length ? (
            <BarList
              color="var(--warn)"
              rows={groupFacets.map((g) => ({
                label: g.groupEn ?? "—",
                value: g._count.groupEn,
                hint: compactAed(g._sum.transValueAed),
              }))}
            />
          ) : (
            <Empty>No data.</Empty>
          )}
        </Card>
      </div>

      <Card className="!p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1500px] text-[12.5px]">
            <thead className="bg-[color:var(--surface)]">
              <tr className="border-b border-[color:var(--border)] text-left">
                <th className="w-[150px] px-4 py-2.5">
                  <SortHeader label="Transaction" sortKey="transactionNumber" defaultDir="asc" />
                </th>
                <th className="w-[115px] px-2 py-2.5">
                  <SortHeader label="Date" sortKey="instanceDate" />
                </th>
                <th className="w-[190px] px-2 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                  Type / procedure
                </th>
                <th className="w-[175px] px-2 py-2.5">
                  <SortHeader label="Area" sortKey="areaEn" defaultDir="asc" />
                </th>
                <th className="px-2 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                  Property
                </th>
                <th className="w-[150px] px-2 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                  Project
                </th>
                <th className="w-[110px] px-2 py-2.5 text-right">
                  <SortHeader label="Size" sortKey="actualArea" align="right" />
                </th>
                <th className="w-[165px] px-4 py-2.5 text-right">
                  <SortHeader label="Amount" sortKey="transValueAed" align="right" />
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <Empty>
                      No transactions match these filters. If the table is empty
                      everywhere, run <code>npm run transactions:sync</code>.
                    </Empty>
                  </td>
                </tr>
              ) : null}
              {rows.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-[color:var(--border)]/50 align-top hover:bg-[color:var(--surface-2)]/50"
                >
                  <td className="px-4 py-2 font-medium tabular-nums">
                    {t.transactionNumber}
                    {t.unitCount > 1 ? (
                      <div className="mt-1">
                        <Pill
                          tone="warn"
                          title={`This transaction covers ${t.unitCount} units. The amount shown is the whole deal, repeated on each unit row.`}
                        >
                          {t.unitCount} units
                          {t.isPrimaryUnit ? " · counted" : " · repeat"}
                        </Pill>
                      </div>
                    ) : null}
                  </td>
                  <td className="px-2 py-2 tabular-nums text-muted">
                    {fmtDate(t.instanceDate)}
                  </td>
                  <td className="px-2 py-2">
                    <Pill tone={groupTone(t.groupEn)}>{t.groupEn ?? "—"}</Pill>
                    <div
                      className="mt-1 line-clamp-2 text-[11px] text-muted"
                      title={t.procedureEn ?? ""}
                    >
                      {t.procedureEn ?? "—"}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <div className="line-clamp-1" title={t.areaEn ?? ""}>
                      {t.areaEn ?? "—"}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {t.isOffplanEn ? (
                        <Pill tone={t.isOffplan ? "accent" : "neutral"}>
                          {t.isOffplanEn}
                        </Pill>
                      ) : null}
                      {t.isFreeHold ? <Pill tone="good">Free hold</Pill> : null}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <div className="line-clamp-1">
                      {t.propSubTypeEn ?? t.propTypeEn ?? "—"}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted">
                      {[t.usageEn, t.roomsEn].filter(Boolean).join(" · ") || "—"}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <div
                      className="line-clamp-2 text-[11.5px]"
                      title={t.projectEn ?? ""}
                    >
                      {t.projectEn ?? "—"}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted">
                    {t.actualArea ? `${Number(t.actualArea).toFixed(1)} m²` : "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <span
                      className="tabular-nums font-medium"
                      style={{ opacity: t.isPrimaryUnit ? 1 : 0.45 }}
                    >
                      {fullAed(t.transValueAed)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination
          page={filters.page}
          pageCount={pageCount}
          total={total}
          pageSize={filters.pageSize}
        />
      </Card>
    </div>
  );
}
