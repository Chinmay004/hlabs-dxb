/**
 * Rental yield atlas: what a property in a given area actually returns.
 *
 * Gross yield = median annual rent per m² ÷ median sale price per m².
 *
 * WHY PER SQUARE METRE, and not per unit or per bedroom:
 *
 *   Bedroom count cannot join the two datasets. `rents.rooms` is null on 95.6%
 *   of contracts, and where present it is a bare number ("3") against the
 *   transactions vocabulary ("3 B/R"). `actualArea`, by contrast, is populated
 *   on 100% of rows on both sides, so area is the only normaliser available -
 *   and it is the better one anyway, since it does not assume a 2-bed in
 *   Deira is comparable to a 2-bed in Downtown.
 *
 * WHAT IS DELIBERATELY EXCLUDED:
 *
 *   - Off-plan sales. 71% of sales are off-plan and cannot be let, so pricing
 *     them against rents overstates yield badly. Ready stock only.
 *   - Mortgages and gifts. `groupId = 1` (Sales) only; a mortgage value is a
 *     loan, not a price.
 *   - Non-primary unit rows. A multi-unit transaction repeats its whole value
 *     on every unit row - see the note on `Transaction` in the schema.
 *   - The top and bottom 5% of per-m² values in each cell. DLD publishes
 *     AED 1 transfers and 99-year prepaid leases that otherwise dominate a
 *     median in a thin cell.
 *
 * KNOWN LIMITS, which the UI surfaces rather than hides:
 *
 *   - Sales and rents are matched at area × property-sub-type level, never at
 *     unit level: a rent row carries no parcel or property id at all, so there
 *     is no key to match a specific unit's rent to its own sale.
 *   - Renewal contracts sit below market (rent caps). The `version` option
 *     exists because a buyer letting a newly bought unit achieves the "New"
 *     rate, roughly 6-7% above the renewal median.
 *   - Only Flat, Villa, Office and Shop exist in both vocabularies. Everything
 *     else ("Labor Camps", "Hotel", "Residential", "Commercial") appears on
 *     one side only and can never produce a yield.
 */
import { prisma } from "../db";

/** Sub-types that exist in BOTH the transaction and rent vocabularies. */
export const YIELDABLE_SUBTYPES = ["Flat", "Villa", "Office", "Shop"] as const;
export type YieldSubtype = (typeof YIELDABLE_SUBTYPES)[number];

export type RentVersion = "all" | "new" | "renewed";

export interface YieldFilters {
  subtype: YieldSubtype;
  version: RentVersion;
  /** Minimum sales and leases required before a cell is reported. */
  minSales: number;
  minLeases: number;
  area?: string;
}

export interface YieldRow {
  area: string;
  sales: number;
  leases: number;
  medianPriceAed: number;
  medianPricePerSqm: number;
  medianRentAed: number;
  medianRentPerSqm: number;
  medianSaleAreaSqm: number;
  medianLeaseAreaSqm: number;
  grossYieldPct: number;
  /** How far the sale and lease size distributions diverge, as a ratio. */
  sizeSkew: number;
  confidence: "high" | "medium" | "low";
}

export function parseYieldFilters(sp: URLSearchParams): YieldFilters {
  const subtypeRaw = sp.get("subtype") as YieldSubtype | null;
  const versionRaw = sp.get("version");
  const int = (v: string | null, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
  };
  return {
    subtype:
      subtypeRaw && YIELDABLE_SUBTYPES.includes(subtypeRaw) ? subtypeRaw : "Flat",
    version:
      versionRaw === "new" || versionRaw === "renewed" ? versionRaw : "all",
    minSales: int(sp.get("minSales"), 20),
    minLeases: int(sp.get("minLeases"), 20),
    area: sp.get("area")?.trim() || undefined,
  };
}

/**
 * Confidence is about sample depth AND comparability.
 *
 * A cell with plenty of rows on both sides can still be misleading if the
 * flats being sold are nothing like the flats being let - a market selling
 * penthouses while letting studios. `sizeSkew` catches that, and drops the
 * cell's confidence even when the counts look healthy.
 */
function confidenceOf(sales: number, leases: number, sizeSkew: number): YieldRow["confidence"] {
  const skewed = sizeSkew > 1.6 || sizeSkew < 0.625;
  if (sales >= 100 && leases >= 100 && !skewed) return "high";
  if (sales >= 30 && leases >= 30 && sizeSkew <= 2.2 && sizeSkew >= 0.45) return "medium";
  return "low";
}

interface RawYieldRow {
  area: string;
  sales: bigint;
  leases: bigint;
  median_price: number | null;
  median_price_sqm: number | null;
  median_rent: number | null;
  median_rent_sqm: number | null;
  median_sale_area: number | null;
  median_lease_area: number | null;
}

