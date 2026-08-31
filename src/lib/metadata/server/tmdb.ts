// Server-only: reads a secret API key from process.env. Import this ONLY
// from route handlers under src/app/api/ — never from a client component
// or any module a client component imports, or the key could leak into
// the client bundle.
import type { MetadataDetails } from "@/lib/metadata/types";
import { normalizeDescription, normalizeYear } from "@/lib/metadata/sanitize";

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w342";

// TMDB's genre id -> name lists are small, public, and stable reference
// data (https://developer.themoviedb.org/reference/genre-movie-list),
// hardcoded here to avoid an extra round trip per search.
const MOVIE_GENRES: Record<number, string> = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
  99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
  27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance", 878: "Science Fiction",
  10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
};

const TV_GENRES: Record<number, string> = {
  10759: "Action & Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
  99: "Documentary", 18: "Drama", 10751: "Family", 10762: "Kids", 9648: "Mystery",
  10763: "News", 10764: "Reality", 10765: "Sci-Fi & Fantasy", 10766: "Soap",
  10767: "Talk", 10768: "War & Politics", 37: "Western",
};

interface TmdbSearchItem {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
}

function mapGenres(ids: number[] | undefined, table: Record<number, string>): string[] | undefined {
  if (!ids || ids.length === 0) return undefined;
  const names = ids.map((id) => table[id]).filter((name): name is string => Boolean(name));
  return names.length > 0 ? names : undefined;
}

export function isTmdbConfigured(): boolean {
  return Boolean(process.env.TMDB_API_KEY);
}

async function tmdbFetch(path: string, params: Record<string, string>): Promise<unknown> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error("TMDB is not configured.");

  const url = new URL(`${TMDB_API_BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`TMDB request failed (${response.status})`);
  return response.json();
}

export async function searchTmdbMovies(query: string): Promise<MetadataDetails[]> {
  const json = (await tmdbFetch("/search/movie", { query })) as { results?: TmdbSearchItem[] };
  return (json.results ?? []).slice(0, 8).map((item) => ({
    provider: "tmdb" as const,
    externalId: String(item.id),
    title: item.title ?? "Untitled",
    imageUrl: item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : undefined,
    year: normalizeYear(item.release_date),
    description: normalizeDescription(item.overview),
    genres: mapGenres(item.genre_ids, MOVIE_GENRES),
  }));
}

export async function searchTmdbSeries(query: string): Promise<MetadataDetails[]> {
  const json = (await tmdbFetch("/search/tv", { query })) as { results?: TmdbSearchItem[] };
  return (json.results ?? []).slice(0, 8).map((item) => ({
    provider: "tmdb" as const,
    externalId: String(item.id),
    title: item.name ?? "Untitled",
    imageUrl: item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : undefined,
    year: normalizeYear(item.first_air_date),
    description: normalizeDescription(item.overview),
    genres: mapGenres(item.genre_ids, TV_GENRES),
  }));
}

export async function getTmdbSeriesEpisodeCount(id: string): Promise<number | undefined> {
  const json = (await tmdbFetch(`/tv/${id}`, {})) as { number_of_episodes?: number };
  return typeof json.number_of_episodes === "number" ? json.number_of_episodes : undefined;
}
