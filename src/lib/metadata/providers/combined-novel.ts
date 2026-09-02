import type { MetadataDetails, MetadataProviderAdapter } from "@/lib/metadata/types";
import { openLibraryProvider } from "@/lib/metadata/providers/open-library";
import { anilistLightNovelProvider } from "@/lib/metadata/providers/anilist";

/** Same comparison-key normalization spirit as the rest of the codebase's title-matching (see extension's normalizeTitleForMatching) — case/whitespace only, never aggressive enough to conflate two different titles. */
function normalizeForDedup(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * "Books & Novels" search backed by two independent catalogs, queried in
 * parallel and merged into one result list:
 *   - Open Library: traditionally-published books (the original Stage-N
 *     provider — unchanged, see open-library.ts).
 *   - AniList (format: NOVEL/ONE_SHOT): officially-published light novels
 *     (see anilist.ts's anilistLightNovelProvider for exactly what this
 *     does and does not cover — notably, not raw/unlicensed web novels).
 * Neither source alone covers everything a "Novel / Book" search should;
 * together they cover meaningfully more without requiring the user to
 * know which catalog a given title lives in. If one source fails (network
 * error, rate limit), the other's results are still returned rather than
 * failing the whole search — only failing both rejects.
 */
export const combinedNovelProvider: MetadataProviderAdapter = {
  // Kept as "open-library" for the idle/loading/error state's single-line
  // attribution (see MetadataSearchPanel, which switches to a
  // multi-source line once results actually arrive) — arbitrary but
  // stable choice, not meaningful beyond that fallback.
  id: "open-library",

  async search(query, signal) {
    const [openLibraryResult, aniListResult] = await Promise.allSettled([
      openLibraryProvider.search(query, signal),
      anilistLightNovelProvider.search(query, signal),
    ]);

    if (openLibraryResult.status === "rejected" && aniListResult.status === "rejected") {
      throw openLibraryResult.reason;
    }

    const combined: MetadataDetails[] = [
      ...(openLibraryResult.status === "fulfilled" ? openLibraryResult.value : []),
      ...(aniListResult.status === "fulfilled" ? aniListResult.value : []),
    ];

    // De-duplicate by normalized title, preferring the Open Library entry
    // on a collision (arbitrary but consistent tie-break — both sources
    // return comparable data for a straightforward duplicate).
    const seen = new Set<string>();
    const deduped: MetadataDetails[] = [];
    for (const result of combined) {
      const key = normalizeForDedup(result.title);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(result);
    }
    return deduped;
  },

  async fetchDetails(result, signal) {
    if (result.provider === "open-library" && openLibraryProvider.fetchDetails) {
      return openLibraryProvider.fetchDetails(result, signal);
    }
    // AniList's search response already carries everything this provider
    // returns (see anilistLightNovelProvider) — nothing further to enrich.
    return result;
  },
};
