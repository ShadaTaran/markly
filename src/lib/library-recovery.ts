import type { ActivityEvent } from "@/types/activity";
import type { Collection } from "@/types/collection";
import type { LibraryItem, MediaItem } from "@/types/library-item";

/**
 * Stage 28 — narrow, short-lived Undo for exactly two destructive actions:
 * deleting a LibraryItem and merging two duplicates. See README
 * "Destructive Action Recovery & Undo" for the full design (why exact
 * row-snapshot comparison rather than a timestamp is what makes Undo
 * conflict-safe instead of ever overwriting newer progress).
 *
 * This module holds the LOCAL-MODE (signed-out) logic only: building a
 * snapshot and validating whether it's still safe to restore. Local mode
 * has no server transaction to lean on, so every check the cloud RPCs run
 * against a row-locked, live database (0010_stage28_library_recovery.sql)
 * has an equivalent read-only check here, run against in-memory state
 * immediately before any restore actually happens. Cloud mode's
 * equivalents live in the migration's SQL — see cloud/recovery.ts for the
 * client-side RPC wrappers.
 */

export const RECOVERY_TTL_MS = 15 * 60 * 1000;

export type RecoveryActionType = "delete_item" | "merge_items";

export interface DeleteRecoveryPayload {
  item: LibraryItem;
  collectionIds: string[];
  activityEvents: ActivityEvent[];
}

export interface MergeRecoveryPayload {
  survivorId: string;
  duplicateId: string;
  survivorPreMerge: MediaItem;
  duplicatePreMerge: MediaItem;
  /** The survivor exactly as the original merge left it — the reference point Undo compares the CURRENT survivor against. Any real difference (new progress, a rating change, a later merge) means Undo must refuse rather than discard it. */
  survivorPostMergeExpected: MediaItem;
  survivorPreMergeCollectionIds: string[];
  duplicatePreMergeCollectionIds: string[];
  movedActivityIds: string[];
  /** The survivor's own Activity event ids at merge time — these never move, but Undo needs them to compute the exact expected post-merge activity set for the survivor (mirrors survivorPreMergeCollectionIds/duplicatePreMergeCollectionIds's role for collections). */
  survivorPreMergeActivityIds: string[];
}

export interface RecoveryEntry {
  id: string;
  actionType: RecoveryActionType;
  /** Precomputed display title, so the "Recently changed" list never has to re-derive it from payload internals. */
  title: string;
  payload: DeleteRecoveryPayload | MergeRecoveryPayload;
  createdAt: string;
  expiresAt: string;
}

export type RecoveryConflictReason =
  | "id_in_use"
  | "collection_missing"
  | "survivor_missing"
  | "survivor_changed"
  | "collections_changed";

export type UndoOutcome =
  | { status: "recovered" }
  | { status: "recovery_conflict"; reason: RecoveryConflictReason };

export function describeRecoveryAction(actionType: RecoveryActionType, title: string): string {
  return actionType === "delete_item" ? `"${title}" deleted.` : `Merged into "${title}".`;
}

export function isRecoveryExpired(entry: Pick<RecoveryEntry, "expiresAt">, now: number = Date.now()): boolean {
  return new Date(entry.expiresAt).getTime() <= now;
}

/** Structural, order-insensitive-for-arrays-no/plain-deep equality over JSON-shaped data (LibraryItem rows never contain functions, dates-as-objects, or cycles). Used only for the survivor-changed check below — see its doc comment for why exact equality, not a timestamp, is what Undo relies on. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => deepEqual(entry, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(bRecord, key) && deepEqual(aRecord[key], bRecord[key]));
}

/**
 * Local-mode validation for undoing a delete — read-only, never mutates.
 * Mirrors delete_library_item_with_recovery's undo branch: the original id
 * must still be free, and every collection the item belonged to must still
 * exist. Local mode has no TrackingSources at all (Stage 22's device
 * pairing is cloud-only — verified against hooks/useCollections.ts and
 * useLibraryItems.ts, neither of which has a local equivalent), so there's
 * nothing to check there, unlike the cloud RPC.
 */
export function validateDeleteUndo(
  payload: DeleteRecoveryPayload,
  items: LibraryItem[],
  collections: Collection[],
): UndoOutcome {
  if (items.some((item) => item.id === payload.item.id)) {
    return { status: "recovery_conflict", reason: "id_in_use" };
  }
  const missingCollection = payload.collectionIds.some((id) => !collections.some((collection) => collection.id === id));
  if (missingCollection) {
    return { status: "recovery_conflict", reason: "collection_missing" };
  }
  return { status: "recovered" };
}

