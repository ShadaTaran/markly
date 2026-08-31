"use client";

import { useEffect, useState } from "react";
import type {
  LibraryItem,
  MediaItem,
  MediaItemInput,
  WebsiteItem,
  WebsiteItemInput,
} from "@/types/library-item";
import { generateId } from "@/lib/utils";
import { loadLibraryItems, saveLibraryItems } from "@/lib/library-storage";
import { createMediaItem, getUniqueCategories, normalizeCategory, updateMediaItem } from "@/lib/library-items";

/**
 * Owns the markly.library store: hydration, persistence, and every mutation
 * a LibraryItem can undergo. Shared by the main dashboard and the item
 * detail page (Stage 13) so both read/write the exact same contract rather
 * than duplicating this logic — they're independent client trees (separate
 * routes), so each calls this hook itself; correctness comes from both
 * agreeing on the same localStorage read/write behavior, not from shared
 * in-memory state.
 */
export function useLibraryItems(initialItems: LibraryItem[]) {
  const [items, setItems] = useState(initialItems);
  const [isHydrated, setIsHydrated] = useState(false);

  // Runs once on mount (client-only). localStorage isn't available during
  // SSR/static prerendering, so the initial render always uses the caller's
  // starter data to keep server and client output identical (no hydration
  // mismatch); this effect then syncs in any real stored library (or a
  // migrated Markly V1 bookmark list) after mount.
  useEffect(() => {
    const stored = loadLibraryItems();
    if (stored) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from an external store (localStorage) on mount; the value cannot be derived during render because it isn't available at SSR/prerender time.
      setItems(stored);
    }
    setIsHydrated(true);
  }, []);

  // Persist after every change, but only once the initial localStorage read
  // above has completed. Without this guard, this effect would fire on
  // first mount with the starter/initial data and overwrite any
  // already-stored (or just-migrated) items before they've been loaded.
  useEffect(() => {
    if (!isHydrated) return;
    saveLibraryItems(items);
  }, [items, isHydrated]);

  function toggleFavorite(id: string) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, favorite: !item.favorite } : item)));
  }

  function quickIncrementProgress(target: MediaItem) {
    setItems((current) =>
      current.map((item) => {
        if (item.id !== target.id) return item;

        if (item.type === "anime" || item.type === "series") {
          const next = (item.currentEpisode ?? 0) + 1;
          const currentEpisode = item.totalEpisodes !== undefined ? Math.min(next, item.totalEpisodes) : next;
          return { ...item, currentEpisode, updatedAt: new Date().toISOString() };
        }

        if (item.type === "manga") {
          const next = (item.currentChapter ?? 0) + 1;
          const currentChapter = item.totalChapters !== undefined ? Math.min(next, item.totalChapters) : next;
          return { ...item, currentChapter, updatedAt: new Date().toISOString() };
        }

        return item;
      }),
    );
  }

  function deleteItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));
  }

  function addWebsite(values: WebsiteItemInput) {
    const normalized = { ...values, category: normalizeCategory(values.category, getUniqueCategories(items)) };
    const newItem: WebsiteItem = {
      id: generateId(),
      type: "website",
      favorite: false,
      createdAt: new Date().toISOString(),
      ...normalized,
    };
    setItems((current) => [newItem, ...current]);
  }

  function updateWebsite(existing: WebsiteItem, values: WebsiteItemInput) {
    const normalized = { ...values, category: normalizeCategory(values.category, getUniqueCategories(items)) };
    const updated: WebsiteItem = {
      id: existing.id,
      type: "website",
      favorite: existing.favorite,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
      ...normalized,
    };
    setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }

  function addMedia(type: MediaItem["type"], values: MediaItemInput) {
    const normalized = { ...values, category: normalizeCategory(values.category, getUniqueCategories(items)) };
    const newItem = createMediaItem(type, generateId(), new Date().toISOString(), normalized);
    setItems((current) => [newItem, ...current]);
  }

  function updateMedia(existing: MediaItem, values: MediaItemInput) {
    const normalized = { ...values, category: normalizeCategory(values.category, getUniqueCategories(items)) };
    const updated = updateMediaItem(existing, normalized);
    setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }

  return {
    items,
    isHydrated,
    toggleFavorite,
    quickIncrementProgress,
    deleteItem,
    addWebsite,
    updateWebsite,
    addMedia,
    updateMedia,
  };
}
