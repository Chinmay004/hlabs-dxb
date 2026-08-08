/**
 * Client for the DLD open-data transactions endpoint.
 *
 *   POST /open-data/transactions
 *
 * Shares the projects envelope but not its parameter set. Everything below was
 * established by probing the live API and by reading the request builder the
 * public portal ships at /scripts/publicData.js:
 *
 *   - The accepted keys are exactly the eleven in `TransactionFilters`. An
 *     unknown key, or a missing one, comes back as responseCode 420
 *     INVALID_REQUEST with no indication of which field was at fault.
 *   - `P_PROP_TYPE_ID`, not `P_PROPERTY_TYPE_ID`. The response uses the long
 *     spelling; the request does not.
 *   - `P_TAKE` / `P_SKIP` are strings. Passing real numbers binds but fails
 *     validation, and passing "" for one of the int filters takes the upstream
 *     down with an HTML 500 rather than a JSON error.
 *   - Dates are MM/DD/YYYY and both are mandatory; there is no unbounded call.
 *   - Every row repeats the window's grand total in `TOTAL`, which is what we
 *     page against - there is no page-count field.
 *
 * There is no broker, agent or office field in the response. See the schema
 * comment on `Transaction`; deals cannot be attributed to a brokerage.
 */
import { DLD_CONSUMER_ID, DLD_GATEWAY } from "./client";

const TRANSACTIONS_ENDPOINT = `${DLD_GATEWAY}/open-data/transactions`;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * "-1" means "the whole result set in one response", which is what the portal's
 * own CSV export uses.
 *
 * Do not switch this to paging. P_SORT is not a total order, so a paged crawl
 * of July 2026 returned 18,730 of the 19,171 rows the gateway reports - 12 rows
 * lost outright and the rest mis-attributed across page boundaries - while the
 * single call returns all 19,171 and is three times faster (36s vs 114s).
 */
export const TRANSACTION_TAKE_ALL = "-1";

export const TRANSACTION_GROUPS = {
  1: "Sales",
  2: "Mortgages",
  3: "Gifts",
} as const;

export interface DldTransaction {
  RN: number;
  TOTAL: number;
  TRANSACTION_NUMBER: string | null;
  INSTANCE_DATE: string | null;
  GROUP_ID: number | null;
  GROUP_EN: string | null;
  GROUP_AR: string | null;
  PROCEDURE_ID: number | null;
  PROCEDURE_EN: string | null;
  PROCEDURE_AR: string | null;
  IS_OFFPLAN: number | null;
  IS_OFFPLAN_EN: string | null;
  IS_FREE_HOLD: number | null;
  IS_FREE_HOLD_EN: string | null;
  USAGE_ID: number | null;
  USAGE_EN: string | null;
  USAGE_AR: string | null;
  AREA_ID: number | null;
  AREA_EN: string | null;
  AREA_AR: string | null;
  PROPERTY_ID: number | null;
  PARCEL_ID: number | string | null;
  PROPERTY_TYPE_ID: number | null;
  PROP_TYPE_EN: string | null;
  PROP_TYPE_AR: string | null;
  PROPERTY_SUB_TYPE_ID: number | null;
  PROP_SB_TYPE_EN: string | null;
  PROP_SB_TYPE_AR: string | null;
  TRANS_VALUE: number | string | null;
  PROCEDURE_AREA: number | string | null;
  ACTUAL_AREA: number | string | null;
  ROOMS_EN: string | null;
  ROOMS_AR: string | null;
  PARKING: string | null;
  BUILDING_AGE: number | null;
  PROJECT_EN: string | null;
  PROJECT_AR: string | null;
  MASTER_PROJECT_EN: string | null;
  MASTER_PROJECT_AR: string | null;
  NEAREST_METRO_EN: string | null;
  NEAREST_MALL_EN: string | null;
  NEAREST_LANDMARK_EN: string | null;
  TOTAL_BUYER: number | null;
  TOTAL_SELLER: number | null;
}

interface TransactionsEnvelope {
  timeStamp: string;
  responseCode: number;
  validationErrorsList: Array<{ errorMessage?: string }> | null;
  response: { result: DldTransaction[] | null } | null;
}

