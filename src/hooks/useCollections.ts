"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Collection, CollectionInput } from "@/types/collection";
import type { LibraryItem } from "@/types/library-item";
import { generateId } from "@/lib/utils";
import { loadCollections, saveCollections } from "@/lib/collection-storage";
import { getValidItemIds } from "@/lib/collections";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  deleteCollectionRow,
  fetchCollections,
  setCollectionMembership,
  upsertCollectionRow,
} from "@/lib/cloud/collections";

/**
 * Owns collections: hydration, persistence, membership, and CRUD. Signed
 * out (userId null/undefined), this is exactly the Stage 12 markly.collections
 * localStorage store, unchanged. Signed in, it hydrates from and persists to
 * Supabase's collections/collection_items tables instead.
 */
export function useCollections(items: LibraryItem[], itemsHydrated: boolean, userId?: string | null) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydrationToken = useRef(0);

  const hydrate = useCallback(async () => {
    const token = ++hydrationToken.current;
    setIsHydrated(false);

    if (userId) {
      const supabase = getSupabaseClient();
      if (!supabase) {
        if (hydrationToken.current === token) {
          setError("Cloud sync isn't configured for this deployment.");
          setIsHydrated(true);
        }
        return;
      }
      try {
        const cloudCollections = await fetchCollections(supabase, userId);
        if (hydrationToken.current === token) {
          setCollections(cloudCollections);
          setError(null);
        }
      } catch {
        if (hydrationToken.current === token) setError("Unable to load your collections.");
      }
      if (hydrationToken.current === token) setIsHydrated(true);
      return;
    }

    const stored = loadCollections();
    if (hydrationToken.current === token) {
      if (stored) setCollections(stored);
      setIsHydrated(true);
    }
  }, [userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from an external store (localStorage or Supabase) whenever userId changes; the value can't be derived during render since both sources require an effect (localStorage isn't available at SSR/prerender time, and Supabase fetches are async).
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (userId || !isHydrated) return;
    saveCollections(collections);
  }, [collections, isHydrated, userId]);

  // Self-healing membership cleanup: whenever the actual set of library
  // items changes (most notably a deletion), strip any collection item id
  // that no longer refers to a real item. Local-mode only — in cloud mode
  // collection_items has an ON DELETE CASCADE foreign key to library_items,
  // so the database itself guarantees membership never outlives its item.
  useEffect(() => {
    if (userId || !isHydrated || !itemsHydrated) return;

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
  }, [items, isHydrated, itemsHydrated, userId]);

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

    if (userId) {
      const supabase = getSupabaseClient();
      if (supabase) {
        setCollectionMembership(supabase, collectionId, itemId, userId, checked).catch(() => {
          setError("Unable to save this update.");
          hydrate();
        });
      }
    }
  }

  function createCollection(values: CollectionInput, initialItemId?: string) {
    const newCollection: Collection = {
      id: generateId(),
      itemIds: initialItemId ? [initialItemId] : [],
      createdAt: new Date().toISOString(),
      ...values,
    };
    setCollections((current) => [...current, newCollection]);

    if (userId) {
      const supabase = getSupabaseClient();
      if (supabase) {
        const persist = async () => {
          await upsertCollectionRow(supabase, newCollection, userId);
          if (initialItemId) await setCollectionMembership(supabase, newCollection.id, initialItemId, userId, true);
        };
        persist().catch(() => {
          setError("Unable to save this update.");
          hydrate();
        });
      }
    }
  }

  function updateCollection(id: string, values: CollectionInput) {
    const target = collections.find((collection) => collection.id === id);
    if (!target) return;

    const updated: Collection = { ...target, ...values, updatedAt: new Date().toISOString() };
    setCollections((current) => current.map((collection) => (collection.id === id ? updated : collection)));

    if (userId) {
      const supabase = getSupabaseClient();
      if (supabase) {
        upsertCollectionRow(supabase, updated, userId).catch(() => {
          setError("Unable to save this update.");
          hydrate();
        });
      }
    }
  }

  /**
   * Stage 27 — local mode only, called by the merge orchestration
   * (LibraryView/DashboardView's duplicate-merge flow) right after
   * `library.mergeItems` succeeds for a signed-out user. Cloud mode never
   * calls this: collection_items is moved server-side, atomically, inside
   * merge_library_items itself (see the migration's doc comment for why
   * collections has to move via INSERT+DELETE there, not a plain UPDATE)
   * — the caller reloads collections from the server afterward instead.
   * Replaces `duplicateId` with `survivorId` in every collection's
   * itemIds, dropping the duplicate's entry outright wherever the
   * survivor is already a member (Section 22 — no duplicate entries).
   */
  function mergeItemReferences(survivorId: string, duplicateId: string) {
    if (userId) return;
    setCollections((current) =>
      current.map((collection) => {
        if (!collection.itemIds.includes(duplicateId)) return collection;
        const itemIds = collection.itemIds.includes(survivorId)
          ? collection.itemIds.filter((id) => id !== duplicateId)
          : collection.itemIds.map((id) => (id === duplicateId ? survivorId : id));
        return { ...collection, itemIds, updatedAt: new Date().toISOString() };
      }),
    );
  }

  function deleteCollection(id: string) {
    setCollections((current) => current.filter((collection) => collection.id !== id));

    if (userId) {
      const supabase = getSupabaseClient();
      if (supabase) {
        deleteCollectionRow(supabase, id).catch(() => {
          setError("Unable to save this update.");
          hydrate();
        });
      }
    }
  }

  return {
    collections,
    isHydrated,
    error,
    toggleMembership,
    createCollection,
    updateCollection,
    deleteCollection,
    mergeItemReferences,
    reload: hydrate,
  };
}
