import type { LibraryItem } from "@/types/library-item";
import { Dialog } from "@/components/Dialog";
import { Button } from "@/components/Button";

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
        This item will be removed. You&rsquo;ll have a short window to undo this afterward, but treat it as final.
      </p>
      <div className="mt-5 flex items-center justify-end gap-2">
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
