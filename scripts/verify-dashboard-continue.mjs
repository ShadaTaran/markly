#!/usr/bin/env node
// Verifies Stage 32 "Home Dashboard 2.0 & Universal Continue Hub":
//   - lib/dashboard.ts: formatDashboardProgress, resolveResumeTarget,
//     selectBestTrackingSource, countActiveWithinDays, getBuiltInViewItems
//   - Zero-drift consistency against lib/smart-views.ts's built-in
//     Continue/Recently Active/Stalled definitions (same engine, no second
//     interpretation)
//   - URL safety (lib/website.ts's isValidUrl) and TrackingSource display
//     (lib/extension/source-display.ts) as used by the resume resolver
//
// Reproduced verbatim from the real modules (same approach as every other
// script in this directory — plain .mjs, no TypeScript loader). No live
// database/Supabase call is made by this script.
//
// Run with: node scripts/verify-dashboard-continue.mjs

import assert from "node:assert/strict";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

// ============================================================
// lib/website.ts — reproduced verbatim
// ============================================================
function isValidUrl(value) {
  try {
    const { protocol, hostname, username, password } = new URL(value);
    if (protocol !== "http:" && protocol !== "https:") return false;
    if (username || password) return false;
    return hostname.length > 0 && (hostname.includes(".") || hostname === "localhost");
  } catch {
    return false;
  }
}

// ============================================================
// lib/extension/source-display.ts — reproduced verbatim
// ============================================================
const ADAPTER_LABELS = {
  mangadex: "MangaDex",
  "markly-test-reader": "Markly Test Reader",
  "markly-test-reader-b": "Markly Test Reader B",
  "markly-season-test": "Markly Season Test",
};
const HOSTNAME_LABELS = { "novelphoenix.com": "NovelPhoenix", "mangadex.org": "MangaDex" };

