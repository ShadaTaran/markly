import type { MediaItem } from "@/types/library-item";
import type { ActivityEventInput, ProgressKind } from "@/types/activity";

interface ProgressSnapshot {
  kind: ProgressKind;
  value: number;
  /** Only present when kind === "season_episode". */
  season?: number;
}

/** The single personal-progress number for a media item, in its own unit — or undefined if unset. */
function getProgressSnapshot(item: MediaItem): ProgressSnapshot | undefined {
  switch (item.type) {
    case "anime":
    case "series":
      if (item.currentEpisode === undefined) return undefined;
      return item.episodeNumbering === "seasonal"
        ? { kind: "season_episode", value: item.currentEpisode, season: item.currentSeason }
        : { kind: "episode", value: item.currentEpisode };
    case "manga":
      return item.currentChapter !== undefined ? { kind: "chapter", value: item.currentChapter } : undefined;
    case "novel":
      return item.progressValue !== undefined
        ? { kind: item.progressUnit ?? "chapter", value: item.progressValue }
        : undefined;
    case "game":
      return item.playtimeHours !== undefined ? { kind: "playtime", value: item.playtimeHours } : undefined;
    case "movie":
      return undefined;
  }
}

/**
 * Compares a media item before/after a change (Edit form, quick action,
 * etc.) and returns the activity events that change actually represents —
 * only for fields that differ. Used by useLibraryItems so every mutation
 * path (full Edit, quick controls) reports activity consistently from one
 * place, rather than each call site re-deriving what changed.
 */
export function diffMediaTrackingEvents(
  itemId: string,
  before: MediaItem,
  after: MediaItem,
): ActivityEventInput[] {
  const events: ActivityEventInput[] = [];

  if (before.status !== after.status) {
    events.push({ type: "status_updated", itemId, previousValue: before.status, newValue: after.status });
  }

  if (before.rating !== after.rating) {
    events.push({ type: "rating_updated", itemId, previousValue: before.rating, newValue: after.rating });
  }

  const beforeProgress = getProgressSnapshot(before);
  const afterProgress = getProgressSnapshot(after);
  const progressChanged =
    afterProgress &&
    (!beforeProgress ||
      beforeProgress.kind !== afterProgress.kind ||
      beforeProgress.value !== afterProgress.value ||
      beforeProgress.season !== afterProgress.season);

  if (progressChanged && afterProgress) {
    events.push({
      type: "progress_updated",
      itemId,
      progressKind: afterProgress.kind,
      previousValue: beforeProgress?.value,
      newValue: afterProgress.value,
      ...(afterProgress.kind === "season_episode" && { previousSeason: beforeProgress?.season, newSeason: afterProgress.season }),
    });
  }

  return events;
}
