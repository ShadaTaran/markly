import type { MediaItem } from "@/types/library-item";

/** What's safe to hand to the browser — the full tracking_sources row minus internal ids not needed for display/actions. */
export interface TrackingSourceSummary {
  id: string;
  adapterId: string;
  sourceTitle: string;
  sourceUrl: string | null;
  mediaType: MediaItem["type"];
  libraryItemId: string | null;
  autoTrackEnabled: boolean;
  lastDetectedProgress: { kind: string; value: number } | null;
  lastSeenAt: string;
}
