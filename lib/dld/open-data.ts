/**
 * Shared client for every `POST /open-data/<command>` dataset.
 *
 * Nine datasets share one envelope and one set of quirks, so they share one
 * client. Everything here was established by probing the live API and by
 * reading the request builder the portal ships at /scripts/publicData.js.
 *
 * The rules, which apply to all of them:
 *
 *   - Each command accepts an exact parameter set. An unknown key, or a
 *     missing one, returns `responseCode 420 INVALID_REQUEST` naming nothing.
 *   - `P_TAKE` / `P_SKIP` are strings. `"-1"` means "the whole result set in
 *     one response", which is what the portal's CSV export uses.
 *   - Passing `""` for a parameter the backend casts to a number takes the
 *     upstream down with an HTML 500 rather than a JSON error. An HTML body is
 *     therefore a payload bug, not a transient fault, and is not retried.
 *   - Dates are MM/DD/YYYY. Whether they are mandatory varies by command.
 *   - Every row repeats the query's grand total in `TOTAL`; there is no
 *     page-count field. Rows come back with `RN` set to their position in the
 *     current response, so neither field describes the record itself.
 *
 * The public site puts a reCAPTCHA in front of these forms. The gateway does
 * not enforce it - only a browser-ish User-Agent is required - so we call the
 * gateway directly, exactly as the registry crawl does.
 */
import { DLD_CONSUMER_ID, DLD_GATEWAY } from "./client";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const OPEN_DATA_COMMANDS = [
  "transactions",
  "rents",
  "projects",
  "lands",
  "buildings",
  "units",
  "brokers",
  "developers",
  "valuations",
] as const;

export type OpenDataCommand = (typeof OPEN_DATA_COMMANDS)[number];

export const LOOKUP_COMMANDS = [
  "carea-lookup",
  "ejari-property-types",
  "projects-lookup",
] as const;

export type LookupCommand = (typeof LOOKUP_COMMANDS)[number];

/** Every row carries these two response-shaped fields. Never persist them. */
export interface OpenDataRow {
  RN?: number;
  TOTAL?: number;
  DEFAULT_SORT?: string | null;
  [key: string]: unknown;
}

interface OpenDataEnvelope {
  timeStamp?: string;
  responseCode?: number;
  validationErrorsList?: Array<{ errorMessage?: string }> | null;
  response?: { result?: OpenDataRow[] | null } | null;
}

export class OpenDataStats {
  requests = 0;
  retries = 0;
  errors = 0;
  bytes = 0;
}

/**
 * A payload the gateway will never accept, however many times we send it -
 * a wrong key, a bad cast, a malformed date. Retrying is pointless and the
 * caller needs to see it rather than watch a sync spin.
 */
