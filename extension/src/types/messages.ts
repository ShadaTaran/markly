import type { TrackingDetection } from "../adapters/types";
import type { ProgressApiResult } from "../lib/api";

/**
 * The only messages that cross the content-script/service-worker
 * boundary. The content script only ever sends TRACKING_DETECTED — it
 * never receives the device token or calls the Markly API itself.
 */

/**
 * `detection` is null when the content script ran (the page was in
 * scope) but neither an adapter nor universal detection could
 * confidently identify progress on this specific page — reported so the
 * popup can distinguish that from "this page was never in scope at all"
 * (see popup.ts's low_confidence state). A null detection never reaches
 * the Markly API; this message stays entirely local to the extension.
 */
export interface TrackingDetectedMessage {
  type: "TRACKING_DETECTED";
  detection: TrackingDetection | null;
  /**
   * Stage 24 — false only for a video "episode detected, not yet watched
   * enough" discovery ping (see tracking/video/completion.ts and README
   * "Episode/Video Tracking"). Absent or true means "commit this value as
   * progress immediately," the unchanged behavior every reading-media
   * (chapter-kind) detection has always used since Stage 18.
   */
  commit?: boolean;
}

/**
 * Stage 24 — content-script-to-service-worker only, purely local: the
 * current watch ratio (0-1) for an episode still being observed, so the
 * popup can show a live "Watching · N%" without any network request to
 * Markly. Never forwarded to the API; see completion.ts's own doc comment
 * for exactly what this is and isn't used for.
 */
export interface WatchProgressUpdateMessage {
  type: "WATCH_PROGRESS_UPDATE";
  sourceKey: string;
  ratio: number;
}

/**
 * Stage 24 bugfix — content-script-to-service-worker only, purely local:
 * reports the state of the bounded, event-driven search for a primary
 * video (tracking/video/completion.ts's discoverPrimaryVideo) so the
 * popup can show a brief "Finding video player…" during a normal async-
 * mount settling window, distinct from the final "completion tracking
 * unavailable" it should show only once that search has genuinely timed
 * out. "found" clears the searching state immediately, without waiting
 * for the first (throttled, ~1s) WATCH_PROGRESS_UPDATE to arrive.
 */
export interface PlayerStatusUpdateMessage {
  type: "PLAYER_STATUS_UPDATE";
  sourceKey: string;
  status: "searching" | "unavailable" | "found";
}

export interface GetTabStatusMessage {
  type: "GET_TAB_STATUS";
  tabId: number;
}

export interface ConnectMessage {
  type: "CONNECT";
  code: string;
}

export interface DisconnectMessage {
  type: "DISCONNECT";
}

export interface GetPopupStateMessage {
  type: "GET_POPUP_STATE";
}

/** Sent by the popup right after chrome.permissions.request() succeeds for a tab's origin — the tab already finished loading before the grant existed, so chrome.tabs.onUpdated won't fire again on its own; this triggers the same injection immediately instead of waiting for the next navigation. */
export interface InjectNowMessage {
  type: "INJECT_NOW";
  tabId: number;
}

export type ExtensionMessage =
  | TrackingDetectedMessage
  | WatchProgressUpdateMessage
  | PlayerStatusUpdateMessage
  | GetTabStatusMessage
  | ConnectMessage
  | DisconnectMessage
  | GetPopupStateMessage
  | InjectNowMessage;

export interface TabState {
  detection: TrackingDetection | null;
  result: ProgressApiResult;
  /** Stage 24 — local-only current watch ratio (0-1) for an episode-kind detection still being observed; never sent to Markly, and absent once completion has been sent or for non-video detections. */
  watchRatio?: number;
  /** Stage 24 bugfix — "searching" during the bounded player-discovery window, "unavailable" once it's genuinely exhausted. Absent once a video is found (watchRatio takes over) or for non-video detections. */
  playerStatus?: "searching" | "unavailable";
}
