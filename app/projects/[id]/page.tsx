import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { fmtDate, fmtDateTime, fmtNumber } from "@/lib/format";
import { Card, Pill, SectionTitle } from "../../components/ui";

export const dynamic = "force-dynamic";

function value(value: string | number | null | undefined) {
  return value == null || value === "" ? "—" : String(value);
}

function aed(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `AED ${number.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { projectNumber: decodeURIComponent(id) },
  });
  if (!project) notFound();

  const queryForType: Record<number, string> = {
    1: "start-date",
    2: "end-date",
    3: "adoption-date",
    4: "completion-date",
  };

  return (
    <div className="space-y-4">
      <div>
        <Link
          href="/projects"
          className="text-xs text-[color:var(--accent)] hover:underline"
        >
          ← All projects
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {project.nameEn ?? `Project ${project.projectNumber}`}
          </h1>
          <Pill tone="accent">#{project.projectNumber}</Pill>
          {project.status ? (
            <Pill tone={project.status === "CANCELLED" ? "bad" : "good"}>
              {project.status.replaceAll("_", " ")}
            </Pill>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-muted">{project.nameAr ?? "—"}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle hint="All fields below come directly from DLD open data.">
            Project profile
          </SectionTitle>
          <dl className="grid gap-x-8 gap-y-4 text-[13px] sm:grid-cols-2">
            <Item label="Developer">
              {value(project.developerNameEn)}
              <span className="ml-1 text-muted">
                #{value(project.developerNumber)}
              </span>
            </Item>
            <Item label="Developer (Arabic)">
              {value(project.developerNameAr)}
            </Item>
            <Item label="Project type">{value(project.projectTypeEn)}</Item>
            <Item label="Declared project value">
              {aed(project.projectValueAed)}
            </Item>
            <Item label="Escrow account">
              {value(project.escrowAccountNumber)}
            </Item>
            <Item label="Master project">
              {value(project.masterProjectEn)}
            </Item>
            <Item label="Area">{value(project.areaEn)}</Item>
            <Item label="Zone authority">{value(project.zoneEn)}</Item>
          </dl>
        </Card>

        <Card>
          <SectionTitle>Construction progress</SectionTitle>
          <div className="text-4xl font-semibold tabular-nums">
            {Number(project.percentCompleted ?? 0).toFixed(2)}%
          </div>
          <div className="mt-3 h-2.5 overflow-hidden rounded bg-[color:var(--surface-2)]">
            <div
              className="h-full bg-[color:var(--success)]"
              style={{
                width: `${Math.min(100, Math.max(0, Number(project.percentCompleted ?? 0)))}%`,
              }}
            />
          </div>
          <dl className="mt-5 space-y-3 text-[13px]">
            <Item label="Last inspection">{fmtDate(project.inspectionDate)}</Item>
            <Item label="Recorded completion">
              {fmtDate(project.completionDate)}
            </Item>
          </dl>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Dates</SectionTitle>
          <dl className="grid grid-cols-2 gap-4 text-[13px]">
            <Item label="Published / adopted">
              {fmtDate(project.adoptionDate)}
            </Item>
            <Item label="Start">{fmtDate(project.startDate)}</Item>
            <Item label="Planned end">{fmtDate(project.endDate)}</Item>
            <Item label="Completion">{fmtDate(project.completionDate)}</Item>
            <Item label="Inspection">{fmtDate(project.inspectionDate)}</Item>
          </dl>
        </Card>

        <Card>
          <SectionTitle>Inventory</SectionTitle>
          <dl className="grid grid-cols-2 gap-4 text-[13px] sm:grid-cols-3">
            <Item label="Units">{fmtNumber(project.totalUnits)}</Item>
            <Item label="Buildings">{fmtNumber(project.totalBuildings)}</Item>
            <Item label="Villas">{fmtNumber(project.totalVillas)}</Item>
            <Item label="Lands">{fmtNumber(project.totalLands)}</Item>
            <Item label="Total inventory">
              {fmtNumber(project.totalInventory)}
            </Item>
          </dl>
        </Card>
      </div>

      <Card>
        <SectionTitle>Description</SectionTitle>
        <div className="grid gap-6 text-[13px] leading-relaxed lg:grid-cols-2">
          <div className="whitespace-pre-wrap">
            {project.descriptionEn ?? "No English description supplied."}
          </div>
          <div className="whitespace-pre-wrap text-muted" dir="rtl">
            {project.descriptionAr ?? "—"}
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle hint="This makes source coverage and freshness auditable.">
          Source provenance
        </SectionTitle>
        <dl className="grid gap-4 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
          <Item label="Source window">{project.sourceYear}</Item>
          <Item label="Matched DLD queries">
            {project.dateMatchTypes
              .map((type) => queryForType[type] ?? String(type))
              .join(", ")}
          </Item>
          <Item label="First seen">{fmtDateTime(project.firstSeenAt)}</Item>
          <Item label="Last seen">{fmtDateTime(project.lastSeenAt)}</Item>
        </dl>
      </Card>
    </div>
  );
}

function Item({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}
