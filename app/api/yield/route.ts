import type { NextRequest } from "next/server";
import { getYieldAtlas, parseYieldFilters, summarise } from "@/lib/analytics/yield";

export const dynamic = "force-dynamic";

/**
 * Gross rental yield by area. See lib/analytics/yield.ts for the methodology -
 * in particular why it is measured per square metre, and what is excluded.
 */
export async function GET(request: NextRequest) {
  const filters = parseYieldFilters(request.nextUrl.searchParams);
  const rows = await getYieldAtlas(filters);

  return Response.json({
    filters,
    summary: summarise(rows),
    rows,
    methodology: {
      formula: "median annual rent per m² ÷ median sale price per m²",
      excludes: [
        "off-plan sales (71% of sales; cannot be let)",
        "mortgages and gifts (sales only)",
        "repeat unit rows of multi-unit transactions",
        "top and bottom 5% of per-m² values in each area",
      ],
      caveats: [
        "matched at area × property-sub-type level; rents carry no property key, so unit-level matching is impossible",
        "renewal contracts sit below market — use version=new for achievable rent",
        "sizeSkew is median lease m² ÷ median sale m²; far from 1.0 means the stock being let differs from the stock being sold",
      ],
    },
  });
}
