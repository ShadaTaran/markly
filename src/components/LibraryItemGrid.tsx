import type { LibraryItem, MediaItem, WebsiteItem } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { WebsiteItemCard } from "@/components/WebsiteItemCard";
import { MediaItemCard } from "@/components/MediaItemCard";
import { EmptyState } from "@/components/EmptyState";
import { ItemTypeIcon } from "@/components/ItemTypeIcon";
import { FolderIcon, GlobeIcon, SearchIcon, StarIcon } from "@/components/icons";
import { ALL_FILTER, FAVORITES_FILTER } from "@/lib/constants";
import type { TypeFilterValue } from "@/lib/library-items";
import { STATUS_FILTER_LABELS, type StatusFilterValue } from "@/lib/tracking";

interface LibraryItemGridProps {
  items: LibraryItem[];
  totalItems: number;
  searchQuery: string;
  activeType: TypeFilterValue;
  activeStatus: StatusFilterValue;
  activeCategory: string;
  activeTag: string | null;
  /** Item count of the selected collection, unaffected by other filters — undefined when viewing "All Items". */
  collectionSize?: number;
  onToggleFavorite: (id: string) => void;
  onEdit: (item: WebsiteItem | MediaItem) => void;
  onAddToCollection: (item: LibraryItem) => void;
  onDeleteRequest: (item: LibraryItem) => void;
  onClearSearch: () => void;
  onClearTag: () => void;
  onTagClick: (tag: string) => void;
  onQuickIncrement: (item: MediaItem) => void;
}

export function LibraryItemGrid({
  items,
  totalItems,
  searchQuery,
  activeType,
  activeStatus,
  activeCategory,
  activeTag,
  collectionSize,
  onToggleFavorite,
  onEdit,
  onAddToCollection,
  onDeleteRequest,
  onClearSearch,
  onClearTag,
  onTagClick,
  onQuickIncrement,
}: LibraryItemGridProps) {
  if (items.length === 0) {
    const trimmedQuery = searchQuery.trim();
    const hasCategoryFilter = activeCategory !== ALL_FILTER && activeCategory !== FAVORITES_FILTER;
    const hasStatusFilter = activeStatus !== ALL_FILTER;

    if (totalItems === 0) {
      return (
        <EmptyState
          icon={<GlobeIcon width={22} height={22} />}
          title="No items yet"
          description="Add something to start building your library."
        />
      );
    }

    if (collectionSize === 0) {
      return (
        <EmptyState
          icon={<FolderIcon width={22} height={22} />}
          title="No items in this collection yet."
          description="Add items from your library using their actions menu."
        />
      );
    }

    if (trimmedQuery) {
      return (
        <EmptyState
          icon={<SearchIcon width={22} height={22} />}
          title="No items found"
          description={`No items match "${trimmedQuery}".`}
          action={{ label: "Clear search", onClick: onClearSearch }}
        />
      );
    }

    if (activeTag) {
      return (
        <EmptyState
          icon={<SearchIcon width={22} height={22} />}
          title="No items found"
          description={`No items tagged "${activeTag}".`}
          action={{ label: "Clear tag filter", onClick: onClearTag }}
        />
      );
    }

    if (activeCategory === FAVORITES_FILTER) {
      return (
        <EmptyState
          icon={<StarIcon width={22} height={22} />}
          title="No favorites yet"
          description="Star items to keep your most useful ones here."
        />
      );
    }

    if (hasStatusFilter && (activeType !== ALL_FILTER || hasCategoryFilter)) {
      return (
        <EmptyState
          icon={<SearchIcon width={22} height={22} />}
          title="No items found"
          description="No items match your current filters."
        />
      );
    }

    if (hasStatusFilter) {
      const statusLabel = STATUS_FILTER_LABELS[activeStatus].toLowerCase();
      return (
        <EmptyState
          icon={<SearchIcon width={22} height={22} />}
          title="No items found"
          description={`No items are currently ${statusLabel}.`}
        />
      );
    }

    if (activeType !== ALL_FILTER && hasCategoryFilter) {
      return (
        <EmptyState
          icon={<SearchIcon width={22} height={22} />}
          title="No items found"
          description="No items match your current filters."
        />
      );
    }

    if (activeType !== ALL_FILTER) {
      const label = ITEM_TYPE_LABELS[activeType];
      return (
        <EmptyState
          icon={<ItemTypeIcon type={activeType} width={22} height={22} />}
          title={`No ${label} yet`}
          description={`Add ${label} to your library.`}
        />
      );
    }

    if (hasCategoryFilter) {
      return (
        <EmptyState
          icon={<SearchIcon width={22} height={22} />}
          title={`No items in ${activeCategory} yet`}
        />
      );
    }

    return (
      <EmptyState
        icon={<SearchIcon width={22} height={22} />}
        title="No items found"
        description="Try a different search term or category."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => {
        // "website" and the six media-ish types have real cards today.
        // Future types (article, video, other) plug into this switch with
        // their own card once implemented.
        switch (item.type) {
          case "website":
            return (
              <WebsiteItemCard
                key={item.id}
                item={item}
                activeTag={activeTag}
                onToggleFavorite={onToggleFavorite}
                onEdit={onEdit}
                onAddToCollection={onAddToCollection}
                onDeleteRequest={onDeleteRequest}
                onTagClick={onTagClick}
              />
            );
          case "anime":
          case "manga":
          case "novel":
          case "movie":
          case "series":
          case "game":
            return (
              <MediaItemCard
                key={item.id}
                item={item}
                activeTag={activeTag}
                onToggleFavorite={onToggleFavorite}
                onEdit={onEdit}
                onAddToCollection={onAddToCollection}
                onDeleteRequest={onDeleteRequest}
                onTagClick={onTagClick}
                onQuickIncrement={onQuickIncrement}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
