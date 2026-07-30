/**
 * Client for the public Dubai Land Department gateway.
 *
 * Two endpoints carry everything we need:
 *
 *   GET /offices/   every licensed brokerage (~10.2k rows)
 *   GET /brokers/   every licensed broker card (~34k rows)
 *
 * Both share the same envelope and the same paging contract. Notable quirks,
 * all established by probing the live API:
 *
 *   - Only `consumer-id` is required. No cookie, no auth header.
 *   - The page cursor is `pageIndex` (0-based). `pageNumber`, `page`, `offset`
 *     and friends are silently ignored, so a wrong name yields page 0 forever.
 *   - `pageSize` caps out around 2000 and the server occasionally returns one
 *     or two fewer rows than asked for, and repeats a handful across page
 *     boundaries. Callers must dedupe by primary key rather than trust counts.
 *   - There is no sort or date-range parameter. Full crawl is the only way to
 *     get a consistent snapshot - which is cheap: ~45 requests for both sets.
 *   - Requests without a browser-ish User-Agent get a 403.
 */

export const DLD_GATEWAY = "https://gateway.dubailand.gov.ae";

export const DLD_CONSUMER_ID =
  process.env.DLD_CONSUMER_ID ?? "gkb3WvEG0rY9eilwXC0P2pTz8UzvLj9F";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Server starts shedding load above this; 1000 is the reliable sweet spot. */
export const PAGE_SIZE = 1000;

export interface DldEnvelope<T> {
  Response: T[] | null;
  TimeStamp: string;
  Errors: unknown[];
  ExceptionId: string | null;
  Token: string | null;
  TotalRowsCount: number;
}

export interface DldOffice {
  RowIndex: number;
  TotalRowsCount: number;
  RealEstateNumber: string;
  LicenseNumber: string | null;
  OfficeNameAr: string | null;
  OfficeNameEn: string | null;
  OfficeIssueDate: string | null;
  OfficeExpiryDate: string | null;
  OfficeFax: string | null;
  OfficePhone: string | null;
  OfficeWebSite: string | null;
  ContactPersonNameAr: string | null;
  ContactPersonNameEn: string | null;
  ContactPersonMobile: string | null;
  ContactPersonEmail: string | null;
  OfficeLogo: string | null;
  OfficeRankId: number | null;
  OfficeRank: string | null;
  AwardsCount: number | null;
  YouTubeUrl: string | null;
  FaceBookUrl: string | null;
  InstagramUrl: string | null;
  TwitterUrl: string | null;
  LinkedInUrl: string | null;
  WhatsAppBusinessNumber: string | null;
  Activities: Array<{
    ActivityId: number;
    ActivityNameAr: string | null;
    ActivityNameEn: string | null;
  }> | null;
}

export interface DldBroker {
  RowIndex: number;
  TotalRowsCount: number;
  CardNumber: string;
  CardHolderNameAr: string | null;
  CardHolderNameEn: string | null;
  CardIssueDate: string | null;
  CardExpiryDate: string | null;
  CardHolderPhone: string | null;
  CardHolderMobile: string | null;
  CardHolderEmail: string | null;
  RealEstateNumber: string | null;
  LicenseNumber: string | null;
  OfficeNameAr: string | null;
  OfficeNameEn: string | null;
  OfficeIssueDate: string | null;
  OfficeExpiryDate: string | null;
  CardHolderPhoto: string | null;
  OfficeLogo: string | null;
  OfficeRankId: number | null;
  OfficeRank: string | null;
  CardRankId: number | null;
  CardRank: string | null;
  AwardsCount: number | null;
}

export class DldStats {
  requests = 0;
  errors = 0;
  retries = 0;
}

