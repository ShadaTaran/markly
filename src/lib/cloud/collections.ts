import type { SupabaseClient } from "@supabase/supabase-js";
import type { CollectionItemRow, CollectionRow } from "@/lib/supabase/database.types";
import type { Collection } from "@/types/collection";

/** Fetches collections plus their membership (a separate join-table query, merged client-side) — never a duplicated LibraryItem. */
export async function fetchCollections(supabase: SupabaseClient, userId: string): Promise<Collection[]> {
  const [collectionsResult, membersResult] = await Promise.all([
    supabase
      .from("collections")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .returns<CollectionRow[]>(),
    supabase
      .from("collection_items")
      .select("collection_id, item_id")
      .eq("user_id", userId)
      .returns<Pick<CollectionItemRow, "collection_id" | "item_id">[]>(),
  ]);

  if (collectionsResult.error) throw collectionsResult.error;
  if (membersResult.error) throw membersResult.error;

  const itemIdsByCollection = new Map<string, string[]>();
  (membersResult.data ?? []).forEach((row) => {
    const list = itemIdsByCollection.get(row.collection_id) ?? [];
    list.push(row.item_id);
    itemIdsByCollection.set(row.collection_id, list);
  });

  return (collectionsResult.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    itemIds: itemIdsByCollection.get(row.id) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
  }));
}

export async function upsertCollectionRow(supabase: SupabaseClient, collection: Collection, userId: string): Promise<void> {
  const { error } = await supabase.from("collections").upsert({
    id: collection.id,
    user_id: userId,
    name: collection.name,
    description: collection.description ?? null,
    created_at: collection.createdAt,
    updated_at: collection.updatedAt ?? null,
  });
  if (error) throw error;
}

export async function deleteCollectionRow(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from("collections").delete().eq("id", id);
  if (error) throw error;
}

/** Adds or removes one collection_items row — a targeted join-table write rather than replacing the whole membership list. */
export async function setCollectionMembership(
  supabase: SupabaseClient,
  collectionId: string,
  itemId: string,
  userId: string,
  member: boolean,
): Promise<void> {
  if (member) {
    const { error } = await supabase
      .from("collection_items")
      .upsert({ collection_id: collectionId, item_id: itemId, user_id: userId });
    if (error) throw error;
    return;
  }

  const { error } = await supabase
    .from("collection_items")
    .delete()
    .eq("collection_id", collectionId)
    .eq("item_id", itemId);
  if (error) throw error;
}
