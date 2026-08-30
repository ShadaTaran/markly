import type { Bookmark } from "@/types/bookmark";

const STORAGE_KEY = "markly.bookmarks";

function isValidBookmark(value: unknown): value is Bookmark {
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

export function loadBookmarks(): Bookmark[] | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isValidBookmark)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function saveBookmarks(bookmarks: Bookmark[]): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
  } catch {
  }
}