function getSourceHostname(sourceUrl) {
  if (!sourceUrl) return null;
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
// Stage 40 — a manual (Stage 40 Add Source) row's own chosen label always
// wins; every other source's display logic is unchanged from Stage 32.
function getSourceDisplayName(adapterId, sourceUrl, sourceTitle) {
  if (adapterId === "manual" && sourceTitle) return sourceTitle;
  if (ADAPTER_LABELS[adapterId]) return ADAPTER_LABELS[adapterId];
  const hostname = getSourceHostname(sourceUrl);
  if (hostname && HOSTNAME_LABELS[hostname]) return HOSTNAME_LABELS[hostname];
  return hostname ?? adapterId;
}
function sameTrustedHost(urlA, urlB) {
  const hostA = getSourceHostname(urlA);
  const hostB = getSourceHostname(urlB);
  return hostA !== null && hostB !== null && hostA === hostB;
}
function getSafeOpenSourceUrl(source) {
  const safeSourceUrl = source.sourceUrl && isValidUrl(source.sourceUrl) ? source.sourceUrl : null;
  const workUrl = source.lastDetectedMetadata?.workUrl;
  if (workUrl && isValidUrl(workUrl) && safeSourceUrl && sameTrustedHost(workUrl, safeSourceUrl)) {
    return workUrl;
  }
  return safeSourceUrl;
}

// ============================================================
// lib/tracking.ts's getProgressInfo — reproduced verbatim
// ============================================================
function getProgressInfo(item) {
  switch (item.type) {
    case "anime":
    case "series": {
      if (item.currentEpisode === undefined && item.totalEpisodes === undefined) return null;
      const current = item.currentEpisode ?? 0;
      if (item.episodeNumbering === "seasonal") {
        return {
          text: item.currentSeason !== undefined ? `Season ${item.currentSeason}, Episode ${current}` : `Episode ${current}`,
        };
      }
      if (item.totalEpisodes !== undefined) {
        return { text: `${current} / ${item.totalEpisodes} episodes`, percent: Math.min(100, (current / item.totalEpisodes) * 100) };
      }
      return { text: `${current} episode${current === 1 ? "" : "s"}` };
    }
    case "manga": {
      if (item.currentChapter === undefined && item.totalChapters === undefined) return null;
      const current = item.currentChapter ?? 0;
      if (item.totalChapters !== undefined) {
        return { text: `${current} / ${item.totalChapters} chapters`, percent: Math.min(100, (current / item.totalChapters) * 100) };
      }
      return { text: `Chapter ${current}` };
    }
    case "novel": {
      if (item.progressValue === undefined) return null;
      const unit = item.progressUnit ?? "chapter";
      if (unit === "percent") return { text: `${item.progressValue}%` };
      if (unit === "page") return { text: `Page ${item.progressValue}` };
      return { text: `Chapter ${item.progressValue}` };
    }
    case "game": {
      if (item.playtimeHours === undefined) return null;
      return { text: `${item.playtimeHours} hour${item.playtimeHours === 1 ? "" : "s"}` };
    }
    case "movie":
      return null;
    default:
      return null;
  }
}

const MEDIA_TYPES = new Set(["anime", "manga", "novel", "game", "movie", "series"]);
function isMediaItem(item) {
  return MEDIA_TYPES.has(item.type);
}
function getItemHref(item) {
  return `/library/${item.id}`;
}

// ============================================================
// lib/dashboard.ts — reproduced verbatim
// ============================================================
function formatDashboardProgress(item) {
  if (!isMediaItem(item)) return null;
  return getProgressInfo(item)?.text ?? null;
}

function byRecencyThenId(a, b) {
  const byLastSeen = b.lastSeenAt.localeCompare(a.lastSeenAt);
  if (byLastSeen !== 0) return byLastSeen;
  return a.id.localeCompare(b.id);
}

function selectBestTrackingSource(sources, itemId) {
  const eligible = sources.filter((source) => source.libraryItemId === itemId);
  const withSafeUrl = eligible.filter((source) => getSafeOpenSourceUrl(source) !== null);
  if (withSafeUrl.length === 0) return null;
  return [...withSafeUrl].sort(byRecencyThenId)[0];
}

// Stage 41 — see lib/resume.ts's own doc comment for the full rationale:
// a manual source's last_seen_at means "time added/linked", never "time
// consumed" (nothing updates it again after creation), so it can't safely
// be compared against an extension-detected source's genuinely-refreshed
// last_seen_at, or even against another manual source's own "time added".
function selectContinueSource(sources, itemId) {
  const eligible = sources.filter((source) => source.libraryItemId === itemId && getSafeOpenSourceUrl(source) !== null);
  if (eligible.length === 0) return { kind: "none" };
  if (eligible.length === 1) {
    const source = eligible[0];
    return { kind: "direct", source, url: getSafeOpenSourceUrl(source) };
  }
  const allGenuinelyTimestamped = eligible.every((source) => source.adapterId !== "manual");
  if (allGenuinelyTimestamped) {
    const best = [...eligible].sort(byRecencyThenId)[0];
    return { kind: "direct", source: best, url: getSafeOpenSourceUrl(best) };
  }
  return { kind: "choose_source", sources: [...eligible].sort(byRecencyThenId) };
}

const CONTINUE_VERB = { anime: "watching", series: "watching", movie: "watching", manga: "reading", novel: "reading", game: "playing" };
function getContinueActionLabel(item) {
  if (item.type === "website") return "Open website";
  if (!isMediaItem(item)) return "Open item";
  const verb = CONTINUE_VERB[item.type];
  switch (item.status) {
    case "planned":
      return `Start ${verb}`;
    case "in_progress":
      return `Continue ${verb}`;
    case "on_hold":
      return `Resume ${verb}`;
    case "completed":
    case "dropped":
      return "Open source";
    default:
      return "Open source";
  }
}

function ownStoredUrl(item) {
  if (item.type === "website") return item.url;
  if (isMediaItem(item)) return item.sourceUrl;
  return undefined;
}

function toResumeSourceOption(source) {
  const url = getSafeOpenSourceUrl(source);
  return {
    sourceId: source.id,
    url,
    label: getSourceDisplayName(source.adapterId, source.sourceUrl, source.sourceTitle),
    hostname: getSourceHostname(url),
    progressText: source.lastDetectedProgress ? String(source.lastDetectedProgress.value) : "No progress detected yet",
  };
}

function resolveResumeTarget(item, trackingSources) {
  if (item.type === "website") {
    const stored = ownStoredUrl(item);
    if (stored && isValidUrl(stored)) return { kind: "canonical_url", url: stored, actionLabel: "Open website", hostname: getSourceHostname(stored) ?? undefined };
    return { kind: "unavailable", reason: "no-target" };
  }
  if (!isMediaItem(item)) return { kind: "unavailable", reason: "no-target" };

  const actionLabel = getContinueActionLabel(item);
  const selection = selectContinueSource(trackingSources, item.id);

  if (selection.kind === "direct") {
    const { source, url } = selection;
    return {
      kind: "direct",
      url,
      actionLabel,
      sourceLabel: getSourceDisplayName(source.adapterId, url, source.sourceTitle),
      hostname: getSourceHostname(url) ?? undefined,
    };
  }
  if (selection.kind === "choose_source") {
    return { kind: "choose_source", actionLabel, sources: selection.sources.map(toResumeSourceOption) };
  }

  const stored = ownStoredUrl(item);
  if (stored && isValidUrl(stored)) {
    return { kind: "canonical_url", url: stored, actionLabel, hostname: getSourceHostname(stored) ?? undefined };
  }
  return { kind: "unavailable", reason: "no-target" };
}

function countActiveWithinDays(items, activitySummary, days, now) {
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const item of items) {
    const lastActivity = activitySummary.get(item.id);
    if (lastActivity !== undefined && new Date(lastActivity).getTime() >= cutoffMs) count += 1;
  }
  return count;
}

// ============================================================
// lib/smart-views.ts — the minimal subset needed for Continue/Recently
// Active/Stalled, reproduced verbatim (same engine used by the Library
// page's Smart Views bar — see verify-library-smart-views.mjs for the
// full-engine test suite; this script only re-derives what's needed to
// prove Dashboard never drifts from it).
// ============================================================
function matchesStatuses(item, statuses) {
  if (statuses.length === 0) return true;
  return "status" in item && statuses.includes(item.status);
}
function matchesActivity(item, activity, activitySummary, nowMs) {
  if (activity.mode === "any") return true;
  const last = activitySummary.get(item.id);
  if (activity.mode === "never") return last === undefined;
  if (activity.mode === "active_within") {
    if (last === undefined) return false;
    return nowMs - new Date(last).getTime() <= activity.days * 24 * 60 * 60 * 1000;
  }
  // inactive_for — never-active items count once old enough (createdAt fallback), matching Stage 31 §17/§49.
  const referenceMs = last !== undefined ? new Date(last).getTime() : new Date(item.createdAt).getTime();
  return nowMs - referenceMs >= activity.days * 24 * 60 * 60 * 1000;
}

function filterSmartViewItems(items, definition, context) {
  const nowMs = context.now.getTime();
  return items.filter(
    (item) => matchesStatuses(item, definition.statuses) && matchesActivity(item, definition.activity, context.activitySummary, nowMs),
  );
}

