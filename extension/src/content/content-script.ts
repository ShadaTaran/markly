import { findMatchingAdapter } from "../adapters/registry";
import { detectUniversal } from "../tracking/universal/detect";
import { describeDetection, formatDiagnostics } from "../tracking/universal/diagnostics";
import type { TrackingDetectedMessage } from "../types/messages";

/**
 * Injected only on pages within our tracked scope (see lib/config.ts —
 * the Markly dev origin, plus any origin the user has explicitly granted
 * via chrome.permissions). This script does exactly one thing: decide how
 * to read the current page, and forward whatever normalized detection
 * result to the service worker — even a null one, so the popup can tell
 * "couldn't confidently detect anything on this page" apart from "this
 * page was never in scope." A null result never reaches the Markly API;
 * it's purely local extension state. This script never reads passwords,
 * forms, cookies, or any other page content, and never talks to Markly
 * directly — the device token never reaches this context.
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
function runDetection() {
  const url = new URL(window.location.href);
  const adapter = findMatchingAdapter(url);
  const detection = adapter ? adapter.detect(document, url) : detectUniversal(document, url);

  if (!adapter) {
    // Development visibility into the confidence engine's decision — a
    // console.debug line in this page's own DevTools console, nothing
    // more. Never sent to Markly, never shown in the popup; see
    // tracking/universal/diagnostics.ts for exactly what it reads and why
    // that's safe.
    console.debug(formatDiagnostics(describeDetection(document, url)));
  }

  const message: TrackingDetectedMessage = { type: "TRACKING_DETECTED", detection };
  chrome.runtime.sendMessage(message).catch(() => {
    // Service worker may be waking up or briefly unavailable — nothing
    // for the content script to retry; the next navigation tries again.
  });
}

runDetection();

/**
 * Stage 23 — generic single-page-app navigation support (verified
 * necessary against a real site: MangaDex's reader is a client-side-
 * routed Vue app — "Next Chapter" changes the URL via history.pushState
 * with no full page reload, confirmed by a beforeunload probe that never
 * fired across the transition — so without this, this script's one-time
 * run above would only ever see the first chapter a tab was opened on).
 * Not built for MangaDex specifically: any site using client-side routing
 * gets the same re-detection for free, with zero site-specific code here.
 *
 * history.pushState/replaceState are the two APIs virtually every client-
 * side router (React Router, Vue Router, Next.js, etc.) calls under the
 * hood to change the URL without reloading; popstate covers the
 * back/forward-button case those two don't. Debounced so a router's own
 * multi-step transition (which may call pushState more than once) only
 * triggers one re-detection, after giving the new page a brief moment to
 * finish updating its own title/meta tags — this is NOT a MutationObserver
 * and does not watch the document's content at all, continuously or
 * otherwise; it only reacts to the URL itself changing.
 */
const SPA_NAVIGATION_DEBOUNCE_MS = 600;
let lastHref = window.location.href;
let spaNavigationTimer: ReturnType<typeof setTimeout> | undefined;

function handlePossibleSpaNavigation() {
  if (window.location.href === lastHref) return;
  lastHref = window.location.href;
  clearTimeout(spaNavigationTimer);
  spaNavigationTimer = setTimeout(runDetection, SPA_NAVIGATION_DEBOUNCE_MS);
}

for (const method of ["pushState", "replaceState"] as const) {
  const original = history[method];
  history[method] = function patchedHistoryMethod(...args: Parameters<History[typeof method]>) {
    const result = original.apply(this, args);
    handlePossibleSpaNavigation();
    return result;
  };
}
window.addEventListener("popstate", handlePossibleSpaNavigation);
