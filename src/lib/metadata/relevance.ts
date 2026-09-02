/**
 * Deterministic, client-safe catalog-result relevance ranking — for
 * *display* only (sorting/filtering search results in MetadataSearchPanel),
 * never for automatic linking. Smart Auto-Link's own exact-match
 * comparison (`normalizeTitleForMatching`, src/lib/extension/auto-link.ts)
 * is completely separate from and untouched by this file — the two
 * intentionally never share code, because they answer different
 * questions with very different risk tolerances: "is this worth showing
 * the user as a possible match" tolerates false positives far better than
 * "is this safe to write to a LibraryItem automatically." No AI/LLM
 * involved — everything below is plain string comparison.
 *
 * The case/whitespace/quote-only normalization step mirrors that
 * function's own stated principle (fold away meaningless formatting
 * differences, never strip real words) — duplicated rather than imported
 * because that module is `server-only` and this one runs in the browser.
 */

export type TitleRelevance = "exact" | "close" | "unrelated";

function normalizeForComparison(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‒–—―]/g, "-")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

// Punctuation with no title-identity meaning for *ranking* purposes —
// deliberately more permissive than the exact-match comparison above,
// since display ranking can afford to fold "Whose Body?" down to "whose
// body" in a way an automatic-linking comparison never should.
function stripPunctuation(text: string): string {
  return text
    .replace(/['".,:;!?()[\]{}-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const VOLUME_SUFFIX_PATTERN = /\b(?:vol(?:ume)?|book|bk|part)\.?\s*\d+\b.*$/i;

/** Strips a trailing "Vol. 1" / "Volume 2" / "Book 3" / "Part 1" marker — books and light novels routinely have one, and it must never make a genuinely matching volume look unrelated (see calculateTitleRelevance's "exact" case). */
function stripVolumeSuffix(text: string): string {
  return text.replace(VOLUME_SUFFIX_PATTERN, "").trim();
}

const RELEVANCE_STOP_WORDS = new Set(["a", "an", "the"]);

function significantWords(text: string): string[] {
  return text.split(" ").filter((word) => word.length > 0 && !RELEVANCE_STOP_WORDS.has(word));
}

/** True if every word of `shorter` matches `longer` at the same leading positions, in order — handles a result that's the query plus trailing subtitle content ("Mushoku Tensei" -> "Mushoku Tensei: Jobless Reincarnation"), in either direction. */
function isOrderedPrefix(shorter: string[], longer: string[]): boolean {
  if (shorter.length === 0 || shorter.length > longer.length) return false;
  return shorter.every((word, index) => longer[index] === word);
}

/**
 * Ranks how likely `resultTitle` is to actually be the work `query` was
 * searching for.
 *   - "exact": identical after case/whitespace/quote normalization, or
 *     differs only by a trailing volume/book/part marker — the same work.
 *   - "close": one title's significant words are an ordered prefix of the
 *     other's (a missing/extra leading article, or a result with
 *     additional subtitle content after the query's words), or the two
 *     share enough of their combined vocabulary (Jaccard similarity ≥
 *     0.6) to plausibly be the same work.
 *   - "unrelated": everything else — sharing one incidental common word
 *     is not enough ("Lord Edgware Dies" vs. "Lord of the Mysteries" share
 *     "lord" and nothing else, and must not read as a likely match).
 */
export function calculateTitleRelevance(query: string, resultTitle: string): TitleRelevance {
  const normQuery = normalizeForComparison(query);
  const normResult = normalizeForComparison(resultTitle);
  if (normQuery === normResult) return "exact";

  const cleanQuery = stripPunctuation(normQuery);
  const cleanResult = stripPunctuation(normResult);

  const queryNoVolume = stripVolumeSuffix(cleanQuery);
  const resultNoVolume = stripVolumeSuffix(cleanResult);
  if (queryNoVolume === resultNoVolume) return "exact";

  const queryWords = significantWords(queryNoVolume);
  const resultWords = significantWords(resultNoVolume);
  if (queryWords.length === 0 || resultWords.length === 0) return "unrelated";

  if (isOrderedPrefix(queryWords, resultWords) || isOrderedPrefix(resultWords, queryWords)) {
    return "close";
  }

  const overlapCount = queryWords.filter((word) => resultWords.includes(word)).length;
  const unionSize = new Set([...queryWords, ...resultWords]).size;
  const jaccard = overlapCount / unionSize;
  return jaccard >= 0.6 ? "close" : "unrelated";
}

const RELEVANCE_RANK: Record<TitleRelevance, number> = { exact: 0, close: 1, unrelated: 2 };

/**
 * Splits and sorts search results by relevance to `query`: relevant
 * results (exact, then close) first in that order, unrelated results set
 * aside rather than presented as likely matches. Never drops a result
 * outright — the caller decides how (or whether) to surface the
 * `unrelated` set, e.g. behind a "Show more results" toggle. Has no
 * connection to and no effect on Smart Auto-Link.
 */
export function partitionByRelevance<T>(
  query: string,
  results: T[],
  getTitle: (item: T) => string,
): { relevant: T[]; unrelated: T[] } {
  const scored = results.map((result) => ({ result, relevance: calculateTitleRelevance(query, getTitle(result)) }));
  const relevant = scored
    .filter((entry) => entry.relevance !== "unrelated")
    .sort((a, b) => RELEVANCE_RANK[a.relevance] - RELEVANCE_RANK[b.relevance])
    .map((entry) => entry.result);
  const unrelated = scored.filter((entry) => entry.relevance === "unrelated").map((entry) => entry.result);
  return { relevant, unrelated };
}
