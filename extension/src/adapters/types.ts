/**
 * A normalized progress observation — never arbitrary page content. Every
 * field here is exactly what the Markly API needs to identify a work and
 * a progress value; nothing else about the page is ever included.
 */
export interface TrackingProgress {
  kind: string;
  value: number;
}

export type TrackingMediaType = "anime" | "manga" | "novel" | "game" | "movie" | "series";

export interface TrackingDetection {
  adapterId: string;
  /** Stable identity for the WORK (e.g. "lord-of-mysteries") — never the current chapter's URL, since that changes every chapter. */
  sourceKey: string;
  sourceUrl: string;
  sourceTitle: string;
  mediaType: TrackingMediaType;
  progress: TrackingProgress;
}

/**
 * One supported site. `matches` decides whether this adapter applies to a
 * URL at all (checked before any script runs); `detect` reads only the
 * DOM elements it needs and returns null when the expected structure
 * isn't present — it must never guess.
 */
export interface TrackingAdapter {
  id: string;
  displayName: string;
  matches(url: URL): boolean;
  detect(document: Document, url: URL): TrackingDetection | null;
}
