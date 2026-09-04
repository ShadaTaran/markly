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
  // Stage 25 — only ever returned for a season_episode-kind commit: this
  // item's existing numbering is (explicitly or implicitly) absolute, so
  // the seasonal write was refused rather than silently reinterpreting it
  // — see src/lib/extension/progress.ts's applySeasonEpisodeProgress.
  | "numbering_mismatch"
  | "unauthorized"
  // Stage 24 — a discovery-only (commitProgress: false) request succeeded:
  // identity/Smart Auto-Link/Auto-Add ran, but no progress was committed.
  // The server never returns this for a commitProgress-true request.
  | "detected"
  // Extension-local only, set by submitProgress itself — the fetch never
  // completed (offline, DNS failure, Markly not running). Distinct from
  // "server_error" below: here, nothing about Markly's own state is known
  // one way or the other.
  | "error"
  // Extension-local only — the request reached Markly and got a real HTTP
  // response, but a non-2xx one (e.g. the 502 tracking_failed the server
  // returns for an unexpected internal error). Markly *was* reachable;
  // this specific update just didn't go through — distinct copy from
  // "error" so the popup doesn't claim Markly is unreachable when it
  // demonstrably just answered.
  | "server_error"
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
  /** Stage 25 — only ever set for a season_episode-kind response; see ProgressApiStatus's numbering_mismatch note. */
  currentSeason?: number;
  currentEpisode?: number;
  /** True only on the exact request that just created a smart auto-link (Stage 18) OR a Stage 22 auto-add that found an exact match once its advisory lock resolved — never set again for later chapters from the same (now-linked) source. */
  autoLinked?: boolean;
  /** Stage 22 — true only on the exact request that just auto-created the LibraryItem itself (never re-set for later chapters). Mutually exclusive with autoLinked: a given response is never both, since a source is either newly created or newly linked to something that already existed. */
  autoAdded?: boolean;
  reason?: NeedsLinkReason;
}

/** `commit` defaults to true — every reading-media (chapter-kind) call site omits it entirely, unchanged since Stage 18. Only the video completion-observer ever passes `false` (see content-script.ts). */
export async function submitProgress(token: string, detection: TrackingDetection, commit = true): Promise<ProgressApiResult> {
  try {
    const response = await fetch(`${MARKLY_BASE_URL}/api/extension/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...detection, commitProgress: commit }),
    });

    if (response.status === 401) return { status: "unauthorized" };

    const data = (await response.json().catch(() => ({}))) as {
      status?: ProgressApiStatus;
      currentValue?: number;
      currentSeason?: number;
      currentEpisode?: number;
      autoLinked?: boolean;
      autoAdded?: boolean;
      reason?: NeedsLinkReason;
    };
    if (!response.ok) return { status: "server_error" };
    if (!data.status) return { status: "error" };
    return {
      status: data.status,
      currentValue: data.currentValue,
      currentSeason: data.currentSeason,
      currentEpisode: data.currentEpisode,
      autoLinked: data.autoLinked,
      autoAdded: data.autoAdded,
      reason: data.reason,
    };
  } catch {
    return { status: "error" };
  }
}
