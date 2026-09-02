import type { MetadataDetails, MetadataProviderAdapter } from "@/lib/metadata/types";
import { normalizeDescription, normalizeStringArray } from "@/lib/metadata/sanitize";

// Public GraphQL endpoint, no API key, CORS-open — safe to call directly
// from the browser. Unauthenticated rate limit is generous (~30 req/min).
const ANILIST_ENDPOINT = "https://graphql.anilist.co";

const SEARCH_QUERY = `
  query ($search: String, $type: MediaType, $formatIn: [MediaFormat]) {
    Page(page: 1, perPage: 8) {
      media(search: $search, type: $type, format_in: $formatIn, sort: SEARCH_MATCH) {
        id
        title { english romaji }
        description(asHtml: false)
        coverImage { large medium }
        startDate { year }
        episodes
        chapters
        genres
        studios(isMain: true) { nodes { name } }
        staff(sort: RELEVANCE, perPage: 2) { nodes { name { full } } }
      }
    }
  }
`;

interface AniListMedia {
  id: number;
  title: { english: string | null; romaji: string | null };
  description: string | null;
  coverImage: { large: string | null; medium: string | null } | null;
  startDate: { year: number | null } | null;
  episodes: number | null;
  chapters: number | null;
  genres: string[] | null;
  studios: { nodes: { name: string }[] } | null;
  staff: { nodes: { name: { full: string | null } }[] } | null;
}

async function searchAniList(
  query: string,
  mediaType: "ANIME" | "MANGA",
  signal: AbortSignal,
  formatIn?: string[],
): Promise<AniListMedia[]> {
  const response = await fetch(ANILIST_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: SEARCH_QUERY, variables: { search: query, type: mediaType, formatIn } }),
    signal,
  });

  if (!response.ok) throw new Error(`AniList request failed (${response.status})`);

  const json = (await response.json()) as { data?: { Page?: { media?: AniListMedia[] } } };
  return json.data?.Page?.media ?? [];
}

function toDetails(media: AniListMedia, kind: "anime" | "manga" | "novel"): MetadataDetails {
  // AniList has no dedicated "author" field for manga or novel entries;
  // the top staff credits by relevance (for a novel, typically just the
  // author; for manga, the story/art creator(s)) are the closest reliable
  // approximation, so this is a best-effort mapping either way.
  const staffNames = normalizeStringArray(media.staff?.nodes.map((node) => node.name.full ?? ""));

  return {
    provider: "anilist",
    externalId: String(media.id),
    title: media.title.english || media.title.romaji || "Untitled",
    imageUrl: media.coverImage?.large ?? media.coverImage?.medium ?? undefined,
    year: media.startDate?.year ?? undefined,
    description: media.description ? normalizeDescription(media.description) : undefined,
    genres: normalizeStringArray(media.genres),
    totalEpisodes: kind === "anime" ? media.episodes ?? undefined : undefined,
    totalChapters: kind === "manga" ? media.chapters ?? undefined : undefined,
    studio: kind === "anime" ? media.studios?.nodes[0]?.name : undefined,
    authors: kind === "manga" || kind === "novel" ? staffNames : undefined,
  };
}

export const anilistAnimeProvider: MetadataProviderAdapter = {
  id: "anilist",
  async search(query, signal) {
    const media = await searchAniList(query, "ANIME", signal);
    return media.map((item) => toDetails(item, "anime"));
  },
};

export const anilistMangaProvider: MetadataProviderAdapter = {
  id: "anilist",
  async search(query, signal) {
    const media = await searchAniList(query, "MANGA", signal);
    return media.map((item) => toDetails(item, "manga"));
  },
};

/**
 * AniList's `MediaType: MANGA` catalog holds both comics (`format: MANGA`)
 * and novels (`format: NOVEL`/`ONE_SHOT`) — this queries only the latter,
 * i.e. light novels. Confirmed against the live public API (not assumed):
 * this reliably finds officially-published light novels with a real
 * NOVEL-format entry (e.g. "Mushoku Tensei", "Overlord"), but AniList has
 * *no* novel-format entry at all for many hugely popular raw/fan-
 * translated web novels that were never formally published as a book
 * (e.g. "Reverend Insanity", "The Perfect Run" both return zero results
 * here) — only their manga/manhua adaptation, if one exists, which is a
 * different medium and not what this provider returns. There is no
 * public, unauthenticated, ToS-compliant catalog API for that raw-web-
 * novel case (NovelUpdates, the closest thing, has no public API and
 * disallows scraping) — see combined-novel.ts and the root README for the
 * honest scope of what this expands vs. doesn't.
 */
export const anilistLightNovelProvider: MetadataProviderAdapter = {
  id: "anilist",
  async search(query, signal) {
    const media = await searchAniList(query, "MANGA", signal, ["NOVEL", "ONE_SHOT"]);
    return media.map((item) => toDetails(item, "novel"));
  },
};
