/**
 * Generic, site-agnostic HTML5 video completion tracking (Stage 24). Two
 * responsibilities, deliberately kept separate from everything else in
 * this file's callers: deciding WHICH `<video>` element (if any) is the
 * real episode player worth observing, and deciding WHEN enough of it has
 * been genuinely watched to count as "episode complete." Neither function
 * ever reads video pixel/frame content, records audio, inspects DRM/
 * license data, or sends anything about playback to Markly — completion
 * decisions happen entirely locally; only the final yes/no answer
 * (`onComplete` firing once) ever leaves this module, and even that never
 * reaches the network directly — see content-script.ts, which is the only
 * caller and the only place a completion turns into an API call.
 */

/** currentTime/duration at or above this, OR a genuine `ended` event, is required (in addition to MEANINGFUL_PLAYBACK_RATIO) before an episode counts as watched. */
export const COMPLETION_RATIO_THRESHOLD = 0.85;

/**
 * Real, accumulated forward-playback time must reach at least this
 * fraction of the video's duration — tracked independently of the
 * player's current *position*, so seeking straight to the end and letting
 * one frame play (or fire `ended`) does not qualify: accumulated would
 * still be near zero. Deliberately simple (a single ratio, not a full
 * watch-history reconstruction) — the goal stated for Stage 24 is
 * avoiding obvious false positives, not forensic watch verification.
 */
export const MEANINGFUL_PLAYBACK_RATIO = 0.5;

/** A `timeupdate` delta larger than this is treated as a seek/jump, never counted as playback — normal HTML5 playback fires timeupdate roughly every ~250ms, so a multi-second jump between two events is not continuous watching. */
const MAX_NATURAL_TIMEUPDATE_DELTA_SECONDS = 2;

/** Below this, a `<video>` is treated as decorative (a thumbnail, a tiny inline preview) rather than a real episode player, even when it's the only candidate. */
const MIN_PLAYER_WIDTH_PX = 160;
const MIN_PLAYER_HEIGHT_PX = 120;

/** When more than one visible, adequately-sized video is present, the largest must be at least this many times the area of the runner-up to be picked with confidence — otherwise this is exactly the "main player vs. a similarly-sized second video" ambiguity Stage 24 was told never to guess through. */
const DOMINANT_AREA_RATIO = 2;

function isVisible(el: HTMLElement): boolean {
  if (el.offsetWidth <= 0 || el.offsetHeight <= 0) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return style ? style.visibility !== "hidden" && style.display !== "none" : true;
}

/**
 * Conservative candidate selection — never assumes the first `<video>` in
 * document order is the real player (a page may also have ad pre-rolls,
 * autoplay trailers/previews, or background decoration videos). Only
 * inspects element geometry/visibility, never video content. Returns null
 * whenever there isn't a single, confidently-identifiable primary player
 * — the caller (content-script.ts) still reports the detected episode
 * identity in that case, it just never attempts completion tracking (see
 * README "Episode/Video Tracking").
 */
export function selectPrimaryVideo(document: Document): HTMLVideoElement | null {
  const candidates = Array.from(document.querySelectorAll("video")).filter(
    (video) => isVisible(video) && video.offsetWidth >= MIN_PLAYER_WIDTH_PX && video.offsetHeight >= MIN_PLAYER_HEIGHT_PX,
  );

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const byArea = candidates
    .map((video) => ({ video, area: video.offsetWidth * video.offsetHeight }))
    .sort((a, b) => b.area - a.area);

  const [largest, runnerUp] = byArea;
  if (largest.area >= runnerUp.area * DOMINANT_AREA_RATIO) return largest.video;

  // Two or more similarly-sized videos — no safe way to know which is the
  // episode itself (could be two players in a comparison UI, a grid of
  // previews, etc.). Never guess.
  return null;
}

/**
 * Total time budget for finding a primary player that wasn't present yet
 * at the moment an episode was detected (see discoverPrimaryVideo) — a
 * real, evidence-driven number: the dev harness's own generated video
 * takes several real seconds to mount after page "load" fires (confirmed
 * live — `document.readyState` was already "complete" while the page
 * still had zero `<video>` elements, several seconds before one
 * appeared), and a real site's player can plausibly take a comparable
 * moment to hydrate/buffer. Bounded so this never waits forever.
 */
const PLAYER_DISCOVERY_TIMEOUT_MS = 15000;

/**
 * Coalesces a burst of DOM mutations (React/Vue frequently make several in
 * one render pass) into a single re-check, rather than re-scanning the
 * document on every individual mutation record. Deliberately a THROTTLE,
 * not a debounce: the first mutation in a burst schedules exactly one
 * check this many ms later, and further mutations arriving before that
 * check runs are ignored rather than pushing it back out again. A plain
 * debounce (reset the timer on every mutation) would never fire at all on
 * a page with mutations arriving faster than this interval on a sustained
 * basis (a live chat widget, ad refreshes, animation-driven DOM churn) —
 * a real, if narrower, risk than the specific bug this constant's
 * surrounding function was fixed for.
 */
const MUTATION_CHECK_THROTTLE_MS = 200;

export interface PlayerDiscoveryHandle {
  /** Stops discovery early — neither onFound nor onTimeout fires afterward. Call this when the episode/source context changes before a player was found. */
  cancel(): void;
}

