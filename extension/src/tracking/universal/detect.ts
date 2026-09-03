import { extractFromUrl } from "./url";
import { extractFromHeadings } from "./headings";
import { parseProgressText } from "./progress";
import { extractMetadata } from "./metadata";
import { extractNavigation } from "./navigation";
import { scoreSignals } from "./confidence";
import { buildDetectedMetadata } from "./detected-metadata";
import { siteMediaCapability } from "./site-capability";
import type { TrackingDetection, TrackingMediaType } from "../../adapters/types";

/**
 * Distinct from any site-specific adapter's id, so the backend (and
 * Settings UI) can always tell a universal detection apart from an
 * adapter-produced one if it's ever useful to — though the API contract
 * itself does not care which produced a given detection.
 */
export const UNIVERSAL_DETECTOR_ID = "universal-reader";

function mediaTypeForKind(kind: "chapter" | "episode", hostname: string): TrackingMediaType {
  // Universal detection can tell "chapter" from "episode" but not, from
  // generic page structure alone, manga from novel or anime from series —
  // no safe generic DOM signal distinguishes them (see site-capability.ts
  // for why "many <img> tags" or similar page-structure guessing is
  // deliberately not used). The tiny site-capability registry resolves
  // this for the small number of sites we have real evidence about;
  // everything else falls back to novel/anime, the same defaults as
  // before Stage 23.
  if (kind === "episode") return "anime";
  return siteMediaCapability(hostname) === "manga" ? "manga" : "novel";
}

const TITLE_SEGMENT_SEPARATOR = /\s+[-|:–—]\s+/;
const INLINE_PROGRESS_PATTERN = /\bch(?:apter)?\.?\s*\d+\b|\bep(?:isode)?\.?\s*\d+\b/i;

function findInlineProgressMatch(segment: string): RegExpMatchArray | null {
  return segment.match(INLINE_PROGRESS_PATTERN);
}

/**
 * Isolates the work title out of a page label that also carries the
 * chapter/episode marker and often a site name and/or a chapter-specific
 * name too — real sites rarely label a page with just the work title.
 * Observed on real reader sites (see extension/README.md "Real-world
 * title shapes"), e.g.:
 *   "Lord of the Mysteries - Chapter 1 - Crimson - Novel Phoenix"
 *     -> "Lord of the Mysteries"
 *   "Chapter 234 | Lord of Mysteries"
 *     -> "Lord of Mysteries"
 *   "Lord of Mysteries Ch. 234"
 *     -> "Lord of Mysteries"
 *
 * Splits on common label separators (" - ", " | ", " : ", en/em dash) and
 * finds the first segment that actually contains a chapter/episode
 * marker: everything before that marker (within its segment, plus any
 * earlier segments) is the work title; if the marker leads with nothing
 * before it, the title is instead whatever segment comes right after.
 * Segments after the marker (a chapter's own name, the site's name) are
 * simply dropped. A segment or trailing number that does NOT itself match
 * a chapter/episode pattern is never touched, so "Lord of Mysteries 2" is
 * never confused with a progress marker.
 */
function extractWorkTitleFromLabel(text: string): string {
  const segments = text.split(TITLE_SEGMENT_SEPARATOR);

  for (let i = 0; i < segments.length; i++) {
    const match = findInlineProgressMatch(segments[i]);
    if (!match || match.index === undefined) continue;

    const before = segments[i].slice(0, match.index).trim();
    if (before.length > 0) {
      return [...segments.slice(0, i), before].join(" - ").trim();
    }
    if (i === 0) {
      // The marker leads with nothing before it, and it's the very first
      // segment — e.g. "Chapter 235 - Lord of Mysteries - Site". The real
      // title is whatever comes right after it.
      return (segments[i + 1] ?? "").trim();
    }
    // The marker is its own segment with real title text earlier.
    return segments.slice(0, i).join(" - ").trim();
  }

  return text.trim();
}

/** Exported for reuse by adapters whose own markup defeats generic confidence extraction but still benefits from the same title-isolation logic (see mangadex.ts) — never reimplemented per-adapter. */
export function deriveWorkTitle(document: Document, metadata: ReturnType<typeof extractMetadata>): string | null {
  const candidate = metadata.ogTitle ?? metadata.jsonLdName ?? document.querySelector("h1")?.textContent ?? document.title;
  if (!candidate) return null;
  const extracted = extractWorkTitleFromLabel(candidate);
  return extracted.length > 0 ? extracted : null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

/**
 * Stable per-work identity — never the current chapter's URL, which
 * changes every chapter. Prefers the URL with its matched progress
 * segment stripped (e.g. "/novel/lord-of-mysteries/chapter-234" →
 * "example.com/novel/lord-of-mysteries"); falls back to origin + slugified
 * work title when the URL alone isn't distinctive enough.
 */
function deriveSourceKey(url: URL, urlMatch: ReturnType<typeof extractFromUrl>, workTitle: string): string {
  if (urlMatch && urlMatch.strippedPath.length > 1) {
    return `${url.hostname}${urlMatch.strippedPath}`;
  }
  return `${url.hostname}::${slugify(workTitle)}`;
}

/**
 * The universal detection engine: examines a fixed, bounded set of page
 * signals (URL shape, h1/h2 text, document.title, og:title/JSON-LD name,
 * previous/next navigation), scores their agreement (see confidence.ts),
 * and returns a normalized TrackingDetection only when confident — never
 * a guess. Returns null whenever the signals don't clearly agree, or when
 * no usable work title can be derived to anchor a source identity on.
 */
export function detectUniversal(document: Document, url: URL): TrackingDetection | null {
  const urlMatch = extractFromUrl(url);
  const headingMatch = extractFromHeadings(document);
  const titleMatch = parseProgressText(document.title);
  const metadata = extractMetadata(document);
  const metadataMatch = parseProgressText(metadata.ogTitle) ?? parseProgressText(metadata.jsonLdName);
  const navigation = extractNavigation(document, url);

  const result = scoreSignals({ url: urlMatch, heading: headingMatch, title: titleMatch, metadata: metadataMatch, navigation });
  if (!result.confident || result.value === null || result.kind === null) {
    return null;
  }

  const workTitle = deriveWorkTitle(document, metadata);
  if (!workTitle) return null;

  // Enrichment is best-effort and strictly additive — computed only after
  // the detection itself is already confirmed confident, and its absence
  // never affects the detection above in any way (see detected-metadata.ts).
  const detectedMetadata = buildDetectedMetadata(document, url, urlMatch);

  return {
    adapterId: UNIVERSAL_DETECTOR_ID,
    sourceKey: deriveSourceKey(url, urlMatch, workTitle),
    sourceUrl: url.toString(),
    sourceTitle: workTitle,
    mediaType: mediaTypeForKind(result.kind, url.hostname),
    progress: { kind: result.kind, value: result.value },
    ...(detectedMetadata && { detectedMetadata }),
  };
}
