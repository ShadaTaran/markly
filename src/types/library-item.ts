export type LibraryItemType =
  | "website"
  | "anime"
  | "manga"
  | "novel"
  | "game"
  | "movie"
  | "series"
  | "article"
  | "video"
  | "other";

interface BaseLibraryItem {
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  favorite: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface WebsiteItem extends BaseLibraryItem {
  type: "website";
  url: string;
}

/**
 * Shared shape for anime/manga/novel/game/movie/series: a title plus an
 * optional cover image and an optional source/reference link. Game is the
 * only one of these that currently adds anything of its own (`platform`).
 */
interface MediaLibraryItem extends BaseLibraryItem {
  imageUrl?: string;
  sourceUrl?: string;
}

export interface AnimeItem extends MediaLibraryItem {
  type: "anime";
}

export interface MangaItem extends MediaLibraryItem {
  type: "manga";
}

export interface NovelItem extends MediaLibraryItem {
  type: "novel";
}

export interface MovieItem extends MediaLibraryItem {
  type: "movie";
}

export interface SeriesItem extends MediaLibraryItem {
  type: "series";
}

export interface GameItem extends MediaLibraryItem {
  type: "game";
  platform?: string;
}

export type MediaItem = AnimeItem | MangaItem | NovelItem | GameItem | MovieItem | SeriesItem;

/**
 * Stand-in for every LibraryItemType that still doesn't have a dedicated
 * interface (article, video, other). Each will be split out the same way
 * WebsiteItem and the MediaItem types were once it's actually implemented;
 * until then it shares BaseLibraryItem's fields only.
 */
export interface GenericLibraryItem extends BaseLibraryItem {
  type: Exclude<LibraryItemType, "website" | MediaItem["type"]>;
}

export type LibraryItem = WebsiteItem | MediaItem | GenericLibraryItem;

/** Omit<T, K> that distributes over a union instead of collapsing it. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type InputOmitKeys = "id" | "type" | "favorite" | "createdAt" | "updatedAt";

export type WebsiteItemInput = Omit<WebsiteItem, InputOmitKeys>;
export type MediaItemInput = DistributiveOmit<MediaItem, InputOmitKeys>;

export const SUPPORTED_ITEM_TYPES = [
  "website",
  "anime",
  "manga",
  "novel",
  "game",
  "movie",
  "series",
] as const satisfies readonly LibraryItemType[];

/** The subset of LibraryItemType that actually has a form/card today. */
export type SupportedItemType = (typeof SUPPORTED_ITEM_TYPES)[number];

export const ITEM_TYPE_LABELS: Record<LibraryItemType, string> = {
  website: "Website",
  anime: "Anime",
  manga: "Manga",
  novel: "Novel / Book",
  game: "Game",
  movie: "Movie",
  series: "Series",
  article: "Article",
  video: "Video",
  other: "Other",
};
