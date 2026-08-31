import type { MetadataDetails, MetadataProviderAdapter } from "@/lib/metadata/types";

// TMDB requires a secret API key, so these adapters call Markly's own
// server routes rather than TMDB directly — the key never reaches the
// client. See src/lib/metadata/server/tmdb.ts and src/app/api/metadata/.
interface SearchResponse {
  results?: MetadataDetails[];
  error?: string;
}

async function fetchSearch(path: string, query: string, signal: AbortSignal): Promise<MetadataDetails[]> {
  const response = await fetch(`${path}?q=${encodeURIComponent(query)}`, { signal });
  const json = (await response.json()) as SearchResponse;
  if (!response.ok) throw new Error(json.error ?? "Search failed.");
  return json.results ?? [];
}

export const tmdbMovieProvider: MetadataProviderAdapter = {
  id: "tmdb",
  search: (query, signal) => fetchSearch("/api/metadata/movies/search", query, signal),
};

export const tmdbSeriesProvider: MetadataProviderAdapter = {
  id: "tmdb",
  search: (query, signal) => fetchSearch("/api/metadata/series/search", query, signal),

  async fetchDetails(result, signal): Promise<MetadataDetails> {
    try {
      const response = await fetch(
        `/api/metadata/series/details?id=${encodeURIComponent(result.externalId)}`,
        { signal },
      );
      if (!response.ok) return result;

      const json = (await response.json()) as { totalEpisodes?: number };
      return json.totalEpisodes !== undefined ? { ...result, totalEpisodes: json.totalEpisodes } : result;
    } catch {
      return result;
    }
  },
};
