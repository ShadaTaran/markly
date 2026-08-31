import type { SupabaseClient } from "@supabase/supabase-js";
import { loadLibraryItems } from "@/lib/library-storage";
import { loadCollections } from "@/lib/collection-storage";
import { loadActivity } from "@/lib/activity-storage";
import { toLibraryItemRow } from "@/lib/cloud/library-items";
import { toActivityEventRow } from "@/lib/cloud/activity";
import { generateId } from "@/lib/utils";

const MIGRATION_FLAG_PREFIX = "markly.migrated.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function migrationFlagKey(userId: string): string {
  return `${MIGRATION_FLAG_PREFIX}${userId}`;
}

/** Whether this browser has already imported its local data into this account — the UX-nicety half of duplicate protection (the real safety net is upsert-by-id in the writes below). */
export function hasCompletedMigration(userId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(migrationFlagKey(userId)) === "true";
  } catch {
    return false;
  }
}

function markMigrationComplete(userId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(migrationFlagKey(userId), "true");
  } catch {
    // Storage unavailable; the import itself already succeeded server-side —
    // at worst this user sees the import prompt again next sign-in.
  }
}

export interface LocalDataSummary {
  itemCount: number;
  collectionCount: number;
  activityCount: number;
}

/** Reads what's on this device without touching the network — used to decide whether to offer an import. Returns null when there's nothing worth importing. */
export function readLocalDataSummary(): LocalDataSummary | null {
  const items = loadLibraryItems();
  if (!items || items.length === 0) return null;

  return {
    itemCount: items.length,
    collectionCount: loadCollections()?.length ?? 0,
    activityCount: loadActivity()?.length ?? 0,
  };
}

export type MigrationResult = { success: true } | { success: false; error: string };

/**
 * Imports this device's local library into the signed-in user's cloud
 * account. Every table is upserted by id, so re-running this (a retried
 * failed import, or the same browser signing in again) never duplicates
 * rows — it's always safe to call again. Local data, and the original
 * localStorage keys, are left untouched either way.
 */
export async function migrateLocalDataToCloud(supabase: SupabaseClient, userId: string): Promise<MigrationResult> {
  const items = loadLibraryItems() ?? [];
  const collections = loadCollections() ?? [];
  const activity = loadActivity() ?? [];

  if (items.length === 0) {
    markMigrationComplete(userId);
    return { success: true };
  }

  // Local ids are crypto.randomUUID() output almost always — but generateId()
  // has a non-UUID fallback for environments without it, and a uuid column
  // can't hold that. Remap those (rare) ids to a fresh UUID and carry the
  // mapping through every reference: collection membership and activity
  // events both key off the original item id.
  const idMap = new Map<string, string>();
  items.forEach((item) => idMap.set(item.id, UUID_PATTERN.test(item.id) ? item.id : generateId()));
  const remapId = (id: string) => idMap.get(id) ?? id;

  const remappedItems = items.map((item) => ({ ...item, id: remapId(item.id) }));
  const importedItemIds = new Set(remappedItems.map((item) => item.id));

  try {
    const itemRows = remappedItems.map((item) => toLibraryItemRow(item, userId));
    const { error: itemsError } = await supabase.from("library_items").upsert(itemRows);
    if (itemsError) throw itemsError;

    if (collections.length > 0) {
      const collectionRows = collections.map((collection) => ({
        id: collection.id,
        user_id: userId,
        name: collection.name,
        description: collection.description ?? null,
        created_at: collection.createdAt,
        updated_at: collection.updatedAt ?? null,
      }));
      const { error: collectionsError } = await supabase.from("collections").upsert(collectionRows);
      if (collectionsError) throw collectionsError;

      // Collections are imported before membership rows so the referenced
      // collection_id already exists — required by the FK, and mirrors the
      // dependency order collection_items itself models (never inserted
      // before its collection and item both exist).
      const membershipRows = collections.flatMap((collection) =>
        collection.itemIds
          .map(remapId)
          .filter((itemId) => importedItemIds.has(itemId))
          .map((itemId) => ({ collection_id: collection.id, item_id: itemId, user_id: userId })),
      );
      if (membershipRows.length > 0) {
        const { error: membershipError } = await supabase.from("collection_items").upsert(membershipRows);
        if (membershipError) throw membershipError;
      }
    }

    if (activity.length > 0) {
      const activityRows = activity
        .filter((event) => importedItemIds.has(remapId(event.itemId)))
        .map((event) => toActivityEventRow({ ...event, itemId: remapId(event.itemId) }, userId));
      if (activityRows.length > 0) {
        const { error: activityError } = await supabase.from("activity_events").upsert(activityRows);
        if (activityError) throw activityError;
      }
    }

    markMigrationComplete(userId);
    return { success: true };
  } catch {
    return { success: false, error: "Import failed. Your local data is unchanged — you can try again." };
  }
}
