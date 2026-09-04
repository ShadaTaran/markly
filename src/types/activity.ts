import type { TrackingStatus } from "@/types/library-item";

/** What kind of progress a progress_updated event refers to — matches the personal tracking model per type. "season_episode" is Stage 25's season-relative variant of "episode" — see ProgressActivityEvent.previousSeason/newSeason. */
export type ProgressKind = "episode" | "chapter" | "page" | "percent" | "playtime" | "season_episode";

interface BaseActivityEvent {
  id: string;
  itemId: string;
  timestamp: string;
}

/** Present only for changes applied by something other than a direct in-app user action: an external-account sync (Stage 17), or the browser extension's auto-tracking (Stage 18). Absent means a normal in-app user action. */
export type ActivitySource = "anilist_sync" | "browser_extension";

export interface ProgressActivityEvent extends BaseActivityEvent {
  type: "progress_updated";
  progressKind: ProgressKind;
  previousValue?: number;
  newValue: number;
  /** Only present when progressKind === "season_episode" — the season previousValue/newValue's episode number belongs to. Every other progressKind never sets these. */
  previousSeason?: number;
  newSeason?: number;
  source?: ActivitySource;
}

export interface RatingActivityEvent extends BaseActivityEvent {
  type: "rating_updated";
  /** Absent newValue means the rating was cleared/removed. */
  previousValue?: number;
  newValue?: number;
  source?: ActivitySource;
}

export interface StatusActivityEvent extends BaseActivityEvent {
  type: "status_updated";
  previousValue?: TrackingStatus;
  newValue: TrackingStatus;
  source?: ActivitySource;
}

export interface ItemAddedActivityEvent extends BaseActivityEvent {
  type: "item_added";
}

export type ActivityEvent =
  | ProgressActivityEvent
  | RatingActivityEvent
  | StatusActivityEvent
  | ItemAddedActivityEvent;

export type ActivityEventType = ActivityEvent["type"];

type WithoutBase<T> = Omit<T, "id" | "timestamp">;

/** What callers pass to log an event — id/timestamp are assigned when it's actually recorded. */
export type ActivityEventInput =
  | WithoutBase<ProgressActivityEvent>
  | WithoutBase<RatingActivityEvent>
  | WithoutBase<StatusActivityEvent>
  | WithoutBase<ItemAddedActivityEvent>;
