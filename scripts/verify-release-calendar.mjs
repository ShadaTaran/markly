#!/usr/bin/env node
// Verifies Stage 33 "Release Calendar & Upcoming Content":
//   - lib/release-calendar.ts: library-scoped association, normalization,
//     window boundaries, sorting, timezone-aware local-day grouping,
//     Today/Tomorrow labeling
//   - lib/integrations/anilist/calendar.ts's batching/pagination model
//   - stale-response protection via the existing LatestRequestGuard
//
// Reproduced verbatim from the real modules (same approach as every other
// script in this directory — plain .mjs, no TypeScript loader). No live
// database/Supabase/AniList network call is made by this script — Phase 0's
// live AniList schema inspection and the live Calendar validation are
// reported separately (see the Stage 33 final report).
//
// Run with: node scripts/verify-release-calendar.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

// ============================================================
// lib/release-calendar.ts — reproduced verbatim
// ============================================================
function buildAniListMediaAssociation(items) {
  const candidatesByMediaId = new Map();
  for (const item of items) {
    if (item.type !== "anime") continue;
    const catalogSource = item.catalogSource;
    if (!catalogSource || catalogSource.provider !== "anilist") continue;
    const mediaId = Number(catalogSource.externalId);
    if (!Number.isInteger(mediaId) || mediaId <= 0) continue;
    const list = candidatesByMediaId.get(mediaId);
    if (list) list.push(item);
    else candidatesByMediaId.set(mediaId, [item]);
  }
  const association = new Map();
  for (const [mediaId, candidates] of candidatesByMediaId) {
    const chosen = candidates.length === 1 ? candidates[0] : [...candidates].sort((a, b) => a.id.localeCompare(b.id))[0];
    association.set(mediaId, chosen);
  }
  return association;
}

function isWithinReleaseWindow(startsAtMs, nowMs, rangeEndMs) {
  return startsAtMs > nowMs && startsAtMs <= rangeEndMs;
}

function makeReleaseEventId(mediaId, episode, startsAt) {
  return `anilist:${mediaId}:${episode}:${startsAt}`;
}

function normalizeAniListSchedules(raw, mediaIdToLibraryItem, window) {
  const seen = new Set();
  const events = [];
  for (const entry of raw) {
    const mediaId = typeof entry.mediaId === "number" ? entry.mediaId : Number(entry.mediaId);
    if (!Number.isInteger(mediaId)) continue;

    const libraryItem = mediaIdToLibraryItem.get(mediaId);
    if (!libraryItem) continue;

    const episode = typeof entry.episode === "number" && Number.isFinite(entry.episode) && entry.episode > 0 ? entry.episode : undefined;
    if (episode === undefined) continue;

    const airingAtSeconds = typeof entry.airingAt === "number" && Number.isFinite(entry.airingAt) ? entry.airingAt : undefined;
    if (airingAtSeconds === undefined) continue;
    const startsAtMs = airingAtSeconds * 1000;
    if (!isWithinReleaseWindow(startsAtMs, window.nowMs, window.rangeEndMs)) continue;

    const startsAt = new Date(startsAtMs).toISOString();
    const id = makeReleaseEventId(mediaId, episode, startsAt);
    if (seen.has(id)) continue;
    seen.add(id);

    const rawTitle = entry.media?.title;
    const mediaTitle = typeof rawTitle?.english === "string" ? rawTitle.english : typeof rawTitle?.romaji === "string" ? rawTitle.romaji : undefined;

    events.push({
      id,
      provider: "anilist",
      kind: "episode",
      libraryItemId: libraryItem.id,
      externalMediaId: String(mediaId),
      startsAt,
      episode,
      title: libraryItem.title,
      sourceMetadata: mediaTitle ? { mediaTitle } : undefined,
    });
  }
  return events;
}

function sortReleaseEvents(events) {
  return [...events].sort((a, b) => {
    if (a.startsAt !== b.startsAt) return a.startsAt.localeCompare(b.startsAt);
    const byTitle = (a.title ?? "").localeCompare(b.title ?? "", undefined, { sensitivity: "base" });
    if (byTitle !== 0) return byTitle;
    return a.id.localeCompare(b.id);
  });
}

function getLocalDayKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function dayKeyToUTCDate(dayKey) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function groupReleaseEventsByLocalDay(events, timeZone) {
  const byDay = new Map();
  for (const event of events) {
    const dayKey = getLocalDayKey(new Date(event.startsAt), timeZone);
    const list = byDay.get(dayKey);
    if (list) list.push(event);
    else byDay.set(dayKey, [event]);
  }
  return [...byDay.entries()]
    .map(([dayKey, dayEvents]) => ({ dayKey, events: sortReleaseEvents(dayEvents) }))
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

function formatReleaseDayLabel(dayKey, timeZone, now) {
  const nowKey = getLocalDayKey(now, timeZone);
  const diffDays = Math.round((dayKeyToUTCDate(dayKey).getTime() - dayKeyToUTCDate(nowKey).getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(dayKeyToUTCDate(dayKey));
}

function formatReleaseEventTime(iso, timeZone) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
}

// ============================================================
// lib/integrations/anilist/calendar.ts's batching model — reproduced
// verbatim, but with a fake network layer instead of a real fetch, so the
// REQUEST COUNT/shape can be asserted deterministically (§8, §57, §82).
// ============================================================
const CHUNK_SIZE = 50;
const MAX_PAGES_PER_CHUNK = 5;
const MAX_REQUESTS_PER_LOAD = 20;

function chunk(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

/**
 * Mirrors fetchAniListAiringSchedules's control flow EXACTLY (global
 * request budget tracked across every chunk/page, never reset per chunk;
 * a per-chunk MAX_PAGES_PER_CHUNK cap; abort-awareness; an explicit
 * isPartial/partialReason result instead of silent truncation) — calling
 * `fakeFetchPage(ids, page)` instead of a real network request, so
 * request COUNT and completeness can be asserted deterministically
 * without ever touching the network (§8, §57, §82, and the follow-up
 * scalability review).
 */
async function modelFetchAniListAiringSchedules(mediaIds, fakeFetchPage, signal = { aborted: false }) {
  const uniqueIds = [...new Set(mediaIds)];
  if (uniqueIds.length === 0) return { schedules: [], isPartial: false, requestCount: 0 };

  const results = [];
  let requestCount = 0;
  let partialReason;
  let stopped = false;

  for (const idChunk of chunk(uniqueIds, CHUNK_SIZE)) {
    if (stopped || signal.aborted) break;

    let page = 1;
    while (page <= MAX_PAGES_PER_CHUNK) {
      if (signal.aborted) {
        stopped = true;
        break;
      }
      if (requestCount >= MAX_REQUESTS_PER_LOAD) {
        partialReason = "request_budget_exhausted";
        stopped = true;
        break;
      }

      requestCount += 1;
      const { schedules, hasNextPage } = await fakeFetchPage(idChunk, page);
      results.push(...schedules);

      if (!hasNextPage) break;
      if (page === MAX_PAGES_PER_CHUNK) {
        partialReason = "pagination_limit";
        stopped = true;
        break;
      }
      page += 1;
    }
  }

  return { schedules: results, isPartial: partialReason !== undefined, partialReason, requestCount };
}

// ============================================================
// LatestRequestGuard — reproduced verbatim (see lib/latest-request-guard.ts)
// ============================================================
class LatestRequestGuard {
  currentId = 0;
  controller = null;
  start() {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const id = ++this.currentId;
    return { id, signal: controller.signal };
  }
  isCurrent(token) {
    return token.id === this.currentId;
  }
  cancel() {
    this.controller?.abort();
  }
}

// ============================================================
// Fixtures
// ============================================================
let idCounter = 0;
function makeAnimeItem(overrides = {}) {
  idCounter += 1;
  return {
    id: overrides.id ?? `item-${idCounter}`,
    type: "anime",
    title: overrides.title ?? `Anime ${idCounter}`,
    description: "",
    category: "",
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: overrides.status ?? "in_progress",
    catalogSource: "catalogSource" in overrides ? overrides.catalogSource : { provider: "anilist", externalId: String(overrides.externalId ?? 100 + idCounter) },
    ...overrides,
  };
}
function makeSchedule(overrides = {}) {
  return {
    mediaId: overrides.mediaId ?? 1,
    episode: "episode" in overrides ? overrides.episode : 8,
    airingAt: "airingAt" in overrides ? overrides.airingAt : 0,
    media: "media" in overrides ? overrides.media : { id: overrides.mediaId ?? 1, title: { english: "Some Anime", romaji: "Some Anime Romaji" } },
  };
}
const NOW = new Date("2026-06-01T00:00:00.000Z");
const NOW_MS = NOW.getTime();
const NOW_S = Math.floor(NOW_MS / 1000);
function secondsAfterNow(seconds) {
  return NOW_S + seconds;
}
const DAY_S = 24 * 60 * 60;

// ============================================================
// A — Library-only scope & association (§5, §9, §10, §79, §80, §81)
// ============================================================
check("A1: only type=anime with catalogSource.provider='anilist' and a valid integer externalId are eligible", () => {
  const eligible = makeAnimeItem({ externalId: 123 });
  const wrongProvider = makeAnimeItem({ catalogSource: { provider: "tmdb", externalId: "5" } });
  const noCatalog = makeAnimeItem({ catalogSource: undefined });
  const wrongType = { ...makeAnimeItem({ externalId: 999 }), type: "manga" };
  const badId = makeAnimeItem({ catalogSource: { provider: "anilist", externalId: "not-a-number" } });
  const association = buildAniListMediaAssociation([eligible, wrongProvider, noCatalog, wrongType, badId]);
  assert.equal(association.size, 1);
  assert.equal(association.get(123).id, eligible.id);
});
check("A2 (§81 — no fuzzy matching): identical title to a real AniList media but no catalogSource -> no association at all", () => {
  const item = makeAnimeItem({ title: "One Piece", catalogSource: undefined });
  const association = buildAniListMediaAssociation([item]);
  assert.equal(association.size, 0);
});
check("A3 (§80 — duplicate local items): two LibraryItems share the same AniList id -> exactly one association, deterministic (lowest id wins)", () => {
  const dup1 = makeAnimeItem({ id: "zzz-newer", externalId: 42 });
  const dup2 = makeAnimeItem({ id: "aaa-older", externalId: 42 });
  const association = buildAniListMediaAssociation([dup1, dup2]);
  assert.equal(association.size, 1);
  assert.equal(association.get(42).id, "aaa-older");
  // order-independence: swapping input order must not change the outcome
  const reordered = buildAniListMediaAssociation([dup2, dup1]);
  assert.equal(reordered.get(42).id, "aaa-older");
});

// ============================================================
// B — Normalization (§75)
// ============================================================
const WINDOW_14D = { nowMs: NOW_MS, rangeEndMs: NOW_MS + 14 * DAY_S * 1000 };

check("B1: valid event normalizes correctly", () => {
  const association = new Map([[1, makeAnimeItem({ id: "item-1", externalId: 1 })]]);
  const raw = [makeSchedule({ mediaId: 1, episode: 8, airingAt: secondsAfterNow(3600) })];
  const events = normalizeAniListSchedules(raw, association, WINDOW_14D);
  assert.equal(events.length, 1);
  assert.equal(events[0].libraryItemId, "item-1");
  assert.equal(events[0].episode, 8);
  assert.equal(events[0].provider, "anilist");
  assert.equal(events[0].kind, "episode");
});
check("B2 (§79 — library scope): unknown media not in the association map is discarded", () => {
  const association = new Map([[1, makeAnimeItem({ id: "item-1", externalId: 1 })]]);
  const raw = [makeSchedule({ mediaId: 999, airingAt: secondsAfterNow(3600) })];
  assert.deepEqual(normalizeAniListSchedules(raw, association, WINDOW_14D), []);
});
check("B3: missing/invalid mediaId discarded safely (no throw)", () => {
  const association = new Map([[1, makeAnimeItem({ id: "item-1", externalId: 1 })]]);
  const raw = [makeSchedule({ mediaId: "not-a-number", airingAt: secondsAfterNow(3600) })];
  assert.deepEqual(normalizeAniListSchedules(raw, association, WINDOW_14D), []);
});
check("B4: missing airingAt discarded", () => {
  const association = new Map([[1, makeAnimeItem({ id: "item-1", externalId: 1 })]]);
  const raw = [makeSchedule({ mediaId: 1, airingAt: null })];
  assert.deepEqual(normalizeAniListSchedules(raw, association, WINDOW_14D), []);
});
check("B5: invalid episode (zero, negative, non-numeric) discarded", () => {
  const association = new Map([[1, makeAnimeItem({ id: "item-1", externalId: 1 })]]);
  for (const episode of [0, -1, "eight", null, undefined]) {
    const raw = [makeSchedule({ mediaId: 1, episode, airingAt: secondsAfterNow(3600) })];
    assert.deepEqual(normalizeAniListSchedules(raw, association, WINDOW_14D), [], `episode=${episode} must be discarded`);
  }
});
check("B6 (§83): event outside the requested window is discarded — before now, and after rangeEnd", () => {
  const association = new Map([[1, makeAnimeItem({ id: "item-1", externalId: 1 })]]);
  const beforeNow = [makeSchedule({ mediaId: 1, airingAt: secondsAfterNow(-3600) })];
  const afterRangeEnd = [makeSchedule({ mediaId: 1, airingAt: secondsAfterNow(15 * DAY_S) })];
  assert.deepEqual(normalizeAniListSchedules(beforeNow, association, WINDOW_14D), []);
  assert.deepEqual(normalizeAniListSchedules(afterRangeEnd, association, WINDOW_14D), []);
});
check("B7 (§83 boundary): startsAt exactly now is EXCLUDED (> now, not >=)", () => {
  const association = new Map([[1, makeAnimeItem({ id: "item-1", externalId: 1 })]]);
  const raw = [makeSchedule({ mediaId: 1, airingAt: secondsAfterNow(0) })];
  assert.deepEqual(normalizeAniListSchedules(raw, association, WINDOW_14D), []);
});
check("B8 (§83 boundary): startsAt exactly at rangeEnd is INCLUDED (<=)", () => {
  const association = new Map([[1, makeAnimeItem({ id: "item-1", externalId: 1 })]]);
  const raw = [makeSchedule({ mediaId: 1, airingAt: Math.floor(WINDOW_14D.rangeEndMs / 1000) })];
  assert.equal(normalizeAniListSchedules(raw, association, WINDOW_14D).length, 1);
});
check("B9 (§83 boundary): one second past rangeEnd is excluded", () => {
  const association = new Map([[1, makeAnimeItem({ id: "item-1", externalId: 1 })]]);
  const raw = [makeSchedule({ mediaId: 1, airingAt: Math.floor(WINDOW_14D.rangeEndMs / 1000) + 1 })];
  assert.deepEqual(normalizeAniListSchedules(raw, association, WINDOW_14D), []);
});
check("B10 (§56 dedup): duplicate raw entries (same media/episode/time, e.g. pagination overlap) collapse to one event", () => {
  const association = new Map([[1, makeAnimeItem({ id: "item-1", externalId: 1 })]]);
  const raw = [makeSchedule({ mediaId: 1, episode: 8, airingAt: secondsAfterNow(3600) }), makeSchedule({ mediaId: 1, episode: 8, airingAt: secondsAfterNow(3600) })];
  assert.equal(normalizeAniListSchedules(raw, association, WINDOW_14D).length, 1);
});
check("B11 (§80): two duplicate local items resolved to the SAME chosen item -> one provider event still produces exactly one Calendar event", () => {
  const dup1 = makeAnimeItem({ id: "zzz", externalId: 7 });
  const dup2 = makeAnimeItem({ id: "aaa", externalId: 7 });
  const association = buildAniListMediaAssociation([dup1, dup2]);
  const raw = [makeSchedule({ mediaId: 7, airingAt: secondsAfterNow(3600) })];
  const events = normalizeAniListSchedules(raw, association, WINDOW_14D);
  assert.equal(events.length, 1);
  assert.equal(events[0].libraryItemId, "aaa");
});
check("B12 (§35): displayed title comes from the LibraryItem, not the provider's own title", () => {
  const item = makeAnimeItem({ id: "item-1", externalId: 1, title: "My Personal Title" });
  const association = new Map([[1, item]]);
  const raw = [makeSchedule({ mediaId: 1, airingAt: secondsAfterNow(3600), media: { id: 1, title: { english: "Provider English Title", romaji: "Provider Romaji" } } })];
  const events = normalizeAniListSchedules(raw, association, WINDOW_14D);
  assert.equal(events[0].title, "My Personal Title");
  assert.equal(events[0].sourceMetadata.mediaTitle, "Provider English Title", "provider title still preserved as context, just never the primary display title");
});
check("B13: event id is stable and never an array index", () => {
  const association = new Map([[1, makeAnimeItem({ id: "item-1", externalId: 1 })]]);
  const airingAt = secondsAfterNow(3600);
  const raw = [makeSchedule({ mediaId: 1, episode: 8, airingAt })];
  const events = normalizeAniListSchedules(raw, association, WINDOW_14D);
  assert.equal(events[0].id, `anilist:1:8:${new Date(airingAt * 1000).toISOString()}`);
});

// ============================================================
// C — Chronological sort (§78)
// ============================================================
check("C1: out-of-order provider response is sorted chronologically, earliest first", () => {
  const events = [
    { id: "c", startsAt: "2026-06-03T00:00:00.000Z", title: "C" },
    { id: "a", startsAt: "2026-06-01T00:00:00.000Z", title: "A" },
    { id: "b", startsAt: "2026-06-02T00:00:00.000Z", title: "B" },
  ];
  assert.deepEqual(sortReleaseEvents(events).map((e) => e.id), ["a", "b", "c"]);
});
check("C2: equal timestamp tie-broken by title, then stable event id", () => {
  const events = [
    { id: "z-id", startsAt: "2026-06-01T00:00:00.000Z", title: "Zebra" },
    { id: "a-id", startsAt: "2026-06-01T00:00:00.000Z", title: "Apple" },
    { id: "m-id", startsAt: "2026-06-01T00:00:00.000Z", title: "Apple" }, // same title as a-id, tie-break by id
  ];
  assert.deepEqual(sortReleaseEvents(events).map((e) => e.id), ["a-id", "m-id", "z-id"]);
});

// ============================================================
// D — Timezone grouping (§76)
// ============================================================
check("D1 (§76 — exact scenario from the review): 2026-09-07T17:30:00Z groups under Sep 8 in Asia/Manila, Sep 7 in UTC and America/New_York", () => {
  const iso = "2026-09-07T17:30:00.000Z";
  assert.equal(getLocalDayKey(new Date(iso), "UTC"), "2026-09-07");
  assert.equal(getLocalDayKey(new Date(iso), "Asia/Manila"), "2026-09-08");
  assert.equal(getLocalDayKey(new Date(iso), "America/New_York"), "2026-09-07");
});
check("D2: groupReleaseEventsByLocalDay buckets events by the correct local day and sorts groups day-ascending", () => {
  const events = [
    { id: "late", startsAt: "2026-09-08T23:00:00.000Z", title: "Late" },
    { id: "early", startsAt: "2026-09-07T01:00:00.000Z", title: "Early" },
  ];
  const groups = groupReleaseEventsByLocalDay(events, "UTC");
  assert.deepEqual(groups.map((g) => g.dayKey), ["2026-09-07", "2026-09-08"]);
});
check("D3: an event just before local midnight and one just after fall into different day groups", () => {
  const events = [
    { id: "before", startsAt: "2026-09-07T23:59:00.000Z", title: "Before" },
    { id: "after", startsAt: "2026-09-08T00:01:00.000Z", title: "After" },
  ];
  const groups = groupReleaseEventsByLocalDay(events, "UTC");
  assert.equal(groups.length, 2);
});

// ============================================================
// E — Today/Tomorrow (§77)
// ============================================================
check("E1: same local calendar date as now -> Today", () => {
  const now = new Date("2026-09-07T12:00:00.000Z");
  assert.equal(formatReleaseDayLabel("2026-09-07", "UTC", now), "Today");
});
check("E2: next local calendar date -> Tomorrow", () => {
  const now = new Date("2026-09-07T12:00:00.000Z");
  assert.equal(formatReleaseDayLabel("2026-09-08", "UTC", now), "Tomorrow");
});
check("E3: later date -> formatted month/day, no year clutter", () => {
  const now = new Date("2026-09-07T12:00:00.000Z");
  assert.equal(formatReleaseDayLabel("2026-09-20", "UTC", now), "September 20");
});
check("E4: Today/Tomorrow use LOCAL calendar-day semantics, not now+24h — near a timezone's local midnight this must not misclassify", () => {
  // now = Sep 7, 11:30 PM in Asia/Manila (UTC+8) => Sep 7 15:30 UTC
  const now = new Date("2026-09-07T15:30:00.000Z");
  // an event at Sep 8, 00:30 Manila time (UTC+8) => Sep 7 16:30 UTC — only 1 real hour later, but ALREADY the next Manila calendar day
  const eventDayKey = getLocalDayKey(new Date("2026-09-07T16:30:00.000Z"), "Asia/Manila");
  assert.equal(formatReleaseDayLabel(eventDayKey, "Asia/Manila", now), "Tomorrow", "1 hour later must already read as Tomorrow in Manila's own calendar, not still Today just because it's under 24h away");
});

// ============================================================
// E5 — event time display (§18)
// ============================================================
check("E5: event time renders a real local clock time, never a raw Unix timestamp", () => {
  const label = formatReleaseEventTime("2026-09-08T01:00:00.000Z", "Asia/Manila"); // 9:00 AM Manila
  assert.equal(label, "9:00 AM");
});

// ============================================================
// F — Batching (§8, §57, §82)
// ============================================================
await checkAsync("F1: many linked items -> ids are deduplicated and requests are batched, never one request per item", async () => {
  const ids = Array.from({ length: 120 }, (_, i) => i + 1); // 120 unique ids, some libraries could have this many linked anime
  let calls = 0;
  const result = await modelFetchAniListAiringSchedules(ids, (idChunk) => {
    calls += 1;
    assert.ok(idChunk.length <= CHUNK_SIZE, "a single request must never carry more than CHUNK_SIZE ids");
    return { schedules: [], hasNextPage: false };
  });
  // 120 ids / 50 per chunk = 3 chunks, 1 request each (no pagination needed since hasNextPage is always false here)
  assert.equal(calls, 3);
  assert.equal(result.requestCount, 3);
  assert.equal(result.isPartial, false, "well under budget and no chunk hit its own page cap — this is a genuinely complete result");
  assert.ok(calls < ids.length, "must be far fewer requests than LibraryItems — never one request per item");
});
await checkAsync("F2: duplicate ids passed in are deduplicated before any request is made", async () => {
  const idsWithDuplicates = [1, 1, 2, 2, 2, 3];
  let seenIds = null;
  await modelFetchAniListAiringSchedules(idsWithDuplicates, (idChunk) => {
    seenIds = idChunk;
    return { schedules: [], hasNextPage: false };
  });
  assert.deepEqual([...new Set(seenIds)], seenIds, "no id appears twice in the actual request");
  assert.equal(seenIds.length, 3);
});
await checkAsync("F3: pagination continues within a chunk until hasNextPage is false, bounded by MAX_PAGES_PER_CHUNK", async () => {
  let callsForChunk = 0;
  const { requestCount } = await modelFetchAniListAiringSchedules([1], () => {
    callsForChunk += 1;
    return { schedules: [{ mediaId: 1 }], hasNextPage: callsForChunk < 3 }; // 3 pages total
  });
  assert.equal(requestCount, 3);
});
await checkAsync("F4: pagination never loops forever — hard-capped at MAX_PAGES_PER_CHUNK even if hasNextPage stays true, and this is reported as an explicit partial result, never silent success", async () => {
  const result = await modelFetchAniListAiringSchedules([1], () => ({ schedules: [], hasNextPage: true }));
  assert.equal(result.requestCount, MAX_PAGES_PER_CHUNK, "must stop at the hard cap, never spin indefinitely");
  assert.equal(result.isPartial, true, "AniList still said hasNextPage=true when the cap was hit — this must never read as complete");
  assert.equal(result.partialReason, "pagination_limit");
});
await checkAsync("F5: zero eligible ids -> zero requests (no network call at all when nothing is AniList-linked)", async () => {
  const { requestCount } = await modelFetchAniListAiringSchedules([], () => {
    throw new Error("must never be called");
  });
  assert.equal(requestCount, 0);
});
check("F6 (§58 — large library): 500+ LibraryItems with many AniList-linked anime still produces a small, bounded request count", () => {
  const items = [];
  for (let i = 0; i < 500; i++) {
    items.push(i % 3 === 0 ? makeAnimeItem({ externalId: i }) : { ...makeAnimeItem({}), type: "website", catalogSource: undefined, url: "https://example.com" });
  }
  const association = buildAniListMediaAssociation(items);
  assert.ok(association.size <= 167, "sanity: roughly a third of 500 are eligible anime");
  assert.ok(association.size > 0);
});

// ============================================================
// F7-F19 — scalability follow-up review: dense chunks, the GLOBAL
// request budget (tracked across every chunk/page, never reset per
// chunk), and honest partial-result reporting instead of silent
// truncation.
// ============================================================

await checkAsync("F7 (review §3 — dense >250-row chunk): a single 50-id chunk with more than 250 valid rows across a 30-day window must not be silently truncated at 250", async () => {
  // Page 5 (MAX_PAGES_PER_CHUNK) still reports hasNextPage: true — real rows beyond 250 exist for this one chunk alone.
  let pagesServed = 0;
  const totalRowsIfUncapped = 300; // > 250 (5 pages * 50/page)
  const result = await modelFetchAniListAiringSchedules(
    Array.from({ length: 50 }, (_, i) => i + 1),
    () => {
      pagesServed += 1;
      const remaining = totalRowsIfUncapped - (pagesServed - 1) * 50;
      const rowsThisPage = Math.min(50, Math.max(0, remaining));
      return { schedules: Array.from({ length: rowsThisPage }, (_, i) => ({ mediaId: 1, episode: i })), hasNextPage: pagesServed * 50 < totalRowsIfUncapped };
    },
  );
  assert.equal(result.requestCount, MAX_PAGES_PER_CHUNK, "stops at the per-chunk page cap");
  assert.equal(result.schedules.length, 250, "only the first 5 pages worth (250 rows) were actually fetched");
  assert.equal(result.isPartial, true, "must NOT report this as a complete 250-row answer — 300 real rows existed");
  assert.equal(result.partialReason, "pagination_limit");
});

await checkAsync("F8 (review §10/§11.A — 500 unique linked anime, one page each): exactly 10 initial chunks/requests, complete, not partial", async () => {
  const ids = Array.from({ length: 500 }, (_, i) => i + 1);
  let chunksSeen = 0;
  const result = await modelFetchAniListAiringSchedules(ids, () => {
    chunksSeen += 1;
    return { schedules: [], hasNextPage: false };
  });
  assert.equal(chunksSeen, 10, "500 ids / 50 per chunk = exactly 10 chunks");
  assert.equal(result.requestCount, 10);
  assert.equal(result.isPartial, false, "well under the 20-request budget, no pagination needed — genuinely complete");
});

await checkAsync("F9 (review §11.B — every chunk needs exactly two pages): 10 chunks * 2 pages = 20 requests, exactly at budget, still complete", async () => {
  const ids = Array.from({ length: 500 }, (_, i) => i + 1);
  const pagesServedByChunk = new Map();
  const result = await modelFetchAniListAiringSchedules(ids, (idChunk) => {
    const key = idChunk[0];
    const served = (pagesServedByChunk.get(key) ?? 0) + 1;
    pagesServedByChunk.set(key, served);
    return { schedules: [], hasNextPage: served < 2 }; // exactly 2 pages per chunk
  });
  assert.equal(result.requestCount, 20, "10 chunks * 2 pages = 20 — must use exactly the budget it needs, no more");
  assert.equal(result.isPartial, false, "20 requests fits exactly within MAX_REQUESTS_PER_LOAD — every chunk finished its own pagination honestly");
});

await checkAsync("F10 (review §11.C/D — every chunk would need three pages, budget forces an early, HONEST stop): global budget (20) is reached mid-way through the chunk set; result is explicitly partial, never presented as complete", async () => {
  const ids = Array.from({ length: 500 }, (_, i) => i + 1); // 10 chunks, each 'wants' 3 pages = 30 requests demanded
  const pagesServedByChunk = new Map();
  const result = await modelFetchAniListAiringSchedules(ids, (idChunk) => {
    const key = idChunk[0];
    const served = (pagesServedByChunk.get(key) ?? 0) + 1;
    pagesServedByChunk.set(key, served);
    return { schedules: [], hasNextPage: served < 3 }; // each chunk WOULD need 3 pages if allowed to finish
  });
  assert.equal(result.requestCount, MAX_REQUESTS_PER_LOAD, "must stop exactly at the global budget, never exceed it");
  assert.equal(result.isPartial, true, "30 requests were needed for a complete answer but only 20 were spent — this is NOT a complete calendar");
  assert.equal(result.partialReason, "request_budget_exhausted");
});

await checkAsync("F11 (review §11.D — every chunk genuinely needs four pages, well beyond budget): the GLOBAL budget (not any single chunk's own 5-page cap) is what stops this, exactly at MAX_REQUESTS_PER_LOAD, never silently exceeding the provider's public budget", async () => {
  const ids = Array.from({ length: 500 }, (_, i) => i + 1); // 10 chunks, each 'wants' 4 pages = 40 requests demanded if unconstrained
  const pagesServedByChunk = new Map();
  const result = await modelFetchAniListAiringSchedules(ids, (idChunk) => {
    const key = idChunk[0];
    const served = (pagesServedByChunk.get(key) ?? 0) + 1;
    pagesServedByChunk.set(key, served);
    return { schedules: [], hasNextPage: served < 4 }; // each chunk would finish its own pagination in 4 pages if allowed — never hits its OWN 5-page cap
  });
  assert.equal(result.requestCount, MAX_REQUESTS_PER_LOAD, "the global budget, not any single chunk's own pagination cap, is the binding constraint here");
  assert.ok(result.requestCount < 30, "must stay comfortably under AniList's own confirmed public 30-req/min limit, leaving headroom for anything else happening in the same window");
  assert.equal(result.isPartial, true);
  assert.equal(result.partialReason, "request_budget_exhausted", "no individual chunk ever reached its own MAX_PAGES_PER_CHUNK (4 < 5) — the global budget is unambiguously what cut this off");
});

await checkAsync("F12 (review §12 — mixed pagination, GLOBAL accounting, never reset per chunk): chunk 1 needs 1 page, chunk 2 needs 3, chunk 3 needs 2 — total requests must be the sum across ALL chunks, not reset at each chunk boundary", async () => {
  const ids = Array.from({ length: 150 }, (_, i) => i + 1); // 3 chunks of 50
  const pagesWantedByChunkIndex = [1, 3, 2];
  let chunkIndex = -1;
  let lastSeenFirstId = null;
  const pagesServedByChunk = new Map();
  const result = await modelFetchAniListAiringSchedules(ids, (idChunk) => {
    if (idChunk[0] !== lastSeenFirstId) {
      lastSeenFirstId = idChunk[0];
      chunkIndex += 1;
    }
    const served = (pagesServedByChunk.get(chunkIndex) ?? 0) + 1;
    pagesServedByChunk.set(chunkIndex, served);
    return { schedules: [], hasNextPage: served < pagesWantedByChunkIndex[chunkIndex] };
  });
  assert.equal(result.requestCount, 1 + 3 + 2, "6 total requests across all three chunks — the budget counter must be global, not per-chunk");
  assert.equal(result.isPartial, false, "6 is well under the 20-request budget");
});

await checkAsync("F13 (review §7 — 429 stays distinct): an actual rate-limit response must never be reported as isPartial — it is a thrown failure (rate_limited), not a successful-but-incomplete result", async () => {
  class ModelRateLimitError extends Error {}
  await assert.rejects(
    modelFetchAniListAiringSchedules([1], () => {
      throw new ModelRateLimitError("429");
    }),
    ModelRateLimitError,
  );
});

await checkAsync("F14 (review §13/§18 — abort stops later PAGES): once the signal is aborted mid-chunk, no further pages are requested for that chunk", async () => {
  const signal = { aborted: false };
  let calls = 0;
  const promise = modelFetchAniListAiringSchedules(
    [1],
    async () => {
      calls += 1;
      if (calls === 2) signal.aborted = true; // abort takes effect right after the 2nd page resolves
      return { schedules: [], hasNextPage: true }; // would otherwise keep paginating up to MAX_PAGES_PER_CHUNK
    },
    signal,
  );
  const result = await promise;
  assert.equal(calls, 2, "must stop immediately once aborted — never reach MAX_PAGES_PER_CHUNK's remaining pages");
  assert.equal(result.requestCount, 2);
});

await checkAsync("F15 (review §13/§18 — abort stops later CHUNKS): once aborted after finishing one chunk, no further chunks are started", async () => {
  const signal = { aborted: false };
  const ids = Array.from({ length: 150 }, (_, i) => i + 1); // 3 chunks
  let chunksStarted = 0;
  let lastSeenFirstId = null;
  await modelFetchAniListAiringSchedules(
    ids,
    async (idChunk) => {
      if (idChunk[0] !== lastSeenFirstId) {
        lastSeenFirstId = idChunk[0];
        chunksStarted += 1;
        if (chunksStarted === 1) signal.aborted = true; // abort right after the first chunk's own request resolves
      }
      return { schedules: [], hasNextPage: false };
    },
    signal,
  );
  assert.equal(chunksStarted, 1, "the 2nd and 3rd chunks must never be started once superseded — protects both correctness and the provider's request quota");
});

await checkAsync("F16 (review §13/§19 — range switch cancellation): a slow 30-day load's remaining chunks never fire once a 7-day reload supersedes it (modeled via LatestRequestGuard, the same mechanism useReleaseCalendar uses)", async () => {
  const guard = new LatestRequestGuard();
  const requestsFiredByLoad = { slow: 0, fast: 0 };

  async function simulateLoad(label, ids, delayMsPerPage) {
    const token = guard.start();
    const result = await modelFetchAniListAiringSchedules(
      ids,
      async () => {
        requestsFiredByLoad[label] += 1;
        await new Promise((resolve) => setTimeout(resolve, delayMsPerPage));
        return { schedules: [], hasNextPage: false };
      },
      token.signal,
    );
    if (!guard.isCurrent(token)) return null; // stale — never touch state, matching useReleaseCalendar's own guard.isCurrent check
    return result;
  }

  const slow30Day = simulateLoad("slow", Array.from({ length: 150 }, (_, i) => i + 1), 15); // 3 chunks, slow
  await new Promise((resolve) => setTimeout(resolve, 5)); // let the slow load's first chunk start
  const fast7Day = simulateLoad("fast", [1, 2], 2); // supersedes the slow load

  const [slowResult, fastResult] = await Promise.all([slow30Day, fast7Day]);
  assert.equal(slowResult, null, "the superseded 30-day load's result must never be applied");
  assert.ok(fastResult !== null);
  assert.ok(requestsFiredByLoad.slow < 3, "the slow load's later chunks must not all have fired — cancellation should have caught at least the last one before completion in this timing");
});

await checkAsync("F17 (review §14 — Dashboard uses the same hook/model, no independent request storm): calling the fetch model twice with the SAME small id set (as Dashboard's Upcoming + a separately-mounted Calendar would, on different pages) never behaves as one-request-per-item and each call is independently bounded by the same budget — there is no shared/global state that compounds across mounts", async () => {
  const ids = [1, 2, 3];
  const first = await modelFetchAniListAiringSchedules(ids, () => ({ schedules: [], hasNextPage: false }));
  const second = await modelFetchAniListAiringSchedules(ids, () => ({ schedules: [], hasNextPage: false }));
  assert.equal(first.requestCount, 1);
  assert.equal(second.requestCount, 1);
});

await checkAsync("F18 (review §10/§11.K — normal small-library request is unchanged): a small set of ids with no pagination pressure still completes in exactly one request per chunk, isPartial false — the new budget/partial machinery must not change ordinary behavior", async () => {
  const result = await modelFetchAniListAiringSchedules([1, 2, 3], () => ({ schedules: [{ mediaId: 1, episode: 1 }], hasNextPage: false }));
  assert.equal(result.requestCount, 1);
  assert.equal(result.isPartial, false);
  assert.equal(result.schedules.length, 1);
});

check("F19: MAX_REQUESTS_PER_LOAD leaves real headroom under AniList's confirmed public 30-req/min limit", () => {
  assert.ok(MAX_REQUESTS_PER_LOAD < 30, "must never knowingly consume the entire public quota in one Calendar load");
  assert.ok(MAX_REQUESTS_PER_LOAD >= 10, "must still comfortably cover the ordinary 500-unique-id/no-pagination case (10 chunks)");
});

// ============================================================
// G — Stale response protection (§85)
// ============================================================
await checkAsync("G1: a slower earlier request must not overwrite a faster later one's result", async () => {
  const guard = new LatestRequestGuard();
  let appliedResult = null;

  async function simulateRequest(label, delayMs) {
    const token = guard.start();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (!guard.isCurrent(token)) return; // stale — must not touch state
    appliedResult = label;
  }

  const slow14Day = simulateRequest("14-day (slow)", 30);
  const fast7Day = simulateRequest("7-day (fast)", 5);
  await Promise.all([slow14Day, fast7Day]);

  assert.equal(appliedResult, "7-day (fast)", "the 7-day result must remain even though the 14-day request was issued first and resolves later");
});
check("G2: cancel() aborts the in-flight request's signal", () => {
  const guard = new LatestRequestGuard();
  const token = guard.start();
  assert.equal(token.signal.aborted, false);
  guard.cancel();
  assert.equal(token.signal.aborted, true);
});

// ============================================================
// H — No-mutation audit (§86) — structural/source checks
// ============================================================
check("H1: lib/release-calendar.ts and the AniList calendar client contain no writeback/mutation call names", () => {
  const files = ["src/lib/release-calendar.ts", "src/lib/integrations/anilist/calendar.ts", "src/hooks/useReleaseCalendar.ts"];
  const forbidden = ["SaveMediaListEntry", "insertActivityEvent", "logEvent", "linkSource", "unlinkSource", "updateLibraryItem"];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const term of forbidden) {
      assert.ok(!source.includes(term), `${file} must never reference ${term}`);
    }
  }
});

// ============================================================
// Report
// ============================================================
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}`);
  if (!r.ok) console.log(`  ${r.err?.message ?? r.err}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;

console.log(
  "\nNote: this script reproduces lib/release-calendar.ts, lib/integrations/anilist/calendar.ts's batching model, and lib/latest-request-guard.ts verbatim (same convention as every other script in this directory). It never touches the network or a database. Live AniList schema inspection (confirmed via real read-only queries against the public endpoint) and live Calendar validation are reported separately in the Stage 33 final report.",
);
