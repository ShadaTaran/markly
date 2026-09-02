import { extractFromUrl } from "./url";
import { extractFromHeadings } from "./headings";
import { parseProgressText } from "./progress";
import { extractMetadata } from "./metadata";
import { extractNavigation } from "./navigation";
import { scoreSignals } from "./confidence";
import type { TrackingDetection, TrackingMediaType } from "../../adapters/types";

/**
 * Distinct from any site-specific adapter's id, so the backend (and
 * Settings UI) can always tell a universal detection apart from an
 * adapter-produced one if it's ever useful to — though the API contract
 * itself does not care which produced a given detection.
 */
export const UNIVERSAL_DETECTOR_ID = "universal-reader";

function mediaTypeForKind(kind: "chapter" | "episode"): TrackingMediaType {
  // Universal detection can tell "chapter" from "episode" but not, from
  // generic page structure alone, manga from novel or anime from series
  // — that disambiguation is exactly what a site-specific adapter is for
  // (see extension/README.md). novel/anime are the closest safe defaults.
  return kind === "chapter" ? "novel" : "anime";
}

/** Strips a leading/trailing "Chapter 234 -"/"- Chapter 234" style fragment, leaving just the work title. */
function stripProgressFragment(text: string): string {
  return text
    .replace(/[-|:–—]\s*(ch(?:apter)?|ep(?:isode)?)\.?\s*\d+\s*$/i, "")
    .replace(/^(ch(?:apter)?|ep(?:isode)?)\.?\s*\d+\s*[-|:–—]\s*/i, "")
    .trim();
}

function deriveWorkTitle(document: Document, metadata: ReturnType<typeof extractMetadata>): string | null {
  const candidate = metadata.ogTitle ?? metadata.jsonLdName ?? document.querySelector("h1")?.textContent ?? document.title;
  if (!candidate) return null;
  const stripped = stripProgressFragment(candidate);
  return stripped.length > 0 ? stripped : null;
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

  return {
    adapterId: UNIVERSAL_DETECTOR_ID,
    sourceKey: deriveSourceKey(url, urlMatch, workTitle),
    sourceUrl: url.toString(),
    sourceTitle: workTitle,
    mediaType: mediaTypeForKind(result.kind),
    progress: { kind: result.kind, value: result.value },
  };
}