export async function getYieldAtlas(filters: YieldFilters): Promise<YieldRow[]> {
  const versionClause =
    filters.version === "new"
      ? "AND r.\"versionEn\" = 'New'"
      : filters.version === "renewed"
        ? "AND r.\"versionEn\" = 'Renewed'"
        : "";

  const areaClause = filters.area
    ? `AND UPPER(TRIM(t."areaEn")) = UPPER(TRIM('${filters.area.replace(/'/g, "''")}'))`
    : "";
  const areaClauseRent = filters.area
    ? `AND UPPER(TRIM(r."areaEn")) = UPPER(TRIM('${filters.area.replace(/'/g, "''")}'))`
    : "";

  // Percentile bounds are computed per cell, then applied, so a thin cell is
  // trimmed against its own distribution rather than the whole market's.
  const sql = `
    WITH sale_base AS (
      SELECT UPPER(TRIM(t."areaEn")) AS area,
             t."transValueAed"::float8 AS price,
             t."actualArea"::float8 AS sqm,
             (t."transValueAed" / NULLIF(t."actualArea", 0))::float8 AS price_sqm
      FROM transactions t
      WHERE t."isPrimaryUnit"
        AND t."groupId" = 1
        AND t."isOffplan" = false
        AND t."propSubTypeEn" = $1
        AND t."transValueAed" > 0
        AND t."actualArea" > 0
        AND t."areaEn" IS NOT NULL
        ${areaClause}
    ),
    sale_bounds AS (
      SELECT area,
             PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY price_sqm) AS lo,
             PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY price_sqm) AS hi
      FROM sale_base GROUP BY area
    ),
    sales AS (
      SELECT b.area,
             COUNT(*)::bigint AS sales,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY b.price)::float8 AS median_price,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY b.price_sqm)::float8 AS median_price_sqm,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY b.sqm)::float8 AS median_sale_area
      FROM sale_base b JOIN sale_bounds s USING (area)
      WHERE b.price_sqm BETWEEN s.lo AND s.hi
      GROUP BY b.area
    ),
    lease_base AS (
      SELECT UPPER(TRIM(r."areaEn")) AS area,
             r."annualAmountAed"::float8 AS rent,
             r."actualArea"::float8 AS sqm,
             (r."annualAmountAed" / NULLIF(r."actualArea", 0))::float8 AS rent_sqm
      FROM rents r
      WHERE r."propSubTypeEn" = $1
        AND r."annualAmountAed" > 0
        AND r."actualArea" > 0
        AND r."areaEn" IS NOT NULL
        ${versionClause}
        ${areaClauseRent}
    ),
    lease_bounds AS (
      SELECT area,
             PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY rent_sqm) AS lo,
             PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY rent_sqm) AS hi
      FROM lease_base GROUP BY area
    ),
    leases AS (
      SELECT b.area,
             COUNT(*)::bigint AS leases,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY b.rent)::float8 AS median_rent,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY b.rent_sqm)::float8 AS median_rent_sqm,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY b.sqm)::float8 AS median_lease_area
      FROM lease_base b JOIN lease_bounds l USING (area)
      WHERE b.rent_sqm BETWEEN l.lo AND l.hi
      GROUP BY b.area
    )
    SELECT s.area, s.sales, l.leases,
           s.median_price, s.median_price_sqm, s.median_sale_area,
           l.median_rent, l.median_rent_sqm, l.median_lease_area
    FROM sales s JOIN leases l USING (area)
    WHERE s.sales >= $2 AND l.leases >= $3
    ORDER BY (l.median_rent_sqm / NULLIF(s.median_price_sqm, 0)) DESC NULLS LAST
  `;

  const rows = await prisma.$queryRawUnsafe<RawYieldRow[]>(
    sql,
    filters.subtype,
    filters.minSales,
    filters.minLeases,
  );

  return rows
    .map((r) => {
      const pricePerSqm = r.median_price_sqm ?? 0;
      const rentPerSqm = r.median_rent_sqm ?? 0;
      const saleArea = r.median_sale_area ?? 0;
      const leaseArea = r.median_lease_area ?? 0;
      const sizeSkew = saleArea > 0 && leaseArea > 0 ? leaseArea / saleArea : 0;
      const sales = Number(r.sales);
      const leases = Number(r.leases);

      return {
        area: r.area,
        sales,
        leases,
        medianPriceAed: r.median_price ?? 0,
        medianPricePerSqm: pricePerSqm,
        medianRentAed: r.median_rent ?? 0,
        medianRentPerSqm: rentPerSqm,
        medianSaleAreaSqm: saleArea,
        medianLeaseAreaSqm: leaseArea,
        grossYieldPct: pricePerSqm > 0 ? (rentPerSqm / pricePerSqm) * 100 : 0,
        sizeSkew,
        confidence: confidenceOf(sales, leases, sizeSkew),
      } satisfies YieldRow;
    })
    // A yield outside this band is an artefact of mismatched stock, not a
    // market signal. Dubai gross yields sit roughly 3-11%.
    .filter((r) => r.grossYieldPct > 0.5 && r.grossYieldPct < 30);
}

/** Headline numbers for the atlas, computed over the reported cells. */
export function summarise(rows: YieldRow[]) {
  const usable = rows.filter((r) => r.confidence !== "low");
  const yields = usable.map((r) => r.grossYieldPct).sort((a, b) => a - b);
  const median =
    yields.length === 0
      ? 0
      : yields.length % 2
        ? yields[(yields.length - 1) / 2]
        : (yields[yields.length / 2 - 1] + yields[yields.length / 2]) / 2;

  return {
    areas: rows.length,
    usableAreas: usable.length,
    medianYieldPct: median,
    totalSales: rows.reduce((sum, r) => sum + r.sales, 0),
    totalLeases: rows.reduce((sum, r) => sum + r.leases, 0),
    best: usable[0] ?? null,
    worst: usable.at(-1) ?? null,
  };
}
