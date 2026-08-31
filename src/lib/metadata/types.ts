import type { MetadataProvider } from "@/types/library-item";

export type { MetadataProvider };

/**
 * Normalized shape every provider returns, for both a search-result row and
 * the (possibly enriched) details used to autofill the Add form. Providers
 * whose search/list endpoint already returns everything Markly needs (e.g.
 * AniList, TMDB) just return this directly; providers whose list endpoint
 * is thinner (Open Library, RAWG) implement `fetchDetails` to fill in the
 * rest after the user picks a result.
 */
export interface MetadataDetails {
  provider: MetadataProvider;
  externalId: string;
  title: string;
  imageUrl?: string;
  year?: number;
  description?: string;
  genres?: string[];
  totalEpisodes?: number;
  totalChapters?: number;
  authors?: string[];
  developer?: string;
  publisher?: string;
  catalogPlatforms?: string[];
  studio?: string;
  pageCount?: number;
}

export interface MetadataProviderAdapter {
  id: MetadataProvider;
  search(query: string, signal: AbortSignal): Promise<MetadataDetails[]>;
  /** Optional enrichment call for providers whose search results are incomplete. */
  fetchDetails?(result: MetadataDetails, signal: AbortSignal): Promise<MetadataDetails>;
}
