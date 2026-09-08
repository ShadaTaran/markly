"use client";

import { useId, useState } from "react";
import type { ReleaseReminder, ReleaseReminderTarget } from "@/types/reminder";
import { LEAD_TIME_PRESETS } from "@/types/reminder";
import { Dialog } from "@/components/Dialog";
import { Button } from "@/components/Button";
import type { CreateReminderResult, SaveResult } from "@/hooks/useReminders";

interface RemindMeReleaseDialogProps {
  isOpen: boolean;
  /** The release identity to show/create for — works whether it came from a live Stage 33 ReleaseEvent (Calendar) or an existing reminder's own stored snapshot (Reminder Center's Edit). */
  target: ReleaseReminderTarget | null;
  /** Non-null means Edit — the dialog then updates this reminder's lead time rather than creating a second one (§ "never creating duplicates from repeated clicks"). */
  existing: ReleaseReminder | null;
  onClose: () => void;
  onCreate: (target: ReleaseReminderTarget, remindBeforeMinutes: number) => Promise<CreateReminderResult>;
  onUpdateLeadTime: (id: string, remindBeforeMinutes: number) => Promise<SaveResult>;
}

/**
 * Stage 34 — the ONE release-reminder creation/edit UI. Used by
 * CalendarView's "[Remind me]" action (mandatory) and the Reminder
 * Center's Edit action; reusable as-is by any future Dashboard shortcut
 * (§ "ONLY if it reuses the exact same reminder creation UI/helper — no
 * second implementation"). Lead-time choice is a real radio group, never
 * freeform text, for the fixed presets.
 */
export function RemindMeReleaseDialog({ isOpen, target, existing, onClose, onCreate, onUpdateLeadTime }: RemindMeReleaseDialogProps) {
  const groupName = useId();
  const openKey = `${target ? `${target.externalMediaId}:${target.episode}` : ""}:${existing?.id ?? ""}`;
  const [lastOpenKey, setLastOpenKey] = useState(openKey);
  const [selected, setSelected] = useState(existing?.remindBeforeMinutes ?? 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resets the form the moment a DIFFERENT target/reminder opens —
  // adjusting state during render (React's own sanctioned pattern for
  // this) rather than an effect, so the very first paint after opening for
  // a new target never flashes the previous one's selection.
  if (openKey !== lastOpenKey) {
    setLastOpenKey(openKey);
    setSelected(existing?.remindBeforeMinutes ?? 0);
    setSaving(false);
    setError(null);
  }

  if (!target) return null;

  async function handleSave() {
    if (!target) return;
    setSaving(true);
    setError(null);
    if (existing) {
      const result = await onUpdateLeadTime(existing.id, selected);
      setSaving(false);
      if (!result.ok) {
        setError(result.message ?? "Unable to save this reminder.");
        return;
      }
    } else {
      const result = await onCreate(target, selected);
      setSaving(false);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      // "duplicate" means an active reminder for this exact target already
      // exists (a race with another tab/click) — treated as success, not
      // an error, since the end state (one reminder set) is what the user
      // wanted (§ "never creating duplicates from repeated clicks").
    }
    onClose();
  }

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={existing ? "Edit reminder" : "Remind me"} widthClassName="max-w-sm">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm text-muted-foreground">
          Episode {target.episode}
          {target.title ? ` · ${target.title}` : ""}
        </legend>
        {LEAD_TIME_PRESETS.map((preset) => (
          <label
            key={preset.minutes}
            className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2 text-sm text-foreground has-[:checked]:border-foreground"
          >
            <input
              type="radio"
              name={groupName}
              checked={selected === preset.minutes}
              onChange={() => setSelected(preset.minutes)}
              className="h-4 w-4"
            />
            {preset.label}
          </label>
        ))}
      </fieldset>

      {error && <p className="mt-3 text-xs text-danger">{error}</p>}

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
