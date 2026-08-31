"use client";

import { useEffect, useState } from "react";
import type {
  GameItem,
  LibraryItem,
  MediaItem,
  MediaItemInput,
  NovelItem,
  TrackingStatus,
  WebsiteItem,
  WebsiteItemInput,
} from "@/types/library-item";
import type { ActivityEventInput } from "@/types/activity";
import { generateId } from "@/lib/utils";
import { loadLibraryItems, saveLibraryItems } from "@/lib/library-storage";
import { createMediaItem, getUniqueCategories, normalizeCategory, updateMediaItem } from "@/lib/library-items";
import { diffMediaTrackingEvents } from "@/lib/activity-events";
import { isMediaItem } from "@/lib/item-detail";

/** What the detail page's tracking Edit mode can change in one Save. */
export interface TrackingUpdatePatch {
  status: TrackingStatus;
  rating?: number;
  currentEpisode?: number;
  currentChapter?: number;
  progressValue?: number;
  playtimeHours?: number;
}

/**
 * Owns the markly.library store: hydration, persistence, and every mutation
 * a LibraryItem can undergo. Shared by the main dashboard and the item
 * detail page so both read/write the exact same contract rather than
 * duplicating this logic — they're independent client trees (separate
 * routes), so each calls this hook itself; correctness comes from both
 * agreeing on the same localStorage read/write behavior, not from shared
 * in-memory state.
 *
 * `onActivity`, if provided, is called once per meaningful personal
 * tracking change (never for catalog/metadata-only edits) — this is the
 * single place that decides what counts as activity, so every mutation
 * path (full Edit, quick controls, card +1) reports it consistently
 * instead of each call site re-deriving what changed.
 */
