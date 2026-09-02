import { findMatchingAdapter } from "../adapters/registry";
import { detectUniversal } from "../tracking/universal/detect";
import type { TrackingDetectedMessage } from "../types/messages";

/**
 * Runs once per page load, injected only on pages within our tracked
 * scope (see lib/config.ts — currently just the Markly dev origin). This
 * script does exactly one thing: decide how to read the current page,
 * and forward whatever normalized detection results to the service
 * worker. It never reads passwords, forms, cookies, or any other page
 * content, and never talks to Markly directly — the device token never
 * reaches this context.
 *
 * Precedence: if a registered adapter's matches() claims this URL, that
 * adapter's own detect() result is used exclusively — even if it returns
 * null — since an adapter exists specifically because universal detection
 * was unreliable for that site, so its "nothing here" is more trustworthy
 * than a generic heuristic firing anyway. Universal detection only runs
 * when no adapter claims the URL at all. This keeps adapters working as
 * overrides (see extension/README.md) while letting universal detection
 * cover every other page in scope without needing a dedicated adapter.
 */
const url = new URL(window.location.href);
const adapter = findMatchingAdapter(url);
const detection = adapter ? adapter.detect(document, url) : detectUniversal(document, url);

if (detection) {
  const message: TrackingDetectedMessage = { type: "TRACKING_DETECTED", detection };
  chrome.runtime.sendMessage(message).catch(() => {
    // Service worker may be waking up or briefly unavailable — nothing
    // for the content script to retry; the next page load tries again.
  });
}
