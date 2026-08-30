"use client";

import { useEffect, useMemo, useState } from "react";
import type { Bookmark, BookmarkInput } from "@/types/bookmark";
import { Header } from "@/components/Header";
import { CategoryFilter } from "@/components/CategoryFilter";
import { BookmarkGrid } from "@/components/BookmarkGrid";
import { BookmarkDialog } from "@/components/BookmarkDialog";
import { DeleteBookmarkDialog } from "@/components/DeleteBookmarkDialog";
import { SortSelect } from "@/components/SortSelect";
import { XIcon } from "@/components/icons";
import { generateBookmarkId } from "@/lib/utils";
import { ALL_CATEGORY_FILTER, FAVORITES_FILTER } from "@/lib/constants";
import { loadBookmarks, saveBookmarks } from "@/lib/bookmark-storage";
import {
  filterBookmarks,
  getCategories,
  getUniqueCategories,
  normalizeCategory,
  sortBookmarks,
  type SortOption,
} from "@/lib/bookmarks";

interface BookmarkDashboardProps {
  bookmarks: Bookmark[];
}

type DialogState = { mode: "add" } | { mode: "edit"; bookmark: Bookmark } | null;

export function BookmarkDashboard({ bookmarks: initialBookmarks }: BookmarkDashboardProps) {
  const [bookmarks, setBookmarks] = useState(initialBookmarks);
  const [isHydrated, setIsHydrated] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>(ALL_CATEGORY_FILTER);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sortOption, setSortOption] = useState<SortOption>("newest");
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const [deleteTarget, setDeleteTarget] = useState<Bookmark | null>(null);

  // Runs once on mount (client-only). localStorage isn't available during
  // SSR/static prerendering, so the initial render always uses the mock
  // data to keep server and client output identical (no hydration
  // mismatch); this effect then syncs in any real stored bookmarks after
  // mount. Either way, hydration is marked complete so the save effect
  // below is allowed to run.
  useEffect(() => {
    const stored = loadBookmarks();
    if (stored) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from an external store (localStorage) on mount; the value cannot be derived during render because it isn't available at SSR/prerender time.
      setBookmarks(stored);
    }
    setIsHydrated(true);
  }, []);

  // Persist bookmarks after every change, but only once the initial
  // localStorage read above has completed. Without this guard, this effect
  // would fire on first mount with the mock data and overwrite any
  // already-stored user bookmarks before they've been loaded.
  useEffect(() => {
    if (!isHydrated) return;
    saveBookmarks(bookmarks);
  }, [bookmarks, isHydrated]);

  const uniqueCategories = useMemo(() => getUniqueCategories(bookmarks), [bookmarks]);

  // If the selected category no longer has any bookmarks (e.g. its last
  // bookmark was edited to a different category or deleted), fall back to
  // "All" instead of leaving the user stuck on a filter tab that vanished.
  const activeCategory =
    selectedCategory === ALL_CATEGORY_FILTER ||
    selectedCategory === FAVORITES_FILTER ||
    uniqueCategories.includes(selectedCategory)
      ? selectedCategory
      : ALL_CATEGORY_FILTER;

  const categories = useMemo(() => getCategories(bookmarks), [bookmarks]);

  const filteredBookmarks = useMemo(
    () => filterBookmarks(bookmarks, { searchQuery, activeCategory, activeTag }),
    [bookmarks, searchQuery, activeCategory, activeTag],
  );

  const visibleBookmarks = useMemo(
    () => sortBookmarks(filteredBookmarks, sortOption),
    [filteredBookmarks, sortOption],
  );

  function handleToggleFavorite(id: string) {
    setBookmarks((current) =>
      current.map((bookmark) =>
        bookmark.id === id
          ? { ...bookmark, favorite: !bookmark.favorite }
          : bookmark,
      ),
    );
  }

  function handleTagClick(tag: string) {
    setActiveTag((current) => (current?.toLowerCase() === tag.toLowerCase() ? null : tag));
  }

  function handleOpenAddDialog() {
    setDialogState({ mode: "add" });
  }

  function handleOpenEditDialog(bookmark: Bookmark) {
    setDialogState({ mode: "edit", bookmark });
  }

  function handleCloseDialog() {
    setDialogState(null);
  }

  function handleSubmitBookmark(values: BookmarkInput) {
    const normalizedValues = {
      ...values,
      category: normalizeCategory(values.category, uniqueCategories),
    };

    if (dialogState !== null && dialogState.mode === "edit") {
      const { id } = dialogState.bookmark;
      setBookmarks((current) =>
        current.map((bookmark) =>
          bookmark.id === id ? { ...bookmark, ...normalizedValues } : bookmark,
        ),
      );
    } else {
      const newBookmark: Bookmark = {
        id: generateBookmarkId(),
        favorite: false,
        createdAt: new Date().toISOString(),
        ...normalizedValues,
      };
      setBookmarks((current) => [newBookmark, ...current]);
    }
    setDialogState(null);
  }

  function handleDeleteRequest(bookmark: Bookmark) {
    setDeleteTarget(bookmark);
  }

  function handleCancelDelete() {
    setDeleteTarget(null);
  }

  function handleConfirmDelete() {
    if (!deleteTarget) return;
    const idToDelete = deleteTarget.id;
    setBookmarks((current) => current.filter((bookmark) => bookmark.id !== idToDelete));
    setDeleteTarget(null);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onAddBookmark={handleOpenAddDialog}
      />

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <CategoryFilter
          categories={categories}
          activeCategory={activeCategory}
          onChange={setSelectedCategory}
        />

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {activeTag && (
            <button
              type="button"
              onClick={() => setActiveTag(null)}
              className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-foreground/40"
            >
              Tag: {activeTag}
              <XIcon width={13} height={13} />
            </button>
          )}
          <div className="ml-auto">
            <SortSelect value={sortOption} onChange={setSortOption} />
          </div>
        </div>

        <div className="mt-4">
          <BookmarkGrid
            bookmarks={visibleBookmarks}
            totalBookmarks={bookmarks.length}
            searchQuery={searchQuery}
            activeCategory={activeCategory}
            activeTag={activeTag}
            onToggleFavorite={handleToggleFavorite}
            onEdit={handleOpenEditDialog}
            onDeleteRequest={handleDeleteRequest}
            onClearSearch={() => setSearchQuery("")}
            onClearTag={() => setActiveTag(null)}
            onTagClick={handleTagClick}
          />
        </div>
      </main>

      <BookmarkDialog
        isOpen={dialogState !== null}
        mode={dialogState?.mode ?? "add"}
        bookmark={dialogState !== null && dialogState.mode === "edit" ? dialogState.bookmark : undefined}
        existingCategories={uniqueCategories}
        onClose={handleCloseDialog}
        onSubmit={handleSubmitBookmark}
      />

      <DeleteBookmarkDialog
        bookmark={deleteTarget}
        onCancel={handleCancelDelete}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
