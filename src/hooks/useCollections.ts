"use client";

import { useEffect, useState } from "react";
import type { Collection, CollectionInput } from "@/types/collection";
import type { LibraryItem } from "@/types/library-item";
import { generateId } from "@/lib/utils";
import { loadCollections, saveCollections } from "@/lib/collection-storage";
import { getValidItemIds } from "@/lib/collections";

/**
 * Owns the markly.collections store: hydration, persistence, membership,
 * and CRUD. Shared by the dashboard and the item detail page, mirroring
 * useLibraryItems. Takes the current LibraryItems (and whether that store
 * has finished its own hydration) purely to self-heal stale membership
 * references — it never writes to markly.library itself.
 */
export function useCollections(items: LibraryItem[], itemsHydrated: boolean) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    const stored = loadCollections();
    if (stored) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from an external store (localStorage) on mount; the value cannot be derived during render because it isn't available at SSR/prerender time.
      setCollections(stored);
    }
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    saveCollections(collections);
  }, [collections, isHydrated]);

  // Self-healing membership cleanup: whenever the actual set of library
  // items changes (most notably a deletion), strip any collection item id
  // that no longer refers to a real item. Waits on itemsHydrated too, so it
  // never runs against placeholder/starter items before the real library
  // has loaded and mistakes not-yet-loaded items for deleted ones. Bails
  // out (returns the same array reference) when nothing needs fixing, so
  // this never loops or persists a no-op change.
  useEffect(() => {
    if (!isHydrated || !itemsHydrated) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- reactive cross-store consistency fix (collections referencing deleted items), not derivable at render time since it must persist the corrected value, not just filter it for display.
    setCollections((current) => {
      let changed = false;
      const cleaned = current.map((collection) => {
        const validIds = getValidItemIds(collection, items);
        if (validIds.length !== collection.itemIds.length) {
          changed = true;
          return { ...collection, itemIds: validIds };
        }
        return collection;
      });
      return changed ? cleaned : current;
    });
  }, [items, isHydrated, itemsHydrated]);

  function toggleMembership(collectionId: string, itemId: string, checked: boolean) {
    setCollections((current) =>
      current.map((collection) => {
        if (collection.id !== collectionId) return collection;
        const itemIds = checked
          ? collection.itemIds.includes(itemId)
            ? collection.itemIds
            : [...collection.itemIds, itemId]
          : collection.itemIds.filter((id) => id !== itemId);
        return { ...collection, itemIds, updatedAt: new Date().toISOString() };
      }),
    );
  }

  function createCollection(values: CollectionInput, initialItemId?: string) {
    const newCollection: Collection = {
      id: generateId(),
      itemIds: initialItemId ? [initialItemId] : [],
      createdAt: new Date().toISOString(),
      ...values,
    };
    setCollections((current) => [...current, newCollection]);
  }

  function updateCollection(id: string, values: CollectionInput) {
    setCollections((current) =>
      current.map((collection) =>
        collection.id === id ? { ...collection, ...values, updatedAt: new Date().toISOString() } : collection,
      ),
    );
  }

  function deleteCollection(id: string) {
    setCollections((current) => current.filter((collection) => collection.id !== id));
  }

  return {
    collections,
    isHydrated,
    toggleMembership,
    createCollection,
    updateCollection,
    deleteCollection,
  };
}
