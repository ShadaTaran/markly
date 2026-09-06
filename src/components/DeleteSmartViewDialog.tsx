"use client";

import type { SavedSmartView } from "@/types/smart-view";
import { Dialog } from "@/components/Dialog";

interface DeleteSmartViewDialogProps {
  view: SavedSmartView | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Deletes only the saved query definition — never LibraryItems, Collections, or Activity, and never triggers Stage 28 recovery (Stage 31 §25). */
export function DeleteSmartViewDialog({ view, onCancel, onConfirm }: DeleteSmartViewDialogProps) {
  return (
    <Dialog isOpen={view !== null} onClose={onCancel} title="Delete saved view?" widthClassName="max-w-sm">
      <p className="text-sm text-muted-foreground">
        {view && (
          <>
            &ldquo;{view.name}&rdquo; will be removed. Your library items are never affected.
          </>
        )}
      </p>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-md border border-danger/40 px-3.5 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Delete
        </button>
      </div>
    </Dialog>
  );
}
