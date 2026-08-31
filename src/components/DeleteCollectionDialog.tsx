import type { Collection } from "@/types/collection";
import { Dialog } from "@/components/Dialog";

interface DeleteCollectionDialogProps {
  collection: Collection | null;
  itemCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteCollectionDialog({
  collection,
  itemCount,
  onCancel,
  onConfirm,
}: DeleteCollectionDialogProps) {
  return (
    <Dialog
      isOpen={collection !== null}
      onClose={onCancel}
      title={collection ? `Delete "${collection.name}"?` : "Delete collection?"}
      widthClassName="max-w-sm"
    >
      <p className="text-sm text-muted-foreground">
        The collection will be deleted, but the {itemCount} item{itemCount === 1 ? "" : "s"} inside it will
        remain in your Markly library.
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
          Delete Collection
        </button>
      </div>
    </Dialog>
  );
}