export interface FetchOptions {
  stats?: DldStats;
  timeoutMs?: number;
  maxAttempts?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(
  path: string,
  params: Record<string, string | number>,
  opts: FetchOptions = {},
): Promise<DldEnvelope<T>> {
  const { stats, timeoutMs = 90_000, maxAttempts = 5 } = opts;

  const url = new URL(path, DLD_GATEWAY);
  url.searchParams.set("consumer-id", DLD_CONSUMER_ID);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (stats) stats.requests++;

      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.pathname}`);

      return (await res.json()) as DldEnvelope<T>;
    } catch (err) {
      lastError = err;
      if (stats) stats.retries++;
      // The gateway rate-limits under sustained load; back off rather than hammer.
      if (attempt < maxAttempts) await sleep(1500 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  if (stats) stats.errors++;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Walk every page of an endpoint and return deduped rows.
 *
 * Stops when a page comes back empty or when we have paged past TotalRowsCount.
 * `pageIndex` is 0-based.
 */
async function crawlAll<T>(
  path: string,
  key: (row: T) => string,
  opts: FetchOptions & {
    pageSize?: number;
    extraParams?: Record<string, string | number>;
    onProgress?: (info: {
      page: number;
      pageRows: number;
      unique: number;
      total: number;
    }) => void;
  } = {},
): Promise<{ rows: T[]; reportedTotal: number }> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const seen = new Map<string, T>();
  let reportedTotal = 0;
  let page = 0;

  // Hard ceiling so a paging regression can never turn into an infinite loop.
  const maxPages = 500;

  while (page < maxPages) {
    const env = await request<T>(
      path,
      { pageSize, pageIndex: page, ...(opts.extraParams ?? {}) },
      opts,
    );

    const rows = env.Response ?? [];
    reportedTotal = env.TotalRowsCount || reportedTotal;

    if (rows.length === 0) break;

    for (const row of rows) seen.set(key(row), row);

    opts.onProgress?.({
      page,
      pageRows: rows.length,
      unique: seen.size,
      total: reportedTotal,
    });

    // We have everything the server says exists. This is the normal exit for a
    // single-office lookup and saves a wasted round trip on each of the
    // thousands of them a reconcile pass makes.
    if (reportedTotal > 0 && seen.size >= reportedTotal) break;

    page++;

    // Do NOT treat a short page as the end: the gateway routinely returns a
    // handful fewer rows than asked for, and repeats a few across boundaries,
    // in the middle of the result set. Only an empty page, a complete set, or
    // exhausting the reported total ends the crawl. Two pages of slack absorb
    // the drift the duplicates introduce.
    if (page * pageSize >= reportedTotal + 2 * pageSize) break;
  }

  return { rows: [...seen.values()], reportedTotal };
}

export function fetchAllOffices(
  opts?: Parameters<typeof crawlAll>[2],
): Promise<{ rows: DldOffice[]; reportedTotal: number }> {
  return crawlAll<DldOffice>("/offices/", (o) => o.RealEstateNumber, opts);
}

export function fetchAllBrokers(
  opts?: Parameters<typeof crawlAll>[2],
): Promise<{ rows: DldBroker[]; reportedTotal: number }> {
  return crawlAll<DldBroker>("/brokers/", (b) => b.CardNumber, opts);
}

/** Single brokerage by its RERA real-estate number. */
export async function fetchOffice(
  realEstateNumber: string,
  opts?: FetchOptions,
): Promise<DldOffice | null> {
  const env = await request<DldOffice>(
    "/offices/",
    { officeNumber: realEstateNumber, pageSize: 5 },
    opts,
  );
  return env.Response?.[0] ?? null;
}

/** Single broker by card number. */
export async function fetchBrokerByCard(
  cardNumber: string | number,
  opts?: FetchOptions,
): Promise<DldBroker | null> {
  const env = await request<DldBroker>(
    "/brokers/",
    { cardNumber, pageSize: 5 },
    opts,
  );
  const rows = env.Response ?? [];
  // An unknown cardNumber falls back to an unfiltered listing, so verify the
  // row we got back is actually the card we asked for.
  const match = rows.find((r) => String(r.CardNumber) === String(cardNumber));
  return match ?? null;
}

/** Every broker attached to one brokerage. */
export async function fetchBrokersForOffice(
  realEstateNumber: string,
  opts?: FetchOptions,
): Promise<DldBroker[]> {
  const { rows } = await crawlAll<DldBroker>(
    "/brokers/",
    (b) => b.CardNumber,
    { ...opts, pageSize: 500, extraParams: { officeNumber: realEstateNumber } },
  );
  return rows.filter((r) => r.RealEstateNumber === realEstateNumber);
}

/** Run `fn` over `items` with bounded concurrency. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}
