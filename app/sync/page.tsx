import { prisma } from "@/lib/db";
import Link from "next/link";
import { Card, Empty, Pill, SectionTitle } from "../components/ui";
import { fmtDateTime } from "@/lib/format";
import { SyncButton } from "./sync-button";

export const dynamic = "force-dynamic";

export default async function SyncPage() {
  const [runs, projectRuns, crmRuns, batchStats] = await Promise.all([
    prisma.syncRun.findMany({ orderBy: { startedAt: "desc" }, take: 40 }),
    prisma.projectSyncRun.findMany({ orderBy: { startedAt: "desc" }, take: 10 }),
    prisma.notionSyncRun.findMany({ orderBy: { startedAt: "desc" }, take: 10 }),
    prisma.batch.groupBy({
      by: ["delayStatus"],
      _count: { delayStatus: true },
      where: { status: { notIn: ["Completed", "Cancelled"] } },
    }),
  ]);

  const latest = runs[0];
  const latestProjects = projectRuns[0];
  const latestCrm = crmRuns[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sync</h1>
          <p className="mt-1 text-xs text-muted">
            Each run takes a complete snapshot of both registry endpoints, then
            reconciles broker rosters for recently licensed firms.
          </p>
        </div>
        <SyncButton />
      </div>

      {latest ? (
        <Card>
          <SectionTitle hint={`Started ${fmtDateTime(latest.startedAt)}.`}>
            Latest run
          </SectionTitle>
          <div className="grid grid-cols-2 gap-4 text-[13px] md:grid-cols-5">
            <Metric label="Status">
              <Pill
                tone={
                  latest.status === "SUCCESS"
                    ? "good"
                    : latest.status === "RUNNING"
                      ? "accent"
                      : "bad"
                }
              >
                {latest.status}
              </Pill>
            </Metric>
            <Metric label="Duration">
              {latest.durationMs
                ? `${(latest.durationMs / 1000).toFixed(0)}s`
                : "—"}
            </Metric>
            <Metric label="Requests">
              {latest.requestCount}
              {latest.errorCount ? (
                <span className="ml-1 text-[color:var(--danger)]">
                  ({latest.errorCount} err)
                </span>
              ) : null}
            </Metric>
            <Metric label="Brokerages">
              {latest.officesSeen.toLocaleString()} seen ·{" "}
              <span className="text-[color:var(--success)]">
                {latest.officesNew} new
              </span>
            </Metric>
            <Metric label="Brokers">
              {latest.brokersSeen.toLocaleString()} seen ·{" "}
              <span className="text-[color:var(--success)]">
                {latest.brokersNew} new
              </span>
            </Metric>
          </div>
          {latest.error ? (
            <pre className="mt-3 overflow-x-auto rounded border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 p-3 text-[11px] text-[color:var(--danger)]">
              {latest.error}
            </pre>
          ) : null}
        </Card>
      ) : null}

      <Card className="!p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-[12.5px]">
            <thead>
              <tr className="border-b border-[color:var(--border)] text-left text-[10px] uppercase tracking-wider text-muted">
                <th className="px-4 py-2.5 font-medium">Started</th>
                <th className="px-2 py-2.5 font-medium">Kind</th>
                <th className="px-2 py-2.5 font-medium">Trigger</th>
                <th className="px-2 py-2.5 font-medium">Status</th>
                <th className="px-2 py-2.5 text-right font-medium">Duration</th>
                <th className="px-2 py-2.5 text-right font-medium">Requests</th>
                <th className="px-2 py-2.5 text-right font-medium">
                  Brokerages (new / chg / gone)
                </th>
                <th className="px-4 py-2.5 text-right font-medium">
                  Brokers (new / chg / gone)
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <Empty>No syncs yet. Run one above.</Empty>
                  </td>
                </tr>
              ) : null}

              {runs.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-[color:var(--border)]/50"
                >
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums">
                    {fmtDateTime(r.startedAt)}
                  </td>
                  <td className="px-2 py-2 text-muted">{r.kind}</td>
                  <td className="px-2 py-2 text-muted">{r.trigger}</td>
                  <td className="px-2 py-2">
                    <Pill
                      tone={
                        r.status === "SUCCESS"
                          ? "good"
                          : r.status === "RUNNING"
                            ? "accent"
                            : "bad"
                      }
                    >
                      {r.status}
                    </Pill>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted">
                    {r.durationMs ? `${(r.durationMs / 1000).toFixed(0)}s` : "—"}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted">
                    {r.requestCount}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {r.officesSeen.toLocaleString()}{" "}
                    <span className="text-muted">
                      ({r.officesNew} / {r.officesUpdated} / {r.officesDeactivated})
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {r.brokersSeen.toLocaleString()}{" "}
                    <span className="text-muted">
                      ({r.brokersNew} / {r.brokersUpdated} / {r.brokersDeactivated})
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <SectionTitle
          hint="Four POST calls—start, end, adoption and completion date—are unioned and deduplicated for the current DLD source year."
          action={
            <Link
              href="/projects"
              className="text-xs text-[color:var(--accent)] hover:underline"
            >
              Open projects →
            </Link>
          }
        >
          Projects open-data sync
        </SectionTitle>
        {latestProjects ? (
          <div className="grid grid-cols-2 gap-4 text-[13px] md:grid-cols-6">
            <Metric label="Last run">
              {fmtDateTime(latestProjects.startedAt)}
            </Metric>
            <Metric label="Status">
              <Pill tone={latestProjects.status === "SUCCESS" ? "good" : "bad"}>
                {latestProjects.status}
              </Pill>
            </Metric>
            <Metric label="Source year">{latestProjects.sourceYear}</Metric>
            <Metric label="Projects">
              {latestProjects.projectsSeen.toLocaleString()}
            </Metric>
            <Metric label="New / changed">
              {latestProjects.projectsNew} / {latestProjects.projectsUpdated}
            </Metric>
            <Metric label="External calls">
              {latestProjects.requestCount}
              {latestProjects.errorCount
                ? ` (${latestProjects.errorCount} retry/error)`
                : ""}
            </Metric>
          </div>
        ) : (
          <p className="text-[13px] text-muted">
            No project sync yet. Run <code>npm run projects:sync</code>.
          </p>
        )}
        {latestProjects?.error ? (
          <pre className="mt-3 overflow-x-auto rounded border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 p-3 text-[11px] text-[color:var(--danger)]">
            {latestProjects.error}
          </pre>
        ) : null}
      </Card>

      <Card>
        <SectionTitle
          hint="Pushes leads and batches to the Homeey DXB CRM in Notion, and reads the team's pipeline updates back."
          action={
            <a
              href="https://app.notion.com/p/3aa72683943881f78f05f8785cb4230d"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[color:var(--accent)] hover:underline"
            >
              Open CRM →
            </a>
          }
        >
          Notion CRM sync
        </SectionTitle>

        {batchStats.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {batchStats.map((s) => (
              <Pill
                key={s.delayStatus}
                tone={
                  s.delayStatus === "Critically Overdue"
                    ? "bad"
                    : s.delayStatus === "Overdue"
                      ? "warn"
                      : s.delayStatus === "Due Today"
                        ? "accent"
                        : "good"
                }
              >
                {s.delayStatus}: {s._count.delayStatus}
              </Pill>
            ))}
          </div>
        ) : null}

        {latestCrm ? (
          <div className="grid grid-cols-2 gap-4 text-[13px] md:grid-cols-5">
            <Metric label="Last run">{fmtDateTime(latestCrm.startedAt)}</Metric>
            <Metric label="Status">
              <Pill tone={latestCrm.status === "SUCCESS" ? "good" : "bad"}>
                {latestCrm.status}
              </Pill>
            </Metric>
            <Metric label="Batches created">{latestCrm.batchesCreated}</Metric>
            <Metric label="Pushed">
              {latestCrm.pushedOffices + latestCrm.pushedBrokers} leads ·{" "}
              {latestCrm.pushedBatches} batches
            </Metric>
            <Metric label="Pulled">
              {latestCrm.pulledOffices + latestCrm.pulledBrokers} leads
            </Metric>
          </div>
        ) : (
          <p className="text-[13px] text-muted">
            No CRM sync has run yet. Set <code>NOTION_TOKEN</code> in{" "}
            <code>.env</code>, then run{" "}
            <code className="rounded bg-[color:var(--surface-2)] px-1.5 py-0.5 text-[color:var(--foreground)]">
              npm run crm
            </code>
            . See <code>docs/NOTION_INTEGRATION.md</code>.
          </p>
        )}

        {latestCrm?.error ? (
          <pre className="mt-3 overflow-x-auto rounded border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 p-3 text-[11px] text-[color:var(--danger)]">
            {latestCrm.error}
          </pre>
        ) : null}
      </Card>

      <Card>
        <SectionTitle>Scheduling</SectionTitle>
        <div className="space-y-2 text-[13px] text-muted">
          <p>
            The scheduled job runs{" "}
            <code className="rounded bg-[color:var(--surface-2)] px-1.5 py-0.5 text-[color:var(--foreground)]">
              npm run sync:scheduled
            </code>{" "}
            daily. Install it with{" "}
            <code className="rounded bg-[color:var(--surface-2)] px-1.5 py-0.5 text-[color:var(--foreground)]">
              npm run schedule:install
            </code>
            .
          </p>
          <p>
            Weekly, run{" "}
            <code className="rounded bg-[color:var(--surface-2)] px-1.5 py-0.5 text-[color:var(--foreground)]">
              npm run sync:deep
            </code>{" "}
            to reconcile broker rosters for every brokerage, not just recently
            licensed ones.
          </p>
          <p>
            Five jobs are installed: project sync 07:00, registry sync 07:15,
            CRM sync 07:45 and 13:30, and deep reconcile Sunday 04:30. The CRM
            sync runs after the registry sync so each morning&apos;s batches are
            built from the brokerages licensed overnight.
          </p>
        </div>
      </Card>
    </div>
  );
}

function Metric({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}
