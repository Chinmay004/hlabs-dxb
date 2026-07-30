import Link from "next/link";
import { prisma } from "@/lib/db";
import { brokerOrderBy, brokerWhere, parseBrokerFilters } from "@/lib/filters";
import { FilterBar, TRI_OPTIONS } from "../components/filter-bar";
import { Pagination, SortHeader } from "../components/pagination";
import { Card, Empty, Pill } from "../components/ui";
import { fmtAge, fmtDate, isoDay } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function BrokersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") usp.set(k, v);
    else if (Array.isArray(v) && v[0]) usp.set(k, v[0]);
  }

  const filters = parseBrokerFilters(usp);
  const where = brokerWhere(filters);

  const [total, rows] = await Promise.all([
    prisma.broker.count({ where }),
    prisma.broker.findMany({
      where,
      orderBy: brokerOrderBy(filters),
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Brokers</h1>
        <p className="mt-1 text-xs text-muted">
          Every RERA broker card, with direct email and mobile. “New” means the
          card number cleared the highest we had seen before — a first licence
          rather than an annual renewal.
        </p>
      </div>

      <FilterBar
        exportType="brokers"
        presets={[
          {
            label: "New brokers 7d",
            params: { foundFrom: isoDay(-7), newOnly: "1", sort: "firstSeenAt" },
          },
          {
            label: "New brokers 30d",
            params: { foundFrom: isoDay(-30), newOnly: "1", sort: "firstSeenAt" },
          },
          {
            label: "New + reachable",
            params: {
              foundFrom: isoDay(-60),
              newOnly: "1",
              hasMobile: "yes",
              sort: "firstSeenAt",
            },
          },
          {
            label: "Cards expiring 30d",
            params: { expiringBefore: isoDay(30), sort: "cardExpiryDate", dir: "asc" },
          },
          {
            label: "All cards issued 7d",
            params: { issuedFrom: isoDay(-7), sort: "cardIssueDate" },
          },
        ]}
        fields={[
          {
            name: "q",
            label: "Search",
            type: "text",
            placeholder: "name, card no, email, firm",
            width: "230px",
          },
          { name: "issuedFrom", label: "Card issued from", type: "date" },
          { name: "issuedTo", label: "Card issued to", type: "date" },
          { name: "foundFrom", label: "Discovered from", type: "date" },
          { name: "foundTo", label: "Discovered to", type: "date" },
          {
            name: "newOnly",
            label: "New only",
            type: "select",
            width: "110px",
            options: [
              { value: "", label: "All cards" },
              { value: "1", label: "First licence" },
            ],
          },
          {
            name: "hasEmail",
            label: "Email",
            type: "select",
            width: "95px",
            options: TRI_OPTIONS,
          },
          {
            name: "hasMobile",
            label: "Mobile",
            type: "select",
            width: "95px",
            options: TRI_OPTIONS,
          },
          {
            name: "office",
            label: "RERA office no",
            type: "text",
            width: "120px",
          },
          { name: "expiringBefore", label: "Expiring before", type: "date" },
        ]}
      />

      <Card className="!p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-[12.5px]">
            <thead className="bg-[color:var(--surface)]">
              <tr className="border-b border-[color:var(--border)] text-left">
                <th className="px-4 py-2.5">
                  <SortHeader label="Broker" sortKey="nameEn" defaultDir="asc" />
                </th>
                <th className="w-[90px] px-2 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                  Card
                </th>
                <th className="w-[125px] px-2 py-2.5">
                  <SortHeader label="Card issued" sortKey="cardIssueDate" />
                </th>
                <th className="w-[135px] px-2 py-2.5">
                  <SortHeader label="Discovered" sortKey="firstSeenAt" />
                </th>
                <th className="px-2 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                  Brokerage
                </th>
                <th className="w-[220px] px-2 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                  Email
                </th>
                <th className="w-[140px] px-2 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                  Mobile
                </th>
                <th className="w-[110px] px-4 py-2.5">
                  <SortHeader label="Expires" sortKey="cardExpiryDate" />
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <Empty>No brokers match these filters.</Empty>
                  </td>
                </tr>
              ) : null}

              {rows.map((b) => (
                <tr
                  key={b.cardNumber}
                  className="border-b border-[color:var(--border)]/50 align-top hover:bg-[color:var(--surface-2)]/50"
                >
                  <td className="px-4 py-2">
                    <div className="line-clamp-1 font-medium" title={b.nameEn ?? ""}>
                      {b.nameEn ?? "—"}
                    </div>
                    <div className="mt-0.5 flex gap-1.5 text-[10px] text-muted">
                      {b.cardRank && b.cardRank !== "GENERAL" ? (
                        <Pill tone="accent">{b.cardRank}</Pill>
                      ) : null}
                      {!b.isActive ? <Pill tone="bad">delisted</Pill> : null}
                    </div>
                  </td>

                  <td className="px-2 py-2 tabular-nums text-muted">
                    {b.cardNumber}
                  </td>

                  <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                    {fmtDate(b.cardIssueDate)}
                    <div className="text-[10px] text-muted">
                      {fmtAge(b.cardIssueDate)}
                    </div>
                  </td>

                  <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted">
                    {fmtDate(b.firstSeenAt)}
                    {b.isNewCard ? (
                      <div>
                        <Pill tone="good">new licence</Pill>
                      </div>
                    ) : null}
                  </td>

                  <td className="max-w-[240px] px-2 py-2">
                    {b.realEstateNumber ? (
                      <Link
                        href={`/brokerages/${b.realEstateNumber}`}
                        className="line-clamp-1 hover:text-[color:var(--accent)]"
                        title={b.officeNameEn ?? ""}
                      >
                        {b.officeNameEn ?? `#${b.realEstateNumber}`}
                      </Link>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                    <div className="text-[10px] text-muted">
                      firm licensed {fmtDate(b.officeIssueDate)}
                    </div>
                  </td>

                  <td className="px-2 py-2">
                    {b.email ? (
                      <a
                        href={`mailto:${b.email}`}
                        className="line-clamp-1 text-[color:var(--accent)] hover:underline"
                        title={b.email}
                      >
                        {b.email}
                      </a>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>

                  <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                    {b.mobile ? (
                      <a
                        href={`tel:${b.mobile}`}
                        className="hover:text-[color:var(--accent)]"
                      >
                        {b.mobile}
                      </a>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>

                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted">
                    {fmtDate(b.cardExpiryDate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t border-[color:var(--border)]">
          <Pagination
            page={filters.page}
            pageCount={pageCount}
            total={total}
            pageSize={filters.pageSize}
          />
        </div>
      </Card>
    </div>
  );
}
