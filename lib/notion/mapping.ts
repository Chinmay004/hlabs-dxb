import { createHash } from "node:crypto";

/**
 * FIELD OWNERSHIP — the single most important contract in the CRM.
 *
 * Every property in Notion belongs to exactly one side:
 *
 *   SYSTEM  Postgres owns it. The push writes it on every sync and will happily
 *           overwrite whatever a human typed. Registry facts, scores, batch
 *           scheduling, delay state.
 *
 *   HUMAN   Notion owns it. The pull reads it back into Postgres. The push must
 *           NEVER include it — doing so would erase the team's work on the next
 *           run.
 *
 * The two lists below are the enforcement point. `assertOwnership` runs on every
 * push payload in development and throws if a human field ever leaks in, so the
 * mistake is caught in a test run rather than silently wiping a week of notes.
 *
 * If you add a property in Notion, add it to exactly one of these lists.
 */

export const BROKERAGE_SYSTEM_FIELDS = [
  "Brokerage",
  "RERA No",
  "Lead Score",
  "Tier",
  "Licensed On",
  "Licence Expires",
  "Brokers",
  "New Brokers 30d",
  "Contact Name",
  "Email",
  "Mobile",
  "Office Phone",
  "WhatsApp",
  "Website",
  "Instagram",
  "LinkedIn",
  "Digital Gaps",
  "RERA Rank",
  "Activities",
  "Batch",
  "Synced At",
] as const;

export const BROKERAGE_HUMAN_FIELDS = [
  "Stage",
  "Owner",
  "Channel",
  "Last Contacted",
  "Touchpoints",
  "Next Action",
  "Next Action Date",
  "Client Potential",
  "Services Interest",
  "Deal Value (AED)",
  "Lost Reason",
  "Notes",
] as const;

export const BROKER_SYSTEM_FIELDS = [
  "Broker",
  "Card No",
  "Brokerage",
  "Brokerage Name",
  "New Licence",
  "Card Issued",
  "Card Expires",
  "Discovered",
  "Email",
  "Mobile",
  "Card Rank",
  "Lead Score",
  "Tier",
  "Batch",
  "Synced At",
] as const;

export const BROKER_HUMAN_FIELDS = [
  "Stage",
  "Owner",
  "Channel",
  "Last Contacted",
  "Touchpoints",
  "Next Action",
  "Next Action Date",
  "Client Potential",
  "Lost Reason",
  "Notes",
] as const;

export const BATCH_SYSTEM_FIELDS = [
  "Batch Code",
  "Type",
  "Delay Status",
  "Size",
  "Worked",
  "Assigned Date",
  "Due Date",
  "Completed Date",
  "Days Overdue",
  "Cascade Delay Days",
  "Blocked By",
  "Priority Band",
  "Avg Lead Score",
  "Synced At",
] as const;

/** `Status` is shared: humans drive it, but the engine forces Delayed/Completed
 *  when the facts demand it. It is pushed AND pulled — see docs/CRM_PROTOCOL.md. */
export const BATCH_HUMAN_FIELDS = [
  "Status",
  "Assigned To",
  "Assigned Name",
  "Notes",
] as const;

export const TARGET_SYSTEM_FIELDS = [
  "Period",
  "Type",
  "Start",
  "End",
  "Actual Touches",
  "Actual Batches",
  "Actual Replies",
  "Actual Meetings",
  "Status",
  "Synced At",
] as const;

export const TARGET_HUMAN_FIELDS = [
  "Target Touches",
  "Target Batches",
  "Target Replies",
  "Target Meetings",
  "Notes",
] as const;

const HUMAN_BY_DB: Record<string, readonly string[]> = {
  brokerages: BROKERAGE_HUMAN_FIELDS,
  brokers: BROKER_HUMAN_FIELDS,
  // Batch Status is deliberately pushable; the rest of the human set is not.
  batches: BATCH_HUMAN_FIELDS.filter((f) => f !== "Status"),
  targets: TARGET_HUMAN_FIELDS,
};

/**
 * Guard against a human-owned field ever appearing in a push payload.
 * Throws loudly — this is a data-loss bug, not a warning.
 */
export function assertOwnership(
  db: keyof typeof HUMAN_BY_DB,
  props: Record<string, unknown>,
) {
  const human = HUMAN_BY_DB[db];
  const leaked = Object.keys(props).filter((k) => human.includes(k));
  if (leaked.length > 0) {
    throw new Error(
      `Ownership violation: tried to push human-owned field(s) [${leaked.join(", ")}] ` +
        `to the ${db} database. These belong to the team in Notion and would be ` +
        `overwritten. See docs/CRM_PROTOCOL.md.`,
    );
  }
}

// --------------------------------------------------------------- value helpers

export const title = (v: string | null | undefined) => ({
  title: [{ text: { content: (v ?? "—").slice(0, 2000) } }],
});

export const richText = (v: string | null | undefined) =>
  v == null || v === ""
    ? { rich_text: [] }
    : { rich_text: [{ text: { content: String(v).slice(0, 2000) } }] };

