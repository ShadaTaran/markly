import type { CategoryOption } from "@/lib/library-items";
import { FilterTabs } from "@/components/FilterTabs";
import { PlusIcon } from "@/components/icons";

interface CollectionFilterBarProps {
  options: CategoryOption[];
  activeId: string;
  onChange: (id: string) => void;
  onCreateCollection: () => void;
}

export function CollectionFilterBar({ options, activeId, onChange, onCreateCollection }: CollectionFilterBarProps) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <FilterTabs options={options} activeId={activeId} onChange={onChange} ariaLabel="Filter library by collection" />
      </div>
      <button
        type="button"
        onClick={onCreateCollection}
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <PlusIcon width={13} height={13} />
        New Collection
      </button>
    </div>
  );
}
