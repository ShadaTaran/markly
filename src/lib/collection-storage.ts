import type { Collection } from "@/types/collection";

const COLLECTIONS_STORAGE_KEY = "markly.collections";

function isValidCollection(value: unknown): value is Collection {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Record<string, unknown>;

  const hasRequiredFields =
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.createdAt === "string" &&
    Array.isArray(candidate.itemIds) &&
    candidate.itemIds.every((id) => typeof id === "string");

  if (!hasRequiredFields) return false;
  if (candidate.description !== undefined && typeof candidate.description !== "string") return false;
  if (candidate.updatedAt !== undefined && typeof candidate.updatedAt !== "string") return false;

  return true;
}

/** Removes duplicate item ids within a single collection, preserving first occurrence order. */
function dedupeItemIds(collection: Collection): Collection {
  const unique = Array.from(new Set(collection.itemIds));
  return unique.length === collection.itemIds.length ? collection : { ...collection, itemIds: unique };
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
 * Loads collections from markly.collections. Missing key or malformed JSON
 * both return null (the caller treats that as "no collections yet" — an
 * empty list — never as a reason to touch markly.library). A single
 * malformed record is dropped rather than failing the whole array, so one
 * corrupted collection can't take the rest down with it.
 */
export function loadCollections(): Collection[] | null {
  if (typeof window === "undefined") return null;

  const raw = readJsonArray(COLLECTIONS_STORAGE_KEY);
  if (!raw) return null;

  return raw.filter(isValidCollection).map(dedupeItemIds);
}

export function saveCollections(collections: Collection[]): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(COLLECTIONS_STORAGE_KEY, JSON.stringify(collections));
  } catch {
    // Storage unavailable (e.g. private browsing, quota exceeded); ignore.
    // This never touches markly.library — the two are saved independently.
  }
}