/**
 * Local-mode validation for undoing a merge. The central check — exact
 * equality between the survivor's current state and the state recorded
 * right after the original merge — is what lets any later, unrelated
 * change (new progress, an edit, a second merge) block Undo instead of
 * ever reverting it: if the survivor is byte-identical to what the merge
 * itself produced, nothing has touched it since, and it's safe to restore.
 */
export function validateMergeUndo(
  payload: MergeRecoveryPayload,
  items: LibraryItem[],
  collections: Collection[],
  events: ActivityEvent[],
): UndoOutcome {
  const survivor = items.find((item) => item.id === payload.survivorId);
  if (!survivor) return { status: "recovery_conflict", reason: "survivor_missing" };
  if (items.some((item) => item.id === payload.duplicateId)) {
    return { status: "recovery_conflict", reason: "id_in_use" };
  }
  if (!deepEqual(survivor, payload.survivorPostMergeExpected)) {
    return { status: "recovery_conflict", reason: "survivor_changed" };
  }
  const allCollectionIds = [...payload.survivorPreMergeCollectionIds, ...payload.duplicatePreMergeCollectionIds];
  const missingCollection = allCollectionIds.some((id) => !collections.some((collection) => collection.id === id));
  if (missingCollection) {
    return { status: "recovery_conflict", reason: "collection_missing" };
  }

  // Collection membership lives in Collection.itemIds, a separate array —
  // changing it never touches the LibraryItem object, so the deepEqual
  // check above cannot see a membership added or removed after the
  // merge. Compare the survivor's CURRENT membership set against the
  // expected post-merge union of both sides' pre-merge sets (never the
  // stored sets in isolation) — any real difference either way is user
  // intent since the merge that Undo must never silently discard or
  // resurrect. This mirrors the RPC's equivalent check in
  // 0010_stage28_library_recovery.sql's undo_library_recovery.
  const expectedPostMergeIds = new Set(allCollectionIds);
  const currentSurvivorIds = new Set(
    collections.filter((collection) => collection.itemIds.includes(payload.survivorId)).map((collection) => collection.id),
  );
  const topologyChanged =
    expectedPostMergeIds.size !== currentSurvivorIds.size || [...expectedPostMergeIds].some((id) => !currentSurvivorIds.has(id));
  if (topologyChanged) {
    return { status: "recovery_conflict", reason: "collections_changed" };
  }

  // Activity lives in a separate array too — the deepEqual check above
  // can't see a new event added to the survivor since the merge either.
  // Same technique as collections: compare the survivor's CURRENT full
  // activity-id set against the expected post-merge union (its own
  // pre-merge ids, which never moved, plus the ids moved in from the
  // duplicate). Deliberately never compares timestamps — a clock-
  // dependent check would be unreliable (see 0012_stage28_library_
  // recovery_fix.sql's doc comment for why the cloud RPC was fixed away
  // from exactly that mistake).
  const expectedActivityIds = new Set([...payload.survivorPreMergeActivityIds, ...payload.movedActivityIds]);
  const currentSurvivorActivityIds = new Set(events.filter((event) => event.itemId === payload.survivorId).map((event) => event.id));
  const activityChanged =
    expectedActivityIds.size !== currentSurvivorActivityIds.size || [...expectedActivityIds].some((id) => !currentSurvivorActivityIds.has(id));
  if (activityChanged) {
    return { status: "recovery_conflict", reason: "survivor_changed" };
  }

  return { status: "recovered" };
}

const PENDING_TOAST_KEY = "markly.pendingUndoToast";

/** One-shot, same-tab hand-off for the Undo toast across a navigation (e.g. the item detail page deleting its own item and redirecting to /library). sessionStorage, not localStorage — this is UI state for the current tab only, never meant to sync or persist beyond it. */
export interface PendingUndoToast {
  recoveryId: string;
  actionType: RecoveryActionType;
  title: string;
}

export function setPendingUndoToast(toast: PendingUndoToast): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(PENDING_TOAST_KEY, JSON.stringify(toast));
  } catch {
    // Storage unavailable; the redirect still succeeds, it just won't show a toast.
  }
}

export function takePendingUndoToast(): PendingUndoToast | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_TOAST_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(PENDING_TOAST_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.recoveryId !== "string" || typeof candidate.title !== "string") return null;
    if (candidate.actionType !== "delete_item" && candidate.actionType !== "merge_items") return null;
    return { recoveryId: candidate.recoveryId, actionType: candidate.actionType, title: candidate.title };
  } catch {
    return null;
  }
}
