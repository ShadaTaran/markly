import type { Bookmark, BookmarkInput } from "@/types/bookmark";
import { Dialog } from "@/components/Dialog";
import { BookmarkForm } from "@/components/BookmarkForm";

interface BookmarkDialogProps {
  isOpen: boolean;
  mode: "add" | "edit";
  bookmark?: Bookmark;
  existingCategories: string[];
  onClose: () => void;
  onSubmit: (values: BookmarkInput) => void;
}

export function BookmarkDialog({
  isOpen,
  mode,
  bookmark,
  existingCategories,
  onClose,
  onSubmit,
}: BookmarkDialogProps) {
  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={mode === "edit" ? "Edit Bookmark" : "Add Bookmark"}
    >
      <BookmarkForm
        key={bookmark?.id ?? "new"}
        initialValues={bookmark}
        existingCategories={existingCategories}
        onSubmit={onSubmit}
        onCancel={onClose}
      />
    </Dialog>
  );
}
