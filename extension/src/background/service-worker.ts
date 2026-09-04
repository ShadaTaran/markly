import { isWithinTrackedScope } from "../lib/config";
import { getDeviceToken, setDeviceToken, clearDeviceToken } from "../lib/storage";
import { pairDevice, submitProgress, type ProgressApiResult } from "../lib/api";
import type { ExtensionMessage, TabState } from "../types/messages";
import type { TrackingDetection, TrackingProgress } from "../adapters/types";

/**
 * Restricts chrome.storage.local to trusted extension contexts (this
 * service worker, and the popup) — by default a content script can read
 * chrome.storage.local too, which would let a compromised/malicious page
 * script reach the device token through the extension's own storage APIs
 * even though the content script is never sent the token directly. This
 * closes that path. No-ops harmlessly on Chrome versions that don't
 * support it yet.
 */
chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => undefined);

/** Per-tab last-known detection + API result, so the popup can show "current page" status without re-injecting anything. Cleared when a tab navigates to a non-matching page or closes. */
const tabState = new Map<number, TabState>();

/**
 * Lightweight extension-side dedup, split into two independent caches
 * since Stage 24: `lastCommittedValue` tracks the last value actually
 * *committed* as progress (commit: true — every reading-media detection,
 * plus a video's eventual completion send); `lastDiscoveredValue` tracks
 * the last value sent as a discovery-only ping (commit: false — a video
 * "episode detected" ping, which never commits anything). Keeping these
 * separate matters: a discovery ping for episode 7 must never suppress
 * the *later, real* completion send for episode 7 just because the same
 * numeric value was already mentioned once. The server is still
 * authoritative either way (see /api/extension/progress) — this only
 * avoids redundant round trips on reload/SPA-re-detection repeats.
 */
const lastCommittedValue = new Map<string, string>();
const lastDiscoveredValue = new Map<string, string>();

function dedupeKey(adapterId: string, sourceKey: string): string {
  return `${adapterId}::${sourceKey}`;
}

/**
 * Stage 25 — the dedupe caches used to key directly on `progress.value`,
 * fine while every progress kind had exactly one number. A season_episode
 * detection reuses `value` for the in-season episode number, so two
 * different seasons can share the same value (S1E3 and S2E3 must never be
 * treated as "the same, already-sent" value) — this folds season into the
 * comparison key whenever it's present, and is a no-op for every other
 * kind (identical to comparing `.value` directly, as before).
 */
function progressDedupeValue(progress: TrackingProgress): string {
  return progress.season !== undefined ? `s${progress.season}e${progress.value}` : String(progress.value);
}

