# CRM Protocol

**Read this before touching anything under `lib/crm/`, `lib/notion/`, or the
CRM tables in `prisma/schema.prisma`.**

This document is the contract between Postgres and Notion. The rules here are
not style preferences — breaking any of them silently destroys work the sales
team has already done, and the damage is usually invisible until somebody asks
why a lead they contacted last week is back in the queue.

---

## 1. Who owns what

| | System of record | Surface |
|---|---|---|
| Registry facts (licences, contacts, scores) | **Postgres** | Notion (read-only to humans) |
| Batching and scheduling | **Postgres** | Notion (read-only to humans) |
| Pipeline stage, owner, notes, next action | **Notion** | Postgres (mirror) |
| Targets (the goal numbers) | **Notion** | Postgres (mirror) |
| Target actuals | **Postgres** | Notion (read-only to humans) |

Postgres is authoritative for anything derived. Notion is authoritative for
anything a human decides. Neither side is authoritative for everything, which is
why the ownership lists exist.

---

## 2. Field ownership — the hard rule

Every Notion property is **SYSTEM** or **HUMAN**. The lists live in
[`lib/notion/mapping.ts`](../lib/notion/mapping.ts) and are the enforcement
point, not documentation of one.

- **SYSTEM** — the push writes it every sync. A human edit is lost on the next
  run. Marked 🔒 in the property description in Notion.
- **HUMAN** — the pull reads it. **The push must never include it.**

`assertOwnership()` runs on every push payload and throws if a human field
leaks in:

```
Ownership violation: tried to push human-owned field(s) [Stage] to the
brokerages database. These belong to the team in Notion and would be
overwritten.
```

If you see that error, the fix is to remove the field from the payload — never
to weaken the assertion.

### The two deliberate exceptions

Both are narrow and both are enforced in code:

1. **`Stage` on a brand-new lead page.** A page that does not exist yet has no
   human value to protect, so the push seeds the opening stage. Once
   `notionPageId` is set, `Stage` is never pushed again. See
   `pushBrokerages` / `pushBrokers`.

2. **`Status` on a batch.** Humans set `In Progress` / `Completed`; the engine
   forces `Delayed` and `Completed` when the facts demand it. The pull ignores
   an incoming `Delayed` (it is computed, so a stale value would fight the
   engine every run) and the push only sends `Delayed` or `Completed`.

### Adding a property

1. Add it in Notion with a description starting `🔒 System.` or `Human.`
2. Add it to **exactly one** of the lists in `mapping.ts`.
3. If SYSTEM: add it to the payload builder in `lib/notion/sync.ts`.
4. If HUMAN: add it to the matching `pull*` function and to the Prisma model.

Skipping step 2 means `assertOwnership` cannot protect it.

---

## 3. Sync order — never reorder this

```
1. PULL     read human fields out of Notion
2. ENGINES  batching, delays, targets
3. PUSH     write system fields back
```

**Why pull first.** If we pushed first, a stage the team set at 09:00 would be
overwritten at 13:30 by the stale value still in Postgres. Pulling first means
Postgres learns the truth before anything is computed from it.

**Why engines in the middle.** Batch progress is derived from `contactedAt` and
`status`, both of which are human-owned. Running the engines before the pull
would score batches against yesterday's work and mark active batches as stalled.

**Why batches push before leads.** A lead page carries a relation to its batch
page. The batch page must exist and have a `notionPageId` before a lead can
point at it, or the relation silently pushes empty.

---

## 4. Batching

Implemented in [`lib/crm/batches.ts`](../lib/crm/batches.ts). Tunables in
[`lib/crm/config.ts`](../lib/crm/config.ts).

- A batch is **~25 leads = one person's day**. Configurable via `BATCH_SIZE`.
- Batches are cut from the **highest-scoring unbatched leads**, so the team
  always works the freshest, most promising firms first.
- The queue is topped up to `QUEUE_DEPTH_*` batches. We never cut the whole
  backlog at once — a batch created three weeks early would be scored against
  stale data by the time anyone works it.
- Batch codes are `BRG-2026-W31-01` / `BRK-2026-W31-01`. Stable, sortable, and
  the Notion title.
- Due date is `assignedDate + BATCH_SLA_DAYS` **working days**. Dubai's weekend
  (Fri/Sat in `CRM_CONFIG.weekendDays`) is skipped, so a Thursday batch is not
  born a day late.

### Eligibility

A lead is batchable when it is unbatched, active, above the score floor, in
`🆕 New Lead` or `🎯 Queued`, and has never been contacted. Brokers additionally
require `isNewCard` — a renewal is not a new broker (see the main README).

### Terminal stages

`✅ Won` and `❌ Lost` are terminal. `reclaimStaleAssignments()` unbatches them
every run so they can never be handed out again.

---

## 5. Delay tracking

Three numbers, and they mean different things:

| Field | Meaning |
|---|---|
| `daysOverdue` | Working days this batch is past **its own** due date |
| `cascadeDelayDays` | Delay inherited from the previous unfinished batch in the same lane |
| `daysOverdue + cascadeDelayDays` | How far behind the lane actually is |

