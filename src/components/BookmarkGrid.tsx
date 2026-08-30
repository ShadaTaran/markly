import type { Bookmark } from "@/types/bookmark";
import { BookmarkCard } from "@/components/BookmarkCard";
import { EmptyState } from "@/components/EmptyState";
import { GlobeIcon, SearchIcon, StarIcon } from "@/components/icons";
import { ALL_CATEGORY_FILTER, FAVORITES_FILTER } from "@/lib/constants";

interface BookmarkGridProps {
  bookmarks: Bookmark[];
  totalBookmarks: number;
  searchQuery: string;
  activeCategory: string;
  onToggleFavorite: (id: string) => void;
  onEdit: (bookmark: Bookmark) => void;
  onDeleteRequest: (bookmark: Bookmark) => void;
  onClearSearch: () => void;
}

export function BookmarkGrid({
  bookmarks,
  totalBookmarks,
  searchQuery,
  activeCategory,
  onToggleFavorite,
  onEdit,
  onDeleteRequest,
  onClearSearch,
}: BookmarkGridProps) {
  if (bookmarks.length === 0) {
    const trimmedQuery = searchQuery.trim();

    if (totalBookmarks === 0) {
      return (
        <EmptyState
          icon={<GlobeIcon width={22} height={22} />}
          title="No bookmarks yet"
          description="Add your first bookmark to get started."
        />
      );
    }

    if (trimmedQuery) {
      return (
        <EmptyState
          icon={<SearchIcon width={22} height={22} />}
          title="No bookmarks found"
          description={`No bookmarks match "${trimmedQuery}".`}
          action={{ label: "Clear search", onClick: onClearSearch }}
        />
      );
    }

    if (activeCategory === FAVORITES_FILTER) {
      return (
        <EmptyState
          icon={<StarIcon width={22} height={22} />}
          title="No favorites yet"
          description="Star bookmarks to keep your most useful links here."
        />
      );
    }

    if (activeCategory !== ALL_CATEGORY_FILTER) {
      return (
        <EmptyState
          icon={<SearchIcon width={22} height={22} />}
          title={`No bookmarks in ${activeCategory} yet`}
        />
      );
    }

    return (
      <EmptyState
        icon={<SearchIcon width={22} height={22} />}
        title="No bookmarks found"
        description="Try a different search term or category."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {bookmarks.map((bookmark) => (
        <BookmarkCard
          key={bookmark.id}
          bookmark={bookmark}
          onToggleFavorite={onToggleFavorite}
          onEdit={onEdit}
          onDeleteRequest={onDeleteRequest}
        />
      ))}
    </div>
  );
}
