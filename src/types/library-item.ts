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

/**
 * Whether `currentEpisode` counts every episode of the show in one running
 * sequence ("absolute" — Episode 1, 2, 3…) or resets each season
 * ("seasonal" — Season 1 Episode 12, then Season 2 Episode 1). Absent
 * means "absolute" — every item created before Stage 25, and every
 * AniList-synced item (AniList always reports one continuous absolute
 * progress number, never a season), is interpreted this way. Never
 * inferred from currentEpisode/totalEpisodes alone; only ever set
 * explicitly (a form edit, or a season-aware auto-tracking detection).
 */
export type EpisodeNumbering = "absolute" | "seasonal";

/** Adds current/total episode progress, used by Anime and Series. */
interface EpisodeTrackedItem extends TrackableLibraryItem {
  currentEpisode?: number;
  totalEpisodes?: number;
  episodeNumbering?: EpisodeNumbering;
  /** Only meaningful when episodeNumbering === "seasonal" — which season currentEpisode (season-relative, not a running total) belongs to. */
  currentSeason?: number;
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

/**
 * A written work's publication format — distinct from `type: "novel"`
 * itself, which stays the one tracking media type for every kind of
 * written prose (see README "Metadata Search"). Deliberately a narrow set
 * mapped to the sources Markly actually has evidence for, not every term
 * in common use (no separate "web_serial"/"fanfiction" — nothing
 * currently distinguishes those from "web_novel", so a value with no real
 * signal behind it would just be a second name for the same bucket):
 *   - "book": a traditionally-published book (Open Library's domain).
 *   - "light_novel": an officially-published light novel (AniList's
 *     `format: NOVEL`/`ONE_SHOT` catalog).
 *   - "web_novel": a raw/fan-translated web novel or serial with no
 *     official catalog entry — always a *suggestion* when set from a
 *     browser-extension detection (never asserted as fact), always
 *     user-editable.
 */
export type NovelReadingFormat = "book" | "light_novel" | "web_novel";

export interface NovelItem extends TrackableLibraryItem {
  type: "novel";
  progressValue?: number;
  progressUnit?: NovelProgressUnit;
  authors?: string[];
  pageCount?: number;
  readingFormat?: NovelReadingFormat;
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
  novel: "Books & Novels",
  game: "Game",
  movie: "Movie",
  series: "Series",
  article: "Article",
  video: "Video",
  other: "Other",
};

/** Display label for a novel's optional reading format — see NovelReadingFormat. Never shown for a novel that doesn't have one set (e.g. most manually-added or pre-Stage-20 items). */
export const NOVEL_READING_FORMAT_LABELS: Record<NovelReadingFormat, string> = {
  book: "Book",
  light_novel: "Light Novel",
  web_novel: "Web Novel",
};
