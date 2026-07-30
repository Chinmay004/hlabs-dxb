import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import {
  parseProjectFilters,
  projectOrderBy,
  projectWhere,
} from "@/lib/filters";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const filters = parseProjectFilters(request.nextUrl.searchParams);
  const where = projectWhere(filters);

  const [total, rows, aggregate, statusFacets, areaFacets, typeFacets] =
    await Promise.all([
      prisma.project.count({ where }),
      prisma.project.findMany({
        where,
        orderBy: projectOrderBy(filters),
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      prisma.project.aggregate({
        where,
        _sum: {
          projectValueAed: true,
          totalUnits: true,
          totalBuildings: true,
          totalVillas: true,
        },
        _avg: { percentCompleted: true },
      }),
      prisma.project.groupBy({
        by: ["status"],
        _count: { status: true },
        orderBy: { _count: { status: "desc" } },
      }),
      prisma.project.groupBy({
        by: ["areaEn"],
        _count: { areaEn: true },
        orderBy: { _count: { areaEn: "desc" } },
      }),
      prisma.project.groupBy({
        by: ["projectTypeEn"],
        _count: { projectTypeEn: true },
        orderBy: { _count: { projectTypeEn: "desc" } },
      }),
    ]);

  return Response.json({
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    pageCount: Math.max(1, Math.ceil(total / filters.pageSize)),
    rows,
    aggregate: {
      projectValueAed: aggregate._sum.projectValueAed?.toString() ?? null,
      totalUnits: aggregate._sum.totalUnits ?? 0,
      totalBuildings: aggregate._sum.totalBuildings ?? 0,
      totalVillas: aggregate._sum.totalVillas ?? 0,
      averageCompletion: aggregate._avg.percentCompleted?.toString() ?? null,
    },
    facets: {
      statuses: statusFacets,
      areas: areaFacets,
      projectTypes: typeFacets,
    },
  });
}
