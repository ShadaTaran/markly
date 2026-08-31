"use client";

import { useState, type FormEvent } from "react";
import type { Collection, CollectionInput } from "@/types/collection";
import { isDuplicateCollectionName } from "@/lib/collections";
import { Dialog } from "@/components/Dialog";
import { Field, inputClass } from "@/components/FormField";

interface CollectionDialogProps {
  mode: "create" | "edit";
  collection?: Collection;
  existingCollections: Collection[];
  isOpen: boolean;
  onSubmit: (values: CollectionInput) => void;
  onClose: () => void;
}

export function CollectionDialog({
  mode,
  collection,
  existingCollections,
  isOpen,
  onSubmit,
  onClose,
}: CollectionDialogProps) {
  const [name, setName] = useState(collection?.name ?? "");
  const [description, setDescription] = useState(collection?.description ?? "");
  const [error, setError] = useState<string | undefined>();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Collection name is required.");
      return;
    }
    if (isDuplicateCollectionName(trimmedName, existingCollections, collection?.id)) {
      setError(`A collection named "${trimmedName}" already exists.`);
      return;
    }

    onSubmit({ name: trimmedName, description: description.trim() || undefined });
  }

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={mode === "edit" ? "Edit Collection" : "New Collection"}
      widthClassName="max-w-sm"
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <Field label="Collection name" htmlFor="collection-name" error={error} required>
          <input
            id="collection-name"
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(undefined);
            }}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "collection-name-error" : undefined}
            className={inputClass(Boolean(error))}
            placeholder="e.g. Watch Later"
            autoFocus
          />
        </Field>

        <Field label="Description" htmlFor="collection-description" hint="Optional.">
          <textarea
            id="collection-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            className={`${inputClass(false)} resize-none`}
            placeholder="What is this collection for?"
          />
        </Field>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {mode === "edit" ? "Save Changes" : "Create Collection"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
