import type { Collection } from "@/types/collection";
import type { LibraryItem } from "@/types/library-item";
import { ALL_FILTER } from "@/lib/constants";
import type { CategoryOption } from "@/lib/library-items";

export type CollectionFilterValue = string | typeof ALL_FILTER;

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function nameKey(name: string): string {
  return normalizeName(name).toLowerCase();
}

/** True if another collection already has this name, ignoring case/whitespace. */
export function isDuplicateCollectionName(name: string, collections: Collection[], excludeId?: string): boolean {
  const key = nameKey(name);
  return collections.some((collection) => collection.id !== excludeId && nameKey(collection.name) === key);
}

/** Item ids in a collection that still refer to a real, current LibraryItem. */
export function getValidItemIds(collection: Collection, items: LibraryItem[]): string[] {
  const validIds = new Set(items.map((item) => item.id));
  return collection.itemIds.filter((id) => validIds.has(id));
}

export function getItemsInCollection(collection: Collection, items: LibraryItem[]): LibraryItem[] {
  const memberIds = new Set(collection.itemIds);
  return items.filter((item) => memberIds.has(item.id));
}

/**
 * Options for the Collection filter row: "All Items" plus one entry per
 * collection, counted from actual current membership (never a stored
 * count) so additions/removals/deletions are reflected immediately.
 */
export function getCollectionOptions(collections: Collection[], items: LibraryItem[]): CategoryOption[] {
  return [
    { id: ALL_FILTER, label: "All Items", count: items.length },
    ...collections.map((collection) => ({
      id: collection.id,
      label: collection.name,
      count: getValidItemIds(collection, items).length,
    })),
  ];
}
