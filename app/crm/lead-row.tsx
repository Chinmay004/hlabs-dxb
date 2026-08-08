"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useState } from "react";

import { Pill, TierBadge } from "../components/ui";
import {
  CONTACT_CONFIDENCE,
  OUTREACH_CHANNELS,
  OUTREACH_ENGAGED,
  OUTREACH_OPEN,
  OUTREACH_OUTCOMES,
  RESEARCH_ACTIONABLE,
  RESEARCH_IN_PROGRESS,
  RESEARCH_NOTHING_FOUND,
  RESEARCH_STATUSES,
  RESEARCH_STATUS_HINT,
  RESEARCH_TERMINAL,
  lookupLinks,
} from "@/lib/crm/research";
import { fmtAge, fmtDate } from "@/lib/format";
import { useActor } from "./actor";

export const COLSPAN = 9;

export interface LeadSummary {
  realEstateNumber: string;
  nameEn: string | null;
  leadScore: number;
  leadTier: string;
  activeBrokerCount: number;
  status: string;
  researchStatus: string;
  assignedTo: string | null;
  contactsFound: number;
  outreachCount: number;
  lastOutreachAt: string | null;
  lastOutreachOutcome: string | null;
  nextFollowUpAt: string | null;
}

interface Contact {
  id: string;
  name: string | null;
  title: string | null;
  linkedinUrl: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  isPrimary: boolean;
  source: string | null;
  confidence: string;
  foundBy: string | null;
}

interface OutreachRow {
  id: string;
  channel: string;
  outcome: string;
  sentAt: string;
  followUpAt: string | null;
  notes: string | null;
  actor: string | null;
  contact: { name: string | null } | null;
}

interface Activity {
  id: string;
  type: string;
  summary: string;
  actor: string | null;
  createdAt: string;
}

interface LeadDetail {
  realEstateNumber: string;
  nameEn: string | null;
  website: string | null;
  linkedinUrl: string | null;
  instagramUrl: string | null;
  contactEmail: string | null;
  contactMobile: string | null;
  phone: string | null;
  researchStatus: string;
  researchNotes: string | null;
  assignedTo: string | null;
  contacts: Contact[];
  outreach: OutreachRow[];
  leadActivities: Activity[];
}

function researchTone(status: string): "neutral" | "good" | "warn" | "bad" | "accent" {
  if (RESEARCH_ACTIONABLE.includes(status)) return "good";
  if (status === RESEARCH_IN_PROGRESS) return "accent";
  if (RESEARCH_TERMINAL.includes(status)) return "bad";
  return "neutral";
}

function outcomeTone(outcome: string): "neutral" | "good" | "warn" | "bad" | "accent" {
  if (OUTREACH_ENGAGED.includes(outcome)) return "good";
  if (OUTREACH_OPEN.includes(outcome)) return "accent";
  return "neutral";
}

/**
 * One queue row plus its expandable work panel.
 *
 * The panel's data is fetched on first expand instead of being joined into the
 * queue query: the queue routinely returns hundreds of rows and none of the
 * contacts, outreach or timeline is visible until someone opens one.
 */
