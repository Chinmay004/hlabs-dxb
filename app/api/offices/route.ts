import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { officeOrderBy, officeWhere, parseOfficeFilters } from "@/lib/filters";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const filters = parseOfficeFilters(request.nextUrl.searchParams);
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

  return Response.json({
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    pageCount: Math.max(1, Math.ceil(total / filters.pageSize)),
    rows,
  });
}
