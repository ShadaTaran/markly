import Link from "next/link";
import type { LibraryItem, MediaItem, WebsiteItem } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import type { LibraryViewMode } from "@/hooks/useLibraryViewMode";
import { WebsiteItemCard } from "@/components/WebsiteItemCard";
import { MediaItemCard } from "@/components/MediaItemCard";
import { WebsiteItemCompactCard } from "@/components/WebsiteItemCompactCard";
import { MediaItemCompactCard } from "@/components/MediaItemCompactCard";
import { WebsiteItemRow } from "@/components/WebsiteItemRow";
import { MediaItemRow } from "@/components/MediaItemRow";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/Button";
import { ItemTypeIcon } from "@/components/ItemTypeIcon";
import { FolderIcon, GlobeIcon, PlusIcon, SearchIcon, StarIcon } from "@/components/icons";
import { ALL_FILTER, FAVORITES_FILTER } from "@/lib/constants";
import type { TypeFilterValue } from "@/lib/library-items";
import { STATUS_FILTER_LABELS, type StatusFilterValue } from "@/lib/tracking";
import { isMediaItem } from "@/lib/item-detail";

interface LibraryItemGridProps {
  items: LibraryItem[];
  totalItems: number;
  viewMode: LibraryViewMode;
  searchQuery: string;
  activeType: TypeFilterValue;
  activeStatus: StatusFilterValue;
  activeCategory: string;
  activeTag: string | null;
  /** Item count of the selected collection, unaffected by other filters — undefined when viewing "All Items". */
  collectionSize?: number;
  /** Stage 35 — only relevant to the genuine (not filtered) empty state. Opens the same Add Item dialog the header's Add Item button does. */
  onAddItem: () => void;
  /** Stage 35 — only shown when actually usable in this session (both require a signed-in cloud account). */
  showAniListPath: boolean;
  showExtensionPath: boolean;
  /** Stage 35 — this device has local-only items not yet imported; see useLocalImport. Suppresses the "Add your first item" CTA so it never competes with importing real existing data. */
  pendingLocalImport: boolean;
  /** Stage 35 (final audit) — true once this browser has ever seen the library non-empty (see lib/onboarding.ts). A returning user who emptied their library sees a quieter "Add an item" notice instead of the full first-run copy — onboarding must never reactivate just because the count changed. */
  hasEverHadLibraryItems: boolean;
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
  viewMode,
  searchQuery,
  activeType,
  activeStatus,
  activeCategory,
  activeTag,
  collectionSize,
  onAddItem,
  showAniListPath,
  showExtensionPath,
  pendingLocalImport,
  hasEverHadLibraryItems,
  onToggleFavorite,
  onEdit,
  onAddToCollection,
  onDeleteRequest,
  onClearSearch,
  onClearTag,
  onTagClick,
  onQuickIncrement,
}: LibraryItemGridProps) {
  // Round 6 — empty/filtered-empty behavior is identical across every view
  // mode (never an empty Grid/Compact/List shell); this branch runs before
  // any mode-specific rendering below.
  if (items.length === 0) {
    const trimmedQuery = searchQuery.trim();
    const hasCategoryFilter = activeCategory !== ALL_FILTER && activeCategory !== FAVORITES_FILTER;
    const hasStatusFilter = activeStatus !== ALL_FILTER;

    // Stage 35 — the genuine-empty-library state (never shown for a
    // filtered-empty result — see the other branches below, all of which
    // require totalItems > 0). Distinguishes "this device has local data
    // waiting to import" (the ImportBanner above already owns that
    // message — this stays deliberately minimal) from a truly new,
    // empty library (the one intentional first-run empty state).
    if (totalItems === 0) {
      if (pendingLocalImport) {
        return (
          <EmptyState
            icon={<GlobeIcon width={22} height={22} />}
            title="Your items are ready to import"
            description="Use the notice above to bring them into your account."
          />
        );
      }

      // Stage 35 (final audit) — a returning user who emptied their
      // library is not a new user; onboarding must never reactivate just
      // because the count fell to zero (see hasEverHadLibraryItems in
      // lib/onboarding.ts). They get a quieter way back in instead of the
      // full first-run copy and secondary AniList/extension paths.
      if (hasEverHadLibraryItems) {
        return (
          <EmptyState
            icon={<GlobeIcon width={22} height={22} />}
            title="Your library is empty"
            action={{ label: "Add an item", onClick: onAddItem }}
          />
        );
      }

      return (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <GlobeIcon width={22} height={22} />
          </span>
          <div>
            <p className="text-sm font-medium text-foreground">Your library is empty</p>
            <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
              Track websites, anime, manga, books, games, movies, and series — all in one place.
            </p>
          </div>
          <Button variant="secondary" onClick={onAddItem} className="mt-1">
            <PlusIcon width={14} height={14} />
            Add your first item
          </Button>
          {(showAniListPath || showExtensionPath) && (
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs">
              {showAniListPath && (
                <Link
                  href="/settings/connections"
                  className="font-medium text-muted-foreground hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
                >
                  Import from AniList
                </Link>
              )}
              {showExtensionPath && (
                <Link
                  href="/settings/tracking"
                  className="font-medium text-muted-foreground hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
                >
                  Connect browser extension
                </Link>
              )}
            </div>
          )}
        </div>
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

  if (viewMode === "list") {
    return (
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
        {items.map((item) => {
          if (item.type === "website") {
            return (
              <WebsiteItemRow
                key={item.id}
                item={item}
                onToggleFavorite={onToggleFavorite}
                onEdit={onEdit}
                onAddToCollection={onAddToCollection}
                onDeleteRequest={onDeleteRequest}
              />
            );
          }
          if (!isMediaItem(item)) return null;
          return (
            <MediaItemRow
              key={item.id}
              item={item}
              onToggleFavorite={onToggleFavorite}
              onEdit={onEdit}
              onAddToCollection={onAddToCollection}
              onDeleteRequest={onDeleteRequest}
            />
          );
        })}
      </ul>
    );
  }

  if (viewMode === "compact") {
    return (
      <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items.map((item) => {
          if (item.type === "website") {
            return (
              <WebsiteItemCompactCard
                key={item.id}
                item={item}
                onToggleFavorite={onToggleFavorite}
                onEdit={onEdit}
                onAddToCollection={onAddToCollection}
                onDeleteRequest={onDeleteRequest}
              />
            );
          }
          if (!isMediaItem(item)) return null;
          return (
            <MediaItemCompactCard
              key={item.id}
              item={item}
              onToggleFavorite={onToggleFavorite}
              onEdit={onEdit}
              onAddToCollection={onAddToCollection}
              onDeleteRequest={onDeleteRequest}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
