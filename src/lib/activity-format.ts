import type { ActivityEvent, ProgressKind } from "@/types/activity";
import type { LibraryItem, MediaItem, TrackingStatus } from "@/types/library-item";
import { formatDate, isMediaItem } from "@/lib/item-detail";
import { STATUS_FILTER_LABELS, TRACKING_STATUS_OPTIONS } from "@/lib/tracking";

function getStatusLabelForType(itemType: MediaItem["type"], status: TrackingStatus): string {
  const match = TRACKING_STATUS_OPTIONS[itemType].find((option) => option.value === status);
  return match?.label ?? STATUS_FILTER_LABELS[status];
}

const PROGRESS_UNIT_LABELS: Record<Exclude<ProgressKind, "percent" | "playtime">, string> = {
  episode: "Episode",
  chapter: "Chapter",
  page: "Page",
};

/**
 * Short category line shown above the value change (e.g. "Rating changed",
 * "Chapter progress"). Returns undefined for item_added, which reads fine
 * as a single line with no separate category above it.
 */
export function getActivityLabel(event: ActivityEvent, item: LibraryItem | undefined): string | undefined {
  switch (event.type) {
    case "item_added":
      return undefined;
    case "rating_updated":
      return "Rating changed";
    case "status_updated":
      return "Status changed";
    case "progress_updated": {
      if (!item || !isMediaItem(item)) return "Progress updated";
      switch (item.type) {
        case "anime":
        case "series":
          return "Episode progress";
        case "manga":
          return "Chapter progress";
        case "novel":
          return "Reading progress";
        case "game":
          return "Playtime";
        case "movie":
          return "Progress updated";
      }
    }
  }
}

/**
 * The actual value-change line — never the generic "Progress changed from
 * X to Y" the app already knows more about, and never raw internal values
 * like "in_progress".
 */
export function getActivityDetail(event: ActivityEvent, item: LibraryItem | undefined): string {
  switch (event.type) {
    case "item_added":
      return "Added to library";

    case "rating_updated": {
      if (event.newValue === undefined) return "Rating removed";
      if (event.previousValue === undefined) return `${event.newValue} / 10`;
      return `${event.previousValue} → ${event.newValue}`;
    }

    case "status_updated": {
      if (!item || !isMediaItem(item)) return "Status updated";
      const newLabel = getStatusLabelForType(item.type, event.newValue);
      if (event.previousValue === undefined) return newLabel;
      const previousLabel = getStatusLabelForType(item.type, event.previousValue);
      return `${previousLabel} → ${newLabel}`;
    }

    case "progress_updated": {
      if (event.progressKind === "percent") {
        return event.previousValue !== undefined
          ? `${event.previousValue}% → ${event.newValue}%`
          : `${event.newValue}%`;
      }
      if (event.progressKind === "playtime") {
        return event.previousValue !== undefined
          ? `${event.previousValue}h → ${event.newValue}h`
          : `${event.newValue}h`;
      }
      const label = PROGRESS_UNIT_LABELS[event.progressKind];
      return event.previousValue !== undefined
        ? `${label} ${event.previousValue} → ${event.newValue}`
        : `${label} ${event.newValue}`;
    }
  }
}

/** Compact human-readable relative time — e.g. "3m ago", "2h ago", "Yesterday". */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);

  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;

  return formatDate(iso) ?? "";
}
