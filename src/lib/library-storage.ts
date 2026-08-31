import type { LibraryItem, WebsiteItem } from "@/types/library-item";

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
  if (candidate.imageUrl !== undefined && typeof candidate.imageUrl !== "string") return false;
  if (candidate.sourceUrl !== undefined && typeof candidate.sourceUrl !== "string") return false;
  if (candidate.platform !== undefined && typeof candidate.platform !== "string") return false;

  return true;
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
    return libraryData;
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
