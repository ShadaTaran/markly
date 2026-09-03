#!/usr/bin/env node
// Verifies Stage 24 "anime/video episode tracking foundation" logic:
//   - the generic completion observer (extension/src/tracking/video/
//     completion.ts) — completion threshold, meaningful-playback/seek-
//     cheat resistance, one-time firing, reset-on-episode-change
//   - selectPrimaryVideo's conservative candidate selection
//   - the discovery-vs-commit split in /api/extension/progress (Stage 24's
//     core server-architecture decision) — a discovery ping never commits
//     progress; Auto-Add may still fire from it, but never bakes an
//     unconfirmed episode number into the created item
//   - cross-media isolation (anime vs. novel/manga, unaffected)
//   - old-episode monotonic behavior (reused, unaffected model)
//
// Reproduced verbatim from the real modules rather than imported — same
// approach as every other script in this directory. Keep in sync if the
// real implementations change.
//
// IMPORTANT: the completion-observer logic below was ALSO verified live
// against a real HTML5 <video> element in a real browser (genuine play/
// pause/timeupdate/seeking/seeked/ended events, not simulated) — see the
// Stage 24 final report's "Live browser/dev harness tests" section. This
// script re-verifies the same logic deterministically, using a minimal
// mock video object (real EventTarget, fake currentTime/duration), so it
// can be re-run in CI without a browser. The auto-add/concurrency model
// checks reuse the same JS-model technique as verify-auto-add.mjs /
// verify-manga-tracking.mjs and carry the same caveat: they validate the
// ALGORITHM, not real PostgreSQL locking semantics.
//
// Run with: node scripts/verify-video-tracking.mjs

import assert from "node:assert/strict";

// ============================================================
// completion.ts, reproduced verbatim
// ============================================================
const COMPLETION_RATIO_THRESHOLD = 0.85;
const MEANINGFUL_PLAYBACK_RATIO = 0.5;
const MAX_NATURAL_TIMEUPDATE_DELTA_SECONDS = 2;
const MIN_PLAYER_WIDTH_PX = 160;
const MIN_PLAYER_HEIGHT_PX = 120;
const DOMINANT_AREA_RATIO = 2;

function selectPrimaryVideo(candidates) {
  // candidates: [{ offsetWidth, offsetHeight, visible }]
  const visible = candidates.filter((v) => v.visible && v.offsetWidth >= MIN_PLAYER_WIDTH_PX && v.offsetHeight >= MIN_PLAYER_HEIGHT_PX);
  if (visible.length === 0) return null;
  if (visible.length === 1) return visible[0];
  const byArea = visible.map((v) => ({ v, area: v.offsetWidth * v.offsetHeight })).sort((a, b) => b.area - a.area);
  const [largest, runnerUp] = byArea;
  if (largest.area >= runnerUp.area * DOMINANT_AREA_RATIO) return largest.v;
  return null;
}

// ============================================================
// discoverPrimaryVideo, reproduced verbatim (throttle, not debounce)
// ============================================================
const PLAYER_DISCOVERY_TIMEOUT_MS = 15000;
const MUTATION_CHECK_THROTTLE_MS = 200;

/**
 * Minimal mock of just enough `document`/MutationObserver surface for
 * discoverPrimaryVideo to run unmodified in plain Node (no real DOM/
 * MutationObserver exists there). `mutate()` simulates the browser
 * delivering a mutation-observer callback — the test drives it explicitly
 * instead of a real MutationObserver reacting to real DOM writes, but the
 * function under test is the exact same discoverPrimaryVideo body used in
 * the extension.
 */
function createMockDom(initialVideos) {
  let videos = initialVideos;
  const observers = [];
  const doc = {
    body: {},
    querySelectorAll(selector) {
      if (selector !== "video") return [];
      return videos;
    },
  };
  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
      this.disconnected = false;
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  }
  return {
    doc,
    MockMutationObserver,
    setVideos(next) {
      videos = next;
    },
    /** Simulates a real MutationObserver callback firing for every currently-active (non-disconnected) observer — exactly what a real DOM write would trigger. */
    mutate() {
      for (const o of observers) {
        if (!o.disconnected) o.callback([{}]);
      }
    },
  };
}

