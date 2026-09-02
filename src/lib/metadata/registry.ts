import type { MediaItem } from "@/types/library-item";
import type { MetadataProviderAdapter } from "@/lib/metadata/types";
import { anilistAnimeProvider, anilistMangaProvider } from "@/lib/metadata/providers/anilist";
import { combinedNovelProvider } from "@/lib/metadata/providers/combined-novel";
import { tmdbMovieProvider, tmdbSeriesProvider } from "@/lib/metadata/providers/tmdb";
import { rawgGameProvider } from "@/lib/metadata/providers/rawg";

/**
 * Every media type has an adapter mapped here, even the ones backed by an
 * unconfigured API key (TMDB/RAWG without an env var set) — the adapter's
 * search() will simply reject and the Add Item UI surfaces that as the
 * normal "unable to search right now" state with a manual-entry fallback,
 * rather than needing special-cased "is this configured" UI logic.
 *
 * `novel` is backed by combinedNovelProvider (Open Library + AniList light
 * novels merged) rather than a single source — see combined-novel.ts.
 */
const PROVIDERS_BY_TYPE: Record<MediaItem["type"], MetadataProviderAdapter> = {
  anime: anilistAnimeProvider,
  manga: anilistMangaProvider,
  novel: combinedNovelProvider,
  movie: tmdbMovieProvider,
  series: tmdbSeriesProvider,
  game: rawgGameProvider,
};

export function getMetadataProvider(type: MediaItem["type"]): MetadataProviderAdapter {
  return PROVIDERS_BY_TYPE[type];
}
