"use client";

import { useMemo, useState } from "react";
import type { Bookmark, BookmarkInput } from "@/types/bookmark";
import { Header } from "@/components/Header";
import { CategoryFilter } from "@/components/CategoryFilter";
import { BookmarkGrid } from "@/components/BookmarkGrid";
import { BookmarkDialog } from "@/components/BookmarkDialog";
import { DeleteBookmarkDialog } from "@/components/DeleteBookmarkDialog";
import { generateBookmarkId, getDomain } from "@/lib/utils";

interface BookmarkDashboardProps {
  bookmarks: Bookmark[];
}

const ALL_FILTER = "all";
const FAVORITES_FILTER = "favorites";

type DialogState = { mode: "add" } | { mode: "edit"; bookmark: Bookmark } | null;

export function BookmarkDashboard({ bookmarks: initialBookmarks }: BookmarkDashboardProps) {
  const [bookmarks, setBookmarks] = useState(initialBookmarks);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState(ALL_FILTER);
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const [deleteTarget, setDeleteTarget] = useState<Bookmark | null>(null);

  const uniqueCategories = useMemo(
    () => Array.from(new Set(bookmarks.map((bookmark) => bookmark.category))).sort(),
    [bookmarks],
  );

  const categories = useMemo(
    () => [
      { id: ALL_FILTER, label: "All", count: bookmarks.length },
      {
        id: FAVORITES_FILTER,
        label: "Favorites",
        count: bookmarks.filter((bookmark) => bookmark.favorite).length,
      },
      ...uniqueCategories.map((category) => ({
        id: category,
        label: category,
        count: bookmarks.filter((bookmark) => bookmark.category === category).length,
      })),
    ],
    [bookmarks, uniqueCategories],
  );

  const filteredBookmarks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return bookmarks.filter((bookmark) => {
      const matchesCategory =
        activeCategory === ALL_FILTER
          ? true
          : activeCategory === FAVORITES_FILTER
            ? bookmark.favorite
            : bookmark.category === activeCategory;

      if (!matchesCategory) return false;
      if (!query) return true;

      const haystack = [
        bookmark.title,
        bookmark.description,
        bookmark.category,
        getDomain(bookmark.url),
        ...bookmark.tags,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [bookmarks, searchQuery, activeCategory]);

  function handleToggleFavorite(id: string) {
    setBookmarks((current) =>
      current.map((bookmark) =>
        bookmark.id === id
          ? { ...bookmark, favorite: !bookmark.favorite }
          : bookmark,
      ),
    );
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
    if (dialogState !== null && dialogState.mode === "edit") {
      const { id } = dialogState.bookmark;
      setBookmarks((current) =>
        current.map((bookmark) =>
          bookmark.id === id ? { ...bookmark, ...values } : bookmark,
        ),
      );
    } else {
      const newBookmark: Bookmark = {
        id: generateBookmarkId(),
        favorite: false,
        ...values,
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
          onChange={setActiveCategory}
        />

        <div className="mt-6">
          <BookmarkGrid
            bookmarks={filteredBookmarks}
            onToggleFavorite={handleToggleFavorite}
            onEdit={handleOpenEditDialog}
            onDeleteRequest={handleDeleteRequest}
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
