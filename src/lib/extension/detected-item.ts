import type { MediaItem, MediaItemInput, NovelProgressUnit, TrackingStatus } from "@/types/library-item";
import { TRACKING_STATUS_OPTIONS } from "@/lib/tracking";
import type { PersonalTrackingValues } from "@/components/CatalogTrackingForm";
import type { TrackingSourceSummary } from "@/lib/extension/types";

/**
 * Builds LibraryItem/tracking values directly from what the browser
 * extension already detected — the "no catalog match" fallback (see
 * README "Add or Link"). Deliberately reuses only fields
 * TrackingSourceSummary already exposes (sourceTitle, sourceUrl,
 * mediaType, lastDetectedProgress) — nothing here requires the extension
 * to collect or send anything new.
 */

type DetectedProgress = TrackingSourceSummary["lastDetectedProgress"];

function normalizeDetectedProgressUnit(kind: string | undefined): NovelProgressUnit {
  return kind === "page" || kind === "percent" ? kind : "chapter";
}

/** A type that supports "in_progress" gets it (this is an explicit "I'm reading/watching this now" action, not an inferred one); the couple of types that don't (movie) fall back to "planned" rather than an invalid status. */
function initialStatusFor(mediaType: MediaItem["type"]): TrackingStatus {
  return TRACKING_STATUS_OPTIONS[mediaType].some((option) => option.value === "in_progress") ? "in_progress" : "planned";
}

/** Maps detected progress onto whichever tracking fields the given media type actually has — used to prefill CatalogTrackingForm's `initial` when a catalog result IS selected, so the detected progress isn't lost/reset to blank (see README "Add or Link"). */
export function buildDetectedTrackingValues(mediaType: MediaItem["type"], progress: DetectedProgress): Partial<PersonalTrackingValues> {
  if (!progress) return {};
  switch (mediaType) {
    case "anime":
    case "series":
      return progress.kind === "episode" ? { currentEpisode: progress.value } : {};
    case "manga":
      return progress.kind === "chapter" ? { currentChapter: progress.value } : {};
    case "novel":
      return { progressValue: progress.value, progressUnit: normalizeDetectedProgressUnit(progress.kind) };
    case "game":
      return progress.kind === "playtime" ? { playtimeHours: progress.value } : {};
    case "movie":
      return {};
  }
}

/** Full MediaItemInput for the one-click "Add & Track" path — no catalog data at all, just the detected title/progress/source. */
export function buildDetectedMediaInput(source: TrackingSourceSummary): MediaItemInput {
  const common = {
    title: source.sourceTitle,
    description: "",
    category: "",
    tags: [] as string[],
    imageUrl: undefined,
    sourceUrl: source.sourceUrl ?? undefined,
    status: initialStatusFor(source.mediaType),
    rating: undefined,
    releaseYear: undefined,
    catalogSource: undefined,
  };
  const progress = source.lastDetectedProgress;

  switch (source.mediaType) {
    case "anime":
      return {
        ...common,
        currentEpisode: progress?.kind === "episode" ? progress.value : undefined,
        totalEpisodes: undefined,
        genres: undefined,
        studio: undefined,
      };
    case "series":
      return {
        ...common,
        currentEpisode: progress?.kind === "episode" ? progress.value : undefined,
        totalEpisodes: undefined,
        genres: undefined,
      };
    case "manga":
      return {
        ...common,
        currentChapter: progress?.kind === "chapter" ? progress.value : undefined,
        totalChapters: undefined,
        genres: undefined,
        authors: undefined,
      };
    case "novel":
      return {
        ...common,
        progressValue: progress?.value,
        progressUnit: normalizeDetectedProgressUnit(progress?.kind),
        authors: undefined,
        pageCount: undefined,
        // Suggestion, not fact — a chapter-based reader with no catalog
        // match is *usually* a web novel, but this is always editable
        // (Edit Details) and never presented as a verified attribute.
        readingFormat: "web_novel",
      };
    case "game":
      return {
        ...common,
        platform: undefined,
        playtimeHours: progress?.kind === "playtime" ? progress.value : undefined,
        developer: undefined,
        publisher: undefined,
        catalogPlatforms: undefined,
      };
    case "movie":
      return { ...common, genres: undefined };
  }
}
