import type { TrackingDetection } from "../adapters/types";
import type { ProgressApiResult } from "../lib/api";

/**
 * The only messages that cross the content-script/service-worker
 * boundary. The content script only ever sends TRACKING_DETECTED — it
 * never receives the device token or calls the Markly API itself.
 */

export interface TrackingDetectedMessage {
  type: "TRACKING_DETECTED";
  detection: TrackingDetection;
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

export type ExtensionMessage =
  | TrackingDetectedMessage
  | GetTabStatusMessage
  | ConnectMessage
  | DisconnectMessage
  | GetPopupStateMessage;

export interface TabState {
  detection: TrackingDetection;
  result: ProgressApiResult;
}
