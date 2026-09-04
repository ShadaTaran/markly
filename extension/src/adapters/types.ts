/**
 * A normalized progress observation — never arbitrary page content. Every
 * field here is exactly what the Markly API needs to identify a work and
 * a progress value; nothing else about the page is ever included.
 */
export interface TrackingProgress {
  kind: string;
  value: number;
  /**
   * Stage 25 — present only when kind === "season_episode": which season
   * `value` (the in-season episode number) belongs to. Every other kind
   * never sets this. Widens the existing shape rather than introducing a
   * parallel field, so every kind/value-only consumer written before
   * Stage 25 (popup formatting, service-worker dedup, etc.) keeps working
   * unchanged — only code that needs to distinguish "episode" from
   * "season_episode" has to know about `season` at all.
   */
  season?: number;
}

/**
 * True for both the absolute ("episode") and seasonal ("season_episode")
 * episode-progress kinds — the video completion pipeline
 * (tracking/video/completion.ts) applies identically to both; only how the
 * *value* is interpreted server-side differs (see progress.ts on the main
 * app side).
 */
export function isEpisodeProgressKind(kind: string): boolean {
  return kind === "episode" || kind === "season_episode";
}

export type TrackingMediaType = "anime" | "manga" | "novel" | "game" | "movie" | "series";

/**
 * Optional, safe enrichment metadata — see
 * tracking/universal/detected-metadata.ts for exactly what feeds this and
 * why each field is safe. Every field is optional; tracking never depends
 * on any of them being present. Never the chapter's own text.
 */
export interface DetectedMetadata {
  /** Stable work-page URL (chapter segment stripped), when derivable — never the chapter URL itself. */
  workUrl?: string;
  coverUrl?: string;
  authors?: string[];
  description?: string;
  genres?: string[];
}

export interface TrackingDetection {
  adapterId: string;
  /** Stable identity for the WORK (e.g. "lord-of-mysteries") — never the current chapter's URL, since that changes every chapter. */
  sourceKey: string;
  sourceUrl: string;
  sourceTitle: string;
  mediaType: TrackingMediaType;
  progress: TrackingProgress;
  /** Optional — see DetectedMetadata. Absent for the vast majority of adapters/pages, and that's fine. */
  detectedMetadata?: DetectedMetadata;
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
