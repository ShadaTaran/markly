"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { getSupabaseClient } from "@/lib/supabase/client";
import { deleteLibraryItemRow, fetchLibraryItems, upsertLibraryItem } from "@/lib/cloud/library-items";

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
 * Owns every LibraryItem mutation. Signed out (userId null/undefined), this
 * is exactly the Stage 1-15 markly.library localStorage store, unchanged —
 * hydrate on mount, persist the whole array on every change. Signed in, it
 * hydrates from Supabase's library_items table instead, and each mutation
 * additionally persists just the row(s) it changed. Business logic (status
 * auto-advance, clamping, activity diffing) is identical in both modes —
 * only where state is read from/written to differs.
 *
 * `onActivity`, if provided, is called once per meaningful personal
 * tracking change (never for catalog/metadata-only edits) — this is the
 * single place that decides what counts as activity, so every mutation
 * path (full Edit, quick controls, card +1) reports it consistently
 * instead of each call site re-deriving what changed.
 */
export function useLibraryItems(
  initialItems: LibraryItem[],
  onActivity?: (input: ActivityEventInput) => void,
  userId?: string | null,
) {
  const [items, setItems] = useState(initialItems);
  const [isHydrated, setIsHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against a slow, now-stale hydration request (e.g. from just
  // before a sign-out) resolving after a newer one and clobbering it —
  // only the result whose token still matches the latest call is applied.
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
        const cloudItems = await fetchLibraryItems(supabase, userId);
        if (hydrationToken.current === token) {
          setItems(cloudItems);
          setError(null);
        }
      } catch {
        if (hydrationToken.current === token) setError("Unable to load your library.");
      }
      if (hydrationToken.current === token) setIsHydrated(true);
      return;
    }

    const stored = loadLibraryItems();
    if (hydrationToken.current === token) {
      if (stored) setItems(stored);
      setIsHydrated(true);
    }
  }, [userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from an external store (localStorage or Supabase) whenever userId changes; the value can't be derived during render since both sources require an effect (localStorage isn't available at SSR/prerender time, and Supabase fetches are async).
    hydrate();
  }, [hydrate]);

  // Persist after every change, but only in local mode — cloud mode
  // persists the specific changed row from within each mutation below
  // instead of re-upserting the whole array on every change.
  useEffect(() => {
    if (userId || !isHydrated) return;
    saveLibraryItems(items);
  }, [items, isHydrated, userId]);

  /** Fire-and-forget cloud write for one changed/removed row; on failure, surfaces an error and reconciles state from the server rather than leaving an unconfirmed optimistic change in place. */
  function persistCloudChange(operation: Promise<void>) {
    if (!userId) return;
    operation.catch(() => {
      setError("Unable to save this update.");
      hydrate();
    });
  }

  function persistUpsert(item: LibraryItem | undefined) {
    if (!item || !userId) return;
    const supabase = getSupabaseClient();
    if (supabase) persistCloudChange(upsertLibraryItem(supabase, item, userId));
  }

  function toggleFavorite(id: string) {
    let after: LibraryItem | undefined;
    setItems((current) =>
      current.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, favorite: !item.favorite };
        after = updated;
        return updated;
      }),
    );
    persistUpsert(after);
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
    let after: MediaItem | undefined;

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
          const updated = { ...item, currentEpisode, status, updatedAt: new Date().toISOString() };
          after = updated;
          return updated;
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
          const updated = { ...item, currentChapter, status, updatedAt: new Date().toISOString() };
          after = updated;
          return updated;
        }

        return item;
      }),
    );

    events.forEach((event) => onActivity?.(event));
    persistUpsert(after);
  }

  function quickAdjustPlaytime(target: GameItem, delta: number) {
    const events: ActivityEventInput[] = [];
    let after: GameItem | undefined;

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
        const updated = { ...item, playtimeHours, status, updatedAt: new Date().toISOString() };
        after = updated;
        return updated;
      }),
    );

    events.forEach((event) => onActivity?.(event));
    persistUpsert(after);
  }

  function quickSetNovelProgress(target: NovelItem, rawValue: number) {
    const events: ActivityEventInput[] = [];
    let after: NovelItem | undefined;

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
        const updated = { ...item, progressValue: clamped, progressUnit: unit, status, updatedAt: new Date().toISOString() };
        after = updated;
        return updated;
      }),
    );

    events.forEach((event) => onActivity?.(event));
    persistUpsert(after);
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
    persistUpsert(after);
  }

  function deleteItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));

    if (userId) {
      const supabase = getSupabaseClient();
      if (supabase) persistCloudChange(deleteLibraryItemRow(supabase, id));
    }
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
    persistUpsert(newItem);
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
    persistUpsert(updated);
  }

  function addMedia(type: MediaItem["type"], values: MediaItemInput) {
    const normalized = { ...values, category: normalizeCategory(values.category, getUniqueCategories(items)) };
    const newItem = createMediaItem(type, generateId(), new Date().toISOString(), normalized);
    setItems((current) => [newItem, ...current]);
    onActivity?.({ type: "item_added", itemId: newItem.id });
    persistUpsert(newItem);
  }

  function updateMedia(existing: MediaItem, values: MediaItemInput) {
    const normalized = { ...values, category: normalizeCategory(values.category, getUniqueCategories(items)) };
    const updated = updateMediaItem(existing, normalized);
    setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    diffMediaTrackingEvents(updated.id, existing, updated).forEach((event) => onActivity?.(event));
    persistUpsert(updated);
  }

  return {
    items,
    isHydrated,
    error,
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
    reload: hydrate,
  };
}
