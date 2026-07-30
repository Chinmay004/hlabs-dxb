import Link from "next/link";
import { prisma } from "@/lib/db";
import { getRecentChanges, getRecentMoves } from "@/lib/analytics";
import { Card, Empty, Pill, SectionTitle } from "../components/ui";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Human labels for the field names we audit. */
const FIELD_LABEL: Record<string, string> = {
  nameEn: "renamed",
  licenseNumber: "trade licence",
  issueDate: "licence issue date",
  expiryDate: "licence renewed",
  cardIssueDate: "card renewed",
  cardExpiryDate: "card expiry",
  phone: "phone",
  website: "website",
  contactEmail: "contact email",
  contactMobile: "contact mobile",
  contactNameEn: "contact person",
  rank: "RERA rank",
  cardRank: "broker rank",
  whatsapp: "WhatsApp",
  instagramUrl: "Instagram",
  email: "email",
  mobile: "mobile",
  realEstateNumber: "moved brokerage",
};

export default async function ActivityPage() {
  const [moves, changes, newOffices, newBrokers] = await Promise.all([
    getRecentMoves(40),
    getRecentChanges(120),
    prisma.office.findMany({
      orderBy: { firstSeenAt: "desc" },
      take: 25,
      select: {
        realEstateNumber: true,
        nameEn: true,
        issueDate: true,
        firstSeenAt: true,
        activeBrokerCount: true,
        contactEmail: true,
      },
    }),
    prisma.broker.findMany({
      orderBy: { firstSeenAt: "desc" },
      take: 25,
      select: {
        cardNumber: true,
        nameEn: true,
        cardIssueDate: true,
        firstSeenAt: true,
        officeNameEn: true,
        realEstateNumber: true,
        email: true,
      },
    }),
  ]);

  // On the very first sync everything shares one firstSeenAt, which would make
  // "newly discovered" meaningless. Only show it once there is more than one run.
  const runCount = await prisma.syncRun.count({ where: { status: "SUCCESS" } });
  const discoveryMeaningful = runCount > 1;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 text-xs text-muted">
          What changed in the registry since the last sync — new licences, broker
          moves, and field-level edits.
        </p>
      </div>

      {!discoveryMeaningful ? (
        <div className="card border-[color:var(--warn)]/40 bg-[color:var(--warn)]/5 p-3 text-[12.5px] text-muted">
          Only one sync has completed, so everything below was “discovered” at
          once. Change tracking becomes meaningful from the second run onward.
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="!p-0">
          <div className="px-4 pt-4">
            <SectionTitle hint="Brokerages our crawl saw for the first time.">
              Newly discovered brokerages
            </SectionTitle>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-y border-[color:var(--border)] text-left text-[10px] uppercase tracking-wider text-muted">
                  <th className="px-4 py-2 font-medium">Brokerage</th>
                  <th className="px-2 py-2 font-medium">Licensed</th>
                  <th className="px-2 py-2 text-right font-medium">Brokers</th>
                  <th className="px-4 py-2 font-medium">Seen</th>
                </tr>
              </thead>
              <tbody>
                {newOffices.map((o) => (
                  <tr
                    key={o.realEstateNumber}
                    className="border-b border-[color:var(--border)]/50"
                  >
                    <td className="max-w-[240px] px-4 py-2">
                      <Link
                        href={`/brokerages/${o.realEstateNumber}`}
                        className="line-clamp-1 hover:text-[color:var(--accent)]"
                      >
                        {o.nameEn ?? `#${o.realEstateNumber}`}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted">
                      {fmtDate(o.issueDate)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {o.activeBrokerCount}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted">
                      {fmtDate(o.firstSeenAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="!p-0">
          <div className="px-4 pt-4">
            <SectionTitle hint="Broker cards our crawl saw for the first time.">
              Newly discovered brokers
            </SectionTitle>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-y border-[color:var(--border)] text-left text-[10px] uppercase tracking-wider text-muted">
                  <th className="px-4 py-2 font-medium">Broker</th>
                  <th className="px-2 py-2 font-medium">Brokerage</th>
                  <th className="px-2 py-2 font-medium">Card</th>
                  <th className="px-4 py-2 font-medium">Seen</th>
                </tr>
              </thead>
              <tbody>
                {newBrokers.map((b) => (
                  <tr
                    key={b.cardNumber}
                    className="border-b border-[color:var(--border)]/50"
                  >
                    <td className="max-w-[180px] px-4 py-2">
                      <div className="line-clamp-1">{b.nameEn ?? "—"}</div>
                      {b.email ? (
                        <div className="line-clamp-1 text-[10px] text-muted">
                          {b.email}
                        </div>
                      ) : null}
                    </td>
                    <td className="max-w-[180px] px-2 py-2">
                      {b.realEstateNumber ? (
                        <Link
                          href={`/brokerages/${b.realEstateNumber}`}
                          className="line-clamp-1 text-muted hover:text-[color:var(--accent)]"
                        >
                          {b.officeNameEn ?? `#${b.realEstateNumber}`}
                        </Link>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted">
                      {fmtDate(b.cardIssueDate)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted">
                      {fmtDate(b.firstSeenAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card className="!p-0">
        <div className="px-4 pt-4">
          <SectionTitle hint="A broker changing firms means the old firm has a seat to fill and the new one is expanding. Both are openings.">
            Broker moves
          </SectionTitle>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-[12.5px]">
            <thead>
              <tr className="border-y border-[color:var(--border)] text-left text-[10px] uppercase tracking-wider text-muted">
                <th className="px-4 py-2 font-medium">Broker</th>
                <th className="px-2 py-2 font-medium">From</th>
                <th className="px-2 py-2 font-medium">To</th>
                <th className="px-4 py-2 font-medium">Detected</th>
              </tr>
            </thead>
            <tbody>
              {moves.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <Empty>No moves recorded yet.</Empty>
                  </td>
                </tr>
              ) : null}
              {moves.map((m, i) => (
                <tr
                  key={`${m.cardNumber}-${i}`}
                  className="border-b border-[color:var(--border)]/50"
                >
                  <td className="px-4 py-2">{m.brokerName ?? m.cardNumber}</td>
                  <td className="max-w-[240px] px-2 py-2">
                    {m.fromNumber ? (
                      <Link
                        href={`/brokerages/${m.fromNumber}`}
                        className="line-clamp-1 text-muted hover:text-[color:var(--accent)]"
                      >
                        {m.fromOffice ?? `#${m.fromNumber}`}
                      </Link>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="max-w-[240px] px-2 py-2">
                    {m.toNumber ? (
                      <Link
                        href={`/brokerages/${m.toNumber}`}
                        className="line-clamp-1 hover:text-[color:var(--accent)]"
                      >
                        {m.toOffice ?? `#${m.toNumber}`}
                      </Link>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted">
                    {fmtDateTime(m.detectedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <SectionTitle hint="Every field-level edit the registry made, newest first.">
          Registry change feed
        </SectionTitle>
        {changes.length === 0 ? (
          <Empty>No changes recorded yet.</Empty>
        ) : (
          <ul className="space-y-1.5 text-[12.5px]">
            {changes.map((c, i) => (
              <li
                key={`${c.kind}-${c.entityId}-${c.field}-${i}`}
                className="flex flex-wrap items-baseline gap-2"
              >
                <span className="w-[95px] shrink-0 tabular-nums text-muted">
                  {fmtDate(c.detectedAt)}
                </span>
                <Pill tone={c.kind === "office" ? "accent" : "neutral"}>
                  {c.kind}
                </Pill>
                {c.kind === "office" ? (
                  <Link
                    href={`/brokerages/${c.entityId}`}
                    className="max-w-[280px] truncate hover:text-[color:var(--accent)]"
                  >
                    {c.entityName ?? c.entityId}
                  </Link>
                ) : (
                  <span className="max-w-[280px] truncate">
                    {c.entityName ?? c.entityId}
                  </span>
                )}
                <span className="text-muted">
                  {FIELD_LABEL[c.field] ?? c.field}
                </span>
                <span className="truncate text-muted line-through">
                  {c.oldValue?.slice(0, 40) ?? "∅"}
                </span>
                <span className="text-muted">→</span>
                <span className="truncate">{c.newValue?.slice(0, 40) ?? "∅"}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
