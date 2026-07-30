import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { Card, Ext, Pill, SectionTitle, TierBadge } from "@/app/components/ui";
import { daysUntil, fmtAge, fmtDate, fmtDateTime, fmtSpan } from "@/lib/format";
import { CrmPanel } from "./crm-panel";

export const dynamic = "force-dynamic";

export default async function BrokerageDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const office = await prisma.office.findUnique({
    where: { realEstateNumber: id },
  });
  if (!office) notFound();

  const [brokers, changes] = await Promise.all([
    prisma.broker.findMany({
      where: { realEstateNumber: id },
      orderBy: [{ isActive: "desc" }, { cardIssueDate: "desc" }],
      take: 500,
    }),
    prisma.officeChange.findMany({
      where: { realEstateNumber: id },
      orderBy: { detectedAt: "desc" },
      take: 30,
    }),
  ]);

  const activities = Array.isArray(office.activities)
    ? (office.activities as Array<{ nameEn?: string }>)
    : [];

  const expiryDays = daysUntil(office.expiryDate);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {office.nameEn ?? `#${office.realEstateNumber}`}
            </h1>
            <TierBadge tier={office.leadTier} />
            {!office.isActive ? <Pill tone="bad">delisted</Pill> : null}
          </div>
          <p className="mt-1 text-xs text-muted" dir="auto">
            {office.nameAr ?? ""}
          </p>
          <p className="mt-1 text-xs text-muted">
            RERA #{office.realEstateNumber}
            {office.licenseNumber ? ` · trade licence ${office.licenseNumber}` : ""}
            {office.rank ? ` · ${office.rank}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link
            href={`/brokers?office=${office.realEstateNumber}`}
            className="card px-3 py-1.5 text-xs hover:border-[color:var(--accent)]"
          >
            View {office.activeBrokerCount} brokers →
          </Link>
          <a
            href={`/api/export?type=brokers&office=${office.realEstateNumber}`}
            className="card px-3 py-1.5 text-xs hover:border-[color:var(--accent)]"
          >
            ↓ Export roster
          </a>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <SectionTitle>Licence</SectionTitle>
          <dl className="space-y-2 text-[13px]">
            <Row label="Issued">
              {fmtDate(office.issueDate)}{" "}
              <span className="text-muted">({fmtAge(office.issueDate)})</span>
            </Row>
            <Row label="Expires">
              {fmtDate(office.expiryDate)}{" "}
              {expiryDays != null && expiryDays >= 0 ? (
                <Pill tone={expiryDays <= 30 ? "bad" : expiryDays <= 90 ? "warn" : "neutral"}>
                  in {fmtSpan(expiryDays)}
                </Pill>
              ) : expiryDays != null ? (
                <Pill tone="bad">expired</Pill>
              ) : null}
            </Row>
            <Row label="RERA rank">{office.rank ?? "—"}</Row>
            <Row label="Awards">{office.awardsCount}</Row>
            <Row label="Activities">
              {activities.length ? (
                <span className="flex flex-wrap gap-1">
                  {activities.map((a, i) => (
                    <Pill key={i}>{a.nameEn}</Pill>
                  ))}
                </span>
              ) : (
                "—"
              )}
            </Row>
          </dl>
        </Card>

        <Card>
          <SectionTitle>Contact</SectionTitle>
          <dl className="space-y-2 text-[13px]">
            <Row label="Person">{office.contactNameEn ?? "—"}</Row>
            <Row label="Email">
              {office.contactEmail ? (
                <a
                  href={`mailto:${office.contactEmail}`}
                  className="break-all text-[color:var(--accent)] hover:underline"
                >
                  {office.contactEmail}
                </a>
              ) : (
                "—"
              )}
            </Row>
            <Row label="Mobile">{office.contactMobile ?? "—"}</Row>
            <Row label="Office phone">{office.phone ?? "—"}</Row>
            <Row label="WhatsApp">
              {office.whatsapp ? (
                <a
                  href={`https://wa.me/${office.whatsapp.replace(/\D/g, "")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[color:var(--success)] hover:underline"
                >
                  {office.whatsapp}
                </a>
              ) : (
                "—"
              )}
            </Row>
            <Row label="Website">
              <Ext href={office.website} />
            </Row>
            <Row label="Social">
              <span className="flex flex-wrap gap-2">
                {office.instagramUrl ? <Ext href={office.instagramUrl} label="Instagram" /> : null}
                {office.linkedinUrl ? <Ext href={office.linkedinUrl} label="LinkedIn" /> : null}
                {office.facebookUrl ? <Ext href={office.facebookUrl} label="Facebook" /> : null}
                {office.twitterUrl ? <Ext href={office.twitterUrl} label="X" /> : null}
                {office.youtubeUrl ? <Ext href={office.youtubeUrl} label="YouTube" /> : null}
                {!office.instagramUrl &&
                !office.linkedinUrl &&
                !office.facebookUrl &&
                !office.twitterUrl &&
                !office.youtubeUrl ? (
                  <span className="text-muted">none</span>
                ) : null}
              </span>
            </Row>
          </dl>
        </Card>

        <Card>
          <SectionTitle hint="Why this firm scores where it does.">
            Lead signal
          </SectionTitle>
          <div className="mb-3 flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums">
              {office.leadScore}
            </span>
            <span className="text-muted">/ 100</span>
            <TierBadge tier={office.leadTier} />
          </div>
          <dl className="space-y-2 text-[13px]">
            <Row label="Brokers">
              {office.activeBrokerCount}
              {office.brokerCount !== office.activeBrokerCount
                ? ` (${office.brokerCount} incl. lapsed)`
                : ""}
            </Row>
            <Row label="Added last 30d">{office.newBrokers30d}</Row>
            <Row label="Added last 90d">{office.newBrokers90d}</Row>
            <Row label="First broker">{fmtDate(office.firstCardIssuedAt)}</Row>
            <Row label="Latest broker">{fmtDate(office.lastCardIssuedAt)}</Row>
            <Row label="Digital gaps">
              <span className="flex flex-wrap gap-1">
                {!office.website ? <Pill tone="warn">no website</Pill> : null}
                {!office.instagramUrl ? <Pill tone="warn">no Instagram</Pill> : null}
                {!office.whatsapp ? <Pill tone="warn">no WhatsApp</Pill> : null}
                {office.website && office.instagramUrl && office.whatsapp ? (
                  <span className="text-muted">none</span>
                ) : null}
              </span>
            </Row>
            <Row label="First seen by us">{fmtDateTime(office.firstSeenAt)}</Row>
          </dl>

          <div className="mt-4 border-t border-[color:var(--border)] pt-3">
            <CrmPanel
              realEstateNumber={office.realEstateNumber}
              status={office.status}
              ownerNote={office.ownerNote}
            />
          </div>
        </Card>
      </div>

      <Card className="!p-0">
        <div className="px-4 pt-4">
          <SectionTitle hint={`${brokers.length} cards on file.`}>
            Broker roster
          </SectionTitle>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-[12.5px]">
            <thead>
              <tr className="border-y border-[color:var(--border)] text-left text-[10px] uppercase tracking-wider text-muted">
                <th className="px-4 py-2 font-medium">Broker</th>
                <th className="px-2 py-2 font-medium">Card</th>
                <th className="px-2 py-2 font-medium">Discovered</th>
                <th className="px-2 py-2 font-medium">Current term</th>
                <th className="px-2 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Mobile</th>
              </tr>
            </thead>
            <tbody>
              {brokers.map((b) => (
                <tr
                  key={b.cardNumber}
                  className="border-b border-[color:var(--border)]/50"
                  style={{ opacity: b.isActive ? 1 : 0.5 }}
                >
                  <td className="px-4 py-2">{b.nameEn ?? "—"}</td>
                  <td className="px-2 py-2 tabular-nums text-muted">
                    {b.cardNumber}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                    {fmtDate(b.firstSeenAt)}
                    {b.isNewCard ? (
                      <div>
                        <Pill tone="good">new licence</Pill>
                      </div>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted">
                    {fmtDate(b.cardIssueDate)} → {fmtDate(b.cardExpiryDate)}
                  </td>
                  <td className="max-w-[240px] truncate px-2 py-2">
                    {b.email ? (
                      <a
                        href={`mailto:${b.email}`}
                        className="text-[color:var(--accent)] hover:underline"
                      >
                        {b.email}
                      </a>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums">
                    {b.mobile ?? <span className="text-muted">—</span>}
                  </td>
                </tr>
              ))}
              {brokers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted">
                    No brokers registered against this firm — a shell licence, or
                    the owner has not issued cards yet. Either way, a strong
                    signal they are still setting up.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      {changes.length ? (
        <Card>
          <SectionTitle hint="Field-level edits the registry has made since we started watching.">
            Registry changes
          </SectionTitle>
          <ul className="space-y-1.5 text-[12.5px]">
            {changes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-2">
                <span className="tabular-nums text-muted">
                  {fmtDate(c.detectedAt)}
                </span>
                <Pill tone="accent">{c.field}</Pill>
                <span className="text-muted line-through">{c.oldValue ?? "∅"}</span>
                <span>→</span>
                <span>{c.newValue ?? "∅"}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <dt className="w-[110px] shrink-0 text-[11px] uppercase tracking-wider text-muted">
        {label}
      </dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
