import type { Collection } from "@/types/collection";
import { ItemActionsMenu } from "@/components/ItemActionsMenu";

interface CollectionHeaderProps {
  collection: Collection;
  itemCount: number;
  onEdit: () => void;
  onDeleteRequest: () => void;
}

export function CollectionHeader({ collection, itemCount, onEdit, onDeleteRequest }: CollectionHeaderProps) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold text-foreground">{collection.name}</h2>
          <span className="shrink-0 text-xs text-muted-foreground">
            {itemCount} item{itemCount === 1 ? "" : "s"}
          </span>
        </div>
        {collection.description && (
          <p className="mt-1 truncate text-xs text-muted-foreground">{collection.description}</p>
        )}
      </div>

      <ItemActionsMenu label={collection.name} onEdit={onEdit} onDeleteRequest={onDeleteRequest} />
    </div>
  );
}
