"use client";

import { useId, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { Button } from "@/components/Button";
import type { ContinueReminder } from "@/types/reminder";
import type { CreateReminderResult, SaveResult } from "@/hooks/useReminders";

interface RemindMeContinueDialogProps {
  isOpen: boolean;
  libraryItemId: string;
  itemTitle: string;
  existing: ContinueReminder | null;
  onClose: () => void;
  onCreate: (libraryItemId: string, remindAt: string) => Promise<CreateReminderResult>;
  onUpdateTime: (id: string, remindAt: string) => Promise<SaveResult>;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `<input type="datetime-local">`'s value has no timezone of its own — the browser presents/edits it in the viewer's LOCAL time, so this must build that string from the Date's own local getters (getHours/getMinutes), never toISOString/UTC getters, or the displayed value would silently be off by the local UTC offset. */
function toLocalDateTimeInputValue(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The inverse: `new Date(value)` for a timezone-less `datetime-local` string (no trailing Z/offset) is specified to parse as LOCAL time, so a plain .toISOString() already yields the correct absolute UTC instant — no manual offset arithmetic needed either direction. */
function fromLocalDateTimeInputValue(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function defaultLocalValue(): string {
  return toLocalDateTimeInputValue(new Date(Date.now() + 60 * 60 * 1000).toISOString());
}

/**
 * Stage 34 — the ONE continue-reminder creation/edit UI, used by
 * `/library/[id]`'s "[Remind me to continue]" action. No provider data
 * involved at any point — a plain, explicit, user-chosen absolute instant.
 */
export function RemindMeContinueDialog({ isOpen, libraryItemId, itemTitle, existing, onClose, onCreate, onUpdateTime }: RemindMeContinueDialogProps) {
  const inputId = useId();
  const openKey = `${libraryItemId}:${existing?.id ?? ""}`;
  const [lastOpenKey, setLastOpenKey] = useState(openKey);
  const [value, setValue] = useState(existing ? toLocalDateTimeInputValue(existing.remindAt) : defaultLocalValue());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (openKey !== lastOpenKey) {
    setLastOpenKey(openKey);
    setValue(existing ? toLocalDateTimeInputValue(existing.remindAt) : defaultLocalValue());
    setSaving(false);
    setError(null);
  }

  async function handleSave() {
    const remindAt = fromLocalDateTimeInputValue(value);
    if (!remindAt) {
      setError("Choose a valid date and time.");
      return;
    }
    setSaving(true);
    setError(null);
    if (existing) {
      const result = await onUpdateTime(existing.id, remindAt);
      setSaving(false);
      if (!result.ok) {
        setError(result.message ?? "Unable to save this reminder.");
        return;
      }
    } else {
      const result = await onCreate(libraryItemId, remindAt);
      setSaving(false);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      // "duplicate" (an identical active reminder already exists at this
      // exact instant) is treated as success — see
      // RemindMeReleaseDialog's identical reasoning.
    }
    onClose();
  }

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={existing ? "Edit reminder" : "Remind me to continue"} widthClassName="max-w-sm">
      <p className="mb-3 truncate text-sm text-muted-foreground">{itemTitle}</p>
      <label htmlFor={inputId} className="mb-1.5 block text-xs font-medium text-muted-foreground">
        Remind me at
      </label>
      <input
        id={inputId}
        type="datetime-local"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      />
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      <p className="mt-3 text-xs text-muted-foreground">
        Markly will surface this reminder when you return — it can&rsquo;t notify you while closed.
      </p>
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSave} disabled={saving} className="min-w-28">
          {saving ? "Saving…" : existing ? "Save" : "Set reminder"}
        </Button>
      </div>
    </Dialog>
  );
}
