"use client";

import type { SavedSmartView } from "@/types/smart-view";
import { Dialog } from "@/components/Dialog";
import { Button } from "@/components/Button";

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
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          Delete
        </Button>
      </div>
    </Dialog>
  );
}
