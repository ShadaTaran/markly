/**
 * Recognizes common chapter/episode URL path patterns:
 * /chapter-234, /chapter/234, /ch-234, /ch234, /c234
 * /episode-12,  /episode/12,  /ep-12,  /e12
 * (and their decimal-numbered forms — /chapter-12.5 — for manga split
 * releases; see MangaItem.currentChapter/verify-manga-tracking.mjs)
 *
 * Deliberately conservative: the bare single-letter forms (/c234, /e12)
 * require the digits to immediately follow the letter with no separator,
 * so an unrelated path segment doesn't accidentally match. Not every
 * number in a URL is progress — this only matches these specific,
 * well-known shapes, anchored to a path-segment boundary.
 */
export interface UrlProgressMatch {
  value: number;
  kind: "chapter" | "episode";
  /** The pathname with the matched segment removed — the basis for a stable per-work source key (see detect.ts). */
  strippedPath: string;
}

const NUMBER = "(\\d+(?:\\.\\d+)?)";

const CHAPTER_PATTERNS: RegExp[] = [
  new RegExp(`/chapter[-_/]?${NUMBER}(?=[/?#]|$)`, "i"),
  new RegExp(`/ch[-_/]?${NUMBER}(?=[/?#]|$)`, "i"),
  new RegExp(`/c${NUMBER}(?=[/?#]|$)`, "i"),
];

const EPISODE_PATTERNS: RegExp[] = [
  new RegExp(`/episode[-_/]?${NUMBER}(?=[/?#]|$)`, "i"),
  new RegExp(`/ep[-_/]?${NUMBER}(?=[/?#]|$)`, "i"),
  new RegExp(`/e${NUMBER}(?=[/?#]|$)`, "i"),
];

function tryPatterns(path: string, patterns: RegExp[], kind: "chapter" | "episode"): UrlProgressMatch | null {
  for (const pattern of patterns) {
    const match = path.match(pattern);
    if (!match || match.index === undefined) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    const strippedPath = path.slice(0, match.index).replace(/\/$/, "") || "/";
    return { value, kind, strippedPath };
  }
  return null;
}

export function extractFromUrl(url: URL): UrlProgressMatch | null {
  return tryPatterns(url.pathname, CHAPTER_PATTERNS, "chapter") ?? tryPatterns(url.pathname, EPISODE_PATTERNS, "episode");
}
