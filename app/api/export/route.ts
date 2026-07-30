import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import {
  brokerOrderBy,
  brokerWhere,
  officeOrderBy,
  officeWhere,
  parseBrokerFilters,
  parseOfficeFilters,
  parseProjectFilters,
  projectOrderBy,
  projectWhere,
} from "@/lib/filters";

export const dynamic = "force-dynamic";

/** RFC 4180 escaping, plus a guard against spreadsheet formula injection. */
function csvCell(value: unknown): string {
  if (value == null) return "";
  let s: string;
  if (value instanceof Date) s = value.toISOString().slice(0, 19).replace("T", " ");
  else if (typeof value === "object") s = JSON.stringify(value);
  else s = String(value);

  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: Array<[string, string]>, rows: Array<Record<string, unknown>>) {
  const out = [headers.map(([, label]) => csvCell(label)).join(",")];
  for (const row of rows) {
    out.push(headers.map(([key]) => csvCell(row[key])).join(","));
  }
  return out.join("\r\n");
}

const OFFICE_COLUMNS: Array<[string, string]> = [
  ["realEstateNumber", "RERA Office No"],
  ["nameEn", "Brokerage"],
  ["nameAr", "Brokerage (AR)"],
  ["issueDate", "Licensed On"],
  ["expiryDate", "Licence Expires"],
  ["ageDays", "Age (days)"],
  ["leadTier", "Tier"],
  ["leadScore", "Lead Score"],
  ["activeBrokerCount", "Brokers"],
  ["newBrokers30d", "New Brokers 30d"],
  ["contactNameEn", "Contact"],
  ["contactEmail", "Email"],
  ["contactMobile", "Mobile"],
  ["phone", "Office Phone"],
  ["whatsapp", "WhatsApp"],
  ["website", "Website"],
  ["instagramUrl", "Instagram"],
  ["linkedinUrl", "LinkedIn"],
  ["rank", "RERA Rank"],
  ["licenseNumber", "Trade Licence"],
  ["activityNames", "Activities"],
  ["firstSeenAt", "First Seen"],
  ["status", "CRM Status"],
];

const BROKER_COLUMNS: Array<[string, string]> = [
  ["cardNumber", "Card No"],
  ["nameEn", "Broker"],
  ["cardIssueDate", "Card Issued"],
  ["isNewCard", "First Licence"],
  ["cardExpiryDate", "Card Expires"],
  ["email", "Email"],
  ["mobile", "Mobile"],
  ["phone", "Phone"],
  ["realEstateNumber", "RERA Office No"],
  ["officeNameEn", "Brokerage"],
  ["officeIssueDate", "Brokerage Licensed On"],
  ["cardRank", "Card Rank"],
  ["officeRank", "Office Rank"],
  ["firstSeenAt", "First Seen"],
];

const PROJECT_COLUMNS: Array<[string, string]> = [
  ["projectNumber", "Project Number"],
  ["nameEn", "Project Name"],
  ["nameAr", "Project Name (AR)"],
  ["developerNumber", "Developer Number"],
  ["developerNameEn", "Developer"],
  ["developerNameAr", "Developer (AR)"],
  ["startDate", "Start Date"],
  ["endDate", "End Date"],
  ["adoptionDate", "Adoption / Registration Date"],
  ["projectTypeEn", "Project Type"],
  ["projectValueAed", "Project Value (AED)"],
  ["escrowAccountNumber", "Escrow Account"],
  ["status", "Project Status"],
  ["percentCompleted", "Completed (%)"],
  ["inspectionDate", "Inspection Date"],
  ["completionDate", "Completion Date"],
  ["descriptionEn", "Description"],
  ["areaEn", "Area"],
  ["zoneEn", "Zone Authority"],
  ["totalLands", "Total Lands"],
  ["totalBuildings", "Total Buildings"],
  ["totalVillas", "Total Villas"],
  ["totalUnits", "Total Units"],
  ["totalInventory", "Total Inventory"],
  ["masterProjectEn", "Master Project"],
  ["dateMatchTypes", "DLD Date Match Types"],
  ["sourceYear", "Source Window Year"],
  ["firstSeenAt", "First Seen"],
  ["lastSeenAt", "Last Seen"],
];

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const requestedType = sp.get("type");
  const type =
    requestedType === "brokers" || requestedType === "projects"
      ? requestedType
      : "offices";
  const limit = Math.min(50_000, Number(sp.get("limit")) || 25_000);
  const stamp = new Date().toISOString().slice(0, 10);

  let csv: string;
  let filename: string;

  if (type === "offices") {
    const filters = parseOfficeFilters(sp);
    const rows = await prisma.office.findMany({
      where: officeWhere(filters),
      orderBy: officeOrderBy(filters),
      take: limit,
    });

    const now = Date.now();
    csv = toCsv(
      OFFICE_COLUMNS,
      rows.map((r) => ({
        ...r,
        issueDate: r.issueDate?.toISOString().slice(0, 10),
        expiryDate: r.expiryDate?.toISOString().slice(0, 10),
        firstSeenAt: r.firstSeenAt.toISOString().slice(0, 10),
        ageDays: r.issueDate
          ? Math.floor((now - r.issueDate.getTime()) / 86_400_000)
          : null,
        activityNames: Array.isArray(r.activities)
          ? (r.activities as Array<{ nameEn?: string }>)
              .map((a) => a?.nameEn)
              .filter(Boolean)
              .join(" | ")
          : "",
      })),
    );
    filename = `dxb-brokerages-${stamp}.csv`;
  } else if (type === "brokers") {
    const filters = parseBrokerFilters(sp);
    const rows = await prisma.broker.findMany({
      where: brokerWhere(filters),
      orderBy: brokerOrderBy(filters),
      take: limit,
    });

    csv = toCsv(
      BROKER_COLUMNS,
      rows.map((r) => ({
        ...r,
        cardIssueDate: r.cardIssueDate?.toISOString().slice(0, 10),
        cardExpiryDate: r.cardExpiryDate?.toISOString().slice(0, 10),
        officeIssueDate: r.officeIssueDate?.toISOString().slice(0, 10),
        firstSeenAt: r.firstSeenAt.toISOString().slice(0, 10),
      })),
    );
    filename = `dxb-brokers-${stamp}.csv`;
  } else {
    const filters = parseProjectFilters(sp);
    const rows = await prisma.project.findMany({
      where: projectWhere(filters),
      orderBy: projectOrderBy(filters),
      take: limit,
    });

    csv = toCsv(
      PROJECT_COLUMNS,
      rows.map((row) => ({
        ...row,
        projectValueAed: row.projectValueAed?.toString(),
        percentCompleted: row.percentCompleted?.toString(),
        startDate: row.startDate?.toISOString().slice(0, 10),
        endDate: row.endDate?.toISOString().slice(0, 10),
        adoptionDate: row.adoptionDate?.toISOString().slice(0, 10),
        inspectionDate: row.inspectionDate?.toISOString().slice(0, 10),
        completionDate: row.completionDate?.toISOString().slice(0, 10),
        firstSeenAt: row.firstSeenAt.toISOString().slice(0, 19),
        lastSeenAt: row.lastSeenAt.toISOString().slice(0, 19),
        dateMatchTypes: row.dateMatchTypes.join("|"),
      })),
    );
    filename = `dxb-projects-${stamp}.csv`;
  }

  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
