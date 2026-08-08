import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import {
  parseTransactionFilters,
  transactionOrderBy,
  transactionWhere,
} from "@/lib/filters";

export const dynamic = "force-dynamic";

/**
 * Rows in this dataset are *units*, not deals: a multi-unit transaction emits
 * one row per unit and repeats the whole deal's value on each. Value and deal
 * counts therefore aggregate over `isPrimaryUnit` rows only - see the note on
 * `Transaction` in the schema. `total` below is the unit/row count, which is
 * what the table paginates over.
 */
export async function GET(request: NextRequest) {
  const filters = parseTransactionFilters(request.nextUrl.searchParams);
  const where = transactionWhere(filters);
  const dealWhere = { AND: [where, { isPrimaryUnit: true }] };

  const [total, deals, rows, dealAggregate, unitAggregate, groupFacets, areaFacets, typeFacets] =
    await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.count({ where: dealWhere }),
      prisma.transaction.findMany({
        where,
        orderBy: transactionOrderBy(filters),
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      prisma.transaction.aggregate({
        where: dealWhere,
        _sum: { transValueAed: true },
        _avg: { transValueAed: true },
        _max: { transValueAed: true },
      }),
      prisma.transaction.aggregate({
        where,
        _sum: { actualArea: true },
        _avg: { actualArea: true },
      }),
      prisma.transaction.groupBy({
        where: dealWhere,
        by: ["groupEn"],
        _count: { groupEn: true },
        orderBy: { _count: { groupEn: "desc" } },
      }),
      prisma.transaction.groupBy({
        where: dealWhere,
        by: ["areaEn"],
        _count: { areaEn: true },
        _sum: { transValueAed: true },
        orderBy: { _count: { areaEn: "desc" } },
        take: 40,
      }),
      prisma.transaction.groupBy({
        where: dealWhere,
        by: ["propTypeEn"],
        _count: { propTypeEn: true },
        orderBy: { _count: { propTypeEn: "desc" } },
      }),
    ]);

  return Response.json({
    total,
    deals,
    page: filters.page,
    pageSize: filters.pageSize,
    pageCount: Math.max(1, Math.ceil(total / filters.pageSize)),
    rows,
    aggregate: {
      // Deal-level: one contribution per transaction, not per unit.
      totalValueAed: dealAggregate._sum.transValueAed?.toString() ?? null,
      averageValueAed: dealAggregate._avg.transValueAed?.toString() ?? null,
      maxValueAed: dealAggregate._max.transValueAed?.toString() ?? null,
      // Unit-level: area is a genuine per-unit measure.
      totalAreaSqm: unitAggregate._sum.actualArea?.toString() ?? null,
      averageAreaSqm: unitAggregate._avg.actualArea?.toString() ?? null,
    },
    facets: {
      groups: groupFacets,
      areas: areaFacets.map((a) => ({
        areaEn: a.areaEn,
        count: a._count.areaEn,
        valueAed: a._sum.transValueAed?.toString() ?? null,
      })),
      propertyTypes: typeFacets,
    },
  });
}
