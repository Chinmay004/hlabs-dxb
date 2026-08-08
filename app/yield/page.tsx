import {
  getYieldAtlas,
  parseYieldFilters,
  summarise,
  YIELDABLE_SUBTYPES,
  type YieldRow,
} from "@/lib/analytics/yield";
import { prisma } from "@/lib/db";
import { FilterBar } from "../components/filter-bar";
import { Card, Empty, Pill, SectionTitle, Stat } from "../components/ui";

export const dynamic = "force-dynamic";

function aed(value: number, digits = 0) {
  if (!Number.isFinite(value) || value === 0) return "—";
  return Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

function compactAed(value: number) {
  if (!Number.isFinite(value) || value === 0) return "—";
  return `AED ${Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)}`;
}

const CONFIDENCE_TONE = {
  high: "good",
  medium: "warn",
  low: "bad",
} as const;

/** Colour the yield itself so the table scans without reading numbers. */
function yieldColor(pct: number) {
  if (pct >= 7) return "var(--success)";
  if (pct >= 5) return "var(--foreground)";
  if (pct >= 4) return "var(--warn)";
  return "var(--danger)";
}

function YieldBar({ row, max }: { row: YieldRow; max: number }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-sm bg-[color:var(--surface-2)]">
        <div
          className="h-full rounded-sm"
          style={{
            width: `${Math.min(100, (row.grossYieldPct / max) * 100)}%`,
            background: yieldColor(row.grossYieldPct),
          }}
        />
      </div>
      <span
        className="w-14 text-right text-[13px] font-semibold tabular-nums"
        style={{ color: yieldColor(row.grossYieldPct) }}
      >
        {row.grossYieldPct.toFixed(2)}%
      </span>
    </div>
  );
}