export interface PlayerDiscoveryOptions {
  onFound: (video: HTMLVideoElement) => void;
  onTimeout: () => void;
  timeoutMs?: number;
}

/**
 * Event-driven, bounded search for the primary player: tries once
 * immediately (the common case — the video is already there), and only if
 * that fails, watches for it to mount via a MutationObserver scoped to
 * this call alone. Never a polling interval — the observer callback only
 * runs in reaction to real DOM mutations, and only for as long as this
 * one discovery attempt is outstanding: it disconnects itself the instant
 * a video is found, the timeout elapses, or `cancel()` is called (see
 * content-script.ts, which cancels on episode change), so nothing here
 * ever watches the document indefinitely or across episodes.
 */
export function discoverPrimaryVideo(document: Document, options: PlayerDiscoveryOptions): PlayerDiscoveryHandle {
  const immediate = selectPrimaryVideo(document);
  if (immediate) {
    options.onFound(immediate);
    return { cancel() {} };
  }

  let settled = false;
  let checkScheduled = false;
  let throttleTimer: ReturnType<typeof setTimeout> | undefined;

  function cleanup() {
    observer.disconnect();
    clearTimeout(throttleTimer);
    clearTimeout(timeoutId);
  }

  function runCheck() {
    checkScheduled = false;
    if (settled) return;
    const found = selectPrimaryVideo(document);
    if (!found) return;
    settled = true;
    cleanup();
    options.onFound(found);
  }

  const observer = new MutationObserver(() => {
    if (settled || checkScheduled) return; // throttled: a check is already pending, further mutations before it runs don't push it back out
    checkScheduled = true;
    throttleTimer = setTimeout(runCheck, MUTATION_CHECK_THROTTLE_MS);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const timeoutId = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    options.onTimeout();
  }, options.timeoutMs ?? PLAYER_DISCOVERY_TIMEOUT_MS);

  return {
    cancel() {
      if (settled) return;
      settled = true;
      cleanup();
    },
  };
}

export interface CompletionObserverCallbacks {
  /** Fired at most once per observer instance, the moment completion criteria are first met. */
  onComplete: () => void;
  /** Optional, throttled to roughly once per second — local-only current watch ratio (0-1), for the popup's live "Watching · N%"; never itself sent to Markly (see content-script.ts). */
  onProgress?: (ratio: number) => void;
}

export interface CompletionObserverHandle {
  /** Detaches every listener. Call this whenever the episode/video identity changes (SPA navigation, a different video becoming primary) — a stale observer must never be left running against the wrong episode. */
  destroy(): void;
}

/**
 * Attaches only native browser media events — play, pause, timeupdate,
 * seeking, seeked, ended — never polling on a timer. Tracks two local,
 * ephemeral numbers (accumulated real playback seconds, and the video's
 * own currentTime/duration) for exactly as long as this observer is
 * alive; nothing here is persisted to chrome.storage or sent anywhere
 * until `onComplete` fires, and even then only a single boolean-shaped
 * "this episode is done" decision reaches the caller — never a
 * currentTime series, seek history, or any other timing detail.
 */
export function createCompletionObserver(video: HTMLVideoElement, callbacks: CompletionObserverCallbacks): CompletionObserverHandle {
  let accumulated = 0;
  let lastTime = video.currentTime;
  let isPlaying = !video.paused && !video.ended;
  let isSeeking = false;
  let completed = false;
  let lastProgressReportAt = 0;

  function duration(): number {
    return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  }

  function meaningfulPlaybackMet(): boolean {
    const total = duration();
    return total > 0 && accumulated >= total * MEANINGFUL_PLAYBACK_RATIO;
  }

  function ratioMet(): boolean {
    const total = duration();
    return total > 0 && video.currentTime / total >= COMPLETION_RATIO_THRESHOLD;
  }

  function maybeComplete() {
    if (completed) return;
    if ((ratioMet() || video.ended) && meaningfulPlaybackMet()) {
      completed = true;
      callbacks.onComplete();
    }
  }

  function reportProgressThrottled() {
    if (!callbacks.onProgress) return;
    const total = duration();
    if (total <= 0) return;
    const now = Date.now();
    if (now - lastProgressReportAt < 1000) return;
    lastProgressReportAt = now;
    callbacks.onProgress(Math.min(1, Math.max(0, video.currentTime / total)));
  }

  function onTimeUpdate() {
    const now = video.currentTime;
    if (isPlaying && !isSeeking) {
      const delta = now - lastTime;
      if (delta > 0 && delta <= MAX_NATURAL_TIMEUPDATE_DELTA_SECONDS) {
        accumulated += delta;
      }
    }
    lastTime = now;
    maybeComplete();
    reportProgressThrottled();
  }

  function onPlay() {
    isPlaying = true;
    lastTime = video.currentTime;
  }
  function onPause() {
    isPlaying = false;
  }
  function onSeeking() {
    isSeeking = true;
  }
  function onSeeked() {
    isSeeking = false;
    lastTime = video.currentTime;
  }
  function onEnded() {
    isPlaying = false;
    maybeComplete();
  }

  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  video.addEventListener("seeking", onSeeking);
  video.addEventListener("seeked", onSeeked);
  video.addEventListener("ended", onEnded);

  return {
    destroy() {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("ended", onEnded);
    },
  };
}
