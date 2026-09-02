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
  | GetTabStatusMessage
  | ConnectMessage
  | DisconnectMessage
  | GetPopupStateMessage
  | InjectNowMessage;

export interface TabState {
  detection: TrackingDetection | null;
  result: ProgressApiResult;
}
