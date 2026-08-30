export interface Bookmark {
  id: string;
  title: string;
  url: string;
  description: string;
  category: string;
  tags: string[];
  favorite: boolean;
}

export type BookmarkInput = Omit<Bookmark, "id" | "favorite">;
