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
| `/open-data/transactions` | ~19k/month | Sales, mortgages and gifts: amount, area, property type, rooms, parking, project, nearest metro/mall/landmark |
| `/open-data/rents` | ~95k/month | Ejari contracts: contract + annual amount, term, area, project, property type, rooms |
| `/open-data/lands` | 260,730 | Parcel register: parcel id, land number, area, zone, project, land type, size |
| `/open-data/buildings` | 9,845 | Building register with composition — flats, shops, offices, floors, lifts, parking |
| `/open-data/brokers` | 42,997 | Broker cards **including expired licences** — the registry endpoint drops them |
| `/open-data/developers` | 182 | Registered developers: licence number, dates, contact |
| `/open-data/valuations` | ~470/month | Official DLD valuation procedures — assessed worth, not sale price |
| `/open-data/units` | **0** | Answers 200 but returns nothing under every filter tried (2026-08-07) |

Three lookup dictionaries feed the portal's dropdowns and are mirrored too:
`carea-lookup` (437 areas), `projects-lookup` (**4,162** projects — five times what
the year-windowed project sync stores) and `ejari-property-types` (83).

### The gateway holds the current calendar year only

This is a hard ceiling, not a tuning problem. Probed 2026-08-07:

| Window | transactions | rents | valuations |
| ------ | ------------ | ----- | ---------- |
| 2026 | 136,741 | 667,364 | 3,051 |
| 2025 | **0** | **0** | **0** |
| 2024 and earlier | **0** | **0** | **0** |

A multi-year window does not help — `01/01/2000 → 12/31/2026` returns exactly
the same 136,741 rows as 2026 alone. There is no parameter that reaches further
back; the portal itself says so, pointing at Dubai Pulse for previous years.

**Everything historical lives on [Dubai Pulse](https://www.dubaipulse.gov.ae),
which is a different system behind OAuth.** Every DLD dataset there returns
`401 Unauthorized application request` without a token, and credentials are
issued by email on registration — there is no anonymous access and nothing to
reverse-engineer. Once an API Key and Secret exist, put them in `.env` and run
`npx tsx scripts/pulse-discover.ts`, which authenticates and dumps each
dataset's field list so an importer can be written against the real schema
rather than a guess.

So the mirror's realistic coverage is: **whole-catalogue datasets** (lands,
buildings, brokers, developers, lookups) are complete regardless of date, while
**windowed datasets** (transactions, rents, valuations) can only ever go back to
1 January of the current year until Pulse access is in place.

### Month windows lose ~0.5% against a year window

Summing the gateway's own month totals for 2026 gives 136,025 transactions. Asking
the same gateway for the whole year gives **136,741** — 716 more, 0.52%.

The months tile the year exactly: single-day queries confirm both bounds are
inclusive (`07/31 → 07/31` returns 624 rows), so there is no gap or overlap to
explain it. Those 716 rows simply match no month window. This is a
gateway-side inconsistency, not a sync defect — the mirror holds 100% of what
month-windowed queries return, verified month by month.

Left as-is deliberately. Closing it means fetching a whole year in one response
(~140MB for transactions, far more for rents) and giving up the per-month
`sourceMonth` partitioning that makes re-syncs cheap and idempotent. Worth
revisiting only if that 0.5% ever matters.

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

- **Transactions take a different parameter set to projects**, and are fussy
  about it. The accepted keys are exactly `P_FROM_DATE P_TO_DATE P_GROUP_ID
  P_IS_OFFPLAN P_IS_FREE_HOLD P_AREA_ID P_USAGE_ID P_PROP_TYPE_ID P_TAKE
  P_SKIP P_SORT` — note `P_PROP_TYPE_ID`, *not* the `P_PROPERTY_TYPE_ID` the
  response uses. Any unknown or missing key returns `responseCode 420
  INVALID_REQUEST` naming nothing; passing `""` for one of the int filters
  takes the upstream down with an HTML 500 instead of a JSON error. `P_TAKE`
  and `P_SKIP` must be strings. Dates are `MM/DD/YYYY` and both are mandatory.

---

## Joining the open-data sets

**The gateway zeroes most of its own identifier columns.** `AREA_ID`,
`PROPERTY_ID`, `USAGE_ID`, `PROPERTY_TYPE_ID`, `PROCEDURE_ID` and friends all
come back as `0` in the data rows, even though the lookup dictionaries carry
real values. Joins therefore run on names and on the few keys that survive.

Run `npx tsx scripts/mapping-report.ts` to re-measure any of this. Current
match rates:

| Join | Rate | Use it? |
| ---- | ---- | ------- |
| `transactions.areaEn` → area lookup | 100% | ✅ area is the backbone key |
| `rents.areaEn` → area lookup | 100% | ✅ |
| `transactions.projectEn` → projects-lookup | 100% of the 88% that name a project | ✅ 12% are secondary-market with no project |
| `buildings.parcelId` → `lands.parcelId` | 100% | ✅ |
| `transactions.parcelId` → `lands.parcelId` | 96.6% of the 35% that carry one | ⚠️ only a third of deals carry a parcel |
| `od_brokers.realEstateNumber` → `offices` | 89.2% | ✅ |
| `od_brokers.brokerNumber` → `brokers.cardNumber` | 80.5% | ✅ the 19.5% gap **is** the lapsed-licence population |
| `lands.projectNumber` → `projects` | 13.9% | ❌ `projects` is year-windowed; widen it first |
| `projects.developerNumber` → `developers` | 2.1% | ❌ the developer register only has 182 rows |
| `rents.parcelId` → anything | **0%** | ❌ rents carry no parcel id at all |

