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

## Verifying a change without side effects

```bash
npm run crm:engines     # batching + targets, Notion untouched
npm run crm:pull        # reads Notion, still writes nothing to it
npm run db:rederive     # recompute scores/stats without re-crawling
npx tsc --noEmit
```

Run `crm:engines` before `crm` whenever you change batching or delay logic.
