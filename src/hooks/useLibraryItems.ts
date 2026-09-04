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
import { autoAdvanceStatus } from "@/lib/tracking";
import { getSupabaseClient } from "@/lib/supabase/client";
import { deleteLibraryItemRow, fetchLibraryItems, mergeLibraryItems, upsertLibraryItem } from "@/lib/cloud/library-items";
import { computeMergedLibraryItem, type MergeBlockReason } from "@/lib/library-merge";

/** What the detail page's tracking Edit mode can change in one Save. */
export interface TrackingUpdatePatch {
  status: TrackingStatus;
  rating?: number;
  currentEpisode?: number;
  currentChapter?: number;
  progressValue?: number;
  playtimeHours?: number;
}

/** Stage 27 — outcome of a duplicate-merge attempt. See library-merge.ts's computeMergedLibraryItem for what "blocked" means, and README "Safe Duplicate Detection & Manual Merge" for the full flow. */
export type MergeItemsResult =
  | { status: "ok"; merged: MediaItem }
  | { status: "blocked"; reason: MergeBlockReason }
  | { status: "error"; reason: "not_found" | "network" };

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
    const target = items.find((item) => item.id === id);
    if (!target) return;

    const updated = { ...target, favorite: !target.favorite };
    setItems((current) => current.map((item) => (item.id === id ? updated : item)));
    persistUpsert(updated);
  }

  function quickIncrementProgress(target: MediaItem) {
    const item = items.find((candidate) => candidate.id === target.id);
    if (!item) return;

    const events: ActivityEventInput[] = [];
    let updated: MediaItem;

    if (item.type === "anime" || item.type === "series") {
      const previous = item.currentEpisode;
      const next = (previous ?? 0) + 1;
      const isSeasonal = item.episodeNumbering === "seasonal";
      // A seasonal item's totalEpisodes is a whole-series total, not this
      // season's length (Stage 25 never calculates or guesses one — see
      // getQuickIncrementInfo/tracking.ts), so it never clamps here; +1
      // also never touches currentSeason itself — rolling into a new
      // season is never inferred from blind arithmetic, only from a real
      // detection or an explicit edit.
      const currentEpisode = !isSeasonal && item.totalEpisodes !== undefined ? Math.min(next, item.totalEpisodes) : next;
      // Already at the known total — clamping means the value doesn't
      // actually move, so there's nothing to persist or log.
      if (previous === currentEpisode) return;

      const status = autoAdvanceStatus(previous, currentEpisode, item.status);

      events.push({
        type: "progress_updated",
        itemId: item.id,
        progressKind: isSeasonal ? "season_episode" : "episode",
        previousValue: previous,
        newValue: currentEpisode,
        ...(isSeasonal && { previousSeason: item.currentSeason, newSeason: item.currentSeason }),
      });
      if (status !== item.status) {
        events.push({ type: "status_updated", itemId: item.id, previousValue: item.status, newValue: status });
      }
      updated = { ...item, currentEpisode, status, updatedAt: new Date().toISOString() };
    } else if (item.type === "manga") {
      const previous = item.currentChapter;
      const next = (previous ?? 0) + 1;
      const currentChapter = item.totalChapters !== undefined ? Math.min(next, item.totalChapters) : next;
      if (previous === currentChapter) return;

      const status = autoAdvanceStatus(previous, currentChapter, item.status);

      events.push({ type: "progress_updated", itemId: item.id, progressKind: "chapter", previousValue: previous, newValue: currentChapter });
      if (status !== item.status) {
        events.push({ type: "status_updated", itemId: item.id, previousValue: item.status, newValue: status });
      }
      updated = { ...item, currentChapter, status, updatedAt: new Date().toISOString() };
    } else {
      return;
    }

    const persisted = updated;
    setItems((current) => current.map((candidate) => (candidate.id === persisted.id ? persisted : candidate)));
    events.forEach((event) => onActivity?.(event));
    persistUpsert(persisted);
  }

  function quickAdjustPlaytime(target: GameItem, delta: number) {
    const found = items.find((candidate) => candidate.id === target.id);
    if (!found || found.type !== "game") return;
    const item = found;

    const previous = item.playtimeHours;
    const playtimeHours = Math.max(0, (previous ?? 0) + delta);
    const status = autoAdvanceStatus(previous, playtimeHours, item.status);

    const events: ActivityEventInput[] = [
      { type: "progress_updated", itemId: item.id, progressKind: "playtime", previousValue: previous, newValue: playtimeHours },
    ];
    if (status !== item.status) {
      events.push({ type: "status_updated", itemId: item.id, previousValue: item.status, newValue: status });
    }

    const updated: GameItem = { ...item, playtimeHours, status, updatedAt: new Date().toISOString() };
    setItems((current) => current.map((candidate) => (candidate.id === updated.id ? updated : candidate)));
    events.forEach((event) => onActivity?.(event));
    persistUpsert(updated);
  }

  function quickSetNovelProgress(target: NovelItem, rawValue: number) {
    const found = items.find((candidate) => candidate.id === target.id);
    if (!found || found.type !== "novel") return;
    const item = found;

    const unit = item.progressUnit ?? "chapter";
    const previous = item.progressValue;
    const clamped = unit === "percent" ? Math.min(100, Math.max(0, rawValue)) : Math.max(0, rawValue);

    if (previous === clamped) return;

    const status = autoAdvanceStatus(previous, clamped, item.status);
    const events: ActivityEventInput[] = [
      { type: "progress_updated", itemId: item.id, progressKind: unit, previousValue: previous, newValue: clamped },
    ];
    if (status !== item.status) {
      events.push({ type: "status_updated", itemId: item.id, previousValue: item.status, newValue: status });
    }

    const updated: NovelItem = { ...item, progressValue: clamped, progressUnit: unit, status, updatedAt: new Date().toISOString() };
    setItems((current) => current.map((candidate) => (candidate.id === updated.id ? updated : candidate)));
    events.forEach((event) => onActivity?.(event));
    persistUpsert(updated);
  }

  /**
   * Applies a full tracking edit (status + rating + the one relevant
   * progress field) in one atomic update, used by the detail page's
   * tracking Edit mode. Diffs before/after the same way the full item Edit
   * flow does, so Save generates exactly one event per field that actually
   * changed — never duplicates, never events for untouched fields.
   */
  function updateTracking(target: MediaItem, patch: TrackingUpdatePatch) {
    const found = items.find((candidate) => candidate.id === target.id);
    if (!found || !isMediaItem(found)) return;
    const item = found;

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

    const updated = applyPatch(item);
    setItems((current) => current.map((candidate) => (candidate.id === updated.id ? updated : candidate)));
    diffMediaTrackingEvents(target.id, target, updated).forEach((event) => onActivity?.(event));
    persistUpsert(updated);
  }

  function deleteItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));

    if (userId) {
      const supabase = getSupabaseClient();
      if (supabase) persistCloudChange(deleteLibraryItemRow(supabase, id));
    }
  }

  /**
   * Stage 27 — merges `duplicateId` into `survivorId` and removes the
   * duplicate. Never automatic — only ever called from an explicit user
   * confirmation (see README "Safe Duplicate Detection & Manual Merge").
   *
   * Cloud mode: the field-merge computation here is a PREVIEW only — the
   * actual write happens inside the atomic merge_library_items RPC, which
   * independently recomputes every progress-bearing field from whatever
   * is actually in the database at lock time (never trusts this
   * computation for those fields — see the RPC's own doc comment for
   * why). A successful merge re-hydrates from the server rather than
   * trying to replicate the RPC's exact result locally, so the client
   * never ends up showing something the server didn't actually commit.
   *
   * Local mode: this hook IS authoritative (there's no server to defer
   * to), so the computed merge is applied directly. Both the survivor
   * update and the duplicate's removal happen in one synchronous state
   * update — never two separate ones with an await in between — so there
   * is no window where a page close could leave only one applied.
   */
  async function mergeItems(survivorId: string, duplicateId: string): Promise<MergeItemsResult> {
    const survivor = items.find((item) => item.id === survivorId);
    const duplicate = items.find((item) => item.id === duplicateId);
    if (!survivor || !duplicate || !isMediaItem(survivor) || !isMediaItem(duplicate)) {
      return { status: "error", reason: "not_found" };
    }

    const computation = computeMergedLibraryItem(survivor, duplicate);
    if (computation.status === "blocked") return computation;

    if (userId) {
      const supabase = getSupabaseClient();
      if (!supabase) return { status: "error", reason: "network" };
      try {
        const result = await mergeLibraryItems(supabase, survivorId, duplicateId, computation.merged, userId);
        if (result.status !== "merged") {
          // Only "unauthorized"/"not_found"/"type_mismatch" and the
          // progress/catalog conflict statuses reach here — all are
          // reported as "blocked" reasons except the two that mean the
          // request itself couldn't be serviced.
          if (result.status === "unauthorized" || result.status === "not_found") {
            return { status: "error", reason: "not_found" };
          }
          return { status: "blocked", reason: result.status };
        }
        await hydrate();
        return { status: "ok", merged: computation.merged };
      } catch {
        return { status: "error", reason: "network" };
      }
    }

    setItems((current) =>
      current.map((item) => (item.id === survivorId ? computation.merged : item)).filter((item) => item.id !== duplicateId),
    );
    return { status: "ok", merged: computation.merged };
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

  function addMedia(type: MediaItem["type"], values: MediaItemInput): MediaItem {
    const normalized = { ...values, category: normalizeCategory(values.category, getUniqueCategories(items)) };
    const newItem = createMediaItem(type, generateId(), new Date().toISOString(), normalized);
    setItems((current) => [newItem, ...current]);
    onActivity?.({ type: "item_added", itemId: newItem.id });
    persistUpsert(newItem);
    return newItem;
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
    mergeItems,
    addWebsite,
    updateWebsite,
    addMedia,
    updateMedia,
    reload: hydrate,
  };
}
