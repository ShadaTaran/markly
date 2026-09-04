import type { LibraryItem, WebsiteItem } from "@/types/library-item";
import {
  normalizeEpisodeNumbering,
  normalizeNonNegativeInt,
  normalizeNonNegativeNumber,
  normalizePercent,
  normalizePositiveInt,
  normalizeProgressUnit,
  normalizeRating,
  normalizeStatus,
} from "@/lib/tracking";

const LIBRARY_STORAGE_KEY = "markly.library";
const LEGACY_BOOKMARKS_STORAGE_KEY = "markly.bookmarks";

function isValidLibraryItem(value: unknown): value is LibraryItem {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Record<string, unknown>;

  const hasBaseFields =
    typeof candidate.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.category === "string" &&
    typeof candidate.favorite === "boolean" &&
    typeof candidate.createdAt === "string" &&
    Array.isArray(candidate.tags) &&
    candidate.tags.every((tag) => typeof tag === "string");

  if (!hasBaseFields) return false;

  // Website is the only type with a required extra field.
  if (candidate.type === "website") {
    return typeof candidate.url === "string";
  }

  // Every other type (the media-ish types, plus the generic placeholder for
  // article/video/other) only ever adds optional fields, so it's enough to
  // check that whichever of them are present are the right primitive type.
  // Out-of-range (but correctly-typed) values, like rating: 100 or a
  // negative currentEpisode, are handled by normalizeTrackingFields below
  // rather than rejected here.
  if (candidate.imageUrl !== undefined && typeof candidate.imageUrl !== "string") return false;
  if (candidate.sourceUrl !== undefined && typeof candidate.sourceUrl !== "string") return false;
  if (candidate.platform !== undefined && typeof candidate.platform !== "string") return false;
  if (candidate.status !== undefined && typeof candidate.status !== "string") return false;
  if (candidate.rating !== undefined && typeof candidate.rating !== "number") return false;
  if (candidate.currentEpisode !== undefined && typeof candidate.currentEpisode !== "number") return false;
  if (candidate.totalEpisodes !== undefined && typeof candidate.totalEpisodes !== "number") return false;
  if (candidate.episodeNumbering !== undefined && typeof candidate.episodeNumbering !== "string") return false;
  if (candidate.currentSeason !== undefined && typeof candidate.currentSeason !== "number") return false;
  if (candidate.currentChapter !== undefined && typeof candidate.currentChapter !== "number") return false;
  if (candidate.totalChapters !== undefined && typeof candidate.totalChapters !== "number") return false;
  if (candidate.progressValue !== undefined && typeof candidate.progressValue !== "number") return false;
  if (candidate.progressUnit !== undefined && typeof candidate.progressUnit !== "string") return false;
  if (candidate.playtimeHours !== undefined && typeof candidate.playtimeHours !== "number") return false;

  // Stage 11 catalog/import metadata — also always optional.
  if (candidate.releaseYear !== undefined && typeof candidate.releaseYear !== "number") return false;
  if (candidate.developer !== undefined && typeof candidate.developer !== "string") return false;
  if (candidate.publisher !== undefined && typeof candidate.publisher !== "string") return false;
  if (candidate.studio !== undefined && typeof candidate.studio !== "string") return false;
  if (candidate.pageCount !== undefined && typeof candidate.pageCount !== "number") return false;
  if (!isValidOptionalStringArray(candidate.genres)) return false;
  if (!isValidOptionalStringArray(candidate.authors)) return false;
  if (!isValidOptionalStringArray(candidate.catalogPlatforms)) return false;
  if (!isValidCatalogSource(candidate.catalogSource)) return false;

  return true;
}

