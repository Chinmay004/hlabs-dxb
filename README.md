# DXB Registry

A daily mirror of the Dubai Land Department / RERA real-estate registry, built to
answer one question well: **which brokerages just opened, and which brokers just
got licensed?** Those are the leads we pitch brokerage and broker solutions to.

Next.js 16 (App Router) + Postgres via Prisma. Sync engine, API and dashboard all
live in this one project.

---

## The data source

Everything comes from the public gateway at `gateway.dubailand.gov.ae`. It needs
no login; the registry endpoints use a `consumer-id` query parameter, while the
projects endpoint uses the same value as a request header.

| Endpoint              | Rows         | What it gives you |
| --------------------- | ------------ | ----------------- |
| `/offices/`           | ~10,200      | Every licensed brokerage: licence dates, contact person, email, mobile, website, socials, WhatsApp, RERA rank, licensed activities |
| `/brokers/`           | ~34,000      | Every broker card: name, card issue/expiry, direct email + mobile, and the firm they sit under |
| `/open-data/projects` | 815 observed | Project identity, developer, area/zone, lifecycle dates, status, completion, value, escrow and unit counts for the selected date window |

### Quirks, all found by probing the live API

- **The page cursor is `pageIndex`, 0-based.** `pageNumber`, `page`, `offset`,
  `skip` and friends are silently ignored, so a wrong name pages forever on
  page 0.
- **`pageSize` tops out near 2000**, and the server returns a handful fewer rows
  than requested while repeating a few across page boundaries. A crawl must
  dedupe by primary key and must not treat a short page as the last page.
- **There is no sort and no date filter.** A full crawl is the only way to get a
  consistent snapshot — which is cheap, about 45 requests for both sets.
- **Filters that do work:** `officeNumber=<RERA no>` on both endpoints, and
  `cardNumber=<n>` on `/brokers/`. An unmatched `officeNumber` returns empty
  (it does not fall back to the full list); an *unrecognised parameter name*
  is ignored and you get the unfiltered list back.
- **No cookie or session is required.** A browser-ish `User-Agent` is — plain
  clients get a 403.

- **Projects use a POST body and four date selectors.** We call the current
  calendar-year window once each for start, end, adoption and completion dates,
  then deduplicate by project number. The first live import made four calls,
  received 1,100 rows and stored 815 unique projects. This is date-window
  coverage, not a claim that 815 is the full historical project registry.

---

## New brokerages are easy. New brokers are not.

**Brokerages are exact for the full history.** `Office.issueDate` is the original
RERA licence date and never moves, so "which firms opened in March" is just a
date filter. That is the primary signal and it works from the first sync.

**Broker cards are the hard case.** The registry publishes only a card's
*current term* — an annual renewal overwrites `CardIssueDate` — so a naive "cards
issued today" count mixes brand-new brokers in with everyone who happened to
renew. On a typical day the renewals outnumber the real signal several times
over (e.g. 722 cards stamped in July 2026, most of them renewals).

There is an obvious-looking trick here, and it does not work. Card numbers appear
chronological, which suggests: for each card `N`, take the minimum
`cardIssueDate` over all cards numbered `>= N`. Renewals only push dates later,
so that bounds `N`'s first issue and is exact for cards never renewed.

**The registry does not honour that ordering.** Card 39426 carries `2001-04-21`
while card 8515 carries `2010-01-17`, and there are more like it. A suffix
minimum has zero resistance to that — one stale outlier drags every
lower-numbered card down with it. Implemented against real data it collapsed the
series onto a handful of step dates and left entire months reading zero. The
number/date relationship holds in aggregate (median issue date climbs cleanly
across number bands) but not per row, and lead lists are read per row.

So new-vs-renewal is decided by **`Broker.isNewCard`**: at insert time we compare
the card number against a high-water mark recorded by our own previous sync.
That is exact — and only meaningful from the second sync onward, which the UI
states plainly rather than showing a confident zero.

Every row also carries `firstSeenAt` / `lastSeenAt`, so from day two we know
exactly what appeared and what vanished regardless of what the registry claims.

The short version: **history of brokerages, yes. History of individual broker
licences, no — that starts the day you begin syncing.**

---

## Setup

```bash
npm install
```

Create `.env` (see `.env.example`):

```
DATABASE_URL="postgresql://postgres:PASSWORD@localhost:5432/hlabsdxb?schema=public"
DLD_CONSUMER_ID="gkb3WvEG0rY9eilwXC0P2pTz8UzvLj9F"
SYNC_SECRET="some-random-string"
```

