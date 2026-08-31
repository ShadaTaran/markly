import type { TrackingStatus } from "@/types/library-item";

/** What kind of progress a progress_updated event refers to — matches the personal tracking model per type. */
export type ProgressKind = "episode" | "chapter" | "page" | "percent" | "playtime";

interface BaseActivityEvent {
  id: string;
  itemId: string;
  timestamp: string;
}

export interface ProgressActivityEvent extends BaseActivityEvent {
  type: "progress_updated";
  progressKind: ProgressKind;
  previousValue?: number;
  newValue: number;
}

export interface RatingActivityEvent extends BaseActivityEvent {
  type: "rating_updated";
  /** Absent newValue means the rating was cleared/removed. */
  previousValue?: number;
  newValue?: number;
}

export interface StatusActivityEvent extends BaseActivityEvent {
  type: "status_updated";
  previousValue?: TrackingStatus;
  newValue: TrackingStatus;
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