function compareForSort(a, b, sort, activitySummary) {
  const dir = sort.direction === "asc" ? 1 : -1;
  let primary = 0;
  if (sort.by === "lastActivity") {
    const aTime = activitySummary.get(a.id);
    const bTime = activitySummary.get(b.id);
    if (aTime === undefined && bTime === undefined) primary = 0;
    else if (aTime === undefined) primary = 1;
    else if (bTime === undefined) primary = -1;
    else primary = aTime.localeCompare(bTime) * dir;
  }
  if (primary !== 0) return primary;
  const byTitle = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  if (byTitle !== 0) return byTitle;
  return a.id.localeCompare(b.id);
}
function sortSmartViewItems(items, sort, activitySummary) {
  return [...items].sort((a, b) => compareForSort(a, b, sort, activitySummary));
}
function applySmartView(items, definition, context) {
  return sortSmartViewItems(filterSmartViewItems(items, definition, context), definition.sort, context.activitySummary);
}

const DEFAULT_ACTIVITY = { mode: "any", days: null };
const BUILT_IN_VIEWS = {
  "builtin-continue": { statuses: ["in_progress"], activity: DEFAULT_ACTIVITY, sort: { by: "lastActivity", direction: "desc" } },
  "builtin-recently-active": { statuses: [], activity: { mode: "active_within", days: 14 }, sort: { by: "lastActivity", direction: "desc" } },
  "builtin-stalled": { statuses: ["in_progress"], activity: { mode: "inactive_for", days: 30 }, sort: { by: "lastActivity", direction: "asc" } },
};
function getBuiltInViewItems(items, viewId, context) {
  const definition = BUILT_IN_VIEWS[viewId];
  if (!definition) return [];
  return applySmartView(items, definition, context);
}

