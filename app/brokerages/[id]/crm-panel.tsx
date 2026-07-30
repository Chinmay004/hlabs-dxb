"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { STAGES } from "@/lib/crm/config";

const STATUSES = STAGES;

/** Our own pipeline state on top of the registry data. The sync never overwrites it. */
export function CrmPanel({
  realEstateNumber,
  status,
  ownerNote,
}: {
  realEstateNumber: string;
  status: string;
  ownerNote: string | null;
}) {
  const router = useRouter();
  const [localStatus, setLocalStatus] = useState(status);
  const [note, setNote] = useState(ownerNote ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async (patch: { status?: string; ownerNote?: string }) => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(`/api/offices/${realEstateNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-muted">
          Pipeline
        </span>
        <select
          className="field mt-1"
          value={localStatus}
          disabled={saving}
          onChange={(e) => {
            setLocalStatus(e.target.value);
            save({ status: e.target.value });
          }}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-muted">
          Note
        </span>
        <textarea
          className="field mt-1 min-h-[70px] resize-y"
          value={note}
          disabled={saving}
          placeholder="Who you spoke to, what they said…"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (note !== (ownerNote ?? "")) save({ ownerNote: note });
          }}
        />
      </label>

      <div className="h-4 text-[11px] text-muted">
        {saving ? "Saving…" : saved ? "Saved." : ""}
      </div>
    </div>
  );
}
