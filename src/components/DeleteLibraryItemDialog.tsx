import type { LibraryItem } from "@/types/library-item";
import { Dialog } from "@/components/Dialog";

interface DeleteLibraryItemDialogProps {
  item: LibraryItem | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteLibraryItemDialog({
  item,
  onCancel,
  onConfirm,
}: DeleteLibraryItemDialogProps) {
  return (
    <Dialog
      isOpen={item !== null}
      onClose={onCancel}
      title={item ? `Delete "${item.title}"?` : "Delete item?"}
      widthClassName="max-w-sm"
    >
      <p className="text-sm text-muted-foreground">
        This item will be removed. This action cannot be undone.
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