// ============================================================
// Fixtures
// ============================================================
let idCounter = 0;
function makeItem(overrides = {}) {
  idCounter += 1;
  return {
    id: overrides.id ?? `item-${idCounter}`,
    type: "anime",
    title: `Item ${idCounter}`,
    description: "",
    category: "",
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "in_progress",
    ...overrides,
  };
}
function makeSource(overrides = {}) {
  // "in" checks throughout — a caller passing sourceUrl/libraryItemId
  // explicitly as null (a real, meaningful value for both fields) must
  // never be silently replaced by the default via `??`.
  return {
    id: "id" in overrides ? overrides.id : "source-1",
    adapterId: "adapterId" in overrides ? overrides.adapterId : "mangadex",
    sourceTitle: "sourceTitle" in overrides ? overrides.sourceTitle : "Some Title",
    sourceUrl: "sourceUrl" in overrides ? overrides.sourceUrl : "https://mangadex.org/title/abc",
    mediaType: "mediaType" in overrides ? overrides.mediaType : "manga",
    libraryItemId: "libraryItemId" in overrides ? overrides.libraryItemId : null,
    autoTrackEnabled: "autoTrackEnabled" in overrides ? overrides.autoTrackEnabled : true,
    lastDetectedProgress: "lastDetectedProgress" in overrides ? overrides.lastDetectedProgress : null,
    lastDetectedMetadata: overrides.lastDetectedMetadata,
    lastSeenAt: "lastSeenAt" in overrides ? overrides.lastSeenAt : "2026-01-01T00:00:00.000Z",
    autoLinkSuppressed: "autoLinkSuppressed" in overrides ? overrides.autoLinkSuppressed : false,
  };
}
function daysAgo(n, from = new Date("2026-06-01T00:00:00.000Z")) {
  return new Date(from.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}
const NOW = new Date("2026-06-01T00:00:00.000Z");

// ============================================================
// A — progress formatting (§72)
// ============================================================
check("A1: anime absolute, no total — established convention '<n> episode(s)'", () => {
  const item = makeItem({ type: "anime", currentEpisode: 14 });
  assert.equal(formatDashboardProgress(item), "14 episodes");
});
check("A1b: anime absolute, singular episode", () => {
  const item = makeItem({ type: "anime", currentEpisode: 1 });
  assert.equal(formatDashboardProgress(item), "1 episode");
});
check("A2: anime seasonal — 'Season X, Episode Y', never a fake absolute number", () => {
  const item = makeItem({ type: "anime", episodeNumbering: "seasonal", currentSeason: 2, currentEpisode: 6, totalEpisodes: 60 });
  assert.equal(formatDashboardProgress(item), "Season 2, Episode 6");
});
check("A3: manga chapter, no total", () => {
  const item = makeItem({ type: "manga", currentChapter: 42 });
  assert.equal(formatDashboardProgress(item), "Chapter 42");
});
check("A4: fractional manga chapter is shown exactly, never rounded", () => {
  const item = makeItem({ type: "manga", currentChapter: 12.5 });
  assert.equal(formatDashboardProgress(item), "Chapter 12.5");
});
check("A5: novel chapter unit", () => {
  const item = makeItem({ type: "novel", progressValue: 318, progressUnit: "chapter" });
  assert.equal(formatDashboardProgress(item), "Chapter 318");
});
check("A6: novel page unit", () => {
  const item = makeItem({ type: "novel", progressValue: 221, progressUnit: "page" });
  assert.equal(formatDashboardProgress(item), "Page 221");
});
check("A7: novel percent unit", () => {
  const item = makeItem({ type: "novel", progressValue: 43, progressUnit: "percent" });
  assert.equal(formatDashboardProgress(item), "43%");
});
check("A8: game playtime, real field only — no fabricated percentage", () => {
  const item = makeItem({ type: "game", playtimeHours: 12 });
  assert.equal(formatDashboardProgress(item), "12 hours");
});
check("A9: movie has no real progress field — returns null, never fabricated", () => {
  const item = makeItem({ type: "movie" });
  assert.equal(formatDashboardProgress(item), null);
});
check("A10: website has no progress concept at all — returns null", () => {
  const item = makeItem({ type: "website", url: "https://example.com" });
  assert.equal(formatDashboardProgress(item), null);
});
check("A11: series (seasonal) same rules as anime", () => {
  const item = makeItem({ type: "series", episodeNumbering: "seasonal", currentSeason: 3, currentEpisode: 2 });
  assert.equal(formatDashboardProgress(item), "Season 3, Episode 2");
});
check("A12: item with genuinely no progress fields set at all returns null, not 'Chapter 0'", () => {
  const item = makeItem({ type: "manga" });
  assert.equal(formatDashboardProgress(item), null);
});

// ============================================================
// B — resume URL resolution (§73, §74)
// ============================================================
check("B1: valid https TrackingSource wins over nothing else", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({ libraryItemId: "i1", sourceUrl: "https://mangadex.org/title/abc" });
  const result = resolveResumeTarget(item, [source]);
  assert.equal(result.kind, "direct");
  assert.equal(result.url, "https://mangadex.org/title/abc");
});
check("B2: valid http source accepted", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({ libraryItemId: "i1", sourceUrl: "http://example.com/x" });
  assert.equal(resolveResumeTarget(item, [source]).url, "http://example.com/x");
});
check("B3: javascript: scheme rejected, falls back unavailable (no other candidate)", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({ libraryItemId: "i1", sourceUrl: "javascript:alert(1)" });
  const result = resolveResumeTarget(item, [source]);
  assert.equal(result.kind, "unavailable");
});
check("B4: data: scheme rejected", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({ libraryItemId: "i1", sourceUrl: "data:text/html,<script>1</script>" });
  assert.equal(resolveResumeTarget(item, [source]).kind, "unavailable");
});
check("B5: file: scheme rejected", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({ libraryItemId: "i1", sourceUrl: "file:///etc/passwd" });
  assert.equal(resolveResumeTarget(item, [source]).kind, "unavailable");
});
check("B6: malformed URL rejected safely (no throw)", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({ libraryItemId: "i1", sourceUrl: "not a url at all" });
  assert.equal(resolveResumeTarget(item, [source]).kind, "unavailable");
});
check("B7: empty/null source URL treated as absent", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({ libraryItemId: "i1", sourceUrl: null });
  assert.equal(resolveResumeTarget(item, [source]).kind, "unavailable");
});
check("B8: no sources at all -> unavailable", () => {
  const item = makeItem({ id: "i1" });
  assert.equal(resolveResumeTarget(item, []).kind, "unavailable");
});
check("B9: multiple sources -> most recently seen wins", () => {
  const item = makeItem({ id: "i1" });
  const older = makeSource({ id: "s-old", libraryItemId: "i1", sourceUrl: "https://a.example/x", lastSeenAt: "2026-01-01T00:00:00.000Z" });
  const newer = makeSource({ id: "s-new", libraryItemId: "i1", sourceUrl: "https://b.example/x", lastSeenAt: "2026-02-01T00:00:00.000Z" });
  const result = resolveResumeTarget(item, [older, newer]);
  assert.equal(result.url, "https://b.example/x");
});
check("B10: identical lastSeenAt -> deterministic id tie-break, stable across calls", () => {
  const item = makeItem({ id: "i1" });
  const sameTime = "2026-01-01T00:00:00.000Z";
  const sourceA = makeSource({ id: "aaa", libraryItemId: "i1", sourceUrl: "https://a.example/x", lastSeenAt: sameTime });
  const sourceB = makeSource({ id: "zzz", libraryItemId: "i1", sourceUrl: "https://b.example/x", lastSeenAt: sameTime });
  const first = resolveResumeTarget(item, [sourceA, sourceB]);
  const second = resolveResumeTarget(item, [sourceB, sourceA]); // order-independent
  assert.equal(first.url, "https://a.example/x", "lower id wins the tie deterministically");
  assert.equal(second.url, first.url, "input order must not change the outcome");
});
check("B11: unavailable when no safe resume source exists at all", () => {
  const item = makeItem({ id: "i1", type: "movie" });
  assert.deepEqual(resolveResumeTarget(item, []), { kind: "unavailable", reason: "no-target" });
});
check("B12 (§74): catalogSource.provider = 'anilist' is never treated as a resume source — no url field exists on it, and it plays no role in resolution at all", () => {
  const item = makeItem({ id: "i1", type: "anime", catalogSource: { provider: "anilist", externalId: "123" } });
  const result = resolveResumeTarget(item, []);
  assert.equal(result.kind, "unavailable", "an AniList catalog identity must never become https://anilist.co/... or any other synthesized URL");
});
check("B13 (§74): catalogSource.provider = 'open-library' likewise never becomes a resume URL", () => {
  const item = makeItem({ id: "i1", type: "novel", catalogSource: { provider: "open-library", externalId: "OL123" } });
  assert.equal(resolveResumeTarget(item, []).kind, "unavailable");
});
check("B14: a source linked to a DIFFERENT item is never eligible", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({ libraryItemId: "i2", sourceUrl: "https://mangadex.org/title/abc" });
  assert.equal(resolveResumeTarget(item, [source]).kind, "unavailable");
});
check("B15: an unlinked source (libraryItemId null) is never eligible", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({ libraryItemId: null, sourceUrl: "https://mangadex.org/title/abc" });
  assert.equal(resolveResumeTarget(item, [source]).kind, "unavailable");
});
check("B16: extension-created source (adapterId universal-reader-like) is eligible on equal footing — this is a UNIVERSAL hub, no catalog-provider requirement", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({ id: "ext-1", adapterId: "universal-reader", libraryItemId: "i1", sourceUrl: "https://novelphoenix.com/novel/x" });
  const result = resolveResumeTarget(item, [source]);
  assert.equal(result.kind, "direct");
  assert.equal(result.sourceLabel, "NovelPhoenix", "known hostname label wins when the adapter itself has no display name");
});
check("B17: LibraryItem's own sourceUrl used only when no TrackingSource is eligible", () => {
  const item = makeItem({ id: "i1", type: "manga", sourceUrl: "https://myanimelist.net/manga/1" });
  const result = resolveResumeTarget(item, []);
  assert.equal(result.kind, "canonical_url");
  assert.equal(result.url, "https://myanimelist.net/manga/1");
  assert.equal(result.sourceLabel, undefined, "no adapter identity behind an item's own stored URL — never fabricate one");
});
check("B18: LibraryItem's own sourceUrl is validated exactly like any other external target", () => {
  const item = makeItem({ id: "i1", type: "manga", sourceUrl: "javascript:alert(1)" });
  assert.equal(resolveResumeTarget(item, []).kind, "unavailable");
});
check("B19: Website item's own url field is the candidate, not sourceUrl", () => {
  const item = makeItem({ id: "i1", type: "website", url: "https://example.com" });
  const result = resolveResumeTarget(item, []);
  assert.equal(result.kind, "canonical_url");
  assert.equal(result.url, "https://example.com");
});
check("B20: a TrackingSource with an unsafe URL is skipped in favor of the next-best eligible one, not an immediate internal fallback", () => {
  const item = makeItem({ id: "i1" });
  const unsafe = makeSource({ id: "s-unsafe", libraryItemId: "i1", sourceUrl: "javascript:x", lastSeenAt: "2026-03-01T00:00:00.000Z" });
  const safe = makeSource({ id: "s-safe", libraryItemId: "i1", sourceUrl: "https://mangadex.org/title/x", lastSeenAt: "2026-01-01T00:00:00.000Z" });
  const result = resolveResumeTarget(item, [unsafe, safe]);
  assert.equal(result.url, "https://mangadex.org/title/x", "the more-recent but unsafe source must not simply block resolution");
});
check("B21: lastDetectedMetadata.workUrl preferred over sourceUrl when both present (Stage 21 stable work URL)", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({
    libraryItemId: "i1",
    sourceUrl: "https://example.com/chapter/7",
    lastDetectedMetadata: { workUrl: "https://example.com/work/stable" },
  });
  assert.equal(resolveResumeTarget(item, [source]).url, "https://example.com/work/stable");
});