Two consequences worth internalising:

- **Rents join to sales by area and project name only.** There is no parcel or
  property key on a rent row, so rent-vs-sale work is area/project-level, never
  unit-level.
- **`lands.parcelId` is not unique** — one parcel carries many land records. Use
  `EXISTS`, not a `LEFT JOIN`, when measuring coverage or you will count join
  output instead of source rows.

---

## The yield atlas

`/yield` is the first analysis built on the cross-dataset joins. It answers
"what does a property in this area actually return", by pairing ready sales
against Ejari leases.

**Gross yield = median annual rent per m² ÷ median sale price per m².**

Per square metre, because that is the only normaliser available: `rents.rooms`
is null on 95.6% of contracts, and where present it is a bare `"3"` against the
transactions vocabulary `"3 B/R"`. `actualArea` is populated on 100% of rows on
both sides.

Excluded, deliberately:

- **Off-plan sales** — 71% of the sale market and not lettable. Including them
  is the single biggest way to get this number wrong.
- **Mortgages and gifts** — a loan is not a price.
- Repeat unit rows of multi-unit transactions.
- The top and bottom 5% of per-m² values in each area, which removes the AED 1
  transfers and prepaid long leases DLD publishes.

**`sizeSkew` is the column to watch.** It is median let m² ÷ median sold m². Far
from 1.0 means the stock being let is not the stock being sold, so the ratio is
meaningless however deep the sample. Business Bay *offices* score **0.09** —
whole floors are sold while small suites are let — and are marked `low`
confidence rather than reported as a 6.8% yield. Sample depth alone would have
called that cell trustworthy; it is not.

Measured on Jan–Jul 2026 sales and Jun–Jul 2026 leases, flats come out at a
**5.39% median** across 12 usable areas — Burj Khalifa 6.02%, Business Bay
5.97%, Palm Jumeirah 4.61%. Villas sit lower at 4.71%, as expected.

One finding worth recording: new lets run only **~0.10pp** above renewals once
measured per m², far less than the ~6.7% gap the raw medians suggest. The
rent-cap effect is largely a unit-size composition difference, not a price one.

---

## Transactions: two traps worth knowing before you query

**1. There is no broker attribution. At all.** The transaction dataset carries
no broker, agent, office or company field — the full column list is mirrored on
the `Transaction` model. "How much has brokerage X sold" is **not answerable**
from DLD open data, and no join to `Office` or `Broker` is possible. Sources
that appear to show per-agency volume (Property Finder, Bayut, Property Monitor)
derive it from listing portals or paid feeds, not from this API.

**2. Rows are units, not deals, and the value repeats on every one.** A
multi-unit transaction publishes one row per unit, each repeating the *whole
deal's* value. In July 2026, 45 transactions spanned 429 extra rows, the largest
covering 12 units — so a naive `SUM(transValueAed)` turns one AED 1.48m deal
into AED 17.7m. Measured across May–July 2026 the inflation is **3.43%, about
AED 5.16bn**.

The sync therefore stamps every row at write time:

| Column | Meaning |
| ------ | ------- |
| `unitCount` | Rows sharing this deal |
| `dealValueVariants` | Distinct values within the deal (>1 for lease-to-own, which publishes the price and the financed portion as separate rows — 112 deals in May–July) |
| `isPrimaryUnit` | True on exactly one row per deal, the highest-valued one |

So the correct aggregates are:

```sql
deals = count(*)            where "isPrimaryUnit"
value = sum("transValueAed") where "isPrimaryUnit"
units = count(*)                                  -- no filter
```

`/api/transactions`, the `/transactions` page and the CSV export all apply this
already. The grouping is recomputed **globally** after a sync, never per month:
DLD's month window filters on registration date while `instanceDate` can fall
outside it, so one deal's rows can land in two `sourceMonth` batches. Marking
primaries a month at a time gave 40 deals two primary rows each.

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
| `npm run transactions:sync` | Import the current month's transactions                                        |
| `npx tsx scripts/sync-transactions.ts 2026-01 2026-07` | Import an inclusive month range (prefer this form — PowerShell eats the `--` npm needs to forward flags) |
| `npx tsx scripts/sync-open-data.ts all` | Sync every open-data set + lookups; one failure does not stop the rest |
| `npx tsx scripts/sync-open-data.ts rents 2026-05 2026-07` | One dataset, inclusive month range (windowed sets only) |
| `npx tsx scripts/mapping-report.ts` | Measure cross-dataset join coverage and print a worked yield example |
| `npx tsx scripts/pulse-discover.ts` | Authenticate to Dubai Pulse and dump each dataset's schema (needs `DUBAI_PULSE_KEY`/`SECRET`) |
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
| `/transactions`| Sales / mortgages / gifts with area, type, usage, rooms, off-plan, freehold, value and date filters. Deal counts and value are measured per deal, not per unit row |
| `/yield`       | Rental yield atlas — gross yield by area, joining sales to Ejari leases. Every row carries a confidence rating; see below |
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
| `GET /api/transactions`      | Paginated transactions. `total` counts unit rows; `deals` and every value figure are measured per deal |
| `GET /api/yield`             | Yield atlas rows plus the methodology block, so a consumer cannot use the number without the caveats |
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
