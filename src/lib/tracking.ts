import type { LibraryItem, MediaItem, NovelProgressUnit, TrackingStatus } from "@/types/library-item";
import { ALL_FILTER } from "@/lib/constants";
import type { CategoryOption } from "@/lib/library-items";

export const TRACKING_STATUSES: readonly TrackingStatus[] = [
  "planned",
  "in_progress",
  "completed",
  "on_hold",
  "dropped",
];

/** Generic, type-agnostic labels used by the Status filter row. */
export const STATUS_FILTER_LABELS: Record<TrackingStatus, string> = {
  planned: "Planned",
  in_progress: "In Progress",
  completed: "Completed",
  on_hold: "On Hold",
  dropped: "Dropped",
};

/**
 * Per-type status menus. Each type exposes only the statuses that make
 * sense for it (Movie is just planned/completed) with a type-appropriate
 * label, while all types share the same underlying TrackingStatus values.
 */
export const TRACKING_STATUS_OPTIONS: Record<
  MediaItem["type"],
  { value: TrackingStatus; label: string }[]
> = {
  anime: [
    { value: "planned", label: "Want to Watch" },
    { value: "in_progress", label: "Watching" },
    { value: "completed", label: "Completed" },
    { value: "on_hold", label: "On Hold" },
    { value: "dropped", label: "Dropped" },
  ],
  series: [
    { value: "planned", label: "Want to Watch" },
    { value: "in_progress", label: "Watching" },
    { value: "completed", label: "Completed" },
    { value: "on_hold", label: "On Hold" },
    { value: "dropped", label: "Dropped" },
  ],
  manga: [
    { value: "planned", label: "Want to Read" },
    { value: "in_progress", label: "Reading" },
    { value: "completed", label: "Completed" },
    { value: "on_hold", label: "On Hold" },
    { value: "dropped", label: "Dropped" },
  ],
  novel: [
    { value: "planned", label: "Want to Read" },
    { value: "in_progress", label: "Reading" },
    { value: "completed", label: "Completed" },
    { value: "on_hold", label: "On Hold" },
    { value: "dropped", label: "Dropped" },
  ],
  game: [
    { value: "planned", label: "Want to Play" },
    { value: "in_progress", label: "Playing" },
    { value: "completed", label: "Completed" },
    { value: "on_hold", label: "On Hold" },
    { value: "dropped", label: "Dropped" },
  ],
  movie: [
    { value: "planned", label: "Want to Watch" },
    { value: "completed", label: "Watched" },
  ],
};

export function getStatusLabel(item: MediaItem): string {
  const match = TRACKING_STATUS_OPTIONS[item.type].find((option) => option.value === item.status);
  return match?.label ?? STATUS_FILTER_LABELS[item.status];
}

export interface ProgressInfo {
  text: string;
  /** 0-100, present only when both a current and total value are known. */
  percent?: number;
}

/** Builds the card's progress line for a media item, or null if nothing to show. */
export function getProgressInfo(item: MediaItem): ProgressInfo | null {
  switch (item.type) {
    case "anime":
    case "series": {
      if (item.currentEpisode === undefined && item.totalEpisodes === undefined) return null;
      const current = item.currentEpisode ?? 0;
      if (item.totalEpisodes !== undefined) {
        return {
          text: `${current} / ${item.totalEpisodes} episodes`,
          percent: Math.min(100, (current / item.totalEpisodes) * 100),
        };
      }
      return { text: `${current} episode${current === 1 ? "" : "s"}` };
    }
    case "manga": {
      if (item.currentChapter === undefined && item.totalChapters === undefined) return null;
      const current = item.currentChapter ?? 0;
      if (item.totalChapters !== undefined) {
        return {
          text: `${current} / ${item.totalChapters} chapters`,
          percent: Math.min(100, (current / item.totalChapters) * 100),
        };
      }
      return { text: `Chapter ${current}` };
    }
    case "novel": {
      if (item.progressValue === undefined) return null;
      const unit: NovelProgressUnit = item.progressUnit ?? "chapter";
      if (unit === "percent") return { text: `${item.progressValue}%` };
      if (unit === "page") return { text: `Page ${item.progressValue}` };
      return { text: `Chapter ${item.progressValue}` };
    }
    case "game": {
      if (item.playtimeHours === undefined) return null;
      return { text: `${item.playtimeHours} hour${item.playtimeHours === 1 ? "" : "s"}` };
    }
    case "movie":
      return null;
  }
}

export interface QuickIncrementInfo {
  unitLabel: "episode" | "chapter";
  atMax: boolean;
}

/**
 * Only anime/series episodes and manga chapters support a safe "+1" quick
 * action (a single, unambiguous unit of progress with a known total to cap
 * against). Returns null for every other type, which hides the control.
 */
export function getQuickIncrementInfo(item: MediaItem): QuickIncrementInfo | null {
  switch (item.type) {
    case "anime":
    case "series": {
      const current = item.currentEpisode ?? 0;
      return { unitLabel: "episode", atMax: item.totalEpisodes !== undefined && current >= item.totalEpisodes };
    }
    case "manga": {
      const current = item.currentChapter ?? 0;
      return { unitLabel: "chapter", atMax: item.totalChapters !== undefined && current >= item.totalChapters };
    }
    default:
      return null;
  }
}

export type StatusFilterValue = TrackingStatus | typeof ALL_FILTER;

/**
 * Status filter options are a small fixed set, always listed even at a
 * count of zero (mirrors getItemTypeOptions). Counts only ever include
 * trackable (media) items — Website items never have a status.
 */
export function getStatusOptions(items: LibraryItem[]): CategoryOption[] {
  return [
    { id: ALL_FILTER, label: "All", count: items.length },
    ...TRACKING_STATUSES.map((status) => ({
      id: status,
      label: STATUS_FILTER_LABELS[status],
      count: items.filter((item) => "status" in item && item.status === status).length,
    })),
  ];
}

function roundToHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

/** Rating is optional, 1-10, in halves. Returns undefined if out of range. */
export function normalizeRating(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 1 || value > 10) return undefined;
  return roundToHalf(value);
}

export function normalizeStatus(value: unknown): TrackingStatus {
  return typeof value === "string" && (TRACKING_STATUSES as readonly string[]).includes(value)
    ? (value as TrackingStatus)
    : "planned";
}

export function normalizeNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

export function normalizePositiveInt(value: unknown): number | undefined {
  const normalized = normalizeNonNegativeInt(value);
  return normalized !== undefined && normalized > 0 ? normalized : undefined;
}

export function normalizeNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

export function normalizePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 100) return undefined;
  return value;
}

export function normalizeProgressUnit(value: unknown): NovelProgressUnit | undefined {
  return value === "chapter" || value === "page" || value === "percent" ? value : undefined;
}
