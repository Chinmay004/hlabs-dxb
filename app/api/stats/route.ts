import type { NextRequest } from "next/server";
import {
  getActivityBreakdown,
  getOverview,
  getSizeDistribution,
  getTierDistribution,
  getTimeseries,
  type Granularity,
} from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;

  const granularity = (sp.get("granularity") ?? "day") as Granularity;
  const to = sp.get("to") ? new Date(sp.get("to")!) : new Date();
  const from = sp.get("from")
    ? new Date(sp.get("from")!)
    : new Date(to.getTime() - 180 * 86_400_000);

  const [overview, series, sizes, tiers, activities] = await Promise.all([
    getOverview(),
    getTimeseries({ from, to, granularity }),
    getSizeDistribution(),
    getTierDistribution(),
    getActivityBreakdown(),
  ]);

  return Response.json({ overview, series, sizes, tiers, activities });
}
