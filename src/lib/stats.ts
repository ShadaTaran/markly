import type { LibraryItem, MediaItem, SupportedItemType } from "@/types/library-item";
import { SUPPORTED_ITEM_TYPES } from "@/types/library-item";
import { isMediaItem } from "@/lib/item-detail";

/** Short plural labels for the Overview's per-type breakdown — distinct from ITEM_TYPE_LABELS, which are singular and used in forms/filters. */
export const OVERVIEW_TYPE_LABELS: Record<SupportedItemType, string> = {
  website: "Websites",
  anime: "Anime",
  manga: "Manga",
  novel: "Books",
  game: "Games",
  movie: "Movies",
  series: "Series",
};

export interface LibraryTypeCount {
  type: SupportedItemType;
  label: string;
  count: number;
}

/** Always lists every supported type, even at zero, so the breakdown doesn't jump around as the library grows. */
export function getLibraryTypeCounts(items: LibraryItem[]): LibraryTypeCount[] {
  return SUPPORTED_ITEM_TYPES.map((type) => ({
    type,
    label: OVERVIEW_TYPE_LABELS[type],
    count: items.filter((item) => item.type === type).length,
  }));
}

export interface CurrentlyTrackingCounts {
  watching: number;
  reading: number;
  playing: number;
}

/** Groups in_progress media by the verb that matches how the user thinks about it, not by raw type. */
export function getCurrentlyTrackingCounts(items: LibraryItem[]): CurrentlyTrackingCounts {
  const mediaItems = items.filter(isMediaItem);
  const countInProgress = (types: ReadonlyArray<MediaItem["type"]>) =>
    mediaItems.filter((item) => types.includes(item.type) && item.status === "in_progress").length;

  return {
    watching: countInProgress(["anime", "series"]),
    reading: countInProgress(["manga", "novel"]),
    playing: countInProgress(["game"]),
  };
}

