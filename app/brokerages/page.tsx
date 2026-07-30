import Link from "next/link";
import { prisma } from "@/lib/db";
import { officeOrderBy, officeWhere, parseOfficeFilters } from "@/lib/filters";
import { FilterBar, TRI_OPTIONS } from "../components/filter-bar";
import { Pagination, SortHeader } from "../components/pagination";
import { Card, Empty, Ext, Pill, TierBadge } from "../components/ui";
import { daysUntil, fmtAge, fmtDate, fmtSpan, isoDay } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function BrokeragesPage({
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

  const filters = parseOfficeFilters(usp);
  const where = officeWhere(filters);

  const [total, rows] = await Promise.all([
    prisma.office.count({ where }),
    prisma.office.findMany({
      where,
      orderBy: officeOrderBy(filters),
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Brokerages</h1>
          <p className="mt-1 text-xs text-muted">
            Every RERA-licensed real-estate brokerage in Dubai, with contact
            details and lead scoring.
          </p>
        </div>
      </div>

      <FilterBar
        exportType="offices"
        presets={[
          {
            label: "Opened last 7 days",
            params: { issuedFrom: isoDay(-7), sort: "issueDate" },
          },
          {
            label: "Opened last 30 days",
            params: { issuedFrom: isoDay(-30), sort: "issueDate" },
          },
          {
            label: "New + no website + reachable",
            params: {
              issuedFrom: isoDay(-90),
              hasWebsite: "no",
              hasEmail: "yes",
              sort: "leadScore",
            },
          },
          {
            label: "Shells (0 brokers)",
            params: { maxBrokers: "0", sort: "issueDate" },
          },
          {
            label: "Small firms 1–5",
            params: { minBrokers: "1", maxBrokers: "5", sort: "leadScore" },
          },
          {
            label: "Licence expiring 60d",
            params: { expiringBefore: isoDay(60), sort: "expiryDate", dir: "asc" },
          },
          {
            label: "Hiring now",
            params: { sort: "newBrokers30d" },
          },
        ]}
        fields={[
          {
            name: "q",
            label: "Search",
            type: "text",
            placeholder: "name, RERA no, email",
            width: "210px",
          },
          { name: "issuedFrom", label: "Licensed from", type: "date" },
          { name: "issuedTo", label: "Licensed to", type: "date" },
          {
            name: "minBrokers",
            label: "Min brokers",
            type: "number",
            width: "110px",
          },
          {
            name: "maxBrokers",
            label: "Max brokers",
            type: "number",
            width: "110px",
          },
          {
            name: "tier",
            label: "Tier",
            type: "select",
            width: "95px",
            options: [
              { value: "", label: "Any" },
              ...["A+", "A", "B", "C", "D"].map((t) => ({ value: t, label: t })),
            ],
          },
          {
            name: "rank",
            label: "RERA rank",
            type: "select",
            width: "115px",
            options: [
              { value: "", label: "Any" },
              ...["GENERAL", "BRONZE", "SILVER", "GOLD"].map((r) => ({
                value: r,
                label: r,
              })),
            ],
          },
          {
            name: "hasWebsite",
            label: "Website",
            type: "select",
            width: "95px",
            options: TRI_OPTIONS,
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
            name: "expiringBefore",
            label: "Expiring before",
            type: "date",
          },
        ]}
      />

      <Card className="!p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1240px] text-[12.5px]">
            <thead className="bg-[color:var(--surface)]">
              <tr className="border-b border-[color:var(--border)] text-left">
                <th className="px-4 py-2.5">
                  <SortHeader label="Brokerage" sortKey="nameEn" defaultDir="asc" />
                </th>
                <th className="w-[130px] px-2 py-2.5">
                  <SortHeader label="Licensed" sortKey="issueDate" />
                </th>
                <th className="w-[80px] px-2 py-2.5">
                  <SortHeader label="Brokers" sortKey="brokerCount" align="right" />
                </th>
                <th className="w-[70px] px-2 py-2.5">
                  <SortHeader label="+30d" sortKey="newBrokers30d" align="right" />
                </th>
                <th className="w-[230px] px-2 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                  Contact
                </th>
                <th className="w-[150px] px-2 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                  Mobile / phone
                </th>
                <th className="w-[130px] px-2 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                  Presence
                </th>
                <th className="w-[110px] px-2 py-2.5">
                  <SortHeader label="Expires" sortKey="expiryDate" />
                </th>
                <th className="w-[90px] px-4 py-2.5">
                  <SortHeader label="Score" sortKey="leadScore" align="right" />
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <Empty>No brokerages match these filters.</Empty>
                  </td>
                </tr>
              ) : null}

              {rows.map((o) => {
                const expiryDays = daysUntil(o.expiryDate);

                return (
                  <tr
                    key={o.realEstateNumber}
                    className="border-b border-[color:var(--border)]/50 align-top hover:bg-[color:var(--surface-2)]/50"
                  >
                    <td className="px-4 py-2">
                      <Link
                        href={`/brokerages/${o.realEstateNumber}`}
                        className="line-clamp-1 font-medium hover:text-[color:var(--accent)]"
                        title={o.nameEn ?? ""}
                      >
                        {o.nameEn ?? `#${o.realEstateNumber}`}
                      </Link>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted">
                        <span className="tabular-nums">#{o.realEstateNumber}</span>
                        {o.rank && o.rank !== "GENERAL" ? (
                          <Pill tone="accent">{o.rank}</Pill>
                        ) : null}
                        {!o.isActive ? <Pill tone="bad">delisted</Pill> : null}
                      </div>
                    </td>

                    <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                      {fmtDate(o.issueDate)}
                      <div className="text-[10px] text-muted">
                        {fmtAge(o.issueDate)}
                      </div>
                    </td>

                    <td className="px-2 py-2 text-right tabular-nums">
                      {o.activeBrokerCount === 0 ? (
                        <Pill tone="warn">0</Pill>
                      ) : (
                        <Link
                          href={`/brokers?office=${o.realEstateNumber}`}
                          className="hover:text-[color:var(--accent)]"
                        >
                          {o.activeBrokerCount}
                        </Link>
                      )}
                    </td>

                    <td className="px-2 py-2 text-right tabular-nums">
                      {o.newBrokers30d > 0 ? (
                        <span className="text-[color:var(--success)]">
                          +{o.newBrokers30d}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>

                    <td className="px-2 py-2">
                      {o.contactEmail ? (
                        <a
                          href={`mailto:${o.contactEmail}`}
                          className="line-clamp-1 text-[color:var(--accent)] hover:underline"
                          title={o.contactEmail}
                        >
                          {o.contactEmail}
                        </a>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                      {o.contactNameEn ? (
                        <div
                          className="line-clamp-1 text-[10px] text-muted"
                          title={o.contactNameEn}
                        >
                          {o.contactNameEn}
                        </div>
                      ) : null}
                    </td>

                    <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                      {o.contactMobile ? (
                        <a
                          href={`tel:${o.contactMobile}`}
                          className="hover:text-[color:var(--accent)]"
                        >
                          {o.contactMobile}
                        </a>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                      {o.phone && o.phone !== o.contactMobile ? (
                        <div className="text-[10px] text-muted">{o.phone}</div>
                      ) : null}
                    </td>

                    <td className="px-2 py-2">
                      <div className="flex flex-wrap gap-1">
                        {o.website ? (
                          <Ext href={o.website} label="web" />
                        ) : (
                          <Pill tone="warn" title="No website — digital gap">
                            no web
                          </Pill>
                        )}
                        {o.instagramUrl ? <Ext href={o.instagramUrl} label="ig" /> : null}
                        {o.linkedinUrl ? <Ext href={o.linkedinUrl} label="in" /> : null}
                        {o.whatsapp ? (
                          <a
                            href={`https://wa.me/${o.whatsapp.replace(/\D/g, "")}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[color:var(--success)] hover:underline"
                          >
                            wa
                          </a>
                        ) : null}
                      </div>
                    </td>

                    <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                      {fmtDate(o.expiryDate)}
                      {expiryDays != null && expiryDays >= 0 && expiryDays <= 60 ? (
                        <div>
                          <Pill tone={expiryDays <= 30 ? "bad" : "warn"}>
                            in {fmtSpan(expiryDays)}
                          </Pill>
                        </div>
                      ) : null}
                    </td>

                    <td className="px-4 py-2 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <span className="tabular-nums font-semibold">
                          {o.leadScore}
                        </span>
                        <TierBadge tier={o.leadTier} />
                      </div>
                    </td>
                  </tr>
                );
              })}
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
