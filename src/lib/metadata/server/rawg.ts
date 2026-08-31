// Server-only: reads a secret API key from process.env. Import this ONLY
// from route handlers under src/app/api/ — never from a client component
// or any module a client component imports, or the key could leak into
// the client bundle (and RAWG's key is tied to per-IP rate limits, so
// leaking it would also let others burn through the quota).
import type { MetadataDetails } from "@/lib/metadata/types";
import { normalizeDescription, normalizeStringArray, normalizeYear } from "@/lib/metadata/sanitize";

const RAWG_API_BASE = "https://api.rawg.io/api";

interface RawgGame {
  id: number;
  name: string;
  background_image: string | null;
  released: string | null;
  platforms?: { platform: { name: string } }[] | null;
}

interface RawgGameDetails {
  description_raw?: string;
  developers?: { name: string }[];
  publishers?: { name: string }[];
}

export function isRawgConfigured(): boolean {
  return Boolean(process.env.RAWG_API_KEY);
}

async function rawgFetch(path: string, params: Record<string, string>): Promise<unknown> {
  const apiKey = process.env.RAWG_API_KEY;
  if (!apiKey) throw new Error("RAWG is not configured.");

  const url = new URL(`${RAWG_API_BASE}${path}`);
  url.searchParams.set("key", apiKey);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`RAWG request failed (${response.status})`);
  return response.json();
}

export async function searchRawgGames(query: string): Promise<MetadataDetails[]> {
  const json = (await rawgFetch("/games", { search: query, page_size: "8" })) as { results?: RawgGame[] };
  return (json.results ?? []).map((game) => ({
    provider: "rawg" as const,
    externalId: String(game.id),
    title: game.name,
    imageUrl: game.background_image ?? undefined,
    year: normalizeYear(game.released ?? undefined),
    catalogPlatforms: normalizeStringArray(game.platforms?.map((p) => p.platform.name)),
  }));
}

/** RAWG's list endpoint omits description/developers/publishers; only the detail endpoint has them. */
export async function getRawgGameDetails(id: string): Promise<Partial<MetadataDetails>> {
  const json = (await rawgFetch(`/games/${id}`, {})) as RawgGameDetails;
  const developer = json.developers?.map((d) => d.name).join(", ");
  const publisher = json.publishers?.map((p) => p.name).join(", ");

  return {
    description: normalizeDescription(json.description_raw),
    developer: developer || undefined,
    publisher: publisher || undefined,
  };
}
