import type { LibraryItem, LibraryItemType, MediaItem, MediaItemInput } from "@/types/library-item";
import { ITEM_TYPE_LABELS, SUPPORTED_ITEM_TYPES } from "@/types/library-item";
import { ALL_FILTER, FAVORITES_FILTER } from "@/lib/constants";
import { getDomain } from "@/lib/website";
import type { StatusFilterValue } from "@/lib/tracking";

export type SortOption = "newest" | "oldest" | "az" | "za";

export interface CategoryOption {
  id: string;
  label: string;
  count: number;
}

export function getUniqueCategories(items: LibraryItem[]): string[] {
  return Array.from(new Set(items.map((item) => item.category))).sort();
}

export function getCategories(items: LibraryItem[]): CategoryOption[] {
  const uniqueCategories = getUniqueCategories(items);

  return [
    { id: ALL_FILTER, label: "All", count: items.length },
    {
      id: FAVORITES_FILTER,
      label: "Favorites",
      count: items.filter((item) => item.favorite).length,
    },
    ...uniqueCategories.map((category) => ({
      id: category,
      label: category,
      count: items.filter((item) => item.category === category).length,
    })),
  ];
}

/**
 * The type filter's options are a small fixed set (unlike categories, which
 * are dynamic/arbitrary), so every supported type is always listed even at
 * a count of zero — it's a stable menu of what Markly supports, not a
 * reflection of what's currently in the library.
 */