export default async function YieldPage({
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

  const filters = parseYieldFilters(search);
  const [rows, txMonths, rentMonths] = await Promise.all([
    getYieldAtlas(filters),
    prisma.transaction.findMany({
      distinct: ["sourceMonth"],
      select: { sourceMonth: true },
      orderBy: { sourceMonth: "asc" },
    }),
    prisma.rent.findMany({
      distinct: ["sourceMonth"],
      select: { sourceMonth: true },
      orderBy: { sourceMonth: "asc" },
    }),
  ]);

  const summary = summarise(rows);
  const maxYield = Math.max(6, ...rows.map((r) => r.grossYieldPct));
  const salesWindow = txMonths.length
    ? `${txMonths[0].sourceMonth} → ${txMonths.at(-1)!.sourceMonth}`
    : "—";
  const rentWindow = rentMonths.length
    ? `${rentMonths[0].sourceMonth} → ${rentMonths.at(-1)!.sourceMonth}`
    : "—";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Rental yield atlas</h1>
          <p className="mt-1 max-w-4xl text-xs leading-relaxed text-muted">
            Gross yield = <strong>median annual rent per m² ÷ median sale price
            per m²</strong>, by area. Measured per square metre because bedroom
            count cannot join the two datasets — rent contracts omit it on 95.6%
            of rows, while floor area is present on 100% of both. Ready sales
            only: off-plan is 71% of the sale market and cannot be let.
          </p>
        </div>
        <div className="text-right text-[11px] text-muted">
          <div>Sales window: {salesWindow}</div>
          <div>Rent window: {rentWindow}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat
          label={`Median yield · ${filters.subtype}`}
          value={summary.medianYieldPct ? `${summary.medianYieldPct.toFixed(2)}%` : "—"}
          sub={`across ${summary.usableAreas} usable areas`}
          tone="hot"
        />
        <Stat
          label="Best area"
          value={summary.best ? `${summary.best.grossYieldPct.toFixed(2)}%` : "—"}
          sub={summary.best?.area.toLowerCase() ?? "—"}
          tone="good"
        />
        <Stat
          label="Lowest area"
          value={summary.worst ? `${summary.worst.grossYieldPct.toFixed(2)}%` : "—"}
          sub={summary.worst?.area.toLowerCase() ?? "—"}
        />
        <Stat label="Ready sales" value={summary.totalSales} sub="in reported areas" />
        <Stat label="Lease contracts" value={summary.totalLeases} sub="in reported areas" />
      </div>

      <FilterBar
        presets={[
          { label: "Flats", params: { subtype: "Flat" } },
          { label: "Villas", params: { subtype: "Villa" } },
          { label: "Achievable rent (new lets)", params: { subtype: "Flat", version: "new" } },
          { label: "Deep samples only", params: { minSales: "100", minLeases: "100" } },
        ]}
        fields={[
          {
            name: "subtype",
            label: "Property type",
            type: "select",
            width: "150px",
            options: YIELDABLE_SUBTYPES.map((s) => ({ value: s, label: s })),
          },
          {
            name: "version",
            label: "Lease type",
            type: "select",
            width: "175px",
            options: [
              { value: "", label: "All contracts" },
              { value: "new", label: "New lets only" },
              { value: "renewed", label: "Renewals only" },
            ],
          },
          { name: "area", label: "Area", type: "text", width: "200px" },
          { name: "minSales", label: "Min sales", type: "number", width: "120px" },
          { name: "minLeases", label: "Min leases", type: "number", width: "125px" },
        ]}
      />

      <Card className="!p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1150px] text-[12.5px]">
            <thead className="bg-[color:var(--surface)]">
              <tr className="border-b border-[color:var(--border)] text-left text-[10px] font-medium uppercase tracking-wider text-muted">
                <th className="px-4 py-2.5">Area</th>
                <th className="w-[90px] px-2 py-2.5 text-right">Sales</th>
                <th className="w-[90px] px-2 py-2.5 text-right">Leases</th>
                <th className="w-[125px] px-2 py-2.5 text-right">Buy AED/m²</th>
                <th className="w-[125px] px-2 py-2.5 text-right">Rent AED/m²</th>
                <th className="w-[135px] px-2 py-2.5 text-right">Median price</th>
                <th className="w-[125px] px-2 py-2.5 text-right">Median rent</th>
                <th className="w-[105px] px-2 py-2.5 text-right">Size skew</th>
                <th className="w-[175px] px-4 py-2.5 text-right">Gross yield</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <Empty>
                      No area has enough {filters.subtype.toLowerCase()} sales and
                      leases at these thresholds. Lower the minimums, or sync more
                      months.
                    </Empty>
                  </td>
                </tr>
              ) : null}
              {rows.map((r) => (
                <tr
                  key={r.area}
                  className="border-b border-[color:var(--border)]/50 hover:bg-[color:var(--surface-2)]/50"
                  style={{ opacity: r.confidence === "low" ? 0.55 : 1 }}
                >
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium capitalize">
                        {r.area.toLowerCase()}
                      </span>
                      <Pill
                        tone={CONFIDENCE_TONE[r.confidence]}
                        title={
                          r.confidence === "low"
                            ? "Thin sample or the stock being let differs from the stock being sold. Treat as indicative only."
                            : r.confidence === "medium"
                              ? "Reasonable sample, some divergence between let and sold stock."
                              : "Deep sample on both sides, comparable unit sizes."
                        }
                      >
                        {r.confidence}
                      </Pill>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted">{aed(r.sales)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted">{aed(r.leases)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{aed(r.medianPricePerSqm)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{aed(r.medianRentPerSqm)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted">
                    {compactAed(r.medianPriceAed)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted">
                    {compactAed(r.medianRentAed)}
                  </td>
                  <td
                    className="px-2 py-2 text-right tabular-nums"
                    title={`Median let unit is ${r.medianLeaseAreaSqm.toFixed(0)} m², median sold unit is ${r.medianSaleAreaSqm.toFixed(0)} m². Far from 1.00 means they are not the same kind of stock.`}
                    style={{
                      color:
                        r.sizeSkew > 1.6 || r.sizeSkew < 0.625
                          ? "var(--danger)"
                          : "var(--muted)",
                    }}
                  >
                    {r.sizeSkew ? r.sizeSkew.toFixed(2) : "—"}
                  </td>
                  <td className="px-4 py-2">
                    <YieldBar row={r} max={maxYield} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <SectionTitle hint="what this number does and does not say">
          Methodology
        </SectionTitle>
        <div className="grid gap-4 text-[12px] leading-relaxed text-muted md:grid-cols-2">
          <div>
            <div className="mb-1 font-medium text-[color:var(--foreground)]">Excluded</div>
            <ul className="list-disc space-y-1 pl-4">
              <li><strong>Off-plan sales</strong> — 71% of the sale market, and not lettable</li>
              <li><strong>Mortgages and gifts</strong> — a loan is not a price</li>
              <li>Repeat unit rows of multi-unit transactions</li>
              <li>Top and bottom 5% of per-m² values in each area, which removes
                  the AED 1 transfers and prepaid long leases DLD publishes</li>
            </ul>
          </div>
          <div>
            <div className="mb-1 font-medium text-[color:var(--foreground)]">Read with care</div>
            <ul className="list-disc space-y-1 pl-4">
              <li>Matched at <strong>area × property type</strong>, never unit level — a rent
                  row carries no property or parcel id, so a specific unit&apos;s rent
                  can never be tied to its own sale</li>
              <li><strong>Size skew</strong> is the real risk. Business Bay offices score
                  0.09 — whole floors are sold while small suites are let — so its
                  6.8% is meaningless and marked low</li>
              <li>Gross, not net: no service charge, vacancy or agency fee</li>
              <li>New lets run only ~0.10pp above renewals here, so the rent-cap
                  effect is far smaller than headline medians suggest</li>
            </ul>
          </div>
        </div>
      </Card>
    </div>
  );
}
