import type { LibraryItem, MediaItem, WebsiteItem } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { WebsiteItemCard } from "@/components/WebsiteItemCard";
import { MediaItemCard } from "@/components/MediaItemCard";
import { EmptyState } from "@/components/EmptyState";
import { ItemTypeIcon } from "@/components/ItemTypeIcon";
import { GlobeIcon, SearchIcon, StarIcon } from "@/components/icons";
import { ALL_FILTER, FAVORITES_FILTER } from "@/lib/constants";
import type { TypeFilterValue } from "@/lib/library-items";

interface LibraryItemGridProps {
  items: LibraryItem[];
  totalItems: number;
  searchQuery: string;
  activeType: TypeFilterValue;
  activeCategory: string;
  activeTag: string | null;
  onToggleFavorite: (id: string) => void;
  onEdit: (item: WebsiteItem | MediaItem) => void;
  onDeleteRequest: (item: LibraryItem) => void;
  onClearSearch: () => void;
  onClearTag: () => void;
  onTagClick: (tag: string) => void;
}

export function LibraryItemGrid({
  items,
  totalItems,
  searchQuery,
  activeType,
  activeCategory,
  activeTag,
  onToggleFavorite,
  onEdit,
  onDeleteRequest,
  onClearSearch,
  onClearTag,
  onTagClick,
}: LibraryItemGridProps) {
  if (items.length === 0) {
    const trimmedQuery = searchQuery.trim();
    const hasCategoryFilter = activeCategory !== ALL_FILTER && activeCategory !== FAVORITES_FILTER;

    if (totalItems === 0) {
      return (
        <EmptyState
          icon={<GlobeIcon width={22} height={22} />}
          title="No items yet"
          description="Add something to start building your library."
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
                onDeleteRequest={onDeleteRequest}
                onTagClick={onTagClick}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
