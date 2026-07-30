# Notion Integration — setup and reference

How the `hlabs-dxb` codebase talks to the **🏙️ Homeey DXB CRM** Notion
workspace. Read [CRM_PROTOCOL.md](./CRM_PROTOCOL.md) before changing any of it.

The integration is a plain REST client using the official `@notionhq/client`
SDK. It has **no dependency on Claude, an MCP server, or any interactive
session** — it runs headless from Task Scheduler and will keep running after
this repo is deployed anywhere else.

---

## 1. One-time setup

### Create the integration

1. Go to <https://www.notion.so/my-integrations> → **New integration**.
2. Name it `hlabs-dxb`, associate it with the **Homeey Labs** workspace.
3. Capabilities: **Read content**, **Update content**, **Insert content**.
   User information can stay at "No user information" — we only read the
   `people` property, which works regardless.
4. Copy the **Internal Integration Secret** (starts with `ntn_`).

### Share the CRM with it

Notion integrations see nothing by default. Open the
**🏙️ Homeey DXB CRM** page → `···` menu → **Connections** → add `hlabs-dxb`.
Sharing the parent page cascades to all five databases inside it.

> If you skip this step every call fails with `object_not_found`, which reads
> like a wrong ID but is almost always a missing share.

### Configure the environment

Add to `.env`:

```
NOTION_TOKEN="ntn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

The database IDs are already baked in as defaults (see below), so nothing else
is required. Override them only if you rebuild a database from scratch.

### Verify

```bash
npm run crm
```

A first run creates the batch pages, then the lead pages, then the target rows.
Expect it to take a few minutes — Notion allows ~3 requests/second and we pace
deliberately under that.

---

## 2. Database IDs

Defaults live in `lib/notion/client.ts` and can each be overridden by an env var.

| Database | Env var | ID |
|---|---|---|
| 🏢 Brokerages | `NOTION_DB_BROKERAGES` | `8c219ef5-cf6e-417a-8923-a0fb9786bf9b` |
| 👤 Brokers | `NOTION_DB_BROKERS` | `54d4974a-39f0-4cfb-99f1-93b4165bd8cf` |
| 📦 Batches | `NOTION_DB_BATCHES` | `495c35fc-1a8d-484e-9aaf-01de1609cf36` |
| 🎯 Targets | `NOTION_DB_TARGETS` | `be966f82-7a4a-4828-bf23-00799888d302` |
| 📞 Activity Log | `NOTION_DB_ACTIVITY` | `451e6953-eab9-4c6b-b3dd-87647aba2a12` |

Parent page: `3aa72683-9438-81f7-8f05-f8785cb4230d` (`NOTION_PARENT_PAGE`).

---

## 3. Commands

| Command | What it does |
|---|---|
| `npm run crm` | Full cycle: pull → engines → push |
| `npm run crm:scheduled` | Same, tagged `SCHEDULED` in the run log |
| `npm run crm:pull` | Pull + engines, no writes to Notion |
| `npm run crm:engines` | Batches and targets only, Notion untouched |

`--push` exists on the script but is **not** a routine: it skips the pull, so
any change the team made since the last run is invisible to the engines. Use it
only to repopulate a Notion database you have just rebuilt.

---

## 4. Schedule

Installed by `npm run schedule:install`:

| Task | When | Command |
|---|---|---|
| HLabs DXB Registry Sync | daily 07:15 | `npm run sync:scheduled` |
| HLabs DXB CRM Sync | daily 07:45 | `npm run crm:scheduled` |
| HLabs DXB CRM Sync (Midday) | daily 13:30 | `npm run crm:scheduled` |
| HLabs DXB Registry Deep Sync | Sunday 04:30 | `npm run sync:deep` |

The 30-minute gap between the registry sync and the CRM sync is deliberate: the
batches cut at 07:45 are built from leads that landed at 07:15, so the team
starts the day on brokerages licensed overnight. The midday run exists so that
delay state and target attainment reflect the morning's work rather than
yesterday's.

Logs land in `logs/crm-sync.log`.

---

## 5. Rate limiting and cost control

Notion's limit is ~3 requests/second per integration, and there are ~10k
brokerages. Three mechanisms keep a run bounded:

1. **Pacing** — `lib/notion/client.ts` enforces a minimum gap between requests
   (`NOTION_MIN_INTERVAL_MS`, default 340ms). We stay under the limit rather
   than relying on 429 retries.
2. **Payload hashing** — every pushed row stores a SHA-1 of its payload in
   `notionHash`. On the next run, rows whose system fields have not changed are
   skipped without a request. In steady state a sync touches tens of rows, not
   thousands.
3. **Scope** — only leads that are **batched or already in Notion** are pushed.
   The other ~9,000 brokerages stay in Postgres until they are batched. Cap the
   per-run volume with `NOTION_PUSH_LIMIT` (default 400).

If a run does hit a 429, the client honours `Retry-After` and backs off.

---

## 6. Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `NOTION_TOKEN is not set` | No token in `.env` | Section 1 |
| `object_not_found` on every call | CRM page not shared with the integration | Re-share the parent page |
| `validation_error` naming a property | Notion schema and code disagree | Fix the mapping in `lib/notion/mapping.ts`; do **not** rename the Notion property |
| `Ownership violation: ...` | Code tried to push a human-owned field | Intentional guard — see CRM_PROTOCOL.md §2 |
| Rows duplicating in Notion | `notionPageId` lost or a row deleted in Notion | The sync re-creates by design; delete the duplicate in Notion and let the next run relink |
| Everything re-pushes every run | `notionHash` cleared, or a value that changes each run (e.g. a timestamp) crept into a payload | Check what changed in the payload builder |

---

## 7. Rebuilding a Notion database

If a database is deleted or rebuilt, its page IDs change and every stored
`notionPageId` becomes a dangling reference.

```bash
# 1. Recreate the database in Notion (keep the exact property names).
# 2. Point the env var at the new ID.
# 3. Clear the stale links so the sync re-creates the pages:
npm run crm:relink -- --brokerages
# 4. Run a normal sync.
npm run crm
```

Never hand-edit `notionPageId` in Postgres — use the relink script so the
matching `notionHash` is cleared at the same time. A stale hash with a fresh
page id means the sync thinks the row is up to date and never writes it.
