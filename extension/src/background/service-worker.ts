import { isWithinTrackedScope } from "../lib/config";
import { getDeviceToken, setDeviceToken, clearDeviceToken } from "../lib/storage";
import { pairDevice, submitProgress, type ProgressApiResult } from "../lib/api";
import type { ExtensionMessage, TabState } from "../types/messages";
import type { TrackingDetection } from "../adapters/types";

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

/** Lightweight extension-side dedup: skip re-submitting a value we just sent for this exact source. The server is still authoritative (see /api/extension/progress) — this only avoids a redundant round trip on reload/DOM-mutation/service-worker-wakeup repeats. */
const lastSentValue = new Map<string, number>();

function dedupeKey(adapterId: string, sourceKey: string): string {
  return `${adapterId}::${sourceKey}`;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;

  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    return;
  }

  // Injection is gated on scope (host_permissions), not on a specific
  // adapter matching — the content script itself picks an adapter if one
  // claims the URL, and falls back to universal detection otherwise (see
  // content/content-script.ts). This is what lets universal detection
  // run on pages with no dedicated adapter without requesting any
  // broader permission.
  if (!isWithinTrackedScope(url)) {
    tabState.delete(tabId);
    return;
  }

  chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }).catch(() => {
    // Tab may have navigated away already, or isn't script-injectable
    // (e.g. a chrome:// page) — nothing to recover from here.
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  switch (message.type) {
    case "TRACKING_DETECTED": {
      const tabId = sender.tab?.id;
      handleDetection(message.detection, tabId).then(sendResponse);
      return true; // keep the message channel open for the async response
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
    default:
      return false;
  }
});

async function handleDetection(detection: TrackingDetection, tabId: number | undefined): Promise<ProgressApiResult> {
  const key = dedupeKey(detection.adapterId, detection.sourceKey);

  if (lastSentValue.get(key) === detection.progress.value) {
    const cached = tabId !== undefined ? tabState.get(tabId) : undefined;
    const result: ProgressApiResult = cached?.result ?? { status: "unchanged", currentValue: detection.progress.value };
    if (tabId !== undefined) tabState.set(tabId, { detection, result });
    return result;
  }

  const token = await getDeviceToken();
  if (!token) {
    const result: ProgressApiResult = { status: "unauthorized" };
    if (tabId !== undefined) tabState.set(tabId, { detection, result });
    return result;
  }

  const result = await submitProgress(token, detection);

  if (result.status === "unauthorized") {
    // The device was revoked or its token is otherwise no longer valid —
    // stop trying with it until the user re-pairs.
    await clearDeviceToken();
  } else if (result.status !== "error") {
    lastSentValue.set(key, detection.progress.value);
  }

  if (tabId !== undefined) tabState.set(tabId, { detection, result });
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
