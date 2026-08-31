import type { MetadataDetails, MetadataProviderAdapter } from "@/lib/metadata/types";

// RAWG requires a secret API key, so this adapter calls Markly's own
// server routes rather than RAWG directly — the key never reaches the
// client. See src/lib/metadata/server/rawg.ts and src/app/api/metadata/.
export const rawgGameProvider: MetadataProviderAdapter = {
  id: "rawg",

  async search(query, signal): Promise<MetadataDetails[]> {
    const response = await fetch(`/api/metadata/games/search?q=${encodeURIComponent(query)}`, { signal });
    const json = (await response.json()) as { results?: MetadataDetails[]; error?: string };
    if (!response.ok) throw new Error(json.error ?? "Search failed.");
    return json.results ?? [];
  },

  async fetchDetails(result, signal): Promise<MetadataDetails> {
    try {
      const response = await fetch(
        `/api/metadata/games/details?id=${encodeURIComponent(result.externalId)}`,
        { signal },
      );
      if (!response.ok) return result;

      const json = (await response.json()) as Partial<MetadataDetails>;
      return { ...result, ...json };
    } catch {
      return result;
    }
  },
};