Then:

```bash
npm run db:push
npm run sync
npm run projects:sync
npm run dev
```

The first sync takes a few minutes and pulls the full registry.

---

## Commands

| Command                    | What it does                                                                    |
| -------------------------- | ------------------------------------------------------------------------------- |
| `npm run dev`              | Dashboard on http://localhost:3000                                              |
| `npm run sync`             | Full crawl + roster reconcile for brokerages licensed in the past year          |
| `npm run sync:deep`        | Same, but reconciles rosters for **every** brokerage (~10k requests, run weekly) |
| `npm run projects:sync`    | Import this calendar year's projects across all four DLD date selectors          |
| `npm run projects:sync:scheduled` | Scheduled-mode project import with idempotent upserts                    |
| `npm run schedule:install` | Register the registry, CRM and project jobs with Windows Task Scheduler           |
| `npm run schedule:status`  | Show last / next run                                                            |
| `npm run schedule:remove`  | Unregister both jobs                                                            |
| `npm run db:studio`        | Prisma Studio                                                                   |
| `npm run db:rederive`      | Recompute rollups, lead scores and daily stats without re-crawling               |
| `npm run db:reset -- --yes`| Wipe the mirror (including the CRM overlay) and start over                       |

Scheduled registry jobs write to `logs/sync-daily.log` and
`logs/sync-deep.log`; the project task writes to `logs/projects-sync.log`.

---

## How a sync works

1. **Crawl `/offices/`** — page through, dedupe, upsert. Diff each tracked field
   against what we already had and write an `OfficeChange` row per edit.
2. **Crawl `/brokers/`** — same, into `Broker` / `BrokerChange`. Offices that
   appear only on a broker row (paging drops a couple every crawl) get stubbed in
   first so the foreign key holds.
3. **Reconcile rosters** — bulk paging lands ~0.1% short, so we re-pull broker
   lists one office at a time via `?officeNumber=`, which has no such drift.
   This is the slow stage, roughly a second per brokerage, so by default it
   covers only firms licensed in the last 180 days plus any firm with zero
   brokers — the ones we actually sell to — capped at 1200. Tune with
   `RECONCILE_WINDOW_DAYS` / `RECONCILE_MAX_OFFICES` / `RECONCILE_CONCURRENCY`,
   or run `npm run sync:deep` weekly to cover every brokerage.
4. **Deactivate** anything that did not appear in this run (`isActive = false`).
5. **Derive** — per-office rollups, lead scores, and the `daily_stats` fact
   table. Run standalone with `npm run db:rederive` after changing any of that
   logic; it takes seconds instead of re-crawling.

Concurrent runs are refused server-side; a full sync moves the `lastSeenAt`
watermark and two at once could deactivate live rows.

---

## Lead scoring

0–100, recomputed every sync (`recomputeLeadScores` in `lib/dld/derive.ts`).
Weighted for what actually makes a brokerage worth a call:

| Signal           | Max | Why                                                                     |
| ---------------- | --- | ----------------------------------------------------------------------- |
| **Freshness**    | 40  | Licensed this month = buying tools right now                            |
| **Size**         | 22  | Zero or a handful of brokers: owner still decides, nothing entrenched   |
| **Digital gap**  | 20  | No website / Instagram / WhatsApp — the gap *is* the pitch              |
| **Reachability** | 10  | We have an email or mobile to actually use                             |
| **Momentum**     | 8   | Hiring brokers now means budget and growth                             |

Tiers: `A+` ≥ 80, `A` ≥ 68, `B` ≥ 55, `C` ≥ 40, else `D`.

Tune the weights in one SQL block; the whole registry rescores in a second.

---

## Pages

| Route          | What it's for                                                                 |
| -------------- | ----------------------------------------------------------------------------- |
| `/`            | KPIs, 90-day chart, newest brokerages, size and tier distributions            |
| `/daily`       | **Date-wise table** — how many licensed per day/week/month, click through to that day's list |
| `/brokerages`  | Full filterable table: date ranges, size, tier, rank, has-website/email/mobile, expiry |
| `/brokers`     | Same for broker cards, with the renewal-vs-new distinction surfaced           |
| `/projects`    | DLD projects with status, developer, geography, date/month/year, completion, value, unit and escrow filters |
| `/leads`       | Five pre-built segments, each with its own pitch angle                        |
| `/activity`    | Newly discovered rows, broker moves between firms, field-level change feed     |
| `/sync`        | Run history, manual trigger, scheduling notes                                 |

