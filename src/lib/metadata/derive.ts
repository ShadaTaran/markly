const FALLBACK_CATEGORY = "Uncategorized";

/**
 * Derives the personal category and tags for a catalog-backed item straight
 * from the provider's genres: the first genre becomes the category (a
 * single bucket to file the item under, mirroring how the user would file
 * a manually-added item), and every genre becomes a tag. Genre casing is
 * preserved as the provider returned it (tag matching/filtering is already
 * case-insensitive elsewhere) — only whitespace/duplicates are cleaned up.
 * Falls back to a neutral category when the provider supplied no genres at
 * all, rather than inventing one.
 */
export function deriveCategoryAndTags(genres: string[] | undefined): { category: string; tags: string[] } {
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const raw of genres ?? []) {
    const cleaned = raw.trim().replace(/\s+/g, " ");
    const key = cleaned.toLowerCase();
    if (cleaned && !seen.has(key)) {
      seen.add(key);
      tags.push(cleaned);
    }
  }

  return { category: tags[0] ?? FALLBACK_CATEGORY, tags };
}