// ============================================================
// B22-B31 (§8) — workUrl/sourceUrl trust boundary. A metadata-derived
// workUrl must never gain MORE navigation authority than page metadata
// deserves: it's only trusted when it shares sourceUrl's own host. This
// is the exact correctness-review scenario: sourceUrl identifies the real
// tracked site; workUrl is a value read out of that same page's own
// markup (or a same-site adapter-matched anchor) and must be proven
// same-host before Dashboard's Continue button will ever follow it.
// ============================================================
check("B22 (§8.A): sourceUrl and workUrl share a host -> workUrl wins", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({
    libraryItemId: "i1",
    sourceUrl: "https://reader.example.com/chapter/12",
    lastDetectedMetadata: { workUrl: "https://reader.example.com/book/title" },
  });
  assert.equal(resolveResumeTarget(item, [source]).url, "https://reader.example.com/book/title");
});
check("B23 (§8.B — THE threat model case): sourceUrl safe, workUrl a syntactically-valid but UNRELATED https host -> workUrl rejected, safe sourceUrl wins, Dashboard never opens the unrelated origin", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({
    libraryItemId: "i1",
    sourceUrl: "https://reader.example.com/chapter/12",
    lastDetectedMetadata: { workUrl: "https://unrelated.example/path" },
  });
  const result = resolveResumeTarget(item, [source]);
  assert.equal(result.url, "https://reader.example.com/chapter/12", "must fall back to the trusted sourceUrl, never open the unrelated host");
  assert.notEqual(result.url, "https://unrelated.example/path");
});
check("B24 (§8.C): sourceUrl safe, workUrl is javascript: -> sourceUrl wins", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({
    libraryItemId: "i1",
    sourceUrl: "https://reader.example.com/chapter/12",
    lastDetectedMetadata: { workUrl: "javascript:alert(1)" },
  });
  assert.equal(resolveResumeTarget(item, [source]).url, "https://reader.example.com/chapter/12");
});
check("B25 (§8.D): sourceUrl safe, workUrl malformed -> sourceUrl wins", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({
    libraryItemId: "i1",
    sourceUrl: "https://reader.example.com/chapter/12",
    lastDetectedMetadata: { workUrl: "not a url" },
  });
  assert.equal(resolveResumeTarget(item, [source]).url, "https://reader.example.com/chapter/12");
});
check("B26 (§8.E): sourceUrl unsafe, workUrl a valid but unrelated https host -> workUrl is NOT used as a substitute trust anchor; falls to unavailable since no other source exists", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({
    libraryItemId: "i1",
    sourceUrl: "javascript:evil()",
    lastDetectedMetadata: { workUrl: "https://unrelated.example/path" },
  });
  assert.equal(resolveResumeTarget(item, [source]).kind, "unavailable", "an unsafe sourceUrl gives workUrl nothing to prove itself against");
});
check("B27 (§8.F): two sources — the newest has an untrusted cross-host workUrl but a safe sourceUrl; its own safe sourceUrl remains the eligible choice for that source (never internal just because its workUrl was rejected)", () => {
  const item = makeItem({ id: "i1" });
  const newestWithBadWorkUrl = makeSource({
    id: "s-newest",
    libraryItemId: "i1",
    sourceUrl: "https://reader.example.com/chapter/99",
    lastDetectedMetadata: { workUrl: "https://unrelated.example/path" },
    lastSeenAt: "2026-05-01T00:00:00.000Z",
  });
  const older = makeSource({
    id: "s-older",
    libraryItemId: "i1",
    sourceUrl: "https://mangadex.org/title/x",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  });
  const result = resolveResumeTarget(item, [newestWithBadWorkUrl, older]);
  assert.equal(result.url, "https://reader.example.com/chapter/99", "the newest source is still picked (most recently seen), using its OWN safe sourceUrl since its workUrl failed the trust check");
});
check("B28 (§8.G): credential-bearing URL rejected for both sourceUrl and workUrl", () => {
  const item = makeItem({ id: "i1" });
  const credSourceOnly = makeSource({ id: "s1", libraryItemId: "i1", sourceUrl: "https://user:pass@reader.example.com/x" });
  assert.equal(resolveResumeTarget(item, [credSourceOnly]).kind, "unavailable", "a credential-bearing sourceUrl must never become the resume target");

  const credWorkUrl = makeSource({
    id: "s2",
    libraryItemId: "i1",
    sourceUrl: "https://reader.example.com/chapter/1",
    lastDetectedMetadata: { workUrl: "https://user:pass@reader.example.com/book/1" },
  });
  assert.equal(resolveResumeTarget(item, [credWorkUrl]).url, "https://reader.example.com/chapter/1", "a credential-bearing workUrl is rejected even when otherwise same-host; sourceUrl wins instead");
});
check("B29 (§8.H): localhost source+workUrl (dev tracking) continues to work — same-host trust check does not break the existing dev flow", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({
    libraryItemId: "i1",
    sourceUrl: "http://localhost:3000/reader/chapter-1",
    lastDetectedMetadata: { workUrl: "http://localhost:3000/reader/book" },
  });
  assert.equal(resolveResumeTarget(item, [source]).url, "http://localhost:3000/reader/book");
});
check("B30 (§8.I): AniList catalogSource with no TrackingSource/sourceUrl -> unavailable (re-confirmed under the new trust rule)", () => {
  const item = makeItem({ id: "i1", type: "anime", catalogSource: { provider: "anilist", externalId: "123" } });
  assert.equal(resolveResumeTarget(item, []).kind, "unavailable");
});
check("B31 (§8.J): Open Library catalogSource with no TrackingSource/sourceUrl -> unavailable (re-confirmed under the new trust rule)", () => {
  const item = makeItem({ id: "i1", type: "novel", catalogSource: { provider: "open-library", externalId: "OL1" } });
  assert.equal(resolveResumeTarget(item, []).kind, "unavailable");
});
check("B32 (§9): the displayed source name/hostname always matches the URL that will actually open — a rejected workUrl's host never leaks into the label", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({
    adapterId: "some-unknown-adapter",
    libraryItemId: "i1",
    sourceUrl: "https://reader.example.com/chapter/12",
    lastDetectedMetadata: { workUrl: "https://unrelated.example/path" },
  });
  const result = resolveResumeTarget(item, [source]);
  assert.equal(result.url, "https://reader.example.com/chapter/12");
  assert.equal(result.hostname, "reader.example.com", "hostname must reflect the URL that actually opens, never the rejected unrelated.example");
  assert.notEqual(result.hostname, "unrelated.example");
});

