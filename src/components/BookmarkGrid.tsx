import type { Bookmark } from "@/types/bookmark";
import { BookmarkCard } from "@/components/BookmarkCard";
import { SearchIcon } from "@/components/icons";

interface BookmarkGridProps {
  bookmarks: Bookmark[];
  onToggleFavorite: (id: string) => void;
  onEdit: (bookmark: Bookmark) => void;
  onDeleteRequest: (bookmark: Bookmark) => void;
}

export function BookmarkGrid({
  bookmarks,
  onToggleFavorite,
  onEdit,
  onDeleteRequest,
}: BookmarkGridProps) {
  if (bookmarks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-20 text-center">
        <SearchIcon className="text-muted-foreground" width={22} height={22} />
        <p className="text-sm font-medium text-foreground">No bookmarks found</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Try a different search term or category.
        </p>
      </div>
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