export const number = (v: number | null | undefined) => ({
  number: v == null || Number.isNaN(v) ? null : v,
});

export const checkbox = (v: boolean | null | undefined) => ({ checkbox: Boolean(v) });

export const select = (v: string | null | undefined) => ({
  select: v ? { name: v } : null,
});

export const multiSelect = (vals: Array<string | null | undefined>) => ({
  multi_select: vals.filter((v): v is string => Boolean(v)).map((name) => ({ name })),
});

export const date = (v: Date | null | undefined) => ({
  date: v ? { start: v.toISOString().slice(0, 10) } : null,
});

export const dateTime = (v: Date | null | undefined) => ({
  date: v ? { start: v.toISOString() } : null,
});

export const email = (v: string | null | undefined) => ({ email: v || null });

/** Notion rejects phone numbers over 200 chars and empty strings alike. */
export const phone = (v: string | null | undefined) => ({
  phone_number: v ? String(v).slice(0, 200) : null,
});

/** Notion rejects anything that is not a real URL, so drop what will not parse. */
export const url = (v: string | null | undefined) => {
  if (!v) return { url: null };
  try {
    const parsed = new URL(v);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { url: null };
    return { url: v.slice(0, 2000) };
  } catch {
    return { url: null };
  }
};

export const relation = (ids: Array<string | null | undefined>) => ({
  relation: ids.filter((id): id is string => Boolean(id)).map((id) => ({ id })),
});

// -------------------------------------------------------------- read helpers

type NotionProps = Record<string, Record<string, unknown>>;

export function readText(props: NotionProps, key: string): string | null {
  const p = props[key];
  if (!p) return null;
  const arr = (p.rich_text ?? p.title) as Array<{ plain_text?: string }> | undefined;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const text = arr.map((t) => t.plain_text ?? "").join("").trim();
  return text || null;
}

export function readSelect(props: NotionProps, key: string): string | null {
  const p = props[key];
  const sel = p?.select as { name?: string } | null | undefined;
  return sel?.name ?? null;
}

export function readMultiSelect(props: NotionProps, key: string): string[] {
  const p = props[key];
  const arr = p?.multi_select as Array<{ name: string }> | undefined;
  return Array.isArray(arr) ? arr.map((o) => o.name) : [];
}

export function readNumber(props: NotionProps, key: string): number | null {
  const p = props[key];
  const n = p?.number;
  return typeof n === "number" ? n : null;
}

export function readCheckbox(props: NotionProps, key: string): boolean {
  return Boolean(props[key]?.checkbox);
}

export function readDate(props: NotionProps, key: string): Date | null {
  const p = props[key];
  const d = p?.date as { start?: string } | null | undefined;
  if (!d?.start) return null;
  // Notion returns bare dates for date-only properties; anchor them to UTC so
  // they land on the same calendar day the user picked.
  const iso = d.start.length === 10 ? `${d.start}T00:00:00.000Z` : d.start;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function readPeople(
  props: NotionProps,
  key: string,
): { id: string | null; name: string | null } {
  const p = props[key];
  const arr = p?.people as Array<{ id?: string; name?: string }> | undefined;
  if (!Array.isArray(arr) || arr.length === 0) return { id: null, name: null };
  return { id: arr[0].id ?? null, name: arr[0].name ?? null };
}

export function readRelationIds(props: NotionProps, key: string): string[] {
  const p = props[key];
  const arr = p?.relation as Array<{ id: string }> | undefined;
  return Array.isArray(arr) ? arr.map((r) => r.id) : [];
}

/**
 * Properties excluded from the hash.
 *
 *   "Synced At"   changes every run by construction; including it would make
 *                 every row look dirty forever.
 *   the rest      are seeded once when a page is created and never pushed
 *                 again. Hashing them would make the creating run and the run
 *                 after it disagree, costing one pointless rewrite per row.
 */
const HASH_IGNORED = new Set([
  "Synced At",
  "Stage",
  "Target Touches",
  "Target Batches",
  "Target Replies",
  "Target Meetings",
]);

/**
 * Deterministic JSON with keys sorted at every level.
 *
 * Do NOT reach for `JSON.stringify(value, Object.keys(value).sort())` here. The
 * second argument is a replacer *array*, which Notion-shaped payloads fail
 * badly: it whitelists those key names at every nesting level, so a value like
 * `{ date: { start: "..." } }` serialises to `{}` and the hash ends up encoding
 * only the set of property names. That silently skips rows whose values changed
 * and re-pushes rows whose value set merely gained a key.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/**
 * Stable hash of a push payload. Stored on the row so the next sync can skip
 * rows whose system fields have not changed — with ~10k brokerages and a 3 rps
 * rate limit, rewriting unchanged rows would make a full push take an hour.
 */
export function payloadHash(props: Record<string, unknown>): string {
  const hashable = Object.fromEntries(
    Object.entries(props).filter(([k]) => !HASH_IGNORED.has(k)),
  );
  return createHash("sha1").update(stableStringify(hashable)).digest("hex");
}