The cascade is what surfaces **delay stacked on delay**. Worked example:

| Batch | Own | Cascade | Total | Blocked by |
|---|---|---|---|---|
| BRG-W31-01 | 5 | 0 | 5 | — |
| BRG-W31-02 | 3 | 5 | 8 | 01 |
| BRG-W31-03 | 1 | 8 | 9 | 02 |
| BRG-W31-04 | 0 | 9 | 9 | 03 |

Batch 03 is only one day late by itself but is nine days behind in reality.
Batch 04 is not even due yet and is already doomed — which is the thing you want
to see on a Monday morning, not discover on Friday.

`Delay Status` escalates `On Track → Due Today → Overdue → Critically Overdue`
at `BATCH_CRITICAL_DAYS` (default 3). Completed batches get `Done On Time` or
`Done Late` instead, so history stays readable.

---

## 6. Targets

Implemented in [`lib/crm/targets.ts`](../lib/crm/targets.ts).

- Rows are maintained for a rolling window: daily (−14 to +14 working days),
  weekly (±4), monthly (±3).
- **Targets are human-owned.** Defaults are seeded once on creation and never
  overwritten — if somebody sets a month to 800 touches, it stays 800.
- **Actuals are system-owned**, counted from `contactedAt` and `status`.
- Weekly and monthly defaults are the daily figure × working days in the period,
  so the three horizons stay consistent instead of drifting apart.
- `Status` grades attainment **against elapsed time**. A month 10% through with
  10% attainment is `On Track`; the same numbers on the last day are `Behind`.

---

## 7. Invariants

Things that must stay true. If you change code such that one of these breaks,
you have introduced a bug even if nothing throws.

1. **One pipeline vocabulary.** `STAGES` in `lib/crm/config.ts` is the only list
   of stage names, used by Postgres, the local dashboard and Notion alike. There
   is no translation layer, and there must never be one.
2. **`notionPageId` and `notionHash` move together.** Clearing one without the
   other either duplicates pages or silently skips writes forever. Use
   `npm run crm:relink`.
3. **All dates are UTC calendar days.** The registry publishes naive Dubai
   wall-clock which we store against UTC. Introducing a local-timezone
   `getDate()` anywhere in `lib/crm/` will shift batch days off the licence days
   they were built from.
4. **The registry sync never writes CRM fields.** `lib/dld/sync.ts` writes an
   explicit column list. Do not switch it to a spread.
5. **A lead belongs to at most one batch.** `batchId` is a single FK, not a
   join table. Two people working the same lead is the failure this prevents.
6. **Pushes are idempotent.** Running `npm run crm` twice in a row must produce
   zero writes on the second run. If it does not, something time-varying has
   crept into a payload — find it, because it also means every run is burning
   the rate limit rewriting unchanged rows.

### The hashing trap (this bug has already happened once)

`payloadHash` decides whether a row is rewritten. Two ways to break it, both
silent:

**1. Hashing key names instead of values.** Do not write

```ts
JSON.stringify(props, Object.keys(props).sort())   // WRONG
```

The second argument is a replacer *array*, and it whitelists those names at
**every nesting level**. Notion payloads are nested — `{ date: { start: "…" } }`,
`{ number: 5 }` — so the inner keys are not in the whitelist and every value
serialises to `{}`. The hash then encodes only the *set of property names*: rows
whose values changed are skipped, and rows that merely gained a key are
rewritten. Use `stableStringify` in `mapping.ts`, which sorts keys at every
level and keeps the values.

**2. Time-varying values in the payload.** Anything recomputed per run
(`Synced At`) or per day (an age in days) makes every row look dirty forever.
Two remedies, in order of preference:

- Move it into a **Notion formula** so it is always live and never pushed. This
  is what `Age (days)`, `Days Since Contact` and `Follow-Up Due` do.
- If it must be pushed, add it to `HASH_IGNORED` in `mapping.ts`. That list also
  holds the fields seeded only on page creation (`Stage`, the `Target *`
  numbers), so the creating run and the run after it agree.

---

## 8. Testing a change safely

```bash
npm run crm:engines     # batching + targets, Notion untouched
npm run crm:pull        # read Notion, run engines, still no writes
npm run crm             # full cycle
```

Always run `crm:engines` first when changing batching or delay logic. It
exercises the whole engine against real data without spending a single Notion
request or risking the team's fields.

To test delay handling, backdate a batch's `dueDate` and run
`recomputeDelays()` — do not wait for real time to pass.

---

## 9. What NOT to do

- **Do not** rename a Notion property to match the code. Change the code —
  renaming breaks every stored `notionHash` and forces a full re-push.
- **Do not** add a `Last edited time` or `now()` value to a push payload. It
  changes every run, defeats hashing, and turns a 30-request sync into 10,000.
- **Do not** delete rows from the Notion lead databases to "clean up". The sync
  re-creates them from Postgres on the next run, and you lose the notes. Set
  `Stage` to `❌ Lost` instead.
- **Do not** use `--push` as a routine sync. It skips the pull.
- **Do not** widen `assertOwnership` to make an error go away.
