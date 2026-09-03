import { findMatchingAdapter } from "../adapters/registry";
import { detectUniversal } from "../tracking/universal/detect";
import { describeDetection, formatDiagnostics } from "../tracking/universal/diagnostics";
import {
  discoverPrimaryVideo,
  createCompletionObserver,
  type PlayerDiscoveryHandle,
  type CompletionObserverHandle,
} from "../tracking/video/completion";
import type { TrackingDetectedMessage, WatchProgressUpdateMessage, PlayerStatusUpdateMessage } from "../types/messages";
import type { TrackingDetection } from "../adapters/types";

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
function sendDetection(detection: TrackingDetection | null, commit: boolean) {
  const message: TrackingDetectedMessage = { type: "TRACKING_DETECTED", detection, commit };
  chrome.runtime.sendMessage(message).catch(() => {
    // Service worker may be waking up or briefly unavailable — nothing
    // for the content script to retry; the next navigation tries again.
  });
}

/**
 * Stage 24 — episode-kind (video) detections never commit progress the
 * moment they're seen; reading a chapter's page IS progress, but opening
 * an episode's page is not (see README "Episode/Video Tracking"). This
 * still sends an immediate discovery ping (commit: false) so identity/
 * Smart Auto-Link/Auto-Add can happen right away — the user shouldn't
 * need to watch 85% of an episode just to see "Add or Link" — then
 * separately, locally, tries to find the episode's own primary video and
 * watch it for real completion (see tracking/video/completion.ts). If no
 * confident primary video can be found (a cross-origin iframe player,
 * several similarly-sized candidates, or none within the bounded
 * discovery window below), completion tracking is simply unavailable for
 * this page — the popup can say so, but nothing is ever guessed.
 *
 * Bugfix: the player frequently isn't in the DOM yet at the exact moment
 * an episode is first detected — proven directly against the dev harness
 * itself, where `document.readyState` was already "complete" (the
 * injection trigger) several real seconds before its generated <video>
 * element existed at all. The original version called selectPrimaryVideo
 * exactly once and gave up permanently if it returned null. Player
 * discovery is now bounded-but-retried (discoverPrimaryVideo): tried
 * immediately, then — only if that fails — via a debounced
 * MutationObserver capped at PLAYER_DISCOVERY_TIMEOUT_MS, never an
 * unbounded poll. The popup gets a transient "searching" state via
 * PLAYER_STATUS_UPDATE so a normal async-mount settling window doesn't
 * look identical to a genuine "this player can't be observed."
 */
let activeObserver: { sourceKey: string; episode: number; video: HTMLVideoElement; handle: CompletionObserverHandle } | null = null;
let activeDiscovery: { sourceKey: string; episode: number; handle: PlayerDiscoveryHandle } | null = null;

function sendPlayerStatus(sourceKey: string, status: "searching" | "unavailable" | "found") {
  const message: PlayerStatusUpdateMessage = { type: "PLAYER_STATUS_UPDATE", sourceKey, status };
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

function stopActiveObserver() {
  if (!activeObserver) return;
  activeObserver.handle.destroy();
  activeObserver = null;
}

function stopActiveDiscovery() {
  if (!activeDiscovery) return;
  activeDiscovery.handle.cancel();
  activeDiscovery = null;
}

function attachObserverTo(video: HTMLVideoElement, detection: TrackingDetection) {
  const handle = createCompletionObserver(video, {
    onComplete: () => {
      sendDetection(detection, true);
    },
    onProgress: (ratio) => {
      const message: WatchProgressUpdateMessage = { type: "WATCH_PROGRESS_UPDATE", sourceKey: detection.sourceKey, ratio };
      chrome.runtime.sendMessage(message).catch(() => undefined);
    },
  });
  activeObserver = { sourceKey: detection.sourceKey, episode: detection.progress.value, video, handle };
  sendPlayerStatus(detection.sourceKey, "found");
}

function handleEpisodeDetection(detection: TrackingDetection) {
  sendDetection(detection, false);

  const episode = detection.progress.value;

  if (activeObserver && (activeObserver.sourceKey !== detection.sourceKey || activeObserver.episode !== episode)) {
    stopActiveObserver();
  }
  if (activeDiscovery && (activeDiscovery.sourceKey !== detection.sourceKey || activeDiscovery.episode !== episode)) {
    stopActiveDiscovery();
  }

  if (activeObserver) {
    // Same episode we're already observing. A player that's been swapped
    // out from under us (a real, if uncommon, SPA pattern — see README
    // "Episode/Video Tracking") is no longer connected to the document;
    // re-run discovery once for this same episode rather than silently
    // keeping a dead observer. A still-connected player needs no action.
    if (activeObserver.video.isConnected) return;
    stopActiveObserver();
  }

  if (activeDiscovery) return; // already searching for this exact episode

  const handle = discoverPrimaryVideo(document, {
    onFound: (video) => {
      activeDiscovery = null;
      attachObserverTo(video, detection);
    },
    onTimeout: () => {
      activeDiscovery = null;
      sendPlayerStatus(detection.sourceKey, "unavailable");
    },
  });

  // discoverPrimaryVideo already resolved synchronously (the common case
  // — the player was already there) if handle.cancel() is a no-op AND
  // activeDiscovery was never assigned below; only report "searching" for
  // the genuinely-asynchronous case, so the popup doesn't flash a
  // transient message when none was needed. onFound/onTimeout above run
  // synchronously in that same case, so `activeObserver`/the timeout
  // already fired before this line — only assign discovery state if
  // neither happened yet.
  if (!activeObserver) {
    activeDiscovery = { sourceKey: detection.sourceKey, episode, handle };
    sendPlayerStatus(detection.sourceKey, "searching");
  }
}

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

  if (!detection) {
    stopActiveObserver();
    stopActiveDiscovery();
    sendDetection(null, true);
    return;
  }

  if (detection.progress.kind === "episode") {
    handleEpisodeDetection(detection);
    return;
  }

  // Every reading-media (chapter-kind) detection: unchanged since Stage
  // 18 — commit immediately, no observer.
  stopActiveObserver();
  stopActiveDiscovery();
  sendDetection(detection, true);
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
