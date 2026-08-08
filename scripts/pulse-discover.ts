/**
 * Dubai Pulse discovery.
 *
 *   npx tsx scripts/pulse-discover.ts
 *
 * The DLD gateway at gateway.dubailand.gov.ae only serves the CURRENT CALENDAR
 * YEAR - 2025 and earlier return zero rows, and even a 2000-2026 window returns
 * only 2026 data. Everything historical lives on Dubai Pulse, which is a
 * different system with a different contract:
 *
 *   - OAuth2 client-credentials. DLD emails an API Key and API Secret on
 *     registration at dubaipulse.gov.ae; there is no anonymous access. Every
 *     dataset endpoint returns 401 "Unauthorized application request" without
 *     a token, so this cannot be probed blind.
 *   - Tokens are short-lived (~30 min) and must be refreshed.
 *
 * Set DUBAI_PULSE_KEY and DUBAI_PULSE_SECRET in .env, then run this. It
 * authenticates, walks the candidate dataset list, and prints each one's
 * status, row shape and field names - which is what a real importer needs
 * before it can be written. Nothing is persisted.
 */


const TOKEN_URL =
  "https://api.dubaipulse.gov.ae/oauth/client_credential/accesstoken?grant_type=client_credentials";
const BASE = "https://api.dubaipulse.gov.ae/open/dld";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Candidate datasets. The names come from Dubai Pulse's public dataset pages;
 * each returned 401 rather than 404 when probed unauthenticated, which means
 * the resource exists. Anything that 404s here should just be deleted.
 */
const DATASETS = [
  "dld_transactions-open-api",
  "dld_rent_contracts-open-api",
  "dld_projects-open-api",
  "dld_developers-open-api",
  "dld_brokers-open-api",
  "dld_offices-open-api",
  "dld_valuation-open-api",
  "dld_units-open-api",
  "dld_buildings-open-api",
  "dld_land_registry-open-api",
  "dld_accredited_escrow_agents-open-api",
  "dld_licenced_owner_associations-open-api",
  "dld_real_estate_permits-open-api",
  "dld_lkp_transaction_procedures-open-api",
  "dld_lkp_transaction_groups-open-api",
  "dld_lkp_areas-open-api",
  "dld_lkp_property_types-open-api",
];

async function getToken(key: string, secret: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: `client_id=${encodeURIComponent(key)}&client_secret=${encodeURIComponent(secret)}`,
    signal: AbortSignal.timeout(60_000),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`token request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);

  const body = JSON.parse(text) as { access_token?: string; expires_in?: string };
  if (!body.access_token) throw new Error(`no access_token in response: ${text.slice(0, 300)}`);

  console.log(`authenticated, token valid ${body.expires_in ?? "?"}s\n`);
  return body.access_token;
}

async function probe(dataset: string, token: string) {
  // Both header styles are documented in different places; try Bearer first.
  const authStyles: Array<Record<string, string>> = [
    { Authorization: `Bearer ${token}` },
    { access_token: token },
  ];
  for (const headers of authStyles) {
    try {
      const res = await fetch(`${BASE}/${dataset}?limit=2`, {
        headers: { ...headers, Accept: "application/json", "User-Agent": UA },
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      if (res.status === 401) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { status: res.status, note: `non-JSON: ${text.slice(0, 160)}` };
      }

      // The envelope shape is unknown until we see it - find the first array
      // of objects anywhere in the response and treat that as the rows.
      const rows = findRows(parsed);
      return {
        status: res.status,
        note: rows ? `${rows.length} sample row(s)` : "no array found in envelope",
        envelopeKeys: parsed && typeof parsed === "object" ? Object.keys(parsed as object) : [],
        fields: rows?.[0] ? Object.keys(rows[0]) : [],
        sample: rows?.[0],
      };
    } catch (error) {
      return { status: -1, note: (error as Error).message };
    }
  }
  return { status: 401, note: "unauthorized with both Bearer and access_token headers" };
}

function findRows(value: unknown, depth = 0): Array<Record<string, unknown>> | null {
  if (depth > 4 || value == null) return null;
  if (Array.isArray(value)) {
    return value.length && typeof value[0] === "object" && value[0] !== null
      ? (value as Array<Record<string, unknown>>)
      : null;
  }
  if (typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      const found = findRows(nested, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function main() {
  const key = process.env.DUBAI_PULSE_KEY;
  const secret = process.env.DUBAI_PULSE_SECRET;

  if (!key || !secret) {
    console.error(`DUBAI_PULSE_KEY and DUBAI_PULSE_SECRET are not set.

Dubai Pulse has no anonymous access: every DLD dataset returns 401 without a
token. To get credentials, register at https://www.dubaipulse.gov.ae, request
access to the DLD datasets, and DLD emails an API Key and API Secret in two
separate messages. Put them in .env as:

  DUBAI_PULSE_KEY=...
  DUBAI_PULSE_SECRET=...

then re-run this script.`);
    process.exit(2);
  }

  const token = await getToken(key, secret);

  for (const dataset of DATASETS) {
    const result = await probe(dataset, token);
    console.log(`\n═══ ${dataset} — HTTP ${result.status} — ${result.note}`);
    if ("envelopeKeys" in result && result.envelopeKeys?.length) {
      console.log(`  envelope: ${result.envelopeKeys.join(", ")}`);
    }
    if ("fields" in result && result.fields?.length) {
      console.log(`  fields (${result.fields.length}): ${result.fields.join(", ")}`);
      console.log(`  sample: ${JSON.stringify(result.sample).slice(0, 700)}`);
    }
  }

  console.log(`

Next: the field lists above are what an importer needs. Compare them against
the gateway models already in prisma/schema.prisma - where the columns match,
the same tables can absorb the history; where they differ, Pulse gets its own
model. Check especially whether Pulse exposes a broker or agency column on
transactions, which the gateway dataset does NOT.`);
}

main().catch((error) => {
  console.error("\nDiscovery failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
