import type { Collection } from "@/types/collection";

interface ItemCollectionsSectionProps {
  collections: Collection[];
  onManage: () => void;
}

export function ItemCollectionsSection({ collections, onManage }: ItemCollectionsSectionProps) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Collections
        </h2>
        <button
          type="button"
          onClick={onManage}
          className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Manage
        </button>
      </div>

      {collections.length === 0 ? (
        <p className="text-sm text-muted-foreground">Not in any collections yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {collections.map((collection) => (
            <span
              key={collection.id}
              className="max-w-full truncate rounded border border-border px-2 py-1 text-xs text-foreground"
              title={collection.name}
            >
              {collection.name}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
