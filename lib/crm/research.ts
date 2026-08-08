/**
 * Vocabulary for the research and outreach layer.
 *
 * This sits alongside `STAGES` in config.ts and deliberately does NOT overlap
 * with it. The two answer different questions:
 *
 *   STAGES           where is this deal in the pipeline?      (owned in Notion)
 *   RESEARCH_STATUS  has anyone looked this firm up yet?      (owned here)
 *
 * Collapsing them into one field is what made "we searched and found nothing"
 * unrecordable: an unexplored brokerage and an exhausted one both read as
 * `🆕 New Lead`, so the same firm gets re-researched by the next intern and
 * coverage can never be measured. Keep them orthogonal.
 *
 * Like STAGES these strings are stored verbatim in Postgres and rendered
 * verbatim in the UI. One vocabulary, no translation layer.
 */

export const RESEARCH_STATUSES = [
  "⚪ Not Started",
  "🔍 Researching",
  "✅ Enriched",
  "🟡 Partial",
  "🚫 Nothing Found",
  "⛔ Do Not Contact",
] as const;

export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];

export const RESEARCH_NOT_STARTED: ResearchStatus = "⚪ Not Started";
export const RESEARCH_IN_PROGRESS: ResearchStatus = "🔍 Researching";
export const RESEARCH_ENRICHED: ResearchStatus = "✅ Enriched";
export const RESEARCH_PARTIAL: ResearchStatus = "🟡 Partial";
export const RESEARCH_NOTHING_FOUND: ResearchStatus = "🚫 Nothing Found";
export const RESEARCH_DNC: ResearchStatus = "⛔ Do Not Contact";

/**
 * Statuses that mean a human has finished looking, whatever the outcome. This
 * is the definition of "covered" — the denominator for progress reporting and
 * the filter that stops the same firm being handed out twice.
 */
export const RESEARCH_CLOSED: readonly string[] = [
  RESEARCH_ENRICHED,
  RESEARCH_PARTIAL,
  RESEARCH_NOTHING_FOUND,
  RESEARCH_DNC,
];

/** Statuses where a usable contact exists, so the firm is ready for outreach. */
export const RESEARCH_ACTIONABLE: readonly string[] = [
  RESEARCH_ENRICHED,
  RESEARCH_PARTIAL,
];

/** Never hand these back to an intern for research. */
export const RESEARCH_TERMINAL: readonly string[] = [
  RESEARCH_NOTHING_FOUND,
  RESEARCH_DNC,
];

export const RESEARCH_STATUS_HINT: Record<string, string> = {
  "⚪ Not Started": "Nobody has looked this firm up yet.",
  "🔍 Researching": "Claimed by someone right now. Not in anyone else's queue.",
  "✅ Enriched": "A named decision-maker with at least one reachable channel.",
  "🟡 Partial": "Something usable found, but no named decision-maker yet.",
  "🚫 Nothing Found":
    "Searched properly and came up empty. Recorded so nobody repeats the work.",
  "⛔ Do Not Contact": "Asked us to stop, or otherwise off-limits.",
};

// --------------------------------------------------------------- outreach

/**
 * How we reached out. LinkedIn is split into request vs DM on purpose: sending
 * a connection request and messaging someone who already accepted are different
 * actions with different reply rates, and the intern needs to log which one.
 */
export const OUTREACH_CHANNELS = [
  "LinkedIn Request",
  "LinkedIn DM",
  "Email",
  "WhatsApp",
  "Call",
  "Instagram DM",
  "Website Form",
] as const;

export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];

export const OUTREACH_OUTCOMES = [
  "Sent",
  "Accepted",
  "Replied",
  "Positive Reply",
  "Not Interested",
  "No Response",
  "Bounced",
  "Wrong Contact",
] as const;

export type OutreachOutcome = (typeof OUTREACH_OUTCOMES)[number];

/** Outcomes that still might turn into something — the follow-up worklist. */
export const OUTREACH_OPEN: readonly string[] = ["Sent", "Accepted"];

/** Outcomes where the prospect engaged back, however briefly. */
export const OUTREACH_ENGAGED: readonly string[] = [
  "Replied",
  "Positive Reply",
];

/** Outcomes that close the attempt out. A new attempt needs a new row. */
export const OUTREACH_CLOSED: readonly string[] = [
  "Not Interested",
  "No Response",
  "Bounced",
  "Wrong Contact",
];

export const CONTACT_CONFIDENCE = ["High", "Medium", "Low"] as const;
export type ContactConfidence = (typeof CONTACT_CONFIDENCE)[number];

/**
 * Activity log event types. The log is append-only and is the answer to
 * "what did the intern actually do today" — never derive it from row state,
 * because state gets overwritten and the audit trail is the point.
 */
export const ACTIVITY_TYPES = [
  "ASSIGNED",
  "RESEARCH_STARTED",
  "RESEARCH_STATUS",
  "CONTACT_ADDED",
  "CONTACT_REMOVED",
  "OUTREACH_LOGGED",
  "OUTREACH_OUTCOME",
  "NOTE",
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_LABEL: Record<string, string> = {
  ASSIGNED: "Assigned",
  RESEARCH_STARTED: "Research started",
  RESEARCH_STATUS: "Research status",
  CONTACT_ADDED: "Contact added",
  CONTACT_REMOVED: "Contact removed",
  OUTREACH_LOGGED: "Outreach sent",
  OUTREACH_OUTCOME: "Outcome updated",
  NOTE: "Note",
};

// --------------------------------------------------------------- lookup aids

/**
 * Prefilled search URLs for the panel. An intern researching 25 firms a day
 * spends most of that time retyping the same four searches, so we build them
 * from the registry name once and hand over links.
 */
export function lookupLinks(name: string | null, website: string | null) {
  const q = encodeURIComponent((name ?? "").trim());
  const domain = (() => {
    if (!website) return null;
    try {
      return new URL(website).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  })();

  const links = [
    {
      label: "LinkedIn co.",
      href: `https://www.linkedin.com/search/results/companies/?keywords=${q}`,
    },
    {
      label: "LinkedIn people",
      href: `https://www.linkedin.com/search/results/people/?keywords=${q}`,
    },
    { label: "Google", href: `https://www.google.com/search?q=${q}+dubai+real+estate` },
    {
      label: "Instagram",
      href: `https://www.google.com/search?q=site:instagram.com+${q}`,
    },
  ];

  if (domain) {
    links.push({
      label: "Site team",
      href: `https://www.google.com/search?q=site:${domain}+team+OR+about+OR+founder`,
    });
  }

  return links;
}