export function useLibraryItems(initialItems: LibraryItem[], onActivity?: (input: ActivityEventInput) => void) {
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

  /**
   * Only "planned" ever auto-advances, and only on a real 0 → positive
   * transition — on_hold/dropped/completed are never touched automatically,
   * and an already in_progress item just keeps its status. The user stays
   * in control of every other transition (via the status select or Edit).
   */
  function autoAdvanceStatus(previousValue: number | undefined, nextValue: number, status: TrackingStatus): TrackingStatus {
    const wasZero = (previousValue ?? 0) === 0;
    return wasZero && nextValue > 0 && status === "planned" ? "in_progress" : status;
  }

  function quickIncrementProgress(target: MediaItem) {
    const events: ActivityEventInput[] = [];

    setItems((current) =>
      current.map((item) => {
        if (item.id !== target.id) return item;

        if (item.type === "anime" || item.type === "series") {
          const previous = item.currentEpisode;
          const next = (previous ?? 0) + 1;
          const currentEpisode = item.totalEpisodes !== undefined ? Math.min(next, item.totalEpisodes) : next;
          // Already at the known total — clamping means the value doesn't
          // actually move, so there's nothing to persist or log.
          if (previous === currentEpisode) return item;

          const status = autoAdvanceStatus(previous, currentEpisode, item.status);

          events.push({ type: "progress_updated", itemId: item.id, progressKind: "episode", previousValue: previous, newValue: currentEpisode });
          if (status !== item.status) {
            events.push({ type: "status_updated", itemId: item.id, previousValue: item.status, newValue: status });
          }
          return { ...item, currentEpisode, status, updatedAt: new Date().toISOString() };
        }

        if (item.type === "manga") {
          const previous = item.currentChapter;
          const next = (previous ?? 0) + 1;
          const currentChapter = item.totalChapters !== undefined ? Math.min(next, item.totalChapters) : next;
          if (previous === currentChapter) return item;

          const status = autoAdvanceStatus(previous, currentChapter, item.status);

          events.push({ type: "progress_updated", itemId: item.id, progressKind: "chapter", previousValue: previous, newValue: currentChapter });
          if (status !== item.status) {
            events.push({ type: "status_updated", itemId: item.id, previousValue: item.status, newValue: status });
          }
          return { ...item, currentChapter, status, updatedAt: new Date().toISOString() };
        }

        return item;
      }),
    );

    events.forEach((event) => onActivity?.(event));
  }

  function quickAdjustPlaytime(target: GameItem, delta: number) {
    const events: ActivityEventInput[] = [];

    setItems((current) =>
      current.map((item) => {
        if (item.id !== target.id || item.type !== "game") return item;

        const previous = item.playtimeHours;
        const playtimeHours = Math.max(0, (previous ?? 0) + delta);
        const status = autoAdvanceStatus(previous, playtimeHours, item.status);

        events.push({ type: "progress_updated", itemId: item.id, progressKind: "playtime", previousValue: previous, newValue: playtimeHours });
        if (status !== item.status) {
          events.push({ type: "status_updated", itemId: item.id, previousValue: item.status, newValue: status });
        }
        return { ...item, playtimeHours, status, updatedAt: new Date().toISOString() };
      }),
    );

    events.forEach((event) => onActivity?.(event));
  }

  function quickSetNovelProgress(target: NovelItem, rawValue: number) {
    const events: ActivityEventInput[] = [];

    setItems((current) =>
      current.map((item) => {
        if (item.id !== target.id || item.type !== "novel") return item;

        const unit = item.progressUnit ?? "chapter";
        const previous = item.progressValue;
        const clamped = unit === "percent" ? Math.min(100, Math.max(0, rawValue)) : Math.max(0, rawValue);

        if (previous === clamped) return item;

        const status = autoAdvanceStatus(previous, clamped, item.status);

        events.push({ type: "progress_updated", itemId: item.id, progressKind: unit, previousValue: previous, newValue: clamped });
        if (status !== item.status) {
          events.push({ type: "status_updated", itemId: item.id, previousValue: item.status, newValue: status });
        }
        return { ...item, progressValue: clamped, progressUnit: unit, status, updatedAt: new Date().toISOString() };
      }),
    );

    events.forEach((event) => onActivity?.(event));
  }

  /**
   * Applies a full tracking edit (status + rating + the one relevant
   * progress field) in one atomic update, used by the detail page's
   * tracking Edit mode. Diffs before/after the same way the full item Edit
   * flow does, so Save generates exactly one event per field that actually
   * changed — never duplicates, never events for untouched fields.
   */
  function updateTracking(target: MediaItem, patch: TrackingUpdatePatch) {
    let after: MediaItem | undefined;

    function applyPatch(item: MediaItem): MediaItem {
      const updatedAt = new Date().toISOString();
      switch (item.type) {
        case "anime":
        case "series":
          return { ...item, status: patch.status, rating: patch.rating, currentEpisode: patch.currentEpisode, updatedAt };
        case "manga":
          return { ...item, status: patch.status, rating: patch.rating, currentChapter: patch.currentChapter, updatedAt };
        case "novel":
          return { ...item, status: patch.status, rating: patch.rating, progressValue: patch.progressValue, updatedAt };
        case "game":
          return { ...item, status: patch.status, rating: patch.rating, playtimeHours: patch.playtimeHours, updatedAt };
        case "movie":
          return { ...item, status: patch.status, rating: patch.rating, updatedAt };
      }
    }

    setItems((current) =>
      current.map((item) => {
        if (item.id !== target.id || !isMediaItem(item)) return item;
        const updated = applyPatch(item);
        after = updated;
        return updated;
      }),
    );

    if (after) {
      diffMediaTrackingEvents(target.id, target, after).forEach((event) => onActivity?.(event));
    }
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
    onActivity?.({ type: "item_added", itemId: newItem.id });
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
    // Website has no personal tracking fields (status/progress/rating), so there's nothing to log.
  }

  function addMedia(type: MediaItem["type"], values: MediaItemInput) {
    const normalized = { ...values, category: normalizeCategory(values.category, getUniqueCategories(items)) };
    const newItem = createMediaItem(type, generateId(), new Date().toISOString(), normalized);
    setItems((current) => [newItem, ...current]);
    onActivity?.({ type: "item_added", itemId: newItem.id });
  }

  function updateMedia(existing: MediaItem, values: MediaItemInput) {
    const normalized = { ...values, category: normalizeCategory(values.category, getUniqueCategories(items)) };
    const updated = updateMediaItem(existing, normalized);
    setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    diffMediaTrackingEvents(updated.id, existing, updated).forEach((event) => onActivity?.(event));
  }

  return {
    items,
    isHydrated,
    toggleFavorite,
    quickIncrementProgress,
    quickAdjustPlaytime,
    quickSetNovelProgress,
    updateTracking,
    deleteItem,
    addWebsite,
    updateWebsite,
    addMedia,
    updateMedia,
  };
}