export interface TransactionFilters {
  /** 1=Sales, 2=Mortgages, 3=Gifts. "" for all. */
  groupId?: string;
  isOffplan?: string;
  isFreeHold?: string;
  areaId?: string;
  usageId?: string;
  propTypeId?: string;
}

export class TransactionGatewayStats {
  requests = 0;
  errors = 0;
  retries = 0;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The gateway wants MM/DD/YYYY regardless of the portal's DD/MM/YYYY inputs. */
function toGatewayDate(date: Date): string {
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${date.getUTCFullYear()}`;
}

/** Inclusive first/last day of a YYYY-MM string, in UTC. */
export function monthBounds(month: string): { from: Date; to: Date } {
  const [year, mon] = month.split("-").map(Number);
  return {
    from: new Date(Date.UTC(year, mon - 1, 1)),
    to: new Date(Date.UTC(year, mon, 0)),
  };
}

/** Every YYYY-MM from `from` to `to`, inclusive. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

async function requestWindow(
  from: Date,
  to: Date,
  filters: TransactionFilters,
  options: { stats?: TransactionGatewayStats; retries?: number } = {},
): Promise<DldTransaction[]> {
  const retries = options.retries ?? 3;

  // Key order and string types both matter here - see the header comment.
  const payload = {
    P_FROM_DATE: toGatewayDate(from),
    P_TO_DATE: toGatewayDate(to),
    P_GROUP_ID: filters.groupId ?? "",
    P_IS_OFFPLAN: filters.isOffplan ?? "",
    P_IS_FREE_HOLD: filters.isFreeHold ?? "",
    P_AREA_ID: filters.areaId ?? "",
    P_USAGE_ID: filters.usageId ?? "",
    P_PROP_TYPE_ID: filters.propTypeId ?? "",
    P_TAKE: TRANSACTION_TAKE_ALL,
    P_SKIP: "",
    P_SORT: "TRANSACTION_NUMBER_ASC",
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (options.stats) options.stats.requests += 1;
    try {
      const response = await fetch(TRANSACTIONS_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json, */*",
          "Content-Type": "application/json; charset=UTF-8",
          Origin: "https://dubailand.gov.ae",
          Referer: "https://dubailand.gov.ae/",
          AppUser: "",
          "consumer-id": DLD_CONSUMER_ID,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: AbortSignal.timeout(180_000),
      });

      const text = await response.text();

      // A malformed payload takes the upstream down rather than returning JSON.
      if (text.trimStart().startsWith("<")) {
        throw new Error(
          `transactions returned an HTML error page (HTTP ${response.status}) - check the payload shape`,
        );
      }
      if (!response.ok) {
        throw new Error(`transactions returned ${response.status}: ${text.slice(0, 300)}`);
      }

      const envelope = JSON.parse(text) as TransactionsEnvelope;
      if (envelope.responseCode !== 200) {
        const detail = envelope.validationErrorsList?.[0]?.errorMessage ?? "unknown";
        throw new Error(
          `transactions rejected the request (code ${envelope.responseCode}, ${detail})`,
        );
      }

      return envelope.response?.result ?? [];
    } catch (error) {
      lastError = error;
      if (options.stats) {
        options.stats.errors += 1;
        options.stats.retries += 1;
      }
      if (attempt < retries) await wait(1000 * 2 ** (attempt - 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Every transaction row in one calendar month, in a single request.
 *
 * Rows are returned exactly as the gateway sends them - deliberately NOT
 * deduped. A multi-unit transaction legitimately produces several rows that
 * share a transaction number, and some of those are byte-identical to each
 * other, so any dedupe here destroys real units. See the note on
 * `Transaction` in the schema.
 */
export async function fetchTransactionsForMonth(
  month: string,
  options: {
    filters?: TransactionFilters;
    stats?: TransactionGatewayStats;
    onProgress?: (message: string) => void;
  } = {},
): Promise<{ rows: DldTransaction[]; reportedTotal: number }> {
  const { from, to } = monthBounds(month);
  const rows = await requestWindow(from, to, options.filters ?? {}, options);
  const reportedTotal = rows[0]?.TOTAL ?? 0;

  options.onProgress?.(
    `  ${month}: ${rows.length} rows (gateway reports ${reportedTotal})`,
  );

  return { rows, reportedTotal };
}