export function LeadRow({ lead }: { lead: LeadSummary }) {
  const router = useRouter();
  const actor = useActor();

  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/crm/leads/${lead.realEstateNumber}`;

  const load = useCallback(async () => {
    const res = await fetch(base, { cache: "no-store" });
    if (res.ok) setDetail((await res.json()) as LeadDetail);
  }, [base]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !detail) {
      setBusy(true);
      await load();
      setBusy(false);
    }
  };

  /** Every mutation goes through here so refresh + error handling stay uniform. */
  const send = async (
    path: string,
    init: RequestInit & { body?: string },
  ): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        headers: { "Content-Type": "application/json", "x-actor": actor ?? "" },
        ...init,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Request failed (${res.status})`);
        return false;
      }
      await load();
      // Refresh the server component so the row summary and the coverage stats
      // at the top of the page reflect the change too.
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  };

  const patchLead = (patch: Record<string, unknown>) =>
    send(base, { method: "PATCH", body: JSON.stringify({ ...patch, actor }) });

  const claim = () =>
    patchLead({ assignedTo: actor, researchStatus: RESEARCH_IN_PROGRESS });

  const followUpDue =
    lead.nextFollowUpAt != null && new Date(lead.nextFollowUpAt) <= new Date();

  return (
    <>
      <tr
        className="cursor-pointer border-b border-[color:var(--border)]/50 hover:bg-[color:var(--surface-2)]/50"
        onClick={toggle}
      >
        <td className="max-w-[300px] px-4 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted">{open ? "▾" : "▸"}</span>
            <span className="line-clamp-1" title={lead.nameEn ?? ""}>
              {lead.nameEn ?? `#${lead.realEstateNumber}`}
            </span>
          </div>
        </td>
        <td className="px-2 py-2 text-right">
          <span className="mr-1.5 font-semibold tabular-nums">{lead.leadScore}</span>
          <TierBadge tier={lead.leadTier} />
        </td>
        <td className="px-2 py-2 text-right tabular-nums">{lead.activeBrokerCount}</td>
        <td className="px-2 py-2">
          <Pill tone={researchTone(lead.researchStatus)}>{lead.researchStatus}</Pill>
        </td>
        <td className="px-2 py-2 text-right tabular-nums">
          {lead.contactsFound > 0 ? (
            lead.contactsFound
          ) : (
            <span className="text-muted">—</span>
          )}
        </td>
        <td className="whitespace-nowrap px-2 py-2">
          {lead.outreachCount === 0 ? (
            <span className="text-muted">—</span>
          ) : (
            <span className="flex items-center gap-1.5">
              <span className="tabular-nums">{lead.outreachCount}</span>
              {lead.lastOutreachOutcome ? (
                <Pill tone={outcomeTone(lead.lastOutreachOutcome)}>
                  {lead.lastOutreachOutcome}
                </Pill>
              ) : null}
            </span>
          )}
        </td>
        <td className="whitespace-nowrap px-2 py-2 tabular-nums">
          {lead.nextFollowUpAt ? (
            <span style={{ color: followUpDue ? "var(--warn)" : undefined }}>
              {fmtDate(lead.nextFollowUpAt)}
            </span>
          ) : (
            <span className="text-muted">—</span>
          )}
        </td>
        <td className="whitespace-nowrap px-2 py-2">
          {lead.assignedTo ?? <span className="text-muted">unassigned</span>}
        </td>
        <td className="whitespace-nowrap px-4 py-2 text-muted">{lead.status}</td>
      </tr>

      {open ? (
        <tr className="border-b border-[color:var(--border)] bg-[color:var(--surface-2)]/30">
          <td colSpan={COLSPAN} className="px-4 py-3">
            {busy && !detail ? (
              <p className="py-4 text-center text-xs text-muted">Loading…</p>
            ) : detail ? (
              <WorkPanel
                lead={lead}
                detail={detail}
                actor={actor}
                busy={busy}
                error={error}
                base={base}
                onClaim={claim}
                onPatch={patchLead}
                send={send}
              />
            ) : (
              <p className="py-4 text-center text-xs text-muted">
                Could not load this lead.
              </p>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function WorkPanel({
  lead,
  detail,
  actor,
  busy,
  error,
  base,
  onClaim,
  onPatch,
  send,
}: {
  lead: LeadSummary;
  detail: LeadDetail;
  actor: string | null;
  busy: boolean;
  error: string | null;
  base: string;
  onClaim: () => Promise<boolean>;
  onPatch: (patch: Record<string, unknown>) => Promise<boolean>;
  send: (path: string, init: RequestInit & { body?: string }) => Promise<boolean>;
}) {
  const [notes, setNotes] = useState(detail.researchNotes ?? "");
  const [note, setNote] = useState("");
  const links = lookupLinks(detail.nameEn, detail.website);

  return (
    <div className="space-y-3">
      {!actor ? (
        <p className="rounded border border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 px-2.5 py-1.5 text-[11px] text-[color:var(--warn)]">
          Set your name in the header first — everything you log here is
          attributed, and right now it would be recorded as nobody.
        </p>
      ) : null}

      {error ? (
        <p className="rounded border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-2.5 py-1.5 text-[11px] text-[color:var(--danger)]">
          {error}
        </p>
      ) : null}

      {/* --- research row ------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[10px] uppercase tracking-wider text-muted">
          Research
        </span>
        {RESEARCH_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            disabled={busy}
            title={RESEARCH_STATUS_HINT[s]}
            onClick={() => onPatch({ researchStatus: s })}
            className="rounded border px-2 py-1 text-[11px] transition-colors disabled:opacity-40"
            style={{
              borderColor:
                detail.researchStatus === s ? "var(--accent)" : "var(--border)",
              background:
                detail.researchStatus === s ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "transparent",
              color:
                detail.researchStatus === s ? "var(--foreground)" : "var(--muted)",
            }}
          >
            {s}
          </button>
        ))}

        <span className="ml-auto flex items-center gap-1.5">
          {detail.assignedTo ? (
            <>
              <span className="text-[11px] text-muted">
                assigned to{" "}
                <span className="text-[color:var(--foreground)]">
                  {detail.assignedTo}
                </span>
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onPatch({ assignedTo: null })}
                className="rounded border border-[color:var(--border)] px-2 py-1 text-[11px] text-muted disabled:opacity-40"
              >
                Release
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy || !actor}
              onClick={onClaim}
              className="rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/15 px-2.5 py-1 text-[11px] font-medium text-[color:var(--accent)] disabled:opacity-40"
              title="Assign to yourself and mark it as being researched"
            >
              Claim
            </button>
          )}
        </span>
      </div>

      {/* --- lookup shortcuts --------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[10px] uppercase tracking-wider text-muted">
          Look up
        </span>
        {links.map((l) => (
          <a
            key={l.label}
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-[color:var(--border)] px-2 py-1 text-[11px] text-muted hover:border-[color:var(--accent)] hover:text-[color:var(--foreground)]"
          >
            {l.label} ↗
          </a>
        ))}
        {detail.linkedinUrl ? (
          <a
            href={detail.linkedinUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-[color:var(--accent)]/50 px-2 py-1 text-[11px] text-[color:var(--accent)]"
          >
            Registry LinkedIn ↗
          </a>
        ) : null}
        <Link
          href={`/brokerages/${lead.realEstateNumber}`}
          className="ml-auto text-[11px] text-[color:var(--accent)] hover:underline"
        >
          Full registry record →
        </Link>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* --- contacts --------------------------------------------------- */}
        <div className="card p-3">
          <h3 className="mb-2 text-[12px] font-semibold">
            Decision-makers{" "}
            <span className="font-normal text-muted">
              ({detail.contacts.length})
            </span>
          </h3>

          {detail.contacts.length === 0 ? (
            <p className="mb-2 text-[11px] text-muted">
              None recorded. If you searched and there is genuinely nobody
              findable, mark the firm{" "}
              <span className="text-[color:var(--foreground)]">
                {RESEARCH_NOTHING_FOUND}
              </span>{" "}
              so it leaves the queue instead of coming back to someone else.
            </p>
          ) : (
            <ul className="mb-2.5 space-y-1.5">
              {detail.contacts.map((c) => (
                <li
                  key={c.id}
                  className="rounded border border-[color:var(--border)] px-2 py-1.5 text-[11.5px]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{c.name ?? "Unnamed"}</span>
                        {c.title ? (
                          <span className="text-muted">{c.title}</span>
                        ) : null}
                        {c.isPrimary ? <Pill tone="accent">primary</Pill> : null}
                        {c.confidence !== "High" ? (
                          <Pill tone={c.confidence === "Low" ? "warn" : "neutral"}>
                            {c.confidence} confidence
                          </Pill>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-muted">
                        {c.linkedinUrl ? (
                          <a
                            href={c.linkedinUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[color:var(--accent)] hover:underline"
                          >
                            LinkedIn ↗
                          </a>
                        ) : null}
                        {c.email ? <span>{c.email}</span> : null}
                        {c.phone ? <span>{c.phone}</span> : null}
                        {c.whatsapp ? <span>wa {c.whatsapp}</span> : null}
                        {c.source ? <span>via {c.source}</span> : null}
                        {c.foundBy ? <span>· {c.foundBy}</span> : null}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        send(`${base}/contacts?contactId=${c.id}`, {
                          method: "DELETE",
                        })
                      }
                      className="shrink-0 text-[11px] text-muted hover:text-[color:var(--danger)] disabled:opacity-40"
                      title="Remove this contact"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <ContactForm
            busy={busy}
            onSubmit={(body) =>
              send(`${base}/contacts`, {
                method: "POST",
                body: JSON.stringify({ ...body, actor }),
              })
            }
          />
        </div>

        {/* --- outreach --------------------------------------------------- */}
        <div className="card p-3">
          <h3 className="mb-2 text-[12px] font-semibold">
            Outreach{" "}
            <span className="font-normal text-muted">
              ({detail.outreach.length})
            </span>
          </h3>

          {detail.outreach.length === 0 ? (
            <p className="mb-2 text-[11px] text-muted">
              Nothing sent yet.
            </p>
          ) : (
            <ul className="mb-2.5 space-y-1.5">
              {detail.outreach.map((o) => (
                <li
                  key={o.id}
                  className="rounded border border-[color:var(--border)] px-2 py-1.5 text-[11.5px]"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{o.channel}</span>
                    {o.contact?.name ? (
                      <span className="text-muted">→ {o.contact.name}</span>
                    ) : null}
                    <span className="text-muted">{fmtAge(o.sentAt)}</span>
                    {o.actor ? (
                      <span className="text-muted">· {o.actor}</span>
                    ) : null}
                    <select
                      className="field ml-auto !w-auto !py-0.5 !text-[11px]"
                      value={o.outcome}
                      disabled={busy}
                      onChange={(e) =>
                        send(`${base}/outreach`, {
                          method: "PATCH",
                          body: JSON.stringify({
                            outreachId: o.id,
                            outcome: e.target.value,
                            actor,
                          }),
                        })
                      }
                    >
                      {OUTREACH_OUTCOMES.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                  </div>
                  {o.followUpAt ? (
                    <div className="mt-0.5 text-[11px] text-muted">
                      follow up {fmtDate(o.followUpAt)}
                    </div>
                  ) : null}
                  {o.notes ? (
                    <div className="mt-0.5 text-[11px] text-muted">{o.notes}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <OutreachForm
            busy={busy}
            contacts={detail.contacts}
            onSubmit={(body) =>
              send(`${base}/outreach`, {
                method: "POST",
                body: JSON.stringify({ ...body, actor }),
              })
            }
          />
        </div>
      </div>

      {/* --- notes + timeline --------------------------------------------- */}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card p-3">
          <h3 className="mb-2 text-[12px] font-semibold">Research notes</h3>
          <textarea
            className="field min-h-[64px] resize-y"
            placeholder="What you searched, what you found, why you stopped…"
            value={notes}
            disabled={busy}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => {
              if (notes !== (detail.researchNotes ?? "")) {
                onPatch({ researchNotes: notes });
              }
            }}
          />

          <div className="mt-2 flex gap-1.5">
            <input
              className="field"
              placeholder="Add a timeline note…"
              value={note}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || !note.trim()}
              onClick={async () => {
                const ok = await send(base, {
                  method: "POST",
                  body: JSON.stringify({ note, actor }),
                });
                if (ok) setNote("");
              }}
              className="shrink-0 rounded border border-[color:var(--border)] px-2.5 py-1 text-[11px] disabled:opacity-40"
            >
              Log
            </button>
          </div>
        </div>

        <div className="card p-3">
          <h3 className="mb-2 text-[12px] font-semibold">Timeline</h3>
          {detail.leadActivities.length === 0 ? (
            <p className="text-[11px] text-muted">Nothing logged yet.</p>
          ) : (
            <ul className="max-h-[220px] space-y-1 overflow-y-auto pr-1">
              {detail.leadActivities.map((a) => (
                <li key={a.id} className="flex gap-2 text-[11.5px]">
                  <span className="w-[86px] shrink-0 tabular-nums text-muted">
                    {fmtDate(a.createdAt)}
                  </span>
                  <span className="min-w-0 flex-1">
                    {a.summary}
                    {a.actor ? (
                      <span className="text-muted"> · {a.actor}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ContactForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const empty = {
    name: "",
    title: "",
    linkedinUrl: "",
    email: "",
    phone: "",
    source: "",
    confidence: "Medium",
  };
  const [form, setForm] = useState(empty);
  const set = (k: keyof typeof empty, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <form
      className="grid grid-cols-2 gap-1.5"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await onSubmit(form);
        if (ok) setForm(empty);
      }}
    >
      <input
        className="field"
        placeholder="Name"
        value={form.name}
        onChange={(e) => set("name", e.target.value)}
      />
      <input
        className="field"
        placeholder="Title (Founder, Sales Head…)"
        value={form.title}
        onChange={(e) => set("title", e.target.value)}
      />
      <input
        className="field col-span-2"
        placeholder="LinkedIn profile URL"
        value={form.linkedinUrl}
        onChange={(e) => set("linkedinUrl", e.target.value)}
      />
      <input
        className="field"
        placeholder="Email"
        value={form.email}
        onChange={(e) => set("email", e.target.value)}
      />
      <input
        className="field"
        placeholder="Phone / WhatsApp"
        value={form.phone}
        onChange={(e) => set("phone", e.target.value)}
      />
      <input
        className="field"
        placeholder="Source (website team page…)"
        value={form.source}
        onChange={(e) => set("source", e.target.value)}
      />
      <div className="flex gap-1.5">
        <select
          className="field"
          value={form.confidence}
          onChange={(e) => set("confidence", e.target.value)}
        >
          {CONTACT_CONFIDENCE.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={busy}
          className="shrink-0 rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/15 px-2.5 py-1 text-[11px] font-medium text-[color:var(--accent)] disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </form>
  );
}

function OutreachForm({
  busy,
  contacts,
  onSubmit,
}: {
  busy: boolean;
  contacts: Contact[];
  onSubmit: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const empty = {
    channel: OUTREACH_CHANNELS[0] as string,
    contactId: "",
    followUpAt: "",
    notes: "",
  };
  const [form, setForm] = useState(empty);
  const set = (k: keyof typeof empty, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <form
      className="grid grid-cols-2 gap-1.5"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await onSubmit(form);
        if (ok) setForm(empty);
      }}
    >
      <select
        className="field"
        value={form.channel}
        onChange={(e) => set("channel", e.target.value)}
      >
        {OUTREACH_CHANNELS.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <select
        className="field"
        value={form.contactId}
        onChange={(e) => set("contactId", e.target.value)}
      >
        <option value="">No specific person</option>
        {contacts.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name ?? "Unnamed"}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1.5 text-[11px] text-muted">
        follow up
        <input
          className="field"
          type="date"
          value={form.followUpAt}
          onChange={(e) => set("followUpAt", e.target.value)}
        />
      </label>
      <div className="flex gap-1.5">
        <input
          className="field"
          placeholder="Note"
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
        />
        <button
          type="submit"
          disabled={busy}
          className="shrink-0 rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/15 px-2.5 py-1 text-[11px] font-medium text-[color:var(--accent)] disabled:opacity-40"
        >
          Log
        </button>
      </div>
    </form>
  );
}
