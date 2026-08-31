"use client";

import { useState, type FormEvent } from "react";
import type { Collection } from "@/types/collection";
import type { LibraryItem } from "@/types/library-item";
import { isDuplicateCollectionName } from "@/lib/collections";
import { Dialog } from "@/components/Dialog";
import { inputClass } from "@/components/FormField";
import { PlusIcon } from "@/components/icons";

interface CollectionMembershipDialogProps {
  item: LibraryItem | null;
  collections: Collection[];
  onToggleMembership: (collectionId: string, checked: boolean) => void;
  onCreateCollection: (name: string) => void;
  onClose: () => void;
}

export function CollectionMembershipDialog({
  item,
  collections,
  onToggleMembership,
  onCreateCollection,
  onClose,
}: CollectionMembershipDialogProps) {
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | undefined>();

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    if (isDuplicateCollectionName(trimmed, collections)) {
      setError(`A collection named "${trimmed}" already exists.`);
      return;
    }
    onCreateCollection(trimmed);
    setNewName("");
    setError(undefined);
  }

  return (
    <Dialog
      isOpen={item !== null}
      onClose={onClose}
      title={item ? `Add "${item.title}" to Collections` : "Add to Collections"}
      widthClassName="max-w-sm"
    >
      {collections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          You don&apos;t have any collections yet. Create one below.
        </p>
      ) : (
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {collections.map((collection) => {
            const checked = item !== null && collection.itemIds.includes(item.id);
            return (
              <li key={collection.id}>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-surface-hover">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => onToggleMembership(collection.id, event.target.checked)}
                    className="h-4 w-4 shrink-0 rounded border-border accent-foreground"
                  />
                  <span className="truncate">{collection.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={handleCreate} className="mt-3 flex items-start gap-2 border-t border-border pt-3">
        <div className="min-w-0 flex-1">
          <label htmlFor="new-collection-name" className="sr-only">
            New collection name
          </label>
          <input
            id="new-collection-name"
            type="text"
            value={newName}
            onChange={(event) => {
              setNewName(event.target.value);
              setError(undefined);
            }}
            placeholder="New collection name"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "new-collection-name-error" : undefined}
            className={inputClass(Boolean(error))}
          />
          {error && (
            <p id="new-collection-name-error" className="mt-1.5 text-xs text-red-500">
              {error}
            </p>
          )}
        </div>
        <button
          type="submit"
          aria-label="Create collection"
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <PlusIcon width={15} height={15} />
          New
        </button>
      </form>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Done
        </button>
      </div>
    </Dialog>
  );
}
