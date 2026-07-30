import type { Prisma } from "@prisma/client";

/**
 * Filter parsing shared by the page loaders, the JSON API and the CSV export,
 * so a link the user copies out of the table exports exactly the rows they see.
 */

export type TriState = "any" | "yes" | "no";

function tri(v: string | null | undefined): TriState {
  return v === "yes" || v === "no" ? v : "any";
}

function date(v: string | null | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** End of the given day, so `to=2026-07-01` includes everything on the 1st. */
function endOfDay(v: string | null | undefined): Date | undefined {
  const d = date(v);
  if (!d) return undefined;
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

function int(v: string | null | undefined): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function number(v: string | null | undefined): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export interface OfficeFilters {
  q?: string;
  issuedFrom?: Date;
  issuedTo?: Date;
  foundFrom?: Date;
  foundTo?: Date;
  expiringBefore?: Date;
  minBrokers?: number;
  maxBrokers?: number;
  rank?: string;
  tier?: string;
  crmStatus?: string;
  activityId?: number;
  hasWebsite: TriState;
  hasEmail: TriState;
  hasMobile: TriState;
  hasInstagram: TriState;
  includeInactive: boolean;
  sort: string;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
}

export const OFFICE_SORTS = {
  leadScore: "leadScore",
  issueDate: "issueDate",
  firstSeenAt: "firstSeenAt",
  expiryDate: "expiryDate",
  brokerCount: "activeBrokerCount",
  newBrokers30d: "newBrokers30d",
  nameEn: "nameEn",
} as const;

/**
 * Prisma only accepts the `{ sort, nulls }` form on nullable columns — passing
 * it for a non-nullable one is a runtime error, so the two cases have to be
 * built differently.
 */
const NULLABLE_OFFICE_SORTS = new Set(["issueDate", "expiryDate", "nameEn"]);
const NULLABLE_BROKER_SORTS = new Set([
  "cardIssueDate",
  "cardExpiryDate",
  "nameEn",
]);

export function parseOfficeFilters(sp: URLSearchParams): OfficeFilters {
  const sort = sp.get("sort") ?? "leadScore";
  return {
    q: sp.get("q")?.trim() || undefined,
    issuedFrom: date(sp.get("issuedFrom")),
    issuedTo: endOfDay(sp.get("issuedTo")),
    foundFrom: date(sp.get("foundFrom")),
    foundTo: endOfDay(sp.get("foundTo")),
    expiringBefore: endOfDay(sp.get("expiringBefore")),
    minBrokers: int(sp.get("minBrokers")),
    maxBrokers: int(sp.get("maxBrokers")),
    rank: sp.get("rank") || undefined,
    tier: sp.get("tier") || undefined,
    crmStatus: sp.get("crmStatus") || undefined,
    activityId: int(sp.get("activityId")),
    hasWebsite: tri(sp.get("hasWebsite")),
    hasEmail: tri(sp.get("hasEmail")),
    hasMobile: tri(sp.get("hasMobile")),
    hasInstagram: tri(sp.get("hasInstagram")),
    includeInactive: sp.get("includeInactive") === "1",
    sort: sort in OFFICE_SORTS ? sort : "leadScore",
    dir: sp.get("dir") === "asc" ? "asc" : "desc",
    page: Math.max(1, int(sp.get("page")) ?? 1),
    pageSize: Math.min(500, Math.max(10, int(sp.get("pageSize")) ?? 50)),
  };
}

export function officeWhere(f: OfficeFilters): Prisma.OfficeWhereInput {
  const where: Prisma.OfficeWhereInput = {};
  const and: Prisma.OfficeWhereInput[] = [];

  if (!f.includeInactive) where.isActive = true;

  if (f.q) {
    and.push({
      OR: [
        { nameEn: { contains: f.q, mode: "insensitive" } },
        { nameAr: { contains: f.q } },
        { realEstateNumber: { contains: f.q } },
        { licenseNumber: { contains: f.q } },
        { contactEmail: { contains: f.q, mode: "insensitive" } },
        { contactNameEn: { contains: f.q, mode: "insensitive" } },
      ],
    });
  }

  if (f.issuedFrom || f.issuedTo) {
    and.push({ issueDate: { gte: f.issuedFrom, lte: f.issuedTo } });
  }
  if (f.foundFrom || f.foundTo) {
    and.push({ firstSeenAt: { gte: f.foundFrom, lte: f.foundTo } });
  }
  if (f.expiringBefore) {
    and.push({ expiryDate: { lte: f.expiringBefore, gte: new Date() } });
  }
  if (f.minBrokers != null || f.maxBrokers != null) {
    and.push({ activeBrokerCount: { gte: f.minBrokers, lte: f.maxBrokers } });
  }
  if (f.rank) and.push({ rank: f.rank });
  if (f.tier) and.push({ leadTier: f.tier });
  if (f.crmStatus) and.push({ status: f.crmStatus });

  const triFilter = (field: keyof Prisma.OfficeWhereInput, state: TriState) => {
    if (state === "yes") and.push({ [field]: { not: null } } as Prisma.OfficeWhereInput);
    if (state === "no") and.push({ [field]: null } as Prisma.OfficeWhereInput);
  };
  triFilter("website", f.hasWebsite);
  triFilter("contactEmail", f.hasEmail);
  triFilter("contactMobile", f.hasMobile);
  triFilter("instagramUrl", f.hasInstagram);

  if (and.length) where.AND = and;
  return where;
}

export function officeOrderBy(f: OfficeFilters): Prisma.OfficeOrderByWithRelationInput[] {
  const column = OFFICE_SORTS[f.sort as keyof typeof OFFICE_SORTS] ?? "leadScore";
  const primary = NULLABLE_OFFICE_SORTS.has(column)
    ? { [column]: { sort: f.dir, nulls: "last" } }
    : { [column]: f.dir };

  return [
    primary as Prisma.OfficeOrderByWithRelationInput,
    // Stable tiebreak so pagination never repeats or skips a row.
    { realEstateNumber: "asc" },
  ];
}

// ------------------------------------------------------------------- brokers

export interface BrokerFilters {
  q?: string;
  issuedFrom?: Date;
  issuedTo?: Date;
  foundFrom?: Date;
  foundTo?: Date;
  expiringBefore?: Date;
  realEstateNumber?: string;
  cardRank?: string;
  /** Only first-time cards, i.e. genuinely new brokers rather than renewals. */
  newOnly: boolean;
  hasEmail: TriState;
  hasMobile: TriState;
  includeInactive: boolean;
  sort: string;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
}

// `cardNumber` is deliberately absent: it is stored as text, so sorting on it
// would be lexicographic ("9" after "10") rather than numeric. Sort by
// firstSeenAt to get discovery order instead.
export const BROKER_SORTS = {
  cardIssueDate: "cardIssueDate",
  firstSeenAt: "firstSeenAt",
  cardExpiryDate: "cardExpiryDate",
  nameEn: "nameEn",
} as const;

export function parseBrokerFilters(sp: URLSearchParams): BrokerFilters {
  const sort = sp.get("sort") ?? "cardIssueDate";
  return {
    q: sp.get("q")?.trim() || undefined,
    issuedFrom: date(sp.get("issuedFrom")),
    issuedTo: endOfDay(sp.get("issuedTo")),
    foundFrom: date(sp.get("foundFrom")),
    foundTo: endOfDay(sp.get("foundTo")),
    expiringBefore: endOfDay(sp.get("expiringBefore")),
    realEstateNumber: sp.get("office") || undefined,
    cardRank: sp.get("cardRank") || undefined,
    newOnly: sp.get("newOnly") === "1",
    hasEmail: tri(sp.get("hasEmail")),
    hasMobile: tri(sp.get("hasMobile")),
    includeInactive: sp.get("includeInactive") === "1",
    sort: sort in BROKER_SORTS ? sort : "cardIssueDate",
    dir: sp.get("dir") === "asc" ? "asc" : "desc",
    page: Math.max(1, int(sp.get("page")) ?? 1),
    pageSize: Math.min(500, Math.max(10, int(sp.get("pageSize")) ?? 50)),
  };
}

export function brokerWhere(f: BrokerFilters): Prisma.BrokerWhereInput {
  const where: Prisma.BrokerWhereInput = {};
  const and: Prisma.BrokerWhereInput[] = [];

  if (!f.includeInactive) where.isActive = true;

  if (f.q) {
    and.push({
      OR: [
        { nameEn: { contains: f.q, mode: "insensitive" } },
        { nameAr: { contains: f.q } },
        { cardNumber: { contains: f.q } },
        { email: { contains: f.q, mode: "insensitive" } },
        { mobile: { contains: f.q } },
        { officeNameEn: { contains: f.q, mode: "insensitive" } },
      ],
    });
  }

  if (f.issuedFrom || f.issuedTo) {
    and.push({ cardIssueDate: { gte: f.issuedFrom, lte: f.issuedTo } });
  }
  if (f.foundFrom || f.foundTo) {
    and.push({ firstSeenAt: { gte: f.foundFrom, lte: f.foundTo } });
  }
  if (f.expiringBefore) {
    and.push({ cardExpiryDate: { lte: f.expiringBefore, gte: new Date() } });
  }
  if (f.realEstateNumber) and.push({ realEstateNumber: f.realEstateNumber });
  if (f.cardRank) and.push({ cardRank: f.cardRank });
  if (f.newOnly) and.push({ isNewCard: true });

  if (f.hasEmail === "yes") and.push({ email: { not: null } });
  if (f.hasEmail === "no") and.push({ email: null });
  if (f.hasMobile === "yes") and.push({ mobile: { not: null } });
  if (f.hasMobile === "no") and.push({ mobile: null });

  if (and.length) where.AND = and;
  return where;
}

export function brokerOrderBy(f: BrokerFilters): Prisma.BrokerOrderByWithRelationInput[] {
  const column = BROKER_SORTS[f.sort as keyof typeof BROKER_SORTS] ?? "cardIssueDate";
  const primary = NULLABLE_BROKER_SORTS.has(column)
    ? { [column]: { sort: f.dir, nulls: "last" } }
    : { [column]: f.dir };

  return [primary as Prisma.BrokerOrderByWithRelationInput, { cardNumber: "asc" }];
}

// ------------------------------------------------------------------ projects

export type ProjectDateField =
  | "adoptionDate"
  | "startDate"
  | "endDate"
  | "completionDate"
  | "inspectionDate";

export interface ProjectFilters {
  q?: string;
  status?: string;
  area?: string;
  zone?: string;
  projectType?: string;
  developer?: string;
  dateField: ProjectDateField;
  dateFrom?: Date;
  dateTo?: Date;
  year?: number;
  month?: number;
  minCompletion?: number;
  maxCompletion?: number;
  minValue?: number;
  maxValue?: number;
  minUnits?: number;
  maxUnits?: number;
  hasEscrow: TriState;
  sourceYear?: number;
  sort: string;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
}

const PROJECT_DATE_FIELDS = new Set<ProjectDateField>([
  "adoptionDate",
  "startDate",
  "endDate",
  "completionDate",
  "inspectionDate",
]);

export const PROJECT_SORTS = {
  adoptionDate: "adoptionDate",
  startDate: "startDate",
  endDate: "endDate",
  completionDate: "completionDate",
  inspectionDate: "inspectionDate",
  projectValueAed: "projectValueAed",
  percentCompleted: "percentCompleted",
  totalUnits: "totalUnits",
  nameEn: "nameEn",
  firstSeenAt: "firstSeenAt",
} as const;

const NULLABLE_PROJECT_SORTS = new Set([
  "adoptionDate",
  "startDate",
  "endDate",
  "completionDate",
  "inspectionDate",
  "projectValueAed",
  "percentCompleted",
  "nameEn",
]);

export function parseProjectFilters(sp: URLSearchParams): ProjectFilters {
  const dateFieldRaw = sp.get("dateField") as ProjectDateField | null;
  const sort = sp.get("sort") ?? "adoptionDate";
  const month = int(sp.get("month"));
  return {
    q: sp.get("q")?.trim() || undefined,
    status: sp.get("status") || undefined,
    area: sp.get("area") || undefined,
    zone: sp.get("zone") || undefined,
    projectType: sp.get("projectType") || undefined,
    developer: sp.get("developer")?.trim() || undefined,
    dateField:
      dateFieldRaw && PROJECT_DATE_FIELDS.has(dateFieldRaw)
        ? dateFieldRaw
        : "adoptionDate",
    dateFrom: date(sp.get("dateFrom")),
    dateTo: endOfDay(sp.get("dateTo")),
    year:
      int(sp.get("year")) ??
      (month && month >= 1 && month <= 12
        ? new Date().getUTCFullYear()
        : undefined),
    month: month && month >= 1 && month <= 12 ? month : undefined,
    minCompletion: number(sp.get("minCompletion")),
    maxCompletion: number(sp.get("maxCompletion")),
    minValue: number(sp.get("minValue")),
    maxValue: number(sp.get("maxValue")),
    minUnits: int(sp.get("minUnits")),
    maxUnits: int(sp.get("maxUnits")),
    hasEscrow: tri(sp.get("hasEscrow")),
    sourceYear: int(sp.get("sourceYear")),
    sort: sort in PROJECT_SORTS ? sort : "adoptionDate",
    dir: sp.get("dir") === "asc" ? "asc" : "desc",
    page: Math.max(1, int(sp.get("page")) ?? 1),
    pageSize: Math.min(500, Math.max(10, int(sp.get("pageSize")) ?? 50)),
  };
}

function calendarRange(year: number, month?: number) {
  const startMonth = month ? month - 1 : 0;
  const from = new Date(Date.UTC(year, startMonth, 1));
  const to = month
    ? new Date(Date.UTC(year, month, 0, 23, 59, 59, 999))
    : new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
  return { from, to };
}

export function projectWhere(f: ProjectFilters): Prisma.ProjectWhereInput {
  const and: Prisma.ProjectWhereInput[] = [];

  if (f.q) {
    and.push({
      OR: [
        { projectNumber: { contains: f.q } },
        { nameEn: { contains: f.q, mode: "insensitive" } },
        { nameAr: { contains: f.q } },
        { developerNameEn: { contains: f.q, mode: "insensitive" } },
        { developerNameAr: { contains: f.q } },
        { developerNumber: { contains: f.q } },
        { descriptionEn: { contains: f.q, mode: "insensitive" } },
        { areaEn: { contains: f.q, mode: "insensitive" } },
        { masterProjectEn: { contains: f.q, mode: "insensitive" } },
      ],
    });
  }

  if (f.status) and.push({ status: f.status });
  if (f.area) and.push({ areaEn: f.area });
  if (f.zone) and.push({ zoneEn: f.zone });
  if (f.projectType) and.push({ projectTypeEn: f.projectType });
  if (f.developer) {
    and.push({
      OR: [
        { developerNumber: { contains: f.developer } },
        { developerNameEn: { contains: f.developer, mode: "insensitive" } },
        { developerNameAr: { contains: f.developer } },
      ],
    });
  }

  let from = f.dateFrom;
  let to = f.dateTo;
  if (f.year) {
    const range = calendarRange(f.year, f.month);
    from ??= range.from;
    to ??= range.to;
  }
  if (from || to) {
    and.push({
      [f.dateField]: { gte: from, lte: to },
    } as Prisma.ProjectWhereInput);
  }

  if (f.minCompletion != null || f.maxCompletion != null) {
    and.push({
      percentCompleted: { gte: f.minCompletion, lte: f.maxCompletion },
    });
  }
  if (f.minValue != null || f.maxValue != null) {
    and.push({
      projectValueAed: { gte: f.minValue, lte: f.maxValue },
    });
  }
  if (f.minUnits != null || f.maxUnits != null) {
    and.push({ totalUnits: { gte: f.minUnits, lte: f.maxUnits } });
  }
  if (f.hasEscrow === "yes") {
    and.push({ escrowAccountNumber: { not: null } });
  }
  if (f.hasEscrow === "no") and.push({ escrowAccountNumber: null });
  if (f.sourceYear) and.push({ sourceYear: f.sourceYear });

  return and.length ? { AND: and } : {};
}

export function projectOrderBy(
  f: ProjectFilters,
): Prisma.ProjectOrderByWithRelationInput[] {
  const column =
    PROJECT_SORTS[f.sort as keyof typeof PROJECT_SORTS] ?? "adoptionDate";
  const primary = NULLABLE_PROJECT_SORTS.has(column)
    ? { [column]: { sort: f.dir, nulls: "last" } }
    : { [column]: f.dir };
  return [
    primary as Prisma.ProjectOrderByWithRelationInput,
    { projectNumber: "asc" },
  ];
}

/** Rebuild a query string, dropping empties so URLs stay readable. */
export function buildQuery(
  base: URLSearchParams | Record<string, string | number | undefined | null>,
  patch: Record<string, string | number | undefined | null> = {},
): string {
  const sp = base instanceof URLSearchParams
    ? new URLSearchParams(base)
    : new URLSearchParams(
        Object.entries(base)
          .filter(([, v]) => v != null && v !== "")
          .map(([k, v]) => [k, String(v)]),
      );

  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "") sp.delete(k);
    else sp.set(k, String(v));
  }
  sp.sort();
  return sp.toString();
}