/** Shared by the load-triggered gate below and the popup's "just granted permission, track this tab right now" request — never duplicated. */
async function injectContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }).catch(() => {
    // Tab may have navigated away already, or isn't script-injectable
    // (e.g. a chrome:// page) — nothing to recover from here.
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;

  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    return;
  }

  // Injection is gated on scope (host_permissions — required for the
  // Markly dev origin, user-granted per origin for everything else via
  // chrome.permissions; see lib/config.ts), not on a specific adapter
  // matching — the content script itself picks an adapter if one claims
  // the URL, and falls back to universal detection otherwise (see
  // content/content-script.ts). This is what lets universal detection
  // run on any enabled site without a dedicated adapter or any
  // permission broader than that one origin.
  isWithinTrackedScope(url).then((withinScope) => {
    if (!withinScope) {
      tabState.delete(tabId);
      return;
    }
    void injectContentScript(tabId);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  switch (message.type) {
    case "TRACKING_DETECTED": {
      const tabId = sender.tab?.id;
      handleDetection(message.detection, tabId, message.commit ?? true).then(sendResponse);
      return true; // keep the message channel open for the async response
    }
    case "WATCH_PROGRESS_UPDATE": {
      // Stage 24 — purely local: updates this tab's cached state so the
      // popup can show a live watch percentage on demand (GET_TAB_STATUS),
      // without a network round trip and without this ever reaching
      // Markly. No response needed — the content script doesn't wait for one.
      const tabId = sender.tab?.id;
      if (tabId !== undefined) {
        const current = tabState.get(tabId);
        // A ratio update only ever arrives once a player is actually
        // observed — clears any stale "searching" state defensively, even
        // though PLAYER_STATUS_UPDATE("found") already should have.
        if (current) tabState.set(tabId, { ...current, watchRatio: message.ratio, playerStatus: undefined });
      }
      return false;
    }
    case "PLAYER_STATUS_UPDATE": {
      // Stage 24 bugfix — purely local, same reasoning as WATCH_PROGRESS_UPDATE above.
      const tabId = sender.tab?.id;
      if (tabId !== undefined) {
        const current = tabState.get(tabId);
        if (current) {
          tabState.set(tabId, {
            ...current,
            playerStatus: message.status === "found" ? undefined : message.status,
          });
        }
      }
      return false;
    }
    case "GET_TAB_STATUS": {
      sendResponse(tabState.get(message.tabId) ?? null);
      return false;
    }
    case "CONNECT": {
      handleConnect(message.code).then(sendResponse);
      return true;
    }
    case "DISCONNECT": {
      clearDeviceToken().then(() => sendResponse({ ok: true }));
      return true;
    }
    case "GET_POPUP_STATE": {
      handleGetPopupState().then(sendResponse);
      return true;
    }
    case "INJECT_NOW": {
      injectContentScript(message.tabId).then(() => sendResponse({ ok: true }));
      return true;
    }
    default:
      return false;
  }
});

async function handleDetection(
  detection: TrackingDetection | null,
  tabId: number | undefined,
  commit: boolean,
): Promise<ProgressApiResult> {
  if (!detection) {
    // The content script ran (the page was in scope) but nothing was
    // confidently detected — purely local state for the popup; never
    // reaches the Markly API.
    const result: ProgressApiResult = { status: "low_confidence" };
    if (tabId !== undefined) tabState.set(tabId, { detection: null, result });
    return result;
  }

  const key = dedupeKey(detection.adapterId, detection.sourceKey);
  const cache = commit ? lastCommittedValue : lastDiscoveredValue;
  const dedupeValue = progressDedupeValue(detection.progress);

  if (cache.get(key) === dedupeValue) {
    const cached = tabId !== undefined ? tabState.get(tabId) : undefined;
    const result: ProgressApiResult =
      cached?.result ?? (commit ? { status: "unchanged", currentValue: detection.progress.value } : { status: "detected" });
    if (tabId !== undefined) tabState.set(tabId, { detection, result, watchRatio: cached?.watchRatio });
    return result;
  }

  const token = await getDeviceToken();
  if (!token) {
    const result: ProgressApiResult = { status: "unauthorized" };
    if (tabId !== undefined) tabState.set(tabId, { detection, result });
    return result;
  }

  const result = await submitProgress(token, detection, commit);

  if (result.status === "unauthorized") {
    // The device was revoked or its token is otherwise no longer valid —
    // stop trying with it until the user re-pairs.
    await clearDeviceToken();
  } else if (result.status !== "error" && result.status !== "server_error") {
    // Neither a failed fetch ("error") nor a real non-2xx response from
    // Markly ("server_error") is remembered as "already sent" — both mean
    // this value was never actually recorded, so the next opportunity to
    // detect the same value must retry rather than silently skip it.
    cache.set(key, dedupeValue);
  }

  // Once progress actually commits, the local watch-ratio bar no longer
  // means anything (the popup switches to "tracked" copy instead) — clear
  // it. A discovery-only send keeps whatever ratio local playback
  // observation has already reported for this tab.
  const previousWatchRatio = tabId !== undefined ? tabState.get(tabId)?.watchRatio : undefined;
  if (tabId !== undefined) tabState.set(tabId, { detection, result, watchRatio: commit ? undefined : previousWatchRatio });
  return result;
}

async function handleConnect(code: string): Promise<{ ok: boolean; error?: string }> {
  const result = await pairDevice(code);
  if (!result.ok) return { ok: false, error: result.error };
  await setDeviceToken(result.token);
  return { ok: true };
}

async function handleGetPopupState(): Promise<{ connected: boolean }> {
  const token = await getDeviceToken();
  return { connected: token !== null };
}