// ============================================================
// C — URL safety validator itself (§15)
// ============================================================
check("C1: http/https accepted", () => {
  assert.equal(isValidUrl("http://example.com"), true);
  assert.equal(isValidUrl("https://example.com"), true);
});
check("C2: javascript/data/file/chrome/extension schemes rejected", () => {
  for (const scheme of ["javascript:alert(1)", "data:text/plain,x", "file:///x", "chrome://settings", "chrome-extension://abc/x"]) {
    assert.equal(isValidUrl(scheme), false, `${scheme} must be rejected`);
  }
});
check("C3: malformed input rejected without throwing", () => {
  assert.equal(isValidUrl("not a url"), false);
  assert.equal(isValidUrl(""), false);
});
check("C4: localhost explicitly allowed (dev tracking sources)", () => {
  assert.equal(isValidUrl("http://localhost:3000/x"), true);
});
check("C5 (§7): credential-bearing URLs (userinfo) rejected", () => {
  assert.equal(isValidUrl("https://user:password@example.com/path"), false);
  assert.equal(isValidUrl("https://user@example.com/path"), false, "a bare username with no password must also be rejected");
});
check("C6: sameTrustedHost normalizes leading www. on both sides, exactly like getSourceHostname's existing display normalization", () => {
  assert.equal(sameTrustedHost("https://www.example.com/a", "https://example.com/b"), true);
  assert.equal(sameTrustedHost("https://example.com/a", "https://other.example.com/b"), false, "sibling subdomains are never treated as the same trusted host");
});

// ============================================================
// D — Smart View consistency (§66, §75-§77)
// ============================================================
function makeMixedFixture() {
  const items = [
    makeItem({ id: "continue-a", status: "in_progress" }),
    makeItem({ id: "continue-b", status: "in_progress" }),
    makeItem({ id: "planned-a", status: "planned" }),
    makeItem({ id: "completed-a", status: "completed" }),
    makeItem({ id: "stalled-a", status: "in_progress", createdAt: daysAgo(40) }),
    makeItem({ id: "recently-active-only", status: "completed" }),
  ];
  const activitySummary = new Map([
    ["continue-a", daysAgo(1)],
    ["continue-b", daysAgo(10)],
    ["recently-active-only", daysAgo(2)],
    // stalled-a and planned-a/completed-a: no activity at all.
  ]);
  return { items, context: { collections: [], activitySummary, now: NOW } };
}

