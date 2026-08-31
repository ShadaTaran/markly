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

/** Identifies which external catalog (if any) an item's metadata was imported from. */
export type MetadataProvider = "anilist" | "open-library" | "tmdb" | "rawg";

export interface CatalogSourceReference {
  provider: MetadataProvider;
  externalId: string;
}

/**
 * Shared shape for anime/manga/novel/game/movie/series: a title plus an
 * optional cover image and an optional source/reference link. Game is the
 * only one of these that currently adds a field of its own outside the
 * tracking model (`platform`).
 *
 * `releaseYear` and `catalogSource` are external/catalog metadata, only
 * ever set at import time from a search selection — never personal data,
 * and never touched by editing the item's tracking fields.
 */
interface MediaLibraryItem extends BaseLibraryItem {
  imageUrl?: string;
  sourceUrl?: string;
  releaseYear?: number;
  catalogSource?: CatalogSourceReference;
}

/**
 * Status values are shared across every trackable type; each type maps a
 * subset of them to its own labels (see lib/tracking.ts) rather than
 * defining a separate status enum per type.
 */
export type TrackingStatus = "planned" | "in_progress" | "completed" | "on_hold" | "dropped";

/** Adds shared tracking fields (status, rating) to a media item. */
interface TrackableLibraryItem extends MediaLibraryItem {
  status: TrackingStatus;
  rating?: number;
}

/** Adds current/total episode progress, used by Anime and Series. */
interface EpisodeTrackedItem extends TrackableLibraryItem {
  currentEpisode?: number;
  totalEpisodes?: number;
}

export interface AnimeItem extends EpisodeTrackedItem {
  type: "anime";
  /** Catalog genres, imported as-is — distinct from the user's personal tags. */
  genres?: string[];
  studio?: string;
}

export interface SeriesItem extends EpisodeTrackedItem {
  type: "series";
  genres?: string[];
}

export interface MangaItem extends TrackableLibraryItem {
  type: "manga";
  /** Supports decimals (e.g. 12.5) for split-release chapters. */
  currentChapter?: number;
  totalChapters?: number;
  genres?: string[];
  authors?: string[];
}

export type NovelProgressUnit = "chapter" | "page" | "percent";

export interface NovelItem extends TrackableLibraryItem {
  type: "novel";
  progressValue?: number;
  progressUnit?: NovelProgressUnit;
  authors?: string[];
  pageCount?: number;
}

export interface MovieItem extends TrackableLibraryItem {
  type: "movie";
  genres?: string[];
}

export interface GameItem extends TrackableLibraryItem {
  type: "game";
  platform?: string;
  /** Manually-entered total playtime; supports decimals, never negative. */
  playtimeHours?: number;
  /** Catalog metadata — distinct from the user's single personal `platform`. */
  developer?: string;
  publisher?: string;
  catalogPlatforms?: string[];
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
