import { extractMetadata, readMetaAuthor, readSiteIdentity } from "./metadata";
import type { UrlProgressMatch } from "./url";
import type { DetectedMetadata } from "../../adapters/types";

// DetectedMetadata itself lives in adapters/types.ts alongside
// TrackingDetection (the wire shape this becomes a field of) — this file
// only builds one, from the narrow set of structured signals documented
// there and in metadata.ts. Everything here comes from those signals,
// never the chapter's own text, comments, or any other page content.
// Every field is optional; a detection with none of them is exactly as
// valid as one with all of them (see Stage 21 — tracking never depends on
// this).

// Defense-in-depth bounds — the server independently re-validates all of
// this (see src/lib/extension/detected-metadata.ts); these just keep the
// extension from ever constructing an obviously oversized payload in the
// first place.
const MAX_URL_LENGTH = 2000;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_AUTHORS = 5;
const MAX_AUTHOR_LENGTH = 100;
const MAX_GENRES = 8;
const MAX_GENRE_LENGTH = 40;

function boundedHttpUrl(raw: string | null, baseUrl: URL): string | undefined {
  if (!raw) return undefined;
  try {
    const resolved = new URL(raw, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return undefined;
    const value = resolved.toString();
    return value.length > MAX_URL_LENGTH ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * Deterministic boilerplate filter — real sites frequently reuse an
 * auto-generated SEO description template ("Read {title} ... online ...
 * free ...") instead of a real synopsis; observed directly on a real site
 * (NovelPhoenix: "Read Chapter 52 - Spectator - Lord of the Mysteries
 * online for free" / "Read Lord of the Mysteries novel online free at
 * NovelPhoenix in Mobile, Tablet..."). A genuine synopsis essentially
 * never opens by addressing the reader with an imperative "Read ..." —
 * that's specifically what a reading site's own template does. No LLM,
 * no site-specific phrase list — just this one structural check.
 */
function isLikelyBoilerplateDescription(description: string): boolean {
  return /^read\b/i.test(description.trim());
}

function boundedDescription(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || isLikelyBoilerplateDescription(trimmed)) return undefined;
  return trimmed.length > MAX_DESCRIPTION_LENGTH ? trimmed.slice(0, MAX_DESCRIPTION_LENGTH) : trimmed;
}

function boundedAuthors(candidates: string[], siteIdentity: string | null): string[] | undefined {
  const seen = new Set<string>();
  const authors: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    // A site's own name showing up as the "author" (some sites fill
    // `<meta name="author">` with their own brand instead of omitting it
    // — observed directly on NovelPhoenix) is not a real author credit.
    if (siteIdentity && trimmed.toLowerCase() === siteIdentity.toLowerCase()) continue;
    const bounded = trimmed.length > MAX_AUTHOR_LENGTH ? trimmed.slice(0, MAX_AUTHOR_LENGTH) : trimmed;
    const key = bounded.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    authors.push(bounded);
    if (authors.length >= MAX_AUTHORS) break;
  }
  return authors.length > 0 ? authors : undefined;
}

function boundedGenres(candidates: string[]): string[] | undefined {
  const seen = new Set<string>();
  const genres: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const bounded = trimmed.length > MAX_GENRE_LENGTH ? trimmed.slice(0, MAX_GENRE_LENGTH) : trimmed;
    const key = bounded.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    genres.push(bounded);
    if (genres.length >= MAX_GENRES) break;
  }
  return genres.length > 0 ? genres : undefined;
}

export interface BuildDetectedMetadataOptions {
  /**
   * Stage 23 — an adapter-supplied work URL, used instead of deriving one
   * from urlMatch.strippedPath. Needed for sites like MangaDex whose
   * chapter URLs carry no path pattern url.ts recognizes at all (a chapter
   * UUID, not a numbered segment) but which do link to a real, stable work
   * URL elsewhere on the same page (see mangadex.ts) — still zero extra
   * network requests, just a different, equally real signal.
   */
  workUrlOverride?: string;
  /**
   * Stage 23 — false when the current page's og:image is known NOT to be
   * a stable per-work cover (observed on MangaDex: a chapter page's
   * og:image is generated per-chapter, e.g.
   * og.mangadex.org/og-image/chapter/<uuid>, distinct from the work page's
   * own og.mangadex.org/og-image/manga/<uuid> — extracting it here would
   * silently store the wrong, chapter-specific image as if it were the
   * series cover, and Stage 21's fill-once merge policy would then never
   * self-correct it). Defaults to true — every other site this reads
   * (NovelPhoenix included) uses the same og:image on chapter and work
   * pages alike, which is the common, safe case.
   */
  trustPageCover?: boolean;
}

/**
 * Builds the optional enrichment payload for a confident detection.
 * Returns undefined (not an empty object) when nothing safe/usable was
 * found, so a plain detection's wire payload is unchanged from before
 * Stage 21. Never required for tracking to work — see detect.ts, which
 * calls this only after a detection is already confirmed confident.
 */
export function buildDetectedMetadata(
  document: Document,
  url: URL,
  urlMatch: UrlProgressMatch | null,
  options?: BuildDetectedMetadataOptions,
): DetectedMetadata | undefined {
  const metadata = extractMetadata(document);
  const siteIdentity = readSiteIdentity(document);

  const workUrl = options?.workUrlOverride
    ? boundedHttpUrl(options.workUrlOverride, url)
    : urlMatch && urlMatch.strippedPath.length > 1
      ? boundedHttpUrl(`${url.origin}${urlMatch.strippedPath}`, url)
      : undefined;
  const coverUrl = options?.trustPageCover === false ? undefined : boundedHttpUrl(metadata.ogImage, url);
  const description = boundedDescription(metadata.description);
  const metaAuthor = readMetaAuthor(document);
  const authorCandidates = metadata.authors.length > 0 ? metadata.authors : metaAuthor ? [metaAuthor] : [];
  const authors = boundedAuthors(authorCandidates, siteIdentity);
  const genres = boundedGenres(metadata.genres);

  if (!workUrl && !coverUrl && !description && !authors && !genres) return undefined;

  return {
    ...(workUrl && { workUrl }),
    ...(coverUrl && { coverUrl }),
    ...(authors && { authors }),
    ...(description && { description }),
    ...(genres && { genres }),
  };
}
