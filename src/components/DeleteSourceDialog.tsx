import type { TrackingSourceSummary } from "@/lib/extension/types";
import { Dialog } from "@/components/Dialog";
import { Button } from "@/components/Button";

interface DeleteSourceDialogProps {
  source: TrackingSourceSummary | null;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}

/**
 * Stage 42 — permanent removal of an UNLINKED MANUAL TrackingSource row.
 * Deliberately never offered for a linked or non-manual source (see
 * TrackingSettingsPanel's own eligibility check) — this dialog's copy is
 * only ever truthful for that one narrow class: no LibraryItem, no
 * external website/account, and no progress history of any kind is
 * affected, because a manual source never carried consumption progress of
 * its own to begin with (see deleteUnlinkedManualSource's own doc
 * comment). Reuses the exact Dialog/Button primitives
 * DeleteLibraryItemDialog already established, rather than a second
 * ad-hoc confirmation pattern.
 */
export function DeleteSourceDialog({ source, onCancel, onConfirm, busy }: DeleteSourceDialogProps) {
  return (
    <Dialog
      isOpen={source !== null}
      onClose={onCancel}
      title={source ? `Delete "${source.sourceTitle}"?` : "Delete source?"}
      widthClassName="max-w-sm"
    >
      <p className="text-sm text-muted-foreground">
        This removes the saved source record from Markly. It does not affect any library item, and it does not delete
        or change anything on the website itself. You can add this source again later if needed.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">This can&rsquo;t be undone.</p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm} disabled={busy}>
          {busy ? "Deleting…" : "Delete"}
        </Button>
      </div>
    </Dialog>
  );
}