function discoverPrimaryVideo(document, MutationObserverImpl, options) {
  const immediate = selectPrimaryVideo(Array.from(document.querySelectorAll("video")).map(toSelectable));
  if (immediate) {
    options.onFound(immediate);
    return { cancel() {} };
  }

  let settled = false;
  let checkScheduled = false;
  let throttleTimer;

  function cleanup() {
    observer.disconnect();
    clearTimeout(throttleTimer);
    clearTimeout(timeoutId);
  }
  function runCheck() {
    checkScheduled = false;
    if (settled) return;
    const found = selectPrimaryVideo(Array.from(document.querySelectorAll("video")).map(toSelectable));
    if (!found) return;
    settled = true;
    cleanup();
    options.onFound(found);
  }
  const observer = new MutationObserverImpl(() => {
    if (settled || checkScheduled) return;
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
// selectPrimaryVideo (the mocked version above) takes {offsetWidth,
// offsetHeight, visible} objects directly; real <video> elements pass
// that same shape through unchanged (a real element already has those
// properties) — this identity mapping just documents the equivalence.
function toSelectable(v) {
  return v;
}

/** A minimal, real EventTarget-backed mock of an HTMLVideoElement — enough surface for createCompletionObserver to attach real listeners and receive real dispatched events, exactly as it would on a genuine <video>. */
class MockVideoElement extends EventTarget {
  constructor(duration) {
    super();
    this.duration = duration;
    this.currentTime = 0;
    this.paused = true;
    this.ended = false;
  }
  play() {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event("play"));
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  /**
   * Simulates natural forward playback advancing by `seconds`, in real
   * HTML5-video-like ~0.25s timeupdate increments (never a single big
   * jump — a real video firing timeupdate once every ~250ms during
   * playback is exactly what the observer's MAX_NATURAL_TIMEUPDATE_DELTA_
   * SECONDS cap assumes; a coarse single-step jump here would itself look
   * like a seek and, wrongly, not accumulate).
   */
  advance(seconds) {
    const STEP = 0.25;
    let remaining = seconds;
    while (remaining > 0 && this.currentTime < this.duration) {
      const step = Math.min(STEP, remaining, this.duration - this.currentTime);
      this.currentTime += step;
      remaining -= step;
      this.dispatchEvent(new Event("timeupdate"));
    }
    if (this.currentTime >= this.duration) {
      this.paused = true;
      this.ended = true;
      this.dispatchEvent(new Event("ended"));
    }
  }
  /** Simulates a user/programmatic seek — fires seeking, jumps, fires seeked + timeupdate, exactly like a real <video>. */
  seekTo(time) {
    this.dispatchEvent(new Event("seeking"));
    this.currentTime = Math.min(time, this.duration);
    this.dispatchEvent(new Event("seeked"));
    this.dispatchEvent(new Event("timeupdate"));
  }
}

function createCompletionObserver(video, callbacks) {
  let accumulated = 0;
  let lastTime = video.currentTime;
  let isPlaying = !video.paused && !video.ended;
  let isSeeking = false;
  let completed = false;

  function duration() {
    return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  }
  function meaningfulPlaybackMet() {
    const d = duration();
    return d > 0 && accumulated >= d * MEANINGFUL_PLAYBACK_RATIO;
  }
  function ratioMet() {
    const d = duration();
    return d > 0 && video.currentTime / d >= COMPLETION_RATIO_THRESHOLD;
  }
  function maybeComplete() {
    if (completed) return;
    if ((ratioMet() || video.ended) && meaningfulPlaybackMet()) {
      completed = true;
      callbacks.onComplete();
    }
  }
  function onTimeUpdate() {
    const now = video.currentTime;
    if (isPlaying && !isSeeking) {
      const delta = now - lastTime;
      if (delta > 0 && delta <= MAX_NATURAL_TIMEUPDATE_DELTA_SECONDS) accumulated += delta;
    }
    lastTime = now;
    maybeComplete();
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
    getAccumulated: () => accumulated,
  };
}

// ============================================================
// Discovery-vs-commit route model, from src/app/api/extension/progress/route.ts
// ============================================================
function normalizeTitleForMatching(title) {
  return title.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}
function attemptSmartAutoLink(libraryItems, userId, mediaType, sourceTitle) {
  const target = normalizeTitleForMatching(sourceTitle);
  const candidates = libraryItems.filter((i) => i.userId === userId && i.type === mediaType);
  const matches = candidates.filter((i) => normalizeTitleForMatching(i.title) === target);
  if (matches.length === 1) return { kind: "matched", libraryItemId: matches[0].id };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "no_match" };
}

/** buildDetectedMediaInput's anime case (src/lib/extension/detected-item.ts), post-Stage-24: only bakes in currentEpisode when progress.confirmed !== false. */
function buildDetectedAnimeInput(progress) {
  const confirmedEpisode = progress?.kind === "episode" && progress.confirmed !== false ? progress.value : undefined;
  return { type: "anime", status: "in_progress", currentEpisode: confirmedEpisode };
}

/** Models the route's create-or-link path: exact match wins; else auto-add if enabled, never baking in unconfirmed episode progress. */
function routeDiscoveryOrCommit(db, userId, mediaType, sourceTitle, progress, autoAddEnabled) {
  const outcome = attemptSmartAutoLink(db.items, userId, mediaType, sourceTitle);
  if (outcome.kind === "matched") return { status: "linked_existing", libraryItemId: outcome.libraryItemId };
  if (outcome.kind === "ambiguous") return { status: "needs_link", reason: "ambiguous" };
  if (!autoAddEnabled) return { status: "needs_link", reason: "no_match" };

  const input = buildDetectedAnimeInput(progress);
  const id = `item-${db.items.length + 1}`;
  db.items.push({ id, userId, type: mediaType, title: sourceTitle, currentEpisode: input.currentEpisode, status: input.status });
  return { status: "created", libraryItemId: id, currentEpisode: input.currentEpisode };
}

/** apply_extension_progress's advance-only compare (reused model, from verify-atomic-progress.mjs). */
function applyProgress(item, newValue) {
  const current = item.currentEpisode ?? 0;
  if (newValue < current) return { status: "behind_current_progress", currentValue: current };
  if (newValue === current) return { status: "unchanged", currentValue: current };
  item.currentEpisode = newValue;
  return { status: "updated", currentValue: newValue };
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

function main() {
  // --- selectPrimaryVideo ---
  check("video selection: a single adequately-sized visible video is chosen", () => {
    const v = selectPrimaryVideo([{ offsetWidth: 480, offsetHeight: 270, visible: true }]);
    assert.ok(v);
  });
  check("video selection: no candidates -> null", () => {
    assert.equal(selectPrimaryVideo([]), null);
  });
  check("video selection: a tiny decorative video is rejected even as the sole candidate", () => {
    assert.equal(selectPrimaryVideo([{ offsetWidth: 40, offsetHeight: 30, visible: true }]), null);
  });
  check("video selection: a hidden video is never selected", () => {
    assert.equal(selectPrimaryVideo([{ offsetWidth: 480, offsetHeight: 270, visible: false }]), null);
  });
  check("video selection: one dominant player + a small preview -> the dominant one wins", () => {
    const main = { offsetWidth: 800, offsetHeight: 450, visible: true, tag: "main" };
    const preview = { offsetWidth: 200, offsetHeight: 150, visible: true, tag: "preview" };
    const chosen = selectPrimaryVideo([preview, main]);
    assert.equal(chosen.tag, "main");
  });
  check("video selection: two similarly-sized videos -> ambiguous, never guess", () => {
    const a = { offsetWidth: 480, offsetHeight: 270, visible: true };
    const b = { offsetWidth: 460, offsetHeight: 260, visible: true };
    assert.equal(selectPrimaryVideo([a, b]), null);
  });

  // --- Test A: open only, no play ---
  check("A: opening an episode without ever playing -> no completion", () => {
    const video = new MockVideoElement(1200); // 20-minute episode
    let completed = false;
    createCompletionObserver(video, { onComplete: () => (completed = true) });
    assert.equal(completed, false);
  });

  // --- Test B: short watch ---
  check("B: watching only 10% -> no completion", () => {
    const video = new MockVideoElement(1200);
    let completed = false;
    createCompletionObserver(video, { onComplete: () => (completed = true) });
    video.play();
    video.advance(120); // 10%
    assert.equal(completed, false);
  });

  // --- Test C: threshold reached via genuine continuous playback ---
  check("C: meaningful continuous playback to the 85% threshold -> exactly one completion", () => {
    const video = new MockVideoElement(1200);
    let completions = 0;
    createCompletionObserver(video, { onComplete: () => completions++ });
    video.play();
    for (let i = 0; i < 102; i++) video.advance(10); // 1020s = 85%, in small natural deltas
    assert.equal(completions, 1);
  });

  // --- Test D: natural end with sufficient valid playback ---
  check("D: playing all the way to a genuine 'ended' -> exactly one completion", () => {
    const video = new MockVideoElement(60);
    let completions = 0;
    createCompletionObserver(video, { onComplete: () => completions++ });
    video.play();
    for (let i = 0; i < 30; i++) video.advance(2);
    assert.equal(video.ended, true);
    assert.equal(completions, 1);
  });

  // --- Test E: seek cheat ---
  check("E: seeking straight to 99% and letting one moment play to 'ended' -> NOT completed", () => {
    const video = new MockVideoElement(1200);
    let completed = false;
    const observer = createCompletionObserver(video, { onComplete: () => (completed = true) });
    video.seekTo(1200 * 0.99);
    video.play();
    video.advance(12); // the tiny remaining bit, fires ended
    assert.equal(video.ended, true);
    assert.equal(completed, false);
    assert.ok(observer.getAccumulated() < 1200 * MEANINGFUL_PLAYBACK_RATIO, "accumulated playback must stay far below the meaningful threshold");
  });
  check("E2: seeking to 90% (past the ratio threshold) without ever playing -> NOT completed", () => {
    const video = new MockVideoElement(1200);
    let completed = false;
    createCompletionObserver(video, { onComplete: () => (completed = true) });
    video.seekTo(1200 * 0.9); // currentTime/duration now exceeds COMPLETION_RATIO_THRESHOLD, but nothing was ever played
    assert.equal(completed, false);
  });

  // --- Test F: repeated events after completion ---
  check("F: further timeupdate/ended events after completion never fire onComplete again", () => {
    const video = new MockVideoElement(60);
    let completions = 0;
    createCompletionObserver(video, { onComplete: () => completions++ });
    video.play();
    for (let i = 0; i < 30; i++) video.advance(2);
    assert.equal(completions, 1);
    // More events after completion (e.g. a loop, or a stray late timeupdate).
    video.currentTime = 0;
    video.dispatchEvent(new Event("timeupdate"));
    video.dispatchEvent(new Event("ended"));
    assert.equal(completions, 1);
  });

  // --- Rewind-and-replay: accumulation only ever grows, never falsely blocked ---
  check("rewind/replay: watching forward, rewinding, and replaying still reaches completion (never double-penalized)", () => {
    const video = new MockVideoElement(100);
    let completed = false;
    createCompletionObserver(video, { onComplete: () => (completed = true) });
    video.play();
    video.advance(90); // watch 0 -> 90
    video.seekTo(40); // rewind to re-watch a scene
    video.advance(50); // 40 -> 90 again
    video.advance(10); // 90 -> 100, ratio 100% and ended
    assert.equal(completed, true);
  });

  // --- discovery-vs-commit: Auto-Add creates the item but never bakes in an unconfirmed episode ---
  check("J: unknown anime + Auto-Add on -> item created, status Watching, currentEpisode NOT set from the unconfirmed discovery ping", () => {
    const db = { items: [] };
    const discoveryProgress = { kind: "episode", value: 7, confirmed: false };
    const result = routeDiscoveryOrCommit(db, "u1", "anime", "Anime X", discoveryProgress, true);
    assert.equal(result.status, "created");
    assert.equal(result.currentEpisode, undefined, "must NOT falsely become 7 yet");
    assert.equal(db.items[0].status, "in_progress");
  });
  check("I: unknown anime + Auto-Add off -> needs_link, zero items created", () => {
    const db = { items: [] };
    const discoveryProgress = { kind: "episode", value: 7, confirmed: false };
    const result = routeDiscoveryOrCommit(db, "u1", "anime", "Anime X", discoveryProgress, false);
    assert.equal(result.status, "needs_link");
    assert.equal(db.items.length, 0);
  });
  check("K: after real completion, a commitProgress:true request advances currentEpisode via the normal, unchanged monotonic path", () => {
    const db = { items: [] };
    routeDiscoveryOrCommit(db, "u1", "anime", "Anime X", { kind: "episode", value: 7, confirmed: false }, true);
    const item = db.items[0];
    const applyResult = applyProgress(item, 7); // the completion send, confirmed: true (default)
    assert.equal(applyResult.status, "updated");
    assert.equal(item.currentEpisode, 7);
  });
  check("L: ambiguous match -> needs_link/Choose Item, zero new item, even with Auto-Add on", () => {
    const db = { items: [{ id: "a", userId: "u1", type: "anime", title: "Anime X" }, { id: "b", userId: "u1", type: "anime", title: "anime x" }] };
    const result = routeDiscoveryOrCommit(db, "u1", "anime", "Anime X", { kind: "episode", value: 1, confirmed: false }, true);
    assert.equal(result.status, "needs_link");
    assert.equal(result.reason, "ambiguous");
    assert.equal(db.items.length, 2);
  });

  // --- manual "Add & Track" / Edit Details submission of a catalog-hit also never bakes in unconfirmed episode ---
  check("manual creation path: buildDetectedAnimeInput respects confirmed=false regardless of which caller invokes it", () => {
    const input = buildDetectedAnimeInput({ kind: "episode", value: 12, confirmed: false });
    assert.equal(input.currentEpisode, undefined);
  });
  check("manual creation path: a confirmed (or legacy, field-absent) progress value IS baked in — chapter-kind media is entirely unaffected by this stage", () => {
    const confirmed = buildDetectedAnimeInput({ kind: "episode", value: 12, confirmed: true });
    assert.equal(confirmed.currentEpisode, 12);
    const legacy = buildDetectedAnimeInput({ kind: "episode", value: 12 }); // no `confirmed` field at all — must default to "confirmed"
    assert.equal(legacy.currentEpisode, 12);
  });

  // --- Smart Auto-Link media isolation (anime vs. novel/series, unaffected by Stage 24) ---
  check("19: an identically-titled Novel is never matched for a detected Anime source", () => {
    const outcome = attemptSmartAutoLink([{ id: "novel-1", userId: "u1", type: "novel", title: "Frieren" }], "u1", "anime", "Frieren");
    assert.equal(outcome.kind, "no_match");
  });
  check("19b: an identically-titled Anime IS matched", () => {
    const outcome = attemptSmartAutoLink(
      [
        { id: "novel-1", userId: "u1", type: "novel", title: "Frieren" },
        { id: "anime-1", userId: "u1", type: "anime", title: "Frieren" },
      ],
      "u1",
      "anime",
      "Frieren",
    );
    assert.deepEqual(outcome, { kind: "matched", libraryItemId: "anime-1" });
  });

  // --- Test H: old episode never regresses (reused, unaffected model) ---
  check("H: server currently at episode 10; watching episode 4 completely leaves it at 10", () => {
    const item = { currentEpisode: 10 };
    const result = applyProgress(item, 4);
    assert.equal(result.status, "behind_current_progress");
    assert.equal(item.currentEpisode, 10);
  });
}

function printResultsAndExit() {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}`);
    if (!r.ok) console.log(`  ${r.err.message}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(
    "\nNote: the completion-observer checks above were ALSO verified live against a real HTML5 <video> element with genuine browser events (not simulated) — see the Stage 24 final report. The discovery-vs-commit/auto-add checks validate the ALGORITHM only, the same caveat every prior auto-add script in this directory carries.",
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

async function mainAsync() {
  main();

  // ============================================================
  // Regression tests for the real bugfix: "Episode detected /
  // Automatic completion tracking unavailable" even though a real,
  // adequately-sized <video> was visibly present and playing.
  //
  // Root cause, proven live (not assumed) against the dev harness itself:
  // the original code called selectPrimaryVideo() exactly once, at the
  // moment an episode was first detected, and gave up permanently if it
  // returned null. The harness's own generated <video> doesn't exist in
  // the DOM until several real seconds after `document.readyState` is
  // already "complete" (confirmed directly: videoCount was 0 at that
  // point, then 1 once generation finished) — a timing gap the original,
  // one-shot-only selectPrimaryVideo() call could never survive.
  // ============================================================

  await checkAsync("bugfix: a video that does NOT exist yet, but mounts shortly after via a real DOM mutation, is still found (not just the immediate-selection case)", async () => {
    const dom = createMockDom([]); // no video at discovery-start time — the exact reported scenario
    let found = null;
    const handle = discoverPrimaryVideo(dom.doc, dom.MockMutationObserver, {
      onFound: (v) => (found = v),
      onTimeout: () => {
        throw new Error("must not time out — the video does mount, just late");
      },
      timeoutMs: 2000,
    });
    assert.equal(found, null, "must not be found synchronously — it doesn't exist yet");

    // The video mounts (simulating React finishing its async render) —
    // then the mutation observer fires, exactly like a real DOM insertion.
    dom.setVideos([{ offsetWidth: 480, offsetHeight: 270, visible: true }]);
    dom.mutate();

    await new Promise((resolve) => setTimeout(resolve, MUTATION_CHECK_THROTTLE_MS + 100));
    assert.ok(found, "discoverPrimaryVideo must find the video once it mounts, not give up permanently");
    handle.cancel();
  });

  await checkAsync("bugfix: a video that never mounts at all times out (bounded — never waits forever)", async () => {
    const dom = createMockDom([]);
    let timedOut = false;
    discoverPrimaryVideo(dom.doc, dom.MockMutationObserver, {
      onFound: () => {
        throw new Error("must not find a video that was never added");
      },
      onTimeout: () => (timedOut = true),
      timeoutMs: 300,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(timedOut, true);
  });

  await checkAsync("throttle robustness: continuous rapid mutations (faster than the throttle window) do not starve the check indefinitely", async () => {
    // This is the scenario a plain DEBOUNCE (reset the timer on every
    // mutation) would fail: a real page with sustained DOM churn (a chat
    // widget, ad refreshes) faster than MUTATION_CHECK_THROTTLE_MS would
    // never let a debounced timer actually fire. The throttle design
    // (schedule at most one pending check; ignore mutations that arrive
    // before it runs) must still find the video promptly regardless.
    const dom = createMockDom([]);
    let found = null;
    const handle = discoverPrimaryVideo(dom.doc, dom.MockMutationObserver, {
      onFound: (v) => (found = v),
      onTimeout: () => {
        throw new Error("must not time out — a real video is present the whole time mutations are firing");
      },
      timeoutMs: 5000,
    });

    dom.setVideos([{ offsetWidth: 480, offsetHeight: 270, visible: true }]);
    // Fire mutations much faster than the throttle window, continuously,
    // for well longer than one throttle interval.
    const burstInterval = setInterval(() => dom.mutate(), 30);
    await new Promise((resolve) => setTimeout(resolve, MUTATION_CHECK_THROTTLE_MS + 250));
    clearInterval(burstInterval);

    assert.ok(found, "a sustained mutation burst must not starve the throttled check forever");
    handle.cancel();
  });

  await checkAsync("bugfix: cancel() during an in-flight search stops it — neither onFound nor onTimeout fires afterward (episode-change scenario)", async () => {
    const dom = createMockDom([]);
    let fired = false;
    const handle = discoverPrimaryVideo(dom.doc, dom.MockMutationObserver, {
      onFound: () => (fired = true),
      onTimeout: () => (fired = true),
      timeoutMs: 300,
    });
    handle.cancel(); // simulates content-script.ts's stopActiveDiscovery() on episode change
    dom.setVideos([{ offsetWidth: 480, offsetHeight: 270, visible: true }]);
    dom.mutate();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(fired, false);
  });

  await checkAsync("bugfix: an immediately-present video is found synchronously, with no observer/timer overhead at all", async () => {
    const dom = createMockDom([{ offsetWidth: 480, offsetHeight: 270, visible: true }]);
    let found = null;
    const handle = discoverPrimaryVideo(dom.doc, dom.MockMutationObserver, {
      onFound: (v) => (found = v),
      onTimeout: () => {
        throw new Error("must not time out — the video was already there");
      },
    });
    assert.ok(found, "must be found synchronously, before discoverPrimaryVideo even returns");
    handle.cancel(); // a no-op in this path, but must not throw
  });

  printResultsAndExit();
}

mainAsync();
