import Link from "next/link";
import { prisma } from "@/lib/db";
import {
  parseProjectFilters,
  projectOrderBy,
  projectWhere,
} from "@/lib/filters";
import { fmtDate, fmtDateTime, fmtNumber } from "@/lib/format";
import { FilterBar, TRI_OPTIONS } from "../components/filter-bar";
import { Pagination, SortHeader } from "../components/pagination";
import { Card, Empty, Pill, Stat } from "../components/ui";

export const dynamic = "force-dynamic";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function statusTone(status: string | null) {
  if (status === "ACTIVE" || status === "FINISHED") return "good" as const;
  if (status === "CANCELLED") return "bad" as const;
  if (status?.includes("PENDING") || status?.includes("REVIEW")) {
    return "warn" as const;
  }
  return "neutral" as const;
}

function compactAed(value: unknown) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return "—";
  return `AED ${Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(number)}`;
}

export default async function ProjectsPage({
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
  const filters = parseProjectFilters(search);
  const where = projectWhere(filters);

  const [
    total,
    rows,
    aggregate,
    activeCount,
    statuses,
    areas,
    zones,
    projectTypes,
    projectDates,
    sourceYears,
    latestSync,
  ] = await Promise.all([
    prisma.project.count({ where }),
    prisma.project.findMany({
      where,
      orderBy: projectOrderBy(filters),
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.project.aggregate({
      where,
      _sum: { projectValueAed: true, totalUnits: true },
      _avg: { percentCompleted: true },
    }),
    prisma.project.count({ where: { AND: [where, { status: "ACTIVE" }] } }),
    prisma.project.findMany({
      distinct: ["status"],
      select: { status: true },
      orderBy: { status: "asc" },
    }),
    prisma.project.findMany({
      distinct: ["areaEn"],
      select: { areaEn: true },
      orderBy: { areaEn: "asc" },
    }),
    prisma.project.findMany({
      distinct: ["zoneEn"],
      select: { zoneEn: true },
      orderBy: { zoneEn: "asc" },
    }),
    prisma.project.findMany({
      distinct: ["projectTypeEn"],
      select: { projectTypeEn: true },
      orderBy: { projectTypeEn: "asc" },
    }),
    prisma.project.findMany({
      select: {
        adoptionDate: true,
        startDate: true,
        endDate: true,
        completionDate: true,
        inspectionDate: true,
      },
    }),
    prisma.project.findMany({
      distinct: ["sourceYear"],
      select: { sourceYear: true },
      orderBy: { sourceYear: "desc" },
    }),
    prisma.projectSyncRun.findFirst({
      where: { status: "SUCCESS" },
      orderBy: { startedAt: "desc" },
    }),
  ]);

  const availableYears = [
    ...new Set(
      projectDates
        .flatMap((row) => [
          row.adoptionDate,
          row.startDate,
          row.endDate,
          row.completionDate,
          row.inspectionDate,
        ])
        .map((date) => date?.getUTCFullYear())
        .filter((year): year is number => year != null),
    ),
  ].sort((a, b) => b - a);
  const currentSourceYear =
    latestSync?.sourceYear ?? sourceYears[0]?.sourceYear ?? new Date().getUTCFullYear();
  const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dubai projects</h1>
          <p className="mt-1 max-w-4xl text-xs leading-relaxed text-muted">
            DLD project registrations, developers, schedules, values, escrow
            accounts, construction progress, inventory and locations. “Published”
            below means DLD&apos;s adoption/registration date—the source does not
            provide a separate web publication timestamp.
          </p>
        </div>
        <div className="text-right text-[11px] text-muted">
          <div>Source window: {currentSourceYear}</div>
          <div>Last synced: {fmtDateTime(latestSync?.finishedAt)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Matching projects" value={total} sub={`${activeCount} active`} />
        <Stat
          label="Declared value"
          value={compactAed(aggregate._sum.projectValueAed)}
          sub="DLD project value"
        />
        <Stat
          label="Units"
          value={aggregate._sum.totalUnits ?? 0}
          sub="matching inventory"
        />
        <Stat
          label="Avg. completion"
          value={
            aggregate._avg.percentCompleted
              ? `${Number(aggregate._avg.percentCompleted).toFixed(1)}%`
              : "—"
          }
          sub="where reported"
        />
      </div>

      <FilterBar
        exportType="projects"
        presets={[
          {
            label: `Published ${currentSourceYear}`,
            params: {
              dateField: "adoptionDate",
              year: String(currentSourceYear),
              sort: "adoptionDate",
            },
          },
          {
            label: "Published this month",
            params: {
              dateField: "adoptionDate",
              year: String(new Date().getUTCFullYear()),
              month: String(new Date().getUTCMonth() + 1),
              sort: "adoptionDate",
            },
          },
          {
            label: `Starting ${currentSourceYear}`,
            params: {
              dateField: "startDate",
              year: String(currentSourceYear),
              sort: "startDate",
            },
          },
          {
            label: `Completing ${currentSourceYear}`,
            params: {
              dateField: "completionDate",
              year: String(currentSourceYear),
              sort: "completionDate",
              dir: "asc",
            },
          },
          {
            label: "Active construction",
            params: {
              status: "ACTIVE",
              minCompletion: "0.01",
              maxCompletion: "99.99",
              sort: "percentCompleted",
            },
          },
          {
            label: "Large projects",
            params: { minUnits: "500", sort: "totalUnits" },
          },
        ]}
        fields={[
          {
            name: "q",
            label: "Search",
            type: "text",
            placeholder: "project, no., developer, area",
            width: "235px",
          },
          {
            name: "status",
            label: "Status",
            type: "select",
            width: "165px",
            options: [
              { value: "", label: "All statuses" },
              ...statuses
                .map((row) => row.status)
                .filter((value): value is string => Boolean(value))
                .map((value) => ({ value, label: value.replaceAll("_", " ") })),
            ],
          },
          {
            name: "area",
            label: "Area",
            type: "select",
            width: "185px",
            options: [
              { value: "", label: "All areas" },
              ...areas
                .map((row) => row.areaEn)
                .filter((value): value is string => Boolean(value))
                .map((value) => ({ value, label: value })),
            ],
          },
          {
            name: "zone",
            label: "Zone authority",
            type: "select",
            width: "190px",
            options: [
              { value: "", label: "All authorities" },
              ...zones
                .map((row) => row.zoneEn)
                .filter((value): value is string => Boolean(value))
                .map((value) => ({ value, label: value })),
            ],
          },
          {
            name: "projectType",
            label: "Project type",
            type: "select",
            width: "135px",
            options: [
              { value: "", label: "All types" },
              ...projectTypes
                .map((row) => row.projectTypeEn)
                .filter((value): value is string => Boolean(value))
                .map((value) => ({ value, label: value })),
            ],
          },
          {
            name: "developer",
            label: "Developer",
            type: "text",
            placeholder: "name or number",
            width: "180px",
          },
          {
            name: "dateField",
            label: "Date field",
            type: "select",
            width: "155px",
            options: [
              { value: "adoptionDate", label: "Published / adopted" },
              { value: "startDate", label: "Start date" },
              { value: "endDate", label: "Planned end date" },
              { value: "completionDate", label: "Completion date" },
              { value: "inspectionDate", label: "Inspection date" },
            ],
          },
          {
            name: "year",
            label: "Year",
            type: "select",
            width: "105px",
            options: [
              { value: "", label: "Any year" },
              ...availableYears.map((year) => ({
                value: String(year),
                label: String(year),
              })),
            ],
          },
          {
            name: "month",
            label: "Month",
            type: "select",
            width: "125px",
            options: [
              { value: "", label: "Any month" },
              ...MONTHS.map((label, index) => ({
                value: String(index + 1),
                label,
              })),
            ],
          },
          { name: "dateFrom", label: "Date from", type: "date" },
          { name: "dateTo", label: "Date to", type: "date" },
          {
            name: "minCompletion",
            label: "Min complete %",
            type: "number",
            width: "120px",
          },
          {
            name: "maxCompletion",
            label: "Max complete %",
            type: "number",
            width: "120px",
          },
          {
            name: "minUnits",
            label: "Min units",
            type: "number",
            width: "105px",
          },
          {
            name: "maxUnits",
            label: "Max units",
            type: "number",
            width: "105px",
          },
          {
            name: "minValue",
            label: "Min value AED",
            type: "number",
            width: "135px",
          },
          {
            name: "maxValue",
            label: "Max value AED",
            type: "number",
            width: "135px",
          },
          {
            name: "hasEscrow",
            label: "Escrow",
            type: "select",
            width: "105px",
            options: TRI_OPTIONS,
          },
          {
            name: "sourceYear",
            label: "Source window",
            type: "select",
            width: "120px",
            options: [
              { value: "", label: "Any" },
              ...sourceYears.map((row) => ({
                value: String(row.sourceYear),
                label: String(row.sourceYear),
              })),
            ],
          },
        ]}
      />

      <Card className="!p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1450px] text-[12.5px]">
            <thead className="bg-[color:var(--surface)]">
              <tr className="border-b border-[color:var(--border)] text-left">
                <th className="px-4 py-2.5">
                  <SortHeader label="Project" sortKey="nameEn" defaultDir="asc" />
                </th>
                <th className="w-[125px] px-2 py-2.5">
                  <SortHeader label="Published" sortKey="adoptionDate" />
                </th>
                <th className="w-[205px] px-2 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                  Schedule
                </th>
                <th className="w-[165px] px-2 py-2.5">
                  <SortHeader label="Progress" sortKey="percentCompleted" />
                </th>
                <th className="w-[180px] px-2 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                  Area / authority
                </th>
                <th className="px-2 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted">
                  Developer
                </th>
                <th className="w-[105px] px-2 py-2.5 text-right">
                  <SortHeader label="Units" sortKey="totalUnits" align="right" />
                </th>
                <th className="w-[145px] px-4 py-2.5 text-right">
                  <SortHeader
                    label="Value"
                    sortKey="projectValueAed"
                    align="right"
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <Empty>No projects match these filters.</Empty>
                  </td>
                </tr>
              ) : null}
              {rows.map((project) => (
                <tr
                  key={project.projectNumber}
                  className="border-b border-[color:var(--border)]/50 align-top hover:bg-[color:var(--surface-2)]/50"
                >
                  <td className="max-w-[300px] px-4 py-2">
                    <Link
                      href={`/projects/${encodeURIComponent(project.projectNumber)}`}
                      className="line-clamp-1 font-medium hover:text-[color:var(--accent)]"
                      title={project.nameEn ?? ""}
                    >
                      {project.nameEn ?? `Project ${project.projectNumber}`}
                    </Link>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted">
                      <span>#{project.projectNumber}</span>
                      {project.projectTypeEn ? (
                        <Pill>{project.projectTypeEn}</Pill>
                      ) : null}
                      {project.escrowAccountNumber ? (
                        <Pill tone="accent">escrow</Pill>
                      ) : null}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                    {fmtDate(project.adoptionDate)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                    {fmtDate(project.startDate)} → {fmtDate(project.endDate)}
                    {project.completionDate ? (
                      <div className="text-[10px] text-muted">
                        completed {fmtDate(project.completionDate)}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    <Pill tone={statusTone(project.status)}>
                      {(project.status ?? "UNKNOWN").replaceAll("_", " ")}
                    </Pill>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="h-1.5 w-20 overflow-hidden rounded bg-[color:var(--surface-2)]">
                        <div
                          className="h-full bg-[color:var(--success)]"
                          style={{
                            width: `${Math.min(100, Math.max(0, Number(project.percentCompleted ?? 0)))}%`,
                          }}
                        />
                      </div>
                      <span className="tabular-nums text-[10px] text-muted">
                        {Number(project.percentCompleted ?? 0).toFixed(1)}%
                      </span>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <div className="line-clamp-1">{project.areaEn ?? "—"}</div>
                    <div
                      className="line-clamp-1 text-[10px] text-muted"
                      title={project.zoneEn ?? ""}
                    >
                      {project.zoneEn ?? "—"}
                    </div>
                  </td>
                  <td className="max-w-[260px] px-2 py-2">
                    <div
                      className="line-clamp-1"
                      title={project.developerNameEn ?? ""}
                    >
                      {project.developerNameEn ?? "—"}
                    </div>
                    <div className="text-[10px] text-muted">
                      #{project.developerNumber ?? "—"}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {fmtNumber(project.totalUnits)}
                    <div className="text-[10px] text-muted">
                      {fmtNumber(project.totalBuildings)} bldg ·{" "}
                      {fmtNumber(project.totalVillas)} villas
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                    {compactAed(project.projectValueAed)}
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

      <p className="pb-3 text-[11px] leading-relaxed text-muted">
        Coverage is the union of four required DLD source queries: start date,
        end date, adoption date and completion date for {currentSourceYear}. The
        gateway returns only the selected calendar year, so this is a
        current-window project intelligence dataset—not a claim of complete
        historical coverage. CSV export preserves all 29 stored source and
        provenance fields.
      </p>
    </div>
  );
}
