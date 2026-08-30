import type { Bookmark } from "@/types/bookmark";
import { ALL_CATEGORY_FILTER, FAVORITES_FILTER } from "@/lib/constants";
import { getDomain } from "@/lib/utils";

export type SortOption = "newest" | "oldest" | "az" | "za";

export interface CategoryOption {
  id: string;
  label: string;
  count: number;
}

export function getUniqueCategories(bookmarks: Bookmark[]): string[] {
  return Array.from(new Set(bookmarks.map((bookmark) => bookmark.category))).sort();
}

export function getCategories(bookmarks: Bookmark[]): CategoryOption[] {
  const uniqueCategories = getUniqueCategories(bookmarks);

  return [
    { id: ALL_CATEGORY_FILTER, label: "All", count: bookmarks.length },
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
}

/**
 * Resolves a user-entered category against the categories already in use,
 * so casing/whitespace differences (" development", "DEVELOPMENT") reuse
 * the existing category instead of creating a near-duplicate.
 */
export function normalizeCategory(input: string, existingCategories: string[]): string {
  const cleaned = input.trim().replace(/\s+/g, " ");
  const key = cleaned.toLowerCase();
  const existingMatch = existingCategories.find(
    (category) => category.toLowerCase() === key,
  );
  return existingMatch ?? cleaned;
}

interface FilterOptions {
  searchQuery: string;
  activeCategory: string;
  activeTag: string | null;
}

export function filterBookmarks(
  bookmarks: Bookmark[],
  { searchQuery, activeCategory, activeTag }: FilterOptions,
): Bookmark[] {
  const query = searchQuery.trim().toLowerCase();
  const tag = activeTag ? activeTag.toLowerCase() : null;

  return bookmarks.filter((bookmark) => {
    const matchesCategory =
      activeCategory === ALL_CATEGORY_FILTER
        ? true
        : activeCategory === FAVORITES_FILTER
          ? bookmark.favorite
          : bookmark.category === activeCategory;

    if (!matchesCategory) return false;

    if (tag && !bookmark.tags.some((bookmarkTag) => bookmarkTag.toLowerCase() === tag)) {
      return false;
    }

    if (!query) return true;

    const haystack = [
      bookmark.title,
      bookmark.description,
      bookmark.category,
      bookmark.url,
      getDomain(bookmark.url),
      ...bookmark.tags,
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  });
}

export function sortBookmarks(bookmarks: Bookmark[], sortOption: SortOption): Bookmark[] {
  const sorted = [...bookmarks];

  switch (sortOption) {
    case "newest":
      sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      break;
    case "oldest":
      sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      break;
    case "az":
      sorted.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
      break;
    case "za":
      sorted.sort((a, b) => b.title.localeCompare(a.title, undefined, { sensitivity: "base" }));
      break;
  }

  return sorted;
}
