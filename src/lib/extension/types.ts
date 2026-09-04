import type { MediaItem } from "@/types/library-item";
import type { DetectedMetadata } from "@/lib/extension/detected-metadata";

/** What's safe to hand to the browser — the full tracking_sources row minus internal ids not needed for display/actions. */
export interface TrackingSourceSummary {
  id: string;
  adapterId: string;
  sourceTitle: string;
  sourceUrl: string | null;
  mediaType: MediaItem["type"];
  libraryItemId: string | null;
  autoTrackEnabled: boolean;
  lastDetectedProgress: { kind: string; value: number; season?: number; confirmed?: boolean } | null;
  /** Optional safe enrichment metadata from the most recent detection (see README "Metadata Enrichment") — stored alongside lastDetectedProgress in the same DB column, presented here as its own field. */
  lastDetectedMetadata?: DetectedMetadata;
  lastSeenAt: string;
}
