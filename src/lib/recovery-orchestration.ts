"use client";

import type { useActivity } from "@/hooks/useActivity";
import type { useCollections } from "@/hooks/useCollections";
import type { useLibraryItems } from "@/hooks/useLibraryItems";
import type { LibraryItem } from "@/types/library-item";
import { isMediaItem } from "@/lib/item-detail";
import { getSupabaseClient } from "@/lib/supabase/client";
import { deleteLibraryItemWithRecovery, undoLibraryRecovery } from "@/lib/cloud/recovery";
import { addRecoveryAction, getRecoveryAction, removeRecoveryAction } from "@/lib/local-recovery-storage";
import { generateId } from "@/lib/utils";
import { computeMergedLibraryItem, MERGE_BLOCK_REASON_LABELS } from "@/lib/library-merge";
import {
  RECOVERY_TTL_MS,
  validateDeleteUndo,
  validateMergeUndo,
  type DeleteRecoveryPayload,
  type MergeRecoveryPayload,
  type RecoveryActionType,
} from "@/lib/library-recovery";

/**
 * Stage 28 — orchestrates Delete/Merge-with-recovery and Undo across the
 * three per-store hooks, for both signed-in (cloud) and signed-out (local)
 * users. Centralized here rather than duplicated between LibraryView and
 * ItemDetailView (both need delete-with-recovery; only LibraryView
 * currently needs merge) — see README "Destructive Action Recovery &
 * Undo" for the full design this implements.
 */

type Library = ReturnType<typeof useLibraryItems>;
type CollectionsStore = ReturnType<typeof useCollections>;
type Activity = ReturnType<typeof useActivity>;

export interface RecoveryHandle {
  recoveryId: string;
  actionType: RecoveryActionType;
  title: string;
}

export interface DeleteWithRecoveryResult {
  ok: boolean;
  handle?: RecoveryHandle;
  errorText?: string;
}

/**
 * Deletes one LibraryItem with a short-lived Undo available afterward.
 * Cloud mode: one atomic RPC snapshots everything it's about to remove
 * (the row, its collection memberships, its Activity history, any
 * TrackingSource ids pointing at it) before removing it, then this
 * reloads all three stores from the server. Local mode: this builds the
 * same snapshot itself (there's no server transaction to lean on), writes
 * it to markly.recovery, then removes the item exactly as before.
 */
export async function deleteItemWithRecovery(
  item: LibraryItem,
  userId: string | null,
  library: Library,
  collectionsStore: CollectionsStore,
  activity: Activity,
): Promise<DeleteWithRecoveryResult> {
  if (userId) {
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, errorText: "Cloud sync isn't configured for this deployment." };
    try {
      const result = await deleteLibraryItemWithRecovery(supabase, item.id);
      if (result.status !== "deleted" || !result.recoveryId) {
        return { ok: false, errorText: "This item couldn't be found. Try again." };
      }
      await Promise.all([library.reload(), collectionsStore.reload(), activity.reload()]);
      return { ok: true, handle: { recoveryId: result.recoveryId, actionType: "delete_item", title: item.title } };
    } catch {
      return { ok: false, errorText: "Couldn't reach Markly. Try again." };
    }
  }

  const collectionIds = collectionsStore.collections.filter((c) => c.itemIds.includes(item.id)).map((c) => c.id);
  const activityEvents = activity.events.filter((event) => event.itemId === item.id);
  const recoveryId = generateId();
  const now = Date.now();
  const payload: DeleteRecoveryPayload = { item, collectionIds, activityEvents };
  addRecoveryAction({
    id: recoveryId,
    actionType: "delete_item",
    title: item.title,
    payload,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RECOVERY_TTL_MS).toISOString(),
  });

  library.deleteItem(item.id);
  activity.removeEventsForItem(item.id);
  return { ok: true, handle: { recoveryId, actionType: "delete_item", title: item.title } };
}

export interface MergeWithRecoveryResult {
  ok: boolean;
  errorText?: string;
  handle?: RecoveryHandle;
}

/**
 * Stage 27's merge, now with a Stage 28 recovery snapshot layered on top.
 * Local-mode ordering still matters exactly as it did before (see the
 * original handleMergeDuplicates in LibraryView, now moved here):
 * collections/activity are reassigned in the same synchronous batch as
 * the library update, never with an intervening await, so
 * useCollections' self-healing effect never observes a dangling
 * reference. The recovery snapshot is captured first, from the still-
 * intact pre-merge objects, before any of that runs.
 */
