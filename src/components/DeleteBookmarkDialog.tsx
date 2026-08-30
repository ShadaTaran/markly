import type { Bookmark } from "@/types/bookmark";
import { Dialog } from "@/components/Dialog";

interface DeleteBookmarkDialogProps {
  bookmark: Bookmark | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteBookmarkDialog({
  bookmark,
  onCancel,
  onConfirm,
}: DeleteBookmarkDialogProps) {
  return (
    <Dialog
      isOpen={bookmark !== null}
      onClose={onCancel}
      title={bookmark ? `Delete "${bookmark.title}"?` : "Delete bookmark?"}
      widthClassName="max-w-sm"
    >
      <p className="text-sm text-muted-foreground">
        This bookmark will be removed. This action cannot be undone.
      </p>
      <div className="mt-5 flex items-center justify-end gap-2">
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
          className="rounded-md bg-danger px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-danger-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
        >
          Delete
        </button>
      </div>
    </Dialog>
  );
}
