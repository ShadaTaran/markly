import type { MediaItem, MediaItemInput, NovelProgressUnit, TrackingStatus } from "@/types/library-item";
import { TRACKING_STATUS_OPTIONS } from "@/lib/tracking";
import type { PersonalTrackingValues } from "@/components/CatalogTrackingForm";
import type { TrackingSourceSummary } from "@/lib/extension/types";

/**
 * Builds LibraryItem/tracking values directly from what the browser
 * extension already detected — the "no catalog match" fallback (see
 * README "Add or Link"). Reuses TrackingSourceSummary's own fields
 * (sourceTitle, sourceUrl, mediaType, lastDetectedProgress, and — since
 * Stage 21 — lastDetectedMetadata for cover/author/description/genres/
 * a stable work URL). All of it optional; a source with none of
 * lastDetectedMetadata's fields builds exactly the same sparse item Stage
 * 20 always did.
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

/** Full MediaItemInput for the one-click "Add & Track" path — enriched with lastDetectedMetadata when available, but never dependent on it (see module doc comment). */
export function buildDetectedMediaInput(source: TrackingSourceSummary): MediaItemInput {
  const metadata = source.lastDetectedMetadata;
  const common = {
    title: source.sourceTitle,
    description: metadata?.description ?? "",
    category: "",
    tags: [] as string[],
    // Prefer the stable work URL Stage 21 may have derived over the
    // current chapter's URL — the chapter URL is still a reasonable
    // fallback (better than nothing), it's just not the page a "view
    // source" action should ideally land on months later.
    sourceUrl: metadata?.workUrl ?? source.sourceUrl ?? undefined,
    imageUrl: metadata?.coverUrl,
    status: initialStatusFor(source.mediaType),
    rating: undefined,
    releaseYear: undefined,
    catalogSource: undefined,
  };
  const progress = source.lastDetectedProgress;
  // Stage 24: opening an episode's page is identification, not proof of
  // having watched it — unlike a chapter, where reading the page *is* the
  // progress. A discovery-only detection (confirmed === false, set only
  // by the video completion-observer's initial "episode detected" ping —
  // see README "Episode/Video Tracking") never bakes an unwatched episode
  // number into a newly created item; committed progress only ever
  // arrives later, through the normal monotonic progress endpoint once
  // the completion threshold is actually reached.
  const confirmedEpisode = progress?.kind === "episode" && progress.confirmed !== false ? progress.value : undefined;

  switch (source.mediaType) {
    case "anime":
      return {
        ...common,
        currentEpisode: confirmedEpisode,
        totalEpisodes: undefined,
        genres: metadata?.genres,
        studio: undefined,
      };
    case "series":
      return {
        ...common,
        currentEpisode: confirmedEpisode,
        totalEpisodes: undefined,
        genres: metadata?.genres,
      };
    case "manga":
      return {
        ...common,
        currentChapter: progress?.kind === "chapter" ? progress.value : undefined,
        totalChapters: undefined,
        genres: metadata?.genres,
        authors: metadata?.authors,
      };
    case "novel":
      return {
        ...common,
        progressValue: progress?.value,
        progressUnit: normalizeDetectedProgressUnit(progress?.kind),
        authors: metadata?.authors,
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
      return { ...common, genres: metadata?.genres };
  }
}
