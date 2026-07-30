import { Client, isNotionClientError, APIErrorCode } from "@notionhq/client";

/**
 * Thin wrapper over the official Notion SDK.
 *
 * This is a plain REST integration — it does not depend on Claude, an MCP
 * server, or any interactive session. It needs one thing: an internal
 * integration token in NOTION_TOKEN, with the five CRM databases shared to that
 * integration. See docs/NOTION_INTEGRATION.md.
 */

export const NOTION_DB = {
  brokerages: process.env.NOTION_DB_BROKERAGES ?? "8c219ef5-cf6e-417a-8923-a0fb9786bf9b",
  brokers: process.env.NOTION_DB_BROKERS ?? "54d4974a-39f0-4cfb-99f1-93b4165bd8cf",
  batches: process.env.NOTION_DB_BATCHES ?? "495c35fc-1a8d-484e-9aaf-01de1609cf36",
  targets: process.env.NOTION_DB_TARGETS ?? "be966f82-7a4a-4828-bf23-00799888d302",
  activity: process.env.NOTION_DB_ACTIVITY ?? "451e6953-eab9-4c6b-b3dd-87647aba2a12",
} as const;

export const NOTION_PARENT_PAGE =
  process.env.NOTION_PARENT_PAGE ?? "3aa72683-9438-81f7-8f05-f8785cb4230d";

let cached: Client | null = null;

export class NotionNotConfiguredError extends Error {
  constructor() {
    super(
      "NOTION_TOKEN is not set. Create an internal integration at " +
        "https://www.notion.so/my-integrations, share the Homeey DXB CRM page " +
        "with it, and put the secret in .env. See docs/NOTION_INTEGRATION.md.",
    );
    this.name = "NotionNotConfiguredError";
  }
}

export function isNotionConfigured(): boolean {
  return Boolean(process.env.NOTION_TOKEN);
}

export function notion(): Client {
  if (!process.env.NOTION_TOKEN) throw new NotionNotConfiguredError();
  if (!cached) {
    cached = new Client({
      auth: process.env.NOTION_TOKEN,
      // The SDK retries 429s itself; give it room before we add our own backoff.
      timeoutMs: 60_000,
    });
  }
  return cached;
}

export class NotionStats {
  requests = 0;
  errors = 0;
  retries = 0;
  rateLimited = 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Notion allows roughly 3 requests/second per integration. Exceeding it earns a
 * 429 and, sustained, a temporary block — so we pace deliberately rather than
 * relying on retries to sort it out.
 */
const MIN_REQUEST_INTERVAL_MS = Number(process.env.NOTION_MIN_INTERVAL_MS ?? 340);
let lastRequestAt = 0;

async function pace() {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/**
 * Run a Notion call with pacing, retry and rate-limit handling.
 *
 * Retries only what is worth retrying: rate limits, timeouts and 5xx. A
 * validation error means our payload is wrong and will be wrong every time, so
 * it throws immediately with the offending context attached.
 */
export async function withNotion<T>(
  label: string,
  fn: () => Promise<T>,
  stats?: NotionStats,
  maxAttempts = 4,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await pace();
    if (stats) stats.requests++;

    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (isNotionClientError(err)) {
        const code = (err as { code?: string }).code;

        // Permanent — retrying cannot help.
        if (
          code === APIErrorCode.ValidationError ||
          code === APIErrorCode.ObjectNotFound ||
          code === APIErrorCode.Unauthorized ||
          code === APIErrorCode.RestrictedResource
        ) {
          if (stats) stats.errors++;
          throw new Error(`Notion ${label} failed (${code}): ${err.message}`);
        }

        if (code === APIErrorCode.RateLimited) {
          if (stats) stats.rateLimited++;
          // Honour Retry-After when Notion sends one.
          const retryAfter = Number(
            (err as { headers?: Record<string, string> }).headers?.["retry-after"] ?? 0,
          );
          await sleep(retryAfter > 0 ? retryAfter * 1000 : 2000 * attempt);
          if (stats) stats.retries++;
          continue;
        }
      }

      if (attempt < maxAttempts) {
        if (stats) stats.retries++;
        await sleep(1000 * attempt);
        continue;
      }
    }
  }

  if (stats) stats.errors++;
  throw lastError instanceof Error
    ? new Error(`Notion ${label} failed after ${maxAttempts} attempts: ${lastError.message}`)
    : new Error(`Notion ${label} failed: ${String(lastError)}`);
}

/** Page every row of a Notion database, honouring an optional filter. */
export async function queryAll(
  databaseId: string,
  options: {
    filter?: Record<string, unknown>;
    sorts?: Array<Record<string, unknown>>;
    stats?: NotionStats;
    pageSize?: number;
  } = {},
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;

  do {
    const res = await withNotion(
      `query ${databaseId}`,
      () =>
        notion().databases.query({
          database_id: databaseId,
          start_cursor: cursor,
          page_size: options.pageSize ?? 100,
          ...(options.filter ? { filter: options.filter as never } : {}),
          ...(options.sorts ? { sorts: options.sorts as never } : {}),
        }),
      options.stats,
    );

    out.push(...(res.results as Array<Record<string, unknown>>));
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return out;
}
