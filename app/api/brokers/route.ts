import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { brokerOrderBy, brokerWhere, parseBrokerFilters } from "@/lib/filters";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const filters = parseBrokerFilters(request.nextUrl.searchParams);
  const where = brokerWhere(filters);

  const [total, rows] = await Promise.all([
    prisma.broker.count({ where }),
    prisma.broker.findMany({
      where,
      orderBy: brokerOrderBy(filters),
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
