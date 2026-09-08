import type { Collection } from "@/types/collection";
import { Dialog } from "@/components/Dialog";
import { Button } from "@/components/Button";

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
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          Delete Collection
        </Button>
      </div>
    </Dialog>
  );
}