check("D1 (§75): Dashboard Continue ids === Stage31 Continue engine ids, before dashboard limit/slicing", () => {
  const { items, context } = makeMixedFixture();
  const dashboardIds = getBuiltInViewItems(items, "builtin-continue", context).map((i) => i.id);
  const engineIds = applySmartView(items, BUILT_IN_VIEWS["builtin-continue"], context).map((i) => i.id);
  assert.deepEqual(dashboardIds, engineIds);
  assert.deepEqual(dashboardIds, ["continue-a", "continue-b", "stalled-a"], "sanity: exactly the in_progress items, sorted by lastActivity desc, no-activity last");
});
check("D2 (§76): Dashboard Recently Active ids === Stage31 engine ids", () => {
  const { items, context } = makeMixedFixture();
  const dashboardIds = getBuiltInViewItems(items, "builtin-recently-active", context).map((i) => i.id);
  const engineIds = applySmartView(items, BUILT_IN_VIEWS["builtin-recently-active"], context).map((i) => i.id);
  assert.deepEqual(dashboardIds, engineIds);
  assert.deepEqual(dashboardIds, ["continue-a", "recently-active-only", "continue-b"]);
});
check("D3 (§77): Dashboard Stalled ids === Stage31 engine ids", () => {
  const { items, context } = makeMixedFixture();
  const dashboardIds = getBuiltInViewItems(items, "builtin-stalled", context).map((i) => i.id);
  const engineIds = applySmartView(items, BUILT_IN_VIEWS["builtin-stalled"], context).map((i) => i.id);
  assert.deepEqual(dashboardIds, engineIds);
  assert.deepEqual(dashboardIds, ["stalled-a"], "never-active but created 40 days ago counts as stalled via the createdAt fallback, exactly as Stage 31 defines it");
});
check("D4: an unknown view id degrades to an empty list rather than throwing", () => {
  const { items, context } = makeMixedFixture();
  assert.deepEqual(getBuiltInViewItems(items, "builtin-does-not-exist", context), []);
});

// ============================================================
// E — sort reactivity (§78)
// ============================================================
check("E1: B newer than A -> B first; after A's summary advances past B -> A first, no special reload-only state involved", () => {
  const items = [makeItem({ id: "a", status: "in_progress" }), makeItem({ id: "b", status: "in_progress" })];
  let summary = new Map([["a", daysAgo(10)], ["b", daysAgo(1)]]);
  let context = { collections: [], activitySummary: summary, now: NOW };
  assert.deepEqual(getBuiltInViewItems(items, "builtin-continue", context).map((i) => i.id), ["b", "a"]);

  summary = new Map([["a", daysAgo(0)], ["b", daysAgo(1)]]); // a becomes more recent
  context = { collections: [], activitySummary: summary, now: NOW };
  assert.deepEqual(getBuiltInViewItems(items, "builtin-continue", context).map((i) => i.id), ["a", "b"]);
});

// ============================================================
// F — null activity (§79)
// ============================================================
check("F1: in-progress item with null Activity still appears in Continue, after items with real activity", () => {
  const items = [makeItem({ id: "has-activity", status: "in_progress" }), makeItem({ id: "no-activity", status: "in_progress" })];
  const context = { collections: [], activitySummary: new Map([["has-activity", daysAgo(1)]]), now: NOW };
  const ids = getBuiltInViewItems(items, "builtin-continue", context).map((i) => i.id);
  assert.deepEqual(ids, ["has-activity", "no-activity"]);
});
check("F2: an item with null activity never appears in Recently Active", () => {
  const items = [makeItem({ id: "no-activity", status: "in_progress" })];
  const context = { collections: [], activitySummary: new Map(), now: NOW };
  assert.deepEqual(getBuiltInViewItems(items, "builtin-recently-active", context), []);
});

// ============================================================
// G — source fetch failure fallback (§80)
// ============================================================
check("G1: resolveResumeTarget with an empty sources array (as if the fetch failed/hasn't resolved yet) still returns a safe, well-formed result, never throws — Stage 41 no longer fabricates an internal-link URL itself (the caller decides what, if anything, to show for 'unavailable')", () => {
  const item = makeItem({ id: "i1" });
  assert.deepEqual(resolveResumeTarget(item, []), { kind: "unavailable", reason: "no-target" });
});

// ============================================================
// H — partial data failure (§81) and activity snapshot (§24-§27)
// ============================================================
check("H1: an empty/failed activitySummary still lets Continue show basic in-progress items (unsorted-by-recency degrade, never an empty/broken section)", () => {
  const items = [makeItem({ id: "a", status: "in_progress" }), makeItem({ id: "b", status: "in_progress" })];
  const context = { collections: [], activitySummary: new Map(), now: NOW };
  const ids = getBuiltInViewItems(items, "builtin-continue", context).map((i) => i.id);
  assert.deepEqual(new Set(ids), new Set(["a", "b"]), "both in-progress items are still present even with zero activity data");
});
check("H2: Library snapshot counts never touch activitySummary at all — computable even when activity data is completely absent", () => {
  const items = [makeItem({ status: "in_progress" }), makeItem({ status: "completed" }), makeItem({ favorite: true })];
  const total = items.length;
  const completed = items.filter((i) => i.status === "completed").length;
  const favorites = items.filter((i) => i.favorite).length;
  assert.equal(total, 3);
  assert.equal(completed, 1);
  assert.equal(favorites, 1);
});
check("H3 (§25/§27): countActiveWithinDays never depends on a capped event LIST — only on the durable per-item summary map, so it can't undercount a heavy user the way counting raw events would", () => {
  const items = [];
  const summary = new Map();
  for (let i = 0; i < 600; i++) {
    items.push(makeItem({ id: `item-${i}`, status: "in_progress" }));
    summary.set(`item-${i}`, daysAgo(1)); // all 600 active yesterday — no 500-row cap applies to a Map of one entry per item
  }
  assert.equal(countActiveWithinDays(items, summary, 7, NOW), 600, "every one of the 600 items must be counted — proves this metric is immune to any 500-row event cap");
});
check("H4: countActiveWithinDays respects the day boundary exactly (inclusive at the cutoff, like Stage 31's own active_within)", () => {
  const items = [makeItem({ id: "exact" })];
  const summary = new Map([["exact", daysAgo(7)]]);
  assert.equal(countActiveWithinDays(items, summary, 7, NOW), 1);
});
check("H5: countActiveWithinDays excludes an item just past the window", () => {
  const items = [makeItem({ id: "old" })];
  const summary = new Map([["old", daysAgo(8)]]);
  assert.equal(countActiveWithinDays(items, summary, 7, NOW), 0);
});

