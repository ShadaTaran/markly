"use client";

import { useMemo, useState } from "react";
import type { Bookmark } from "@/types/bookmark";
import { Header } from "@/components/Header";
import { CategoryFilter } from "@/components/CategoryFilter";
import { BookmarkGrid } from "@/components/BookmarkGrid";
import { getDomain } from "@/lib/utils";

interface BookmarkDashboardProps {
  bookmarks: Bookmark[];
}

const ALL_FILTER = "all";
const FAVORITES_FILTER = "favorites";

export function BookmarkDashboard({ bookmarks: initialBookmarks }: BookmarkDashboardProps) {
  const [bookmarks, setBookmarks] = useState(initialBookmarks);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState(ALL_FILTER);

  const categories = useMemo(() => {
    const uniqueCategories = Array.from(
      new Set(bookmarks.map((bookmark) => bookmark.category)),
    ).sort();

    return [
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
    ];
  }, [bookmarks]);

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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header searchQuery={searchQuery} onSearchQueryChange={setSearchQuery} />

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
          />
        </div>
      </main>
    </div>
  );
}