export function getItemTypeOptions(items: LibraryItem[]): CategoryOption[] {
  return [
    { id: ALL_FILTER, label: "All", count: items.length },
    ...SUPPORTED_ITEM_TYPES.map((type) => ({
      id: type,
      label: ITEM_TYPE_LABELS[type],
      count: items.filter((item) => item.type === type).length,
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

export type TypeFilterValue = LibraryItemType | typeof ALL_FILTER;

interface FilterOptions {
  searchQuery: string;
  activeType: TypeFilterValue;
  activeStatus: StatusFilterValue;
  activeCategory: string;
  activeTag: string | null;
  /** Restricts to a collection's membership when set; omit/undefined for "All Items". */
  collectionItemIds?: Set<string>;
}

/**
 * Builds the searchable text for one item. Fields on BaseLibraryItem apply
 * to every type; each item type then contributes its own extra fields via
 * a targeted `in` check, so adding a new searchable field to a future type
 * doesn't require touching every other branch.
 */
function getSearchableText(item: LibraryItem): string {
  const parts: string[] = [item.title, item.description, item.category, ...item.tags];

  if (item.type === "website") {
    parts.push(item.url, getDomain(item.url));
  }
  if ("sourceUrl" in item && item.sourceUrl) {
    parts.push(item.sourceUrl);
  }
  if ("platform" in item && item.platform) {
    parts.push(item.platform);
  }

  return parts.join(" ").toLowerCase();
}

export function filterLibraryItems(
  items: LibraryItem[],
  { searchQuery, activeType, activeStatus, activeCategory, activeTag, collectionItemIds }: FilterOptions,
): LibraryItem[] {
  const query = searchQuery.trim().toLowerCase();
  const tag = activeTag ? activeTag.toLowerCase() : null;

  return items.filter((item) => {
    if (collectionItemIds && !collectionItemIds.has(item.id)) return false;

    if (activeType !== ALL_FILTER && item.type !== activeType) return false;

    // Website items (and the generic placeholder type) have no tracking
    // status at all, so a specific status filter simply excludes them.
    if (activeStatus !== ALL_FILTER && (!("status" in item) || item.status !== activeStatus)) {
      return false;
    }

    const matchesCategory =
      activeCategory === ALL_FILTER
        ? true
        : activeCategory === FAVORITES_FILTER
          ? item.favorite
          : item.category === activeCategory;

    if (!matchesCategory) return false;

    if (tag && !item.tags.some((itemTag) => itemTag.toLowerCase() === tag)) {
      return false;
    }

    if (!query) return true;

    return getSearchableText(item).includes(query);
  });
}

export function sortLibraryItems(items: LibraryItem[], sortOption: SortOption): LibraryItem[] {
  const sorted = [...items];

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

/**
 * Constructs a new MediaItem of the given type. Uses a switch over `type`
 * (rather than a type assertion) so TypeScript verifies each branch
 * actually produces a valid member of the MediaItem union.
 */
export function createMediaItem(
  type: MediaItem["type"],
  id: string,
  createdAt: string,
  values: MediaItemInput,
): MediaItem {
  const base = {
    id,
    favorite: false,
    createdAt,
    title: values.title,
    description: values.description,
    category: values.category,
    tags: values.tags,
    imageUrl: values.imageUrl,
    sourceUrl: values.sourceUrl,
    status: values.status,
    rating: values.rating,
    // Catalog/import metadata (only ever set from a search selection at
    // creation time — never touched again by editing).
    releaseYear: values.releaseYear,
    catalogSource: values.catalogSource,
  };

  switch (type) {
    case "anime":
      return {
        ...base,
        type,
        currentEpisode: "currentEpisode" in values ? values.currentEpisode : undefined,
        totalEpisodes: "totalEpisodes" in values ? values.totalEpisodes : undefined,
        genres: "genres" in values ? values.genres : undefined,
        studio: "studio" in values ? values.studio : undefined,
      };
    case "series":
      return {
        ...base,
        type,
        currentEpisode: "currentEpisode" in values ? values.currentEpisode : undefined,
        totalEpisodes: "totalEpisodes" in values ? values.totalEpisodes : undefined,
        genres: "genres" in values ? values.genres : undefined,
      };
    case "manga":
      return {
        ...base,
        type,
        currentChapter: "currentChapter" in values ? values.currentChapter : undefined,
        totalChapters: "totalChapters" in values ? values.totalChapters : undefined,
        genres: "genres" in values ? values.genres : undefined,
        authors: "authors" in values ? values.authors : undefined,
      };
    case "novel":
      return {
        ...base,
        type,
        progressValue: "progressValue" in values ? values.progressValue : undefined,
        progressUnit: "progressUnit" in values ? values.progressUnit : undefined,
        authors: "authors" in values ? values.authors : undefined,
        pageCount: "pageCount" in values ? values.pageCount : undefined,
      };
    case "movie":
      return { ...base, type, genres: "genres" in values ? values.genres : undefined };
    case "game":
      return {
        ...base,
        type,
        platform: "platform" in values ? values.platform : undefined,
        playtimeHours: "playtimeHours" in values ? values.playtimeHours : undefined,
        developer: "developer" in values ? values.developer : undefined,
        publisher: "publisher" in values ? values.publisher : undefined,
        catalogPlatforms: "catalogPlatforms" in values ? values.catalogPlatforms : undefined,
      };
  }
}

export function updateMediaItem(item: MediaItem, values: MediaItemInput): MediaItem {
  const base = {
    ...item,
    title: values.title,
    description: values.description,
    category: values.category,
    tags: values.tags,
    imageUrl: values.imageUrl,
    sourceUrl: values.sourceUrl,
    status: values.status,
    rating: values.rating,
    updatedAt: new Date().toISOString(),
  };

  switch (item.type) {
    case "anime":
    case "series":
      return {
        ...base,
        type: item.type,
        currentEpisode: "currentEpisode" in values ? values.currentEpisode : undefined,
        totalEpisodes: "totalEpisodes" in values ? values.totalEpisodes : undefined,
      };
    case "manga":
      return {
        ...base,
        type: item.type,
        currentChapter: "currentChapter" in values ? values.currentChapter : undefined,
        totalChapters: "totalChapters" in values ? values.totalChapters : undefined,
      };
    case "novel":
      return {
        ...base,
        type: item.type,
        progressValue: "progressValue" in values ? values.progressValue : undefined,
        progressUnit: "progressUnit" in values ? values.progressUnit : undefined,
        authors: "authors" in values ? values.authors : undefined,
      };
    case "movie":
      return { ...base, type: item.type };
    case "game":
      return {
        ...base,
        type: item.type,
        platform: "platform" in values ? values.platform : undefined,
        playtimeHours: "playtimeHours" in values ? values.playtimeHours : undefined,
      };
  }
}