// ============================================================
// I — Stage 41 correction: selectContinueSource's manual-vs-detected
// recency distinction. See lib/resume.ts's own doc comment for the full
// finding. Full Stage 41 action-label/chooser/media-type matrix lives in
// scripts/verify-resume-engine.mjs — these checks only cover the change
// to resolveResumeTarget ITSELF, which this file already owns.
// ============================================================
check("I1 (CRITICAL): a single manual source is still a safe DIRECT target — only 2+ sources trigger the ambiguity guard", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({ adapterId: "manual", libraryItemId: "i1", sourceUrl: "https://example.com/x", lastSeenAt: "2026-06-01T00:00:00.000Z" });
  const result = resolveResumeTarget(item, [source]);
  assert.equal(result.kind, "direct");
  assert.equal(result.url, "https://example.com/x");
});
check("I2 (CRITICAL): a brand-new manual source + an older extension source -> choose_source, never silently pick the manual one just because its last_seen_at is newer", () => {
  const item = makeItem({ id: "i1" });
  const oldExtension = makeSource({ id: "ext-1", adapterId: "mangadex", libraryItemId: "i1", sourceUrl: "https://mangadex.org/title/x", lastSeenAt: "2026-01-01T00:00:00.000Z" });
  const freshManual = makeSource({ id: "man-1", adapterId: "manual", libraryItemId: "i1", sourceUrl: "https://example.com/x", lastSeenAt: "2026-06-01T00:00:00.000Z" });
  const result = resolveResumeTarget(item, [oldExtension, freshManual]);
  assert.equal(result.kind, "choose_source", "a freshly-ADDED manual source must never be mistaken for a freshly-CONSUMED one");
  assert.equal(result.sources.length, 2);
});
check("I3: two manual sources (no extension source at all) -> choose_source, never 'most recently added' passed off as a consumption signal", () => {
  const item = makeItem({ id: "i1" });
  const a = makeSource({ id: "man-a", adapterId: "manual", libraryItemId: "i1", sourceUrl: "https://a.example/x", lastSeenAt: "2026-01-01T00:00:00.000Z" });
  const b = makeSource({ id: "man-b", adapterId: "manual", libraryItemId: "i1", sourceUrl: "https://b.example/x", lastSeenAt: "2026-06-01T00:00:00.000Z" });
  assert.equal(resolveResumeTarget(item, [a, b]).kind, "choose_source");
});
check("I4: multiple EXTENSION-only sources (no manual source in the set) still resolve DIRECT — unchanged from the pre-Stage-41 behavior, since every last_seen_at genuinely reflects a real detection", () => {
  const item = makeItem({ id: "i1" });
  const older = makeSource({ id: "ext-old", adapterId: "mangadex", libraryItemId: "i1", sourceUrl: "https://mangadex.org/title/x", lastSeenAt: "2026-01-01T00:00:00.000Z" });
  const newer = makeSource({ id: "ext-new", adapterId: "markly-test-reader", libraryItemId: "i1", sourceUrl: "https://reader.example.com/x", lastSeenAt: "2026-06-01T00:00:00.000Z" });
  const result = resolveResumeTarget(item, [older, newer]);
  assert.equal(result.kind, "direct");
  assert.equal(result.url, "https://reader.example.com/x");
});
check("I5: choose_source's own sources array is ordered by recency (display order), even though that recency wasn't trusted enough to auto-pick", () => {
  const item = makeItem({ id: "i1" });
  const oldExtension = makeSource({ id: "ext-1", adapterId: "mangadex", libraryItemId: "i1", sourceUrl: "https://mangadex.org/title/x", lastSeenAt: "2026-01-01T00:00:00.000Z" });
  const freshManual = makeSource({ id: "man-1", adapterId: "manual", libraryItemId: "i1", sourceUrl: "https://example.com/x", lastSeenAt: "2026-06-01T00:00:00.000Z" });
  const result = resolveResumeTarget(item, [oldExtension, freshManual]);
  assert.equal(result.sources[0].sourceId, "man-1", "still shown most-recent-first — only the SILENT auto-pick requires the stronger guarantee");
});
check("I6: choose_source is skipped entirely (falls through to a manual source's own eligibility) when the manual source is unsafe — an ineligible source is never counted toward the ambiguity check", () => {
  const item = makeItem({ id: "i1" });
  const unsafeManual = makeSource({ id: "man-1", adapterId: "manual", libraryItemId: "i1", sourceUrl: "javascript:x", lastSeenAt: "2026-06-01T00:00:00.000Z" });
  const extension = makeSource({ id: "ext-1", adapterId: "mangadex", libraryItemId: "i1", sourceUrl: "https://mangadex.org/title/x", lastSeenAt: "2026-01-01T00:00:00.000Z" });
  const result = resolveResumeTarget(item, [unsafeManual, extension]);
  assert.equal(result.kind, "direct", "the unsafe manual source is filtered out before eligibility is even counted, leaving only one real candidate");
  assert.equal(result.url, "https://mangadex.org/title/x");
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
  "\nNote: this script reproduces lib/dashboard.ts, lib/website.ts's isValidUrl, lib/extension/source-display.ts, lib/tracking.ts's getProgressInfo, and the minimal Continue/Recently Active/Stalled subset of lib/smart-views.ts verbatim (same convention as every other script in this directory). It never touches a real database. Live cloud behavior (the /api/tracking-sources route, the real activity-summary RPC) was validated separately against the real Supabase project — see the Stage 32 final report.",
);
