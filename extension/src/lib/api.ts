import { MARKLY_BASE_URL } from "./config";
import type { TrackingDetection } from "../adapters/types";

/**
 * All network calls to Markly live here, and this module is imported
 * only by the service worker — never the content script, which never
 * sees the device token and never talks to Markly directly.
 */

export type PairResult = { ok: true; token: string } | { ok: false; error: string };

export async function pairDevice(code: string): Promise<PairResult> {
  try {
    const response = await fetch(`${MARKLY_BASE_URL}/api/extension/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        browser: "chrome",
        extensionVersion: chrome.runtime.getManifest().version,
      }),
    });
    const data = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!response.ok || typeof data.token !== "string") {
      return { ok: false, error: data.error ?? "pairing_failed" };
    }
    return { ok: true, token: data.token };
  } catch {
    return { ok: false, error: "network_error" };
  }
}

export type ProgressApiStatus =
  | "updated"
  | "unchanged"
  | "behind_current_progress"
  | "needs_link"
  | "tracking_disabled"
  | "incompatible_media_type"
  | "item_not_found"
  | "unauthorized"
  | "error"
  // Extension-local only — the server never returns this. Set by the
  // service worker when the content script ran but neither an adapter
  // nor universal detection could confidently identify progress; no API
  // call is ever made for this case.
  | "low_confidence";

/** Only meaningful when status is "needs_link" — distinguishes "multiple possible items" from "nothing matches yet" so the popup can show the right copy (see popup.ts). */
export type NeedsLinkReason = "ambiguous" | "no_match";

export interface ProgressApiResult {
  status: ProgressApiStatus;
  currentValue?: number;
  /** True only on the exact request that just created a smart auto-link — never set again for later chapters from the same (now-linked) source. */
  autoLinked?: boolean;
  reason?: NeedsLinkReason;
}

export async function submitProgress(token: string, detection: TrackingDetection): Promise<ProgressApiResult> {
  try {
    const response = await fetch(`${MARKLY_BASE_URL}/api/extension/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(detection),
    });

    if (response.status === 401) return { status: "unauthorized" };

    const data = (await response.json().catch(() => ({}))) as {
      status?: ProgressApiStatus;
      currentValue?: number;
      autoLinked?: boolean;
      reason?: NeedsLinkReason;
    };
    if (!response.ok || !data.status) return { status: "error" };
    return { status: data.status, currentValue: data.currentValue, autoLinked: data.autoLinked, reason: data.reason };
  } catch {
    return { status: "error" };
  }
}