export async function mergeItemsWithRecovery(
  survivorId: string,
  duplicateId: string,
  userId: string | null,
  library: Library,
  collectionsStore: CollectionsStore,
  activity: Activity,
): Promise<MergeWithRecoveryResult> {
  const survivor = library.items.find((candidate) => candidate.id === survivorId);
  const duplicate = library.items.find((candidate) => candidate.id === duplicateId);
  if (!survivor || !duplicate || !isMediaItem(survivor) || !isMediaItem(duplicate)) {
    return { ok: false, errorText: "One of these items couldn't be found. Try again." };
  }
  const preview = computeMergedLibraryItem(survivor, duplicate);
  if (preview.status === "blocked") {
    return { ok: false, errorText: MERGE_BLOCK_REASON_LABELS[preview.reason] };
  }

  let recoveryId: string | undefined;
  if (!userId) {
    const survivorCollectionIds = collectionsStore.collections.filter((c) => c.itemIds.includes(survivorId)).map((c) => c.id);
    const duplicateCollectionIds = collectionsStore.collections.filter((c) => c.itemIds.includes(duplicateId)).map((c) => c.id);
    const movedActivityIds = activity.events.filter((event) => event.itemId === duplicateId).map((event) => event.id);
    const survivorPreMergeActivityIds = activity.events.filter((event) => event.itemId === survivorId).map((event) => event.id);
    recoveryId = generateId();
    const now = Date.now();
    const payload: MergeRecoveryPayload = {
      survivorId,
      duplicateId,
      survivorPreMerge: survivor,
      duplicatePreMerge: duplicate,
      survivorPostMergeExpected: preview.merged,
      survivorPreMergeCollectionIds: survivorCollectionIds,
      duplicatePreMergeCollectionIds: duplicateCollectionIds,
      movedActivityIds,
      survivorPreMergeActivityIds,
    };
    addRecoveryAction({
      id: recoveryId,
      actionType: "merge_items",
      title: preview.merged.title,
      payload,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + RECOVERY_TTL_MS).toISOString(),
    });

    collectionsStore.mergeItemReferences(survivorId, duplicateId);
    activity.reassignEventsForItem(duplicateId, survivorId);
  }

  const result = await library.mergeItems(survivorId, duplicateId);
  if (result.status === "blocked") {
    return { ok: false, errorText: MERGE_BLOCK_REASON_LABELS[result.reason] };
  }
  if (result.status === "error") {
    return {
      ok: false,
      errorText: result.reason === "network" ? "Couldn't reach Markly. Try again." : "One of these items couldn't be found. Try again.",
    };
  }

  if (userId) {
    await Promise.all([collectionsStore.reload(), activity.reload()]);
    return {
      ok: true,
      handle: result.recoveryId ? { recoveryId: result.recoveryId, actionType: "merge_items", title: result.merged.title } : undefined,
    };
  }

  return { ok: true, handle: recoveryId ? { recoveryId, actionType: "merge_items", title: preview.merged.title } : undefined };
}

export interface UndoResult {
  ok: boolean;
  message: string;
}

const CONFLICT_MESSAGES: Record<string, string> = {
  id_in_use: "This item changed after that action, so Markly can't safely undo it.",
  collection_missing: "One of the collections involved no longer exists, so Markly can't safely undo this.",
  survivor_missing: "This item changed after that action, so Markly can't safely undo it.",
  survivor_changed: "This item changed after that action, so Markly can't safely undo it.",
  source_claimed_elsewhere: "One of the tracked sources involved has since been linked to something else, so Markly can't safely undo this.",
  collections_changed: "This item's collections changed after that action, so Markly can't safely undo it.",
};

function conflictMessage(reason: string | undefined): string {
  return (reason && CONFLICT_MESSAGES[reason]) || "This can't be safely undone anymore.";
}

/**
 * Undoes a delete or merge, re-validating against the current state before
 * restoring anything. Both branches deliberately fail closed: any
 * ambiguity about whether it's still safe to restore is treated as "no",
 * never as "probably fine" — see README "Destructive Action Recovery &
 * Undo" for the Chapter-61 example this protects against.
 */
export async function undoRecoveryAction(
  recoveryId: string,
  userId: string | null,
  library: Library,
  collectionsStore: CollectionsStore,
  activity: Activity,
): Promise<UndoResult> {
  if (userId) {
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, message: "Cloud sync isn't configured for this deployment." };
    try {
      const result = await undoLibraryRecovery(supabase, recoveryId);
      if (result.status === "recovered") {
        await Promise.all([library.reload(), collectionsStore.reload(), activity.reload()]);
        return { ok: true, message: "Undone." };
      }
      if (result.status === "expired") return { ok: false, message: "The undo period for that action has expired." };
      if (result.status === "not_found") return { ok: false, message: "That action can no longer be undone." };
      return { ok: false, message: conflictMessage(result.reason) };
    } catch {
      return { ok: false, message: "Couldn't reach Markly. Try again." };
    }
  }

  const entry = getRecoveryAction(recoveryId);
  if (!entry) return { ok: false, message: "The undo period for that action has expired." };

  if (entry.actionType === "delete_item") {
    const payload = entry.payload as DeleteRecoveryPayload;
    const outcome = validateDeleteUndo(payload, library.items, collectionsStore.collections);
    if (outcome.status !== "recovered") return { ok: false, message: conflictMessage(outcome.reason) };

    library.restoreDeletedItem(payload.item);
    collectionsStore.restoreMembershipsForItem(payload.item.id, payload.collectionIds);
    activity.restoreEventsForItem(payload.activityEvents);
    removeRecoveryAction(recoveryId);
    return { ok: true, message: "Undone." };
  }

  const payload = entry.payload as MergeRecoveryPayload;
  const outcome = validateMergeUndo(payload, library.items, collectionsStore.collections, activity.events);
  if (outcome.status !== "recovered") return { ok: false, message: conflictMessage(outcome.reason) };

  library.restoreMergedItems(payload.survivorId, payload.survivorPreMerge, payload.duplicatePreMerge);
  collectionsStore.restoreMembershipsForMerge(
    payload.survivorId,
    payload.duplicateId,
    payload.survivorPreMergeCollectionIds,
    payload.duplicatePreMergeCollectionIds,
  );
  activity.restoreEventsForMerge(payload.movedActivityIds, payload.survivorId, payload.duplicateId);
  removeRecoveryAction(recoveryId);
  return { ok: true, message: "Undone." };
}
