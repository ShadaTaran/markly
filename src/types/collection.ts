/**
 * A user-created organizational list. Collections reference LibraryItems by
 * id only — the canonical item data always lives in markly.library, never
 * duplicated here. An item can belong to any number of collections.
 */
export interface Collection {
  id: string;
  name: string;
  description?: string;
  itemIds: string[];
  createdAt: string;
  updatedAt?: string;
}

export type CollectionInput = Pick<Collection, "name" | "description">;
