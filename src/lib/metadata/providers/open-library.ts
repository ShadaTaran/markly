import type { MetadataDetails, MetadataProviderAdapter } from "@/lib/metadata/types";
import { normalizeDescription, normalizeStringArray } from "@/lib/metadata/sanitize";

// Public REST API, no API key, CORS-open — safe to call directly from the
// browser. search.json is a thin index; fetchDetails below fills in the
// description (and subjects-as-genres) from the fuller work record.
const SEARCH_ENDPOINT = "https://openlibrary.org/search.json";
const COVERS_ENDPOINT = "https://covers.openlibrary.org/b/id";

interface OpenLibraryDoc {
  key: string;
  title?: string;
  author_name?: string[];
  cover_i?: number;
  first_publish_year?: number;
}

interface OpenLibraryWork {
  description?: string | { value?: string };
  subjects?: string[];
}

interface OpenLibraryEdition {
  number_of_pages?: number;
}

function coverUrl(coverId: number | undefined): string | undefined {
  return coverId ? `${COVERS_ENDPOINT}/${coverId}-M.jpg` : undefined;
}

/**
 * Open Library's "subjects" are free-text and often compound/overly
 * specific (e.g. "Dune (Imaginary place)", "Fiction, science fiction,
 * general") rather than clean genre-style tags. Keeping only short,
 * comma/parenthesis-free entries yields something closer to a genre list
 * (e.g. "Fiction", "Adventure") without inventing categories of our own.
 */
function pickConciseSubjects(subjects: string[] | undefined): string[] | undefined {
  return subjects
    ?.filter((subject) => !subject.includes(",") && !subject.includes("(") && subject.length <= 24)
    .slice(0, 5);
}

/**
 * Page count is an edition-level fact (it varies by printing), not a work-
 * level one, so it isn't on the work record fetchDetails already reads —
 * this checks a few editions and takes the first one that has it. Best
 * effort: many editions simply don't record a page count.
 */
async function fetchPageCount(workKey: string, signal: AbortSignal): Promise<number | undefined> {
  try {
    const response = await fetch(`https://openlibrary.org${workKey}/editions.json?limit=5`, { signal });
    if (!response.ok) return undefined;

    const json = (await response.json()) as { entries?: OpenLibraryEdition[] };
    const withPageCount = json.entries?.find(
      (edition) => typeof edition.number_of_pages === "number" && edition.number_of_pages > 0,
    );
    return withPageCount?.number_of_pages;
  } catch {
    return undefined;
  }
}

export const openLibraryProvider: MetadataProviderAdapter = {
  id: "open-library",

  async search(query, signal) {
    const url = `${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&limit=8&fields=key,title,author_name,cover_i,first_publish_year`;
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Open Library request failed (${response.status})`);

    const json = (await response.json()) as { docs?: OpenLibraryDoc[] };
    const docs = json.docs ?? [];

    return docs
      .filter((doc): doc is OpenLibraryDoc & { title: string } => Boolean(doc.title?.trim()))
      .map((doc) => ({
        provider: "open-library" as const,
        externalId: doc.key,
        title: doc.title,
        imageUrl: coverUrl(doc.cover_i),
        year: doc.first_publish_year,
        authors: normalizeStringArray(doc.author_name),
      }));
  },

  async fetchDetails(result, signal): Promise<MetadataDetails> {
    try {
      const response = await fetch(`https://openlibrary.org${result.externalId}.json`, { signal });
      if (!response.ok) return result;

      const work = (await response.json()) as OpenLibraryWork;
      const description =
        typeof work.description === "string"
          ? normalizeDescription(work.description)
          : normalizeDescription(work.description?.value);
      const pageCount = await fetchPageCount(result.externalId, signal);

      return {
        ...result,
        description: description ?? result.description,
        genres: normalizeStringArray(pickConciseSubjects(work.subjects)) ?? result.genres,
        pageCount,
      };
    } catch {
      return result;
    }
  },
};