export class OpenDataRequestError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "OpenDataRequestError";
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** MM/DD/YYYY, in UTC. The portal collects DD/MM/YYYY and converts. */
export function gatewayDate(date: Date): string {
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${date.getUTCFullYear()}`;
}

/** Inclusive first/last day of a YYYY-MM string, in UTC. */
export function monthBounds(month: string): { from: Date; to: Date } {
  const [year, mon] = month.split("-").map(Number);
  return { from: new Date(Date.UTC(year, mon - 1, 1)), to: new Date(Date.UTC(year, mon, 0)) };
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
    if (++m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface RequestOptions {
  stats?: OpenDataStats;
  /** Total attempts including the first. */
  attempts?: number;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

/**
 * Whether a failure is worth another attempt.
 *
 * The scheduled sync has died three times on `ENOTFOUND` - the laptop being
 * off the network at 07:19 - so DNS and connection resets are treated as
 * transient and backed off hard rather than failing the run.
 */
function isTransient(error: unknown): boolean {
  if (error instanceof OpenDataRequestError) return false;
  const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  return /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH|socket hang up|fetch failed|aborted|timeout|HTTP 5\d\d|HTTP 429/i.test(
    message,
  );
}

/**
 * One request, with backoff.
 *
 * Backoff is exponential with jitter and a 60s ceiling, so a laptop that wakes
 * up mid-run recovers instead of burning its attempts in the first 10 seconds.
 */
export async function postOpenData(
  command: OpenDataCommand | LookupCommand,
  payload: Record<string, unknown>,
  options: RequestOptions = {},
): Promise<OpenDataRow[]> {
  const { stats, attempts = 5, timeoutMs = 300_000, onProgress } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (stats) stats.requests += 1;
    try {
      const response = await fetch(`${DLD_GATEWAY}/open-data/${command}`, {
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
        signal: AbortSignal.timeout(timeoutMs),
      });

      const text = await response.text();
      if (stats) stats.bytes += text.length;

      // An HTML body means the payload broke the upstream. Permanent.
      if (text.trimStart().startsWith("<")) {
        throw new OpenDataRequestError(
          `${command}: gateway returned an HTML error page (HTTP ${response.status}) - the payload shape is wrong`,
        );
      }
      if (!response.ok) throw new Error(`${command}: HTTP ${response.status}`);

      const envelope = JSON.parse(text) as OpenDataEnvelope;
      if (envelope.responseCode !== 200) {
        const detail = envelope.validationErrorsList?.[0]?.errorMessage ?? "no detail";
        throw new OpenDataRequestError(
          `${command}: rejected with responseCode ${envelope.responseCode} (${detail}) - check the parameter set`,
        );
      }

      return envelope.response?.result ?? [];
    } catch (error) {
      lastError = error;
      if (stats) stats.errors += 1;

      if (!isTransient(error) || attempt === attempts) break;

      if (stats) stats.retries += 1;
      const backoff = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      const jittered = backoff + Math.floor(Math.random() * 1_000);
      onProgress?.(
        `    ${command}: attempt ${attempt}/${attempts} failed (${(error as Error).message.slice(0, 90)}), retrying in ${(jittered / 1000).toFixed(0)}s`,
      );
      await wait(jittered);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** The whole result set in one response. Rows are returned exactly as sent. */
export async function fetchAll(
  command: OpenDataCommand,
  params: Record<string, unknown>,
  options: RequestOptions = {},
): Promise<{ rows: OpenDataRow[]; reportedTotal: number }> {
  const rows = await postOpenData(
    command,
    { ...params, P_TAKE: "-1", P_SKIP: "", P_SORT: "" },
    options,
  );
  return { rows, reportedTotal: rows[0]?.TOTAL ?? rows.length };
}

/**
 * Page through a result set too large to ask for in one response.
 *
 * `key` gives each row its natural identity so repeats across page boundaries
 * are dropped. Only use this where paging has been shown not to lose rows -
 * `P_SORT` is not a total order on every command, and on `transactions` a
 * paged crawl silently dropped rows that the single-shot call returned.
 */
export async function fetchPaged(
  command: OpenDataCommand,
  params: Record<string, unknown>,
  options: RequestOptions & {
    pageSize?: number;
    key: (row: OpenDataRow) => string;
    maxPages?: number;
  },
): Promise<{ rows: OpenDataRow[]; reportedTotal: number }> {
  const pageSize = options.pageSize ?? 25_000;
  const maxPages = options.maxPages ?? 500;
  const seen = new Map<string, OpenDataRow>();
  let reportedTotal = 0;
  let skip = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const rows = await postOpenData(
      command,
      { ...params, P_TAKE: String(pageSize), P_SKIP: String(skip), P_SORT: "" },
      options,
    );
    if (rows.length === 0) break;

    reportedTotal = rows[0]?.TOTAL || reportedTotal;
    for (const row of rows) seen.set(options.key(row), row);

    options.onProgress?.(
      `    ${command}: +${rows.length} rows, ${seen.size}/${reportedTotal || "?"} unique`,
    );

    skip += pageSize;
    if (reportedTotal > 0 && skip >= reportedTotal) break;
  }

  return { rows: [...seen.values()], reportedTotal };
}

/** Lookup dictionaries take no parameters and are small. */
export async function fetchLookup(
  command: LookupCommand,
  options: RequestOptions = {},
): Promise<OpenDataRow[]> {
  return postOpenData(command, {}, options);
}

/** Strip the response-shaped fields before hashing or persisting a row. */
export function stableRow(row: OpenDataRow): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...row };
  delete copy.RN;
  delete copy.TOTAL;
  delete copy.DEFAULT_SORT;
  return copy;
}