function isValidOptionalStringArray(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isValidCatalogSource(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;

  const source = value as Record<string, unknown>;
  return typeof source.provider === "string" && typeof source.externalId === "string";
}

/**
 * Fills in and clamps Stage 10 tracking fields for one already-structurally-
 * valid item. Stage 9 records simply lack these fields (they get sensible
 * defaults); corrupted-but-correctly-typed values (rating: 100, a negative
 * currentEpisode, etc.) are clamped or dropped rather than rejecting the
 * whole item. Website items and the generic placeholder type have no
 * tracking model and pass through unchanged.
 */
function normalizeTrackingFields(item: LibraryItem): LibraryItem {
  // Website items and the generic placeholder type (article/video/other)
  // have no tracking model at all. Every other type is trackable — even a
  // Stage 9 record that predates `status` entirely and so is missing the
  // field outright, not just holding an invalid value for it.
  if (
    item.type !== "anime" &&
    item.type !== "manga" &&
    item.type !== "novel" &&
    item.type !== "game" &&
    item.type !== "movie" &&
    item.type !== "series"
  ) {
    return item;
  }

  const status = normalizeStatus(item.status);
  const rating = normalizeRating(item.rating);

  switch (item.type) {
    case "anime":
    case "series": {
      let currentEpisode = normalizeNonNegativeInt(item.currentEpisode);
      const totalEpisodes = normalizePositiveInt(item.totalEpisodes);
      const episodeNumbering = normalizeEpisodeNumbering(item.episodeNumbering);
      // A leftover currentSeason on an item that isn't (or no longer is)
      // seasonal is dropped rather than kept dangling — never reinterpreted,
      // just not carried forward without the marker that gives it meaning.
      const currentSeason = episodeNumbering === "seasonal" ? normalizePositiveInt(item.currentSeason) : undefined;
      // Only a seasonal item's totalEpisodes clamp is skipped — see
      // getQuickIncrementInfo's same reasoning (tracking.ts): totalEpisodes
      // is a whole-series total, not a per-season one.
      if (episodeNumbering !== "seasonal" && currentEpisode !== undefined && totalEpisodes !== undefined && currentEpisode > totalEpisodes) {
        currentEpisode = totalEpisodes;
      }
      return { ...item, status, rating, currentEpisode, totalEpisodes, episodeNumbering, currentSeason };
    }
    case "manga": {
      let currentChapter = normalizeNonNegativeNumber(item.currentChapter);
      const totalChapters = normalizePositiveInt(item.totalChapters);
      if (currentChapter !== undefined && totalChapters !== undefined && currentChapter > totalChapters) {
        currentChapter = totalChapters;
      }
      return { ...item, status, rating, currentChapter, totalChapters };
    }
    case "novel": {
      const progressUnit = normalizeProgressUnit(item.progressUnit);
      const progressValue =
        progressUnit === undefined
          ? undefined
          : progressUnit === "percent"
            ? normalizePercent(item.progressValue)
            : normalizeNonNegativeNumber(item.progressValue);
      return { ...item, status, rating, progressValue, progressUnit };
    }
    case "game": {
      const playtimeHours = normalizeNonNegativeNumber(item.playtimeHours);
      return { ...item, status, rating, playtimeHours };
    }
    case "movie":
      return { ...item, status, rating };
  }
}

// Markly V1 stored plain bookmarks under `markly.bookmarks`, predating both
// `type` and (for some very old records) `createdAt`. This shape is only
// ever read for a one-time migration into `markly.library` below.
interface LegacyBookmark {
  id: string;
  title: string;
  url: string;
  description: string;
  category: string;
  tags: string[];
  favorite: boolean;
  createdAt?: string;
}

function isValidLegacyBookmark(value: unknown): value is LegacyBookmark {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.category === "string" &&
    typeof candidate.favorite === "boolean" &&
    Array.isArray(candidate.tags) &&
    candidate.tags.every((tag) => typeof tag === "string")
  );
}

function migrateLegacyBookmark(bookmark: LegacyBookmark): WebsiteItem {
  const createdAt =
    typeof bookmark.createdAt === "string" && bookmark.createdAt.length > 0
      ? bookmark.createdAt
      : new Date().toISOString();

  return {
    id: bookmark.id,
    type: "website",
    title: bookmark.title,
    url: bookmark.url,
    description: bookmark.description,
    category: bookmark.category,
    tags: bookmark.tags,
    favorite: bookmark.favorite,
    createdAt,
  };
}

function readJsonArray(key: string): unknown[] | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Loads the library, preferring the current `markly.library` key. If that
 * key doesn't exist yet or is malformed, falls back to migrating Markly
 * V1's `markly.bookmarks` data (each record becomes a `WebsiteItem`). The
 * legacy key is never deleted here — only `markly.library` is written to
 * going forward, so old data stays available as a safety net.
 */
export function loadLibraryItems(): LibraryItem[] | null {
  if (typeof window === "undefined") return null;

  const libraryData = readJsonArray(LIBRARY_STORAGE_KEY);
  if (libraryData && libraryData.every(isValidLibraryItem)) {
    return libraryData.map(normalizeTrackingFields);
  }

  const legacyData = readJsonArray(LEGACY_BOOKMARKS_STORAGE_KEY);
  if (legacyData && legacyData.every(isValidLegacyBookmark)) {
    return legacyData.map(migrateLegacyBookmark);
  }

  return null;
}

export function saveLibraryItems(items: LibraryItem[]): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Storage unavailable (e.g. private browsing, quota exceeded); ignore.
  }
}