Every filter lives in the URL, so any view can be shared as a link or handed
straight to the CSV export.

---

## API

| Route                        | Notes                                                        |
| ---------------------------- | ------------------------------------------------------------ |
| `GET /api/stats`             | Overview KPIs, timeseries, distributions                     |
| `GET /api/offices`           | Paginated, all the same filters as the UI                    |
| `GET /api/offices/[id]`      | One brokerage with roster and change history                 |
| `PATCH /api/offices/[id]`    | Update our CRM `status` / `ownerNote`                        |
| `GET /api/brokers`           | Paginated broker cards                                       |
| `GET /api/projects`          | Paginated projects with the same rich filters as the UI      |
| `GET /api/projects/[id]`     | One project with every stored DLD field and source metadata  |
| `POST /api/projects/sync`    | Trigger the four-selector project import                     |
| `GET /api/export?type=…`     | CSV of the current filter set                                |
| `GET /api/sync`              | Recent run history                                           |
| `POST /api/sync`             | Trigger a run (`x-sync-secret` header when `SYNC_SECRET` set) |

---

## The CRM

The dashboard above answers "who opened". The CRM turns that into work.

Leads flow **DLD → Postgres → batches → Notion → back to Postgres**:

1. The registry sync lands new brokerages and brokers and scores them.
2. The batch engine cuts the top-scoring unbatched leads into batches of ~25 —
   one batch is one person's day — and gives each a working-day due date.
3. The Notion sync pushes them into **🏙️ Homeey DXB CRM**, where the team works
   them and updates stage, owner, notes and next action.
4. The next sync reads those fields back, recomputes batch progress, delay state
   and target attainment, and tops the queue back up.

Brokerages are the primary target and brokers the secondary; they get separate
databases and separate batch lanes (`BRG-*` and `BRK-*`).

### Notion databases

| | What it holds |
|---|---|
| 🏢 Brokerages | Primary lead table. Registry facts + pipeline. |
| 👤 Brokers | Secondary lead table. `New Licence` marks a first-time card. |
| 📦 Batches | Daily work units with SLA, delay and cascade tracking. |
| 🎯 Targets | Daily / weekly / monthly goals vs. actuals. |
| 📞 Activity Log | One row per touch. Fully human-owned. |

### Delay tracking

Each batch reports its own lateness **and** the delay it inherited from the
previous unfinished batch in its lane, so a batch that is one day late behind a
batch that is eight days late reads as nine — and the batch after it shows as
blocked before it is even due. That is the number that tells you the lane is in
trouble.

### Commands

| Command | What it does |
|---|---|
| `npm run crm` | Full cycle: pull from Notion → engines → push |
| `npm run crm:engines` | Batching and targets only, Notion untouched |
| `npm run crm:pull` | Read Notion + run engines, write nothing back |
| `npm run crm:relink` | Clear stored Notion page links after rebuilding a database |
| `npm run db:migrate-stages` | One-time migration off the legacy status vocabulary |

Setup and tokens: **[docs/NOTION_INTEGRATION.md](docs/NOTION_INTEGRATION.md)**.
The rules that keep it from corrupting the team's work:
**[docs/CRM_PROTOCOL.md](docs/CRM_PROTOCOL.md)** — read it before changing
anything under `lib/crm/` or `lib/notion/`.

### Deploying

Locally, `npm run schedule:install` registers everything with Task Scheduler.
On a host, point any scheduler at the API instead — same code, same guarantees:

```bash
curl -X POST -H "x-sync-secret: $SYNC_SECRET" https://your-host/api/crm/sync
```

`POST /api/sync` does the same for the registry crawl. Both refuse to run
concurrently with themselves.

---

## Notes on correctness

- **Timezones.** All timestamp columns are `timestamptz`. The gateway publishes
  naive Dubai wall-clock strings, which we store as-is against UTC and bucket
  with an explicit `AT TIME ZONE 'UTC'` — so a day bucket always equals the date
  RERA printed, regardless of the server's local zone. Bare `::date` casts on a
  `timestamptz` follow the session timezone and will silently shift rows into the
  neighbouring day; don't add any.
- **Phone normalisation** collapses `971|0506555800`, `971-4-4520077` and
  `056 808 6310` to `+971…`, and drops the placeholder values the registry uses
  for "none" (`0`, `1000000000`, all-same-digit strings).
- **CRM fields** (`status`, `ownerNote`, `contactedAt`) are ours. The sync writes
  an explicit column list and never touches them.
