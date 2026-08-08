<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# hlabs-dxb — agent brief

Two systems in one repo:

1. **Registry mirror** — crawls the Dubai Land Department gateway into Postgres
   and serves an analytics dashboard. See [README.md](./README.md).
2. **Outreach CRM** — turns those leads into batched daily work in Notion. See
   [docs/CRM_PROTOCOL.md](./docs/CRM_PROTOCOL.md).

## Before you change anything

| If you are touching… | Read first |
|---|---|
| `lib/dld/**`, the registry crawl or scoring | [README.md](./README.md) |
| `lib/dld/transactions-*`, anything summing transaction value | **[README.md § Transactions: two traps](./README.md#transactions-two-traps-worth-knowing-before-you-query)** |
| `lib/crm/**`, `lib/notion/**`, CRM tables | **[docs/CRM_PROTOCOL.md](./docs/CRM_PROTOCOL.md)** |
| Notion setup, tokens, database IDs | [docs/NOTION_INTEGRATION.md](./docs/NOTION_INTEGRATION.md) |

## Non-negotiables

Documented in full in the files above. The short version:

- **Field ownership is enforced, not advisory.** Notion properties are either
  system-owned (push overwrites them) or human-owned (push must never send
  them). `assertOwnership()` throws on violation. Never weaken it to silence an
  error.
- **Sync order is pull → engines → push.** Reordering silently overwrites the
  sales team's work.
- **One pipeline vocabulary.** `STAGES` in `lib/crm/config.ts` is used verbatim
  by Postgres, the dashboard and Notion. Do not add a translation layer.
- **All dates are UTC calendar days.** The registry publishes naive Dubai
  wall-clock stored against UTC. A bare `::date` cast on a `timestamptz`, or a
  local-timezone `getDate()`, will shift records into the wrong day.
- **Pushes must be idempotent.** Two consecutive `npm run crm` runs must produce
  zero writes on the second. Anything time-varying in a payload defeats the
  hash-skip and burns the Notion rate limit.
- **Broker "new" means `isNewCard`, not a recent `cardIssueDate`.** Card issue
  dates move on annual renewal. The README explains why the obvious
  reconstruction from card numbering does not work.

- **Transactions are units, not deals.** Never `SUM(transValueAed)` without
  `WHERE "isPrimaryUnit"` — a multi-unit transaction repeats its whole value on
  every unit row, and the unguarded total runs ~3.4% high. Deal counts are
  `count(where isPrimaryUnit)`; `count(*)` is a unit count. Recompute the
  grouping globally via `recomputeDealGrouping()`, never per month.

- **Transactions carry no broker attribution.** There is no field linking a
  deal to a brokerage or agent, so no `Office`/`Broker` relation can exist on
  `Transaction`. If asked for a firm's sales volume, the answer is that DLD
  open data cannot provide it — do not invent a join.

- **Never join open-data sets on the gateway's id columns.** `AREA_ID`,
  `PROPERTY_ID`, `USAGE_ID` and the rest are returned as `0`. Join on names
  (`areaEn`, `projectEn`) and the surviving keys (`parcelId`, `projectNumber`,
  `brokerNumber`, `realEstateNumber`). `scripts/mapping-report.ts` prints the
  current match rate for every link — check it before building on a join.

- **`parcelId` is not unique in `lands`.** Measuring coverage with a `LEFT JOIN`
  counts join output, not source rows, and inflates the answer by ~300×. Use
  `EXISTS`.

- **The gateway serves the current calendar year only.** 2025 and earlier
  return zero rows for transactions, rents and valuations, and a multi-year
  window returns the same count as the current year alone. Do not add retry or
  paging logic to "fix" an empty historical window — there is nothing there.
  Pre-2026 history requires Dubai Pulse credentials; see the README.

- **One open-data sync per dataset at a time.** `replace` mode reads, deletes,
  then inserts; two overlapping runs both see an empty table and both insert.
  `runOpenDataSync` refuses to start if a RUNNING row exists — do not remove
  that guard. Stale rows are cleared by `reapStuckRuns()`.

## Verifying a change without side effects

```bash
npm run crm:engines     # batching + targets, Notion untouched
npm run crm:pull        # reads Notion, still writes nothing to it
npm run db:rederive     # recompute scores/stats without re-crawling
npx tsc --noEmit
```

Run `crm:engines` before `crm` whenever you change batching or delay logic.
