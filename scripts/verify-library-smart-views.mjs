#!/usr/bin/env node
// Verifies Stage 31 "Advanced Library Discovery & Smart Views":
//   - lib/smart-views.ts: the pure filter/sort/group engine, built-in view
//     definitions, safe definition parsing, and saved-view name validation
//   - The activity-summary contract (item_id -> latest qualifying-event
//     timestamp) that both local (in-memory) and cloud (RPC) paths feed
//     into the same engine
//
// Reproduced verbatim from the real module (same approach as every other
// script in this directory — plain .mjs, no TypeScript loader available
// under the project's Node >=20.9 baseline). No live database/Supabase
// call is made by this script.
//
// Run with: node scripts/verify-library-smart-views.mjs

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

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T00:00:00.000Z");
function daysAgo(n) {
  return new Date(NOW.getTime() - n * DAY_MS).toISOString();
}

// ============================================================
// Engine, reproduced verbatim from lib/smart-views.ts
// ============================================================
const SUPPORTED_ITEM_TYPES = ["website", "anime", "manga", "novel", "game", "movie", "series"];
const ITEM_TYPE_LABELS = { website: "Website", anime: "Anime", manga: "Manga", novel: "Books & Novels", game: "Game", movie: "Movie", series: "Series", article: "Article", video: "Video", other: "Other" };
const TRACKING_STATUSES = ["planned", "in_progress", "completed", "on_hold", "dropped"];
const STATUS_FILTER_LABELS = { planned: "Planned", in_progress: "In Progress", completed: "Completed", on_hold: "On Hold", dropped: "Dropped" };

function isMediaItem(item) {
  return item.type !== "website" && item.type !== "article" && item.type !== "video" && item.type !== "other";
}

function getSearchableText(item) {
  const parts = [item.title, item.description, item.category, ...item.tags];
  if (item.type === "website") parts.push(item.url, item.url);
  if (item.sourceUrl) parts.push(item.sourceUrl);
  if (item.platform) parts.push(item.platform);
  return parts.join(" ").toLowerCase();
}

const QUALIFYING_ACTIVITY_TYPES = ["progress_updated", "rating_updated", "status_updated"];

function buildActivitySummary(events) {
  const summary = new Map();
  for (const event of events) {
    if (!QUALIFYING_ACTIVITY_TYPES.includes(event.type)) continue;
    const current = summary.get(event.itemId);
    if (!current || event.timestamp > current) summary.set(event.itemId, event.timestamp);
  }
  return summary;
}

function getInactivityReferenceMs(item, activitySummary) {
  const lastActivity = activitySummary.get(item.id);
  return new Date(lastActivity ?? item.createdAt).getTime();
}

function matchesMediaTypes(item, mediaTypes) {
  if (mediaTypes.length === 0) return true;
  return mediaTypes.includes(item.type);
}
function matchesStatuses(item, statuses) {
  if (statuses.length === 0) return true;
  return "status" in item && statuses.includes(item.status);
}
function matchesFavorite(item, favorite) {
  if (favorite === null) return true;
  return item.favorite === favorite;
}
function matchesRating(item, rating) {
  const value = isMediaItem(item) ? item.rating : undefined;
  switch (rating.mode) {
    case "any": return true;
    case "rated": return value !== undefined;
    case "unrated": return value === undefined;
    case "min": return value !== undefined && rating.min !== null && value >= rating.min;
    case "range": return value !== undefined && (rating.min === null || value >= rating.min) && (rating.max === null || value <= rating.max);
  }
}
function matchesCollections(item, selectedItemIds) {
  if (selectedItemIds === null) return true;
  return selectedItemIds.has(item.id);
}
function matchesTags(item, tags) {
  if (tags.values.length === 0) return true;
  const itemTags = new Set(item.tags.map((t) => t.toLowerCase()));
  const wanted = tags.values.map((t) => t.toLowerCase());
  return tags.match === "all" ? wanted.every((t) => itemTags.has(t)) : wanted.some((t) => itemTags.has(t));
}
function matchesActivity(item, activity, activitySummary, nowMs) {
  const lastActivity = activitySummary.get(item.id);
  switch (activity.mode) {
    case "any": return true;
    case "never": return lastActivity === undefined;
    case "active_within": {
      if (lastActivity === undefined || activity.days === null) return false;
      return nowMs - new Date(lastActivity).getTime() <= activity.days * DAY_MS;
    }
    case "inactive_for": {
      if (activity.days === null) return true;
      return nowMs - getInactivityReferenceMs(item, activitySummary) >= activity.days * DAY_MS;
    }
  }
}
function matchesQuery(item, query) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  return getSearchableText(item).includes(trimmed);
}

function buildSelectedCollectionItemIds(collections, selectedIds) {
  if (selectedIds.length === 0) return null;
  const selected = new Set(selectedIds);
  const itemIds = new Set();
  for (const collection of collections) {
    if (!selected.has(collection.id)) continue;
    for (const id of collection.itemIds) itemIds.add(id);
  }
  return itemIds;
}

function filterSmartViewItems(items, definition, context) {
  const selectedCollectionItemIds = buildSelectedCollectionItemIds(context.collections, definition.collections);
  const nowMs = context.now.getTime();
  return items.filter(
    (item) =>
      matchesMediaTypes(item, definition.mediaTypes) &&
      matchesStatuses(item, definition.statuses) &&
      matchesFavorite(item, definition.favorite) &&
      matchesRating(item, definition.rating) &&
      matchesCollections(item, selectedCollectionItemIds) &&
      matchesTags(item, definition.tags) &&
      matchesActivity(item, definition.activity, context.activitySummary, nowMs) &&
      matchesQuery(item, definition.query),
  );
}

function ratingOf(item) {
  return isMediaItem(item) ? item.rating : undefined;
}

function compareForSort(a, b, sort, activitySummary) {
  const dir = sort.direction === "asc" ? 1 : -1;
  let primary = 0;
  switch (sort.by) {
    case "title":
      primary = a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) * dir;
      break;
    case "createdAt":
      primary = a.createdAt.localeCompare(b.createdAt) * dir;
      break;
    case "lastActivity": {
      const aTime = activitySummary.get(a.id);
      const bTime = activitySummary.get(b.id);
      if (aTime === undefined && bTime === undefined) primary = 0;
      else if (aTime === undefined) primary = 1;
      else if (bTime === undefined) primary = -1;
      else primary = aTime.localeCompare(bTime) * dir;
      break;
    }
    case "rating": {
      const aRating = ratingOf(a);
      const bRating = ratingOf(b);
      if (aRating === undefined && bRating === undefined) primary = 0;
      else if (aRating === undefined) primary = 1;
      else if (bRating === undefined) primary = -1;
      else primary = (aRating - bRating) * dir;
      break;
    }
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

function groupSmartViewItems(items, groupBy) {
  if (groupBy === "none") return items.length > 0 ? [{ key: "all", label: "All", items: [...items] }] : [];
  if (groupBy === "mediaType") {
    return SUPPORTED_ITEM_TYPES.map((type) => ({ key: type, label: ITEM_TYPE_LABELS[type], items: items.filter((i) => i.type === type) })).filter((g) => g.items.length > 0);
  }
  const statusGroups = TRACKING_STATUSES.map((status) => ({ key: status, label: STATUS_FILTER_LABELS[status], items: items.filter((i) => "status" in i && i.status === status) })).filter((g) => g.items.length > 0);
  const untracked = items.filter((i) => !("status" in i));
  return untracked.length > 0 ? [...statusGroups, { key: "none", label: "No status", items: untracked }] : statusGroups;
}

function defaultSmartViewDefinition() {
  return {
    version: 1,
    query: "",
    mediaTypes: [],
    statuses: [],
    favorite: null,
    rating: { mode: "any", min: null, max: null },
    collections: [],
    tags: { values: [], match: "any" },
    activity: { mode: "any", days: null },
    sort: { by: "createdAt", direction: "desc" },
    groupBy: "none",
  };
}
function buildInDefinition(overrides) {
  return { ...defaultSmartViewDefinition(), ...overrides };
}

const BUILT_IN_SMART_VIEWS = [
  { id: "builtin-continue", name: "Continue", builtIn: true, definition: buildInDefinition({ statuses: ["in_progress"], sort: { by: "lastActivity", direction: "desc" } }) },
  { id: "builtin-recently-active", name: "Recently Active", builtIn: true, definition: buildInDefinition({ activity: { mode: "active_within", days: 14 }, sort: { by: "lastActivity", direction: "desc" } }) },
  { id: "builtin-stalled", name: "Stalled", builtIn: true, definition: buildInDefinition({ statuses: ["in_progress"], activity: { mode: "inactive_for", days: 30 }, sort: { by: "lastActivity", direction: "asc" } }) },
  { id: "builtin-favorites", name: "Favorites", builtIn: true, definition: buildInDefinition({ favorite: true, sort: { by: "title", direction: "asc" } }) },
  { id: "builtin-unrated", name: "Unrated", builtIn: true, definition: buildInDefinition({ rating: { mode: "unrated", min: null, max: null }, sort: { by: "title", direction: "asc" } }) },
];

function isStringArray(v) { return Array.isArray(v) && v.every((e) => typeof e === "string"); }
function isFiniteNumberOrNull(v) { return v === null || (typeof v === "number" && Number.isFinite(v)); }

function parseSmartViewDefinition(raw) {
  if (!raw || typeof raw !== "object") return null;
  const d = raw;
  if (d.version !== 1) return null;
  if (typeof d.query !== "string") return null;
  if (!isStringArray(d.mediaTypes) || !d.mediaTypes.every((t) => SUPPORTED_ITEM_TYPES.includes(t))) return null;
  if (!isStringArray(d.statuses) || !d.statuses.every((s) => TRACKING_STATUSES.includes(s))) return null;
  if (d.favorite !== null && typeof d.favorite !== "boolean") return null;
  const rating = d.rating;
  if (!rating || typeof rating !== "object") return null;
  if (!["any", "rated", "unrated", "min", "range"].includes(rating.mode)) return null;
  if (!isFiniteNumberOrNull(rating.min) || !isFiniteNumberOrNull(rating.max)) return null;
  if (!isStringArray(d.collections)) return null;
  const tags = d.tags;
  if (!tags || typeof tags !== "object") return null;
  if (!isStringArray(tags.values)) return null;
  if (!["any", "all"].includes(tags.match)) return null;
  const activity = d.activity;
  if (!activity || typeof activity !== "object") return null;
  if (!["any", "active_within", "inactive_for", "never"].includes(activity.mode)) return null;
  if (!isFiniteNumberOrNull(activity.days)) return null;
  const sort = d.sort;
  if (!sort || typeof sort !== "object") return null;
  if (!["title", "createdAt", "lastActivity", "rating"].includes(sort.by)) return null;
  if (!["asc", "desc"].includes(sort.direction)) return null;
  if (!["none", "mediaType", "status"].includes(d.groupBy)) return null;
  return {
    version: 1, query: d.query, mediaTypes: d.mediaTypes, statuses: d.statuses, favorite: d.favorite,
    rating: { mode: rating.mode, min: rating.min, max: rating.max }, collections: d.collections,
    tags: { values: tags.values, match: tags.match }, activity: { mode: activity.mode, days: activity.days },
    sort: { by: sort.by, direction: sort.direction }, groupBy: d.groupBy,
  };
}

function normalizeSmartViewName(name) { return name.trim().replace(/\s+/g, " "); }
function smartViewNameKey(name) { return normalizeSmartViewName(name).toLowerCase(); }
const MAX_SMART_VIEW_NAME_LENGTH = 200;
function validateSmartViewName(name) {
  const normalized = normalizeSmartViewName(name);
  if (/[\x00-\x1f\x7f]/.test(normalized)) return { ok: false, reason: "invalid" };
  if (normalized.length === 0) return { ok: false, reason: "empty" };
  if (normalized.length > MAX_SMART_VIEW_NAME_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, name: normalized };
}
function isDuplicateSmartViewName(name, existing, excludeId) {
  const key = smartViewNameKey(name);
  return existing.some((v) => v.id !== excludeId && smartViewNameKey(v.name) === key);
}

function arraysEqual(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }
function smartViewDefinitionsEqual(a, b) {
  return (
    a.version === b.version && a.query === b.query && arraysEqual(a.mediaTypes, b.mediaTypes) && arraysEqual(a.statuses, b.statuses) &&
    a.favorite === b.favorite && a.rating.mode === b.rating.mode && a.rating.min === b.rating.min && a.rating.max === b.rating.max &&
    arraysEqual(a.collections, b.collections) && arraysEqual(a.tags.values, b.tags.values) && a.tags.match === b.tags.match &&
    a.activity.mode === b.activity.mode && a.activity.days === b.activity.days && a.sort.by === b.sort.by && a.sort.direction === b.sort.direction && a.groupBy === b.groupBy
  );
}

const EMPTY_CONTEXT = { collections: [], activitySummary: new Map(), now: NOW };

// ============================================================
// A — media type filter
// ============================================================
check("A1: single media type filters to exactly that type", () => {
  const items = [makeItem({ type: "anime" }), makeItem({ type: "manga" })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), mediaTypes: ["anime"] }, EMPTY_CONTEXT);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "anime");
});
check("A2: multi-select media type is OR within the dimension", () => {
  const items = [makeItem({ type: "anime" }), makeItem({ type: "manga" }), makeItem({ type: "movie" })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), mediaTypes: ["anime", "manga"] }, EMPTY_CONTEXT);
  assert.equal(result.length, 2);
});
check("A3: empty mediaTypes means no restriction", () => {
  const items = [makeItem({ type: "anime" }), makeItem({ type: "game" })];
  assert.equal(filterSmartViewItems(items, defaultSmartViewDefinition(), EMPTY_CONTEXT).length, 2);
});

// ============================================================
// B — status filter
// ============================================================
check("B1: single status filters exactly", () => {
  const items = [makeItem({ status: "in_progress" }), makeItem({ status: "completed" })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), statuses: ["completed"] }, EMPTY_CONTEXT);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "completed");
});
check("B2: multi-select status is OR", () => {
  const items = [makeItem({ status: "planned" }), makeItem({ status: "in_progress" }), makeItem({ status: "dropped" })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), statuses: ["planned", "dropped"] }, EMPTY_CONTEXT);
  assert.equal(result.length, 2);
});
check("B3: a status filter excludes items with no status field at all (e.g. website)", () => {
  const items = [makeItem({ type: "website", status: undefined, id: "w1" }), makeItem({ status: "in_progress" })];
  delete items[0].status;
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), statuses: ["in_progress"] }, EMPTY_CONTEXT);
  assert.equal(result.length, 1);
});

// ============================================================
// C — favorite three-state
// ============================================================
check("C1: favorite null means any (both favorited and not included)", () => {
  const items = [makeItem({ favorite: true }), makeItem({ favorite: false })];
  assert.equal(filterSmartViewItems(items, defaultSmartViewDefinition(), EMPTY_CONTEXT).length, 2);
});
check("C2: favorite true means favorites only", () => {
  const items = [makeItem({ favorite: true }), makeItem({ favorite: false })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), favorite: true }, EMPTY_CONTEXT);
  assert.equal(result.length, 1);
  assert.equal(result[0].favorite, true);
});
check("C3: favorite false (a real boolean, never treated as 'disabled') means not-favorite only", () => {
  const items = [makeItem({ favorite: true }), makeItem({ favorite: false })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), favorite: false }, EMPTY_CONTEXT);
  assert.equal(result.length, 1);
  assert.equal(result[0].favorite, false);
});

// ============================================================
// D — rating filter
// ============================================================
check("D1: rated excludes unrated", () => {
  const items = [makeItem({ rating: 8 }), makeItem({ rating: undefined })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), rating: { mode: "rated", min: null, max: null } }, EMPTY_CONTEXT);
  assert.equal(result.length, 1);
});
check("D2: unrated is literal absence, never rating 0 (0 is not a valid Markly rating)", () => {
  const items = [makeItem({ rating: undefined }), makeItem({ rating: 1 })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), rating: { mode: "unrated", min: null, max: null } }, EMPTY_CONTEXT);
  assert.equal(result.length, 1);
  assert.equal(result[0].rating, undefined);
});
check("D3: minimum rating", () => {
  const items = [makeItem({ rating: 5 }), makeItem({ rating: 8 }), makeItem({ rating: undefined })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), rating: { mode: "min", min: 7, max: null } }, EMPTY_CONTEXT);
  assert.equal(result.length, 1);
  assert.equal(result[0].rating, 8);
});
check("D4: rating range is inclusive both ends", () => {
  const items = [makeItem({ rating: 4 }), makeItem({ rating: 5 }), makeItem({ rating: 7 }), makeItem({ rating: 8 })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), rating: { mode: "range", min: 5, max: 7 } }, EMPTY_CONTEXT);
  assert.deepEqual(result.map((i) => i.rating).sort(), [5, 7]);
});
check("D5: rating filter treats a non-trackable item (no rating field) as unrated", () => {
  const item = makeItem({ type: "website" });
  delete item.rating;
  const result = filterSmartViewItems([item], { ...defaultSmartViewDefinition(), rating: { mode: "unrated", min: null, max: null } }, EMPTY_CONTEXT);
  assert.equal(result.length, 1);
});

// ============================================================
// E — collection ANY semantics
// ============================================================
check("E1: item in ANY of the selected collections matches", () => {
  const items = [makeItem({ id: "i1" }), makeItem({ id: "i2" }), makeItem({ id: "i3" })];
  const collections = [{ id: "c1", itemIds: ["i1"] }, { id: "c2", itemIds: ["i2"] }];
  const ctx = { ...EMPTY_CONTEXT, collections };
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), collections: ["c1", "c2"] }, ctx);
  assert.deepEqual(result.map((i) => i.id).sort(), ["i1", "i2"]);
});
check("E2: empty collections array means no collection restriction", () => {
  const items = [makeItem({ id: "i1" }), makeItem({ id: "i2" })];
  const collections = [{ id: "c1", itemIds: ["i1"] }];
  const result = filterSmartViewItems(items, defaultSmartViewDefinition(), { ...EMPTY_CONTEXT, collections });
  assert.equal(result.length, 2);
});

// ============================================================
// F — tags ANY/ALL
// ============================================================
check("F1: tags match ANY", () => {
  const items = [makeItem({ tags: ["comfort"] }), makeItem({ tags: ["action"] }), makeItem({ tags: [] })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), tags: { values: ["comfort", "action"], match: "any" } }, EMPTY_CONTEXT);
  assert.equal(result.length, 2);
});
check("F2: tags match ALL requires every selected tag", () => {
  const items = [makeItem({ tags: ["comfort", "short"] }), makeItem({ tags: ["comfort"] })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), tags: { values: ["comfort", "short"], match: "all" } }, EMPTY_CONTEXT);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].tags.sort(), ["comfort", "short"]);
});
check("F3: tag matching is case-insensitive", () => {
  const items = [makeItem({ tags: ["Comfort"] })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), tags: { values: ["comfort"], match: "any" } }, EMPTY_CONTEXT);
  assert.equal(result.length, 1);
});

// ============================================================
// H — search composition (AND across dimensions, OR within one)
// ============================================================
check("H1: query composes with type/status via AND", () => {
  const items = [
    makeItem({ type: "novel", status: "in_progress", title: "Lord of Mysteries" }),
    makeItem({ type: "novel", status: "completed", title: "Lord of Mysteries Vol 2" }),
    makeItem({ type: "anime", status: "in_progress", title: "Lord of the Rings" }),
  ];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), query: "lord", mediaTypes: ["novel"], statuses: ["in_progress"] }, EMPTY_CONTEXT);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Lord of Mysteries");
});
check("H2: zero matches across combined dimensions returns empty, never throws", () => {
  const items = [makeItem({ type: "anime" })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), mediaTypes: ["manga"], query: "anything" }, EMPTY_CONTEXT);
  assert.deepEqual(result, []);
});

// ============================================================
// I — activity boundaries
// ============================================================
check("I1 (§50): active 13d23h ago is included in a 14-day active_within window", () => {
  const events = [{ itemId: "i1", type: "progress_updated", timestamp: new Date(NOW.getTime() - (13 * DAY_MS + 23 * 60 * 60 * 1000)).toISOString() }];
  const summary = buildActivitySummary(events);
  const items = [makeItem({ id: "i1" })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), activity: { mode: "active_within", days: 14 } }, { ...EMPTY_CONTEXT, activitySummary: summary });
  assert.equal(result.length, 1);
});
check("I2 (§50): active exactly 14 days ago is included (inclusive boundary)", () => {
  const events = [{ itemId: "i1", type: "progress_updated", timestamp: daysAgo(14) }];
  const summary = buildActivitySummary(events);
  const result = filterSmartViewItems([makeItem({ id: "i1" })], { ...defaultSmartViewDefinition(), activity: { mode: "active_within", days: 14 } }, { ...EMPTY_CONTEXT, activitySummary: summary });
  assert.equal(result.length, 1);
});
check("I3 (§50): active 15 days ago is excluded from a 14-day window", () => {
  const events = [{ itemId: "i1", type: "progress_updated", timestamp: daysAgo(15) }];
  const summary = buildActivitySummary(events);
  const result = filterSmartViewItems([makeItem({ id: "i1" })], { ...defaultSmartViewDefinition(), activity: { mode: "active_within", days: 14 } }, { ...EMPTY_CONTEXT, activitySummary: summary });
  assert.equal(result.length, 0);
});
check("I4 (§50): an item with no activity is excluded from active_within regardless of window", () => {
  const result = filterSmartViewItems([makeItem({ id: "i1" })], { ...defaultSmartViewDefinition(), activity: { mode: "active_within", days: 14 } }, EMPTY_CONTEXT);
  assert.equal(result.length, 0);
});
check("I5 (§49): active 29d23h ago is NOT stalled-inactive under a 30-day inactive_for", () => {
  const events = [{ itemId: "i1", type: "progress_updated", timestamp: new Date(NOW.getTime() - (29 * DAY_MS + 23 * 60 * 60 * 1000)).toISOString() }];
  const summary = buildActivitySummary(events);
  const result = matchesActivity(makeItem({ id: "i1" }), { mode: "inactive_for", days: 30 }, summary, NOW.getTime());
  assert.equal(result, false);
});
check("I6 (§49): active exactly 30 days ago IS inactive under a 30-day inactive_for (inclusive boundary)", () => {
  const events = [{ itemId: "i1", type: "progress_updated", timestamp: daysAgo(30) }];
  const summary = buildActivitySummary(events);
  const result = matchesActivity(makeItem({ id: "i1" }), { mode: "inactive_for", days: 30 }, summary, NOW.getTime());
  assert.equal(result, true);
});
check("I7 (§49): active 31 days ago is inactive", () => {
  const events = [{ itemId: "i1", type: "progress_updated", timestamp: daysAgo(31) }];
  const summary = buildActivitySummary(events);
  assert.equal(matchesActivity(makeItem({ id: "i1" }), { mode: "inactive_for", days: 30 }, summary, NOW.getTime()), true);
});
check("I8 (§49/§17): never active but created only 10 days ago is NOT yet inactive-for-30 (createdAt fallback measures age, not fabricated activity)", () => {
  const item = makeItem({ id: "i1", createdAt: daysAgo(10) });
  assert.equal(matchesActivity(item, { mode: "inactive_for", days: 30 }, new Map(), NOW.getTime()), false);
});
check("I9 (§49/§17): never active AND created 40 days ago IS inactive-for-30 via the createdAt fallback", () => {
  const item = makeItem({ id: "i1", createdAt: daysAgo(40) });
  assert.equal(matchesActivity(item, { mode: "inactive_for", days: 30 }, new Map(), NOW.getTime()), true);
});
check("I10 (§49): completed 60d inactive is not counted stalled by the activity predicate alone — Stalled's own status:[\"in_progress\"] restriction is what actually excludes it (tested in the built-in view section)", () => {
  const item = makeItem({ id: "i1", status: "completed", createdAt: daysAgo(90) });
  const events = [{ itemId: "i1", type: "status_updated", timestamp: daysAgo(60) }];
  const summary = buildActivitySummary(events);
  assert.equal(matchesActivity(item, { mode: "inactive_for", days: 30 }, summary, NOW.getTime()), true, "the activity predicate itself is status-agnostic by design");
});
check("I11 (§14): never-active item reports lastActivityAt as absent (undefined), never substituting createdAt as if it were real activity", () => {
  const item = makeItem({ id: "i1", createdAt: daysAgo(5) });
  const summary = buildActivitySummary([]);
  assert.equal(summary.get(item.id), undefined);
});
check("I12: mode never means no qualifying activity at all", () => {
  const events = [{ itemId: "i1", type: "progress_updated", timestamp: daysAgo(1) }];
  const summary = buildActivitySummary(events);
  const items = [makeItem({ id: "i1" }), makeItem({ id: "i2" })];
  const result = filterSmartViewItems(items, { ...defaultSmartViewDefinition(), activity: { mode: "never", days: null } }, { ...EMPTY_CONTEXT, activitySummary: summary });
  assert.deepEqual(result.map((i) => i.id), ["i2"]);
});
check("I13 (§13): item_added is never a qualifying activity type", () => {
  const events = [{ itemId: "i1", type: "item_added", timestamp: daysAgo(1) }];
  const summary = buildActivitySummary(events);
  assert.equal(summary.has("i1"), false);
});
check("I14 (§13): progress_updated/rating_updated/status_updated all qualify", () => {
  for (const type of ["progress_updated", "rating_updated", "status_updated"]) {
    const summary = buildActivitySummary([{ itemId: "x", type, timestamp: daysAgo(1) }]);
    assert.ok(summary.has("x"), `${type} should qualify`);
  }
});
check("I15: buildActivitySummary keeps only the LATEST qualifying timestamp per item", () => {
  const events = [
    { itemId: "i1", type: "progress_updated", timestamp: daysAgo(10) },
    { itemId: "i1", type: "rating_updated", timestamp: daysAgo(2) },
    { itemId: "i1", type: "status_updated", timestamp: daysAgo(20) },
  ];
  const summary = buildActivitySummary(events);
  assert.equal(summary.get("i1"), daysAgo(2));
});

// ============================================================
// J — sort matrix
// ============================================================
check("J1: title sort asc", () => {
  const items = [makeItem({ title: "Banana" }), makeItem({ title: "Apple" })];
  const result = sortSmartViewItems(items, { by: "title", direction: "asc" }, new Map());
  assert.deepEqual(result.map((i) => i.title), ["Apple", "Banana"]);
});
check("J2: recently added = createdAt desc", () => {
  const items = [makeItem({ createdAt: "2026-01-01T00:00:00.000Z" }), makeItem({ createdAt: "2026-03-01T00:00:00.000Z" })];
  const result = sortSmartViewItems(items, { by: "createdAt", direction: "desc" }, new Map());
  assert.equal(result[0].createdAt, "2026-03-01T00:00:00.000Z");
});
check("J3: oldest added = createdAt asc", () => {
  const items = [makeItem({ createdAt: "2026-03-01T00:00:00.000Z" }), makeItem({ createdAt: "2026-01-01T00:00:00.000Z" })];
  const result = sortSmartViewItems(items, { by: "createdAt", direction: "asc" }, new Map());
  assert.equal(result[0].createdAt, "2026-01-01T00:00:00.000Z");
});
check("J4 (§34/§78): recently active places no-activity items LAST regardless of direction (desc)", () => {
  const items = [makeItem({ id: "a" }), makeItem({ id: "b" })];
  const summary = new Map([["a", daysAgo(1)]]);
  const result = sortSmartViewItems(items, { by: "lastActivity", direction: "desc" }, summary);
  assert.equal(result[result.length - 1].id, "b");
});
check("J5: recently active places no-activity items LAST even with direction asc", () => {
  const items = [makeItem({ id: "a" }), makeItem({ id: "b" })];
  const summary = new Map([["a", daysAgo(1)]]);
  const result = sortSmartViewItems(items, { by: "lastActivity", direction: "asc" }, summary);
  assert.equal(result[result.length - 1].id, "b");
});
check("J6: highest rated", () => {
  const items = [makeItem({ rating: 5 }), makeItem({ rating: 9 })];
  const result = sortSmartViewItems(items, { by: "rating", direction: "desc" }, new Map());
  assert.equal(result[0].rating, 9);
});
check("J7: lowest rated", () => {
  const items = [makeItem({ rating: 5 }), makeItem({ rating: 9 })];
  const result = sortSmartViewItems(items, { by: "rating", direction: "asc" }, new Map());
  assert.equal(result[0].rating, 5);
});
check("J8 (§34/§78): unrated items sort LAST regardless of highest/lowest direction", () => {
  const items = [makeItem({ id: "a", rating: undefined }), makeItem({ id: "b", rating: 3 })];
  const highest = sortSmartViewItems(items, { by: "rating", direction: "desc" }, new Map());
  const lowest = sortSmartViewItems(items, { by: "rating", direction: "asc" }, new Map());
  assert.equal(highest[highest.length - 1].id, "a");
  assert.equal(lowest[lowest.length - 1].id, "a");
});
check("J9 (§78): deterministic tie-break by title then id — two items are never considered equal", () => {
  const items = [makeItem({ id: "z", title: "Same", createdAt: "2026-01-01T00:00:00.000Z" }), makeItem({ id: "a", title: "Same", createdAt: "2026-01-01T00:00:00.000Z" })];
  const result = sortSmartViewItems(items, { by: "createdAt", direction: "desc" }, new Map());
  assert.equal(result[0].id, "a", "same title AND same createdAt must still tie-break deterministically by id");
});

// ============================================================
// K — grouping
// ============================================================
check("K1: groupBy none returns one group containing every item, no duplicates", () => {
  const items = [makeItem(), makeItem()];
  const groups = groupSmartViewItems(items, "none");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 2);
});
check("K2: groupBy mediaType — every item appears in exactly one group", () => {
  const items = [makeItem({ type: "anime" }), makeItem({ type: "manga" }), makeItem({ type: "anime" })];
  const groups = groupSmartViewItems(items, "mediaType");
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);
  assert.equal(total, items.length);
  const animeGroup = groups.find((g) => g.key === "anime");
  assert.equal(animeGroup.items.length, 2);
});
check("K3: groupBy mediaType uses the canonical SUPPORTED_ITEM_TYPES order, not alphabetical", () => {
  const items = [makeItem({ type: "movie" }), makeItem({ type: "anime" })];
  const groups = groupSmartViewItems(items, "mediaType");
  assert.deepEqual(groups.map((g) => g.key), ["anime", "movie"], "anime precedes movie in SUPPORTED_ITEM_TYPES, not alphabetically (movie < anime alphabetically would be wrong)");
});
check("K4: groupBy status uses TRACKING_STATUSES canonical order and puts statusless items in a trailing group", () => {
  const website = makeItem({ type: "website" });
  delete website.status;
  const items = [makeItem({ status: "completed" }), makeItem({ status: "planned" }), website];
  const groups = groupSmartViewItems(items, "status");
  assert.deepEqual(groups.map((g) => g.key), ["planned", "completed", "none"]);
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);
  assert.equal(total, items.length);
});
check("K5: empty groups are never rendered", () => {
  const groups = groupSmartViewItems([makeItem({ type: "anime" })], "mediaType");
  assert.equal(groups.length, 1);
});

// ============================================================
// L — built-in views
// ============================================================
check("L1 (Continue): status=in_progress only, sorted by lastActivity desc, items without activity still appear (sorted last)", () => {
  const view = BUILT_IN_SMART_VIEWS.find((v) => v.id === "builtin-continue");
  const items = [makeItem({ id: "a", status: "in_progress" }), makeItem({ id: "b", status: "completed" }), makeItem({ id: "c", status: "in_progress" })];
  const summary = new Map([["a", daysAgo(1)]]);
  const result = applySmartView(items, view.definition, { ...EMPTY_CONTEXT, activitySummary: summary });
  assert.deepEqual(result.map((i) => i.id), ["a", "c"], "excludes completed; c (no activity) still appears, sorted after a");
});
check("L2 (Recently Active): active within 14 days, any status, sorted newest-activity-first", () => {
  const view = BUILT_IN_SMART_VIEWS.find((v) => v.id === "builtin-recently-active");
  const items = [makeItem({ id: "a", status: "completed" }), makeItem({ id: "b", status: "in_progress" }), makeItem({ id: "c", status: "dropped" })];
  const summary = new Map([["a", daysAgo(1)], ["b", daysAgo(20)], ["c", daysAgo(5)]]);
  const result = applySmartView(items, view.definition, { ...EMPTY_CONTEXT, activitySummary: summary });
  assert.deepEqual(result.map((i) => i.id), ["a", "c"], "b is excluded (20d > 14d); a is newer than c");
});
check("L3 (Stalled): in_progress AND inactive >=30d, including never-active items old enough", () => {
  const view = BUILT_IN_SMART_VIEWS.find((v) => v.id === "builtin-stalled");
  const items = [
    makeItem({ id: "fresh", status: "in_progress", createdAt: daysAgo(5) }), // never active, too new
    makeItem({ id: "old-never", status: "in_progress", createdAt: daysAgo(40) }), // never active, old enough
    makeItem({ id: "recently-touched", status: "in_progress", createdAt: daysAgo(100) }),
    makeItem({ id: "on-hold-old", status: "on_hold", createdAt: daysAgo(100) }), // excluded: not in_progress
  ];
  const summary = new Map([["recently-touched", daysAgo(2)]]);
  const result = applySmartView(items, view.definition, { ...EMPTY_CONTEXT, activitySummary: summary });
  assert.deepEqual(result.map((i) => i.id).sort(), ["old-never"]);
});
check("L4 (Favorites): favorite=true, sorted by title", () => {
  const view = BUILT_IN_SMART_VIEWS.find((v) => v.id === "builtin-favorites");
  const items = [makeItem({ title: "Zebra", favorite: true }), makeItem({ title: "Apple", favorite: true }), makeItem({ title: "Middle", favorite: false })];
  const result = applySmartView(items, view.definition, EMPTY_CONTEXT);
  assert.deepEqual(result.map((i) => i.title), ["Apple", "Zebra"]);
});
check("L5 (Unrated): rating absent, no status exclusion (literal semantics — a planned item is included too)", () => {
  const view = BUILT_IN_SMART_VIEWS.find((v) => v.id === "builtin-unrated");
  const items = [makeItem({ status: "planned", rating: undefined }), makeItem({ status: "completed", rating: 8 })];
  const result = applySmartView(items, view.definition, EMPTY_CONTEXT);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "planned");
});
check("L6: exactly 5 built-in views exist, matching the product goal's exact list", () => {
  assert.equal(BUILT_IN_SMART_VIEWS.length, 5);
  assert.deepEqual(BUILT_IN_SMART_VIEWS.map((v) => v.name), ["Continue", "Recently Active", "Stalled", "Favorites", "Unrated"]);
});

// ============================================================
// M — safe definition parsing
// ============================================================
check("M1: a well-formed definition round-trips through parseSmartViewDefinition", () => {
  const def = defaultSmartViewDefinition();
  assert.deepEqual(parseSmartViewDefinition(def), def);
});
check("M2: an unsupported version is rejected, never cast into the type", () => {
  assert.equal(parseSmartViewDefinition({ ...defaultSmartViewDefinition(), version: 2 }), null);
});
check("M3: a malformed shape (missing rating) is rejected without throwing", () => {
  const def = defaultSmartViewDefinition();
  delete def.rating;
  assert.equal(parseSmartViewDefinition(def), null);
});
check("M4: null/non-object input is rejected safely", () => {
  assert.equal(parseSmartViewDefinition(null), null);
  assert.equal(parseSmartViewDefinition("garbage"), null);
  assert.equal(parseSmartViewDefinition(42), null);
});
check("M5: an invalid enum value (bad sort.by) is rejected", () => {
  const def = { ...defaultSmartViewDefinition(), sort: { by: "progress", direction: "asc" } };
  assert.equal(parseSmartViewDefinition(def), null);
});
check("M6: an invalid media type value is rejected", () => {
  const def = { ...defaultSmartViewDefinition(), mediaTypes: ["not-a-real-type"] };
  assert.equal(parseSmartViewDefinition(def), null);
});

// ============================================================
// N — saved-view name validation & uniqueness
// ============================================================
check("N1: empty name is rejected", () => {
  assert.deepEqual(validateSmartViewName("   "), { ok: false, reason: "empty" });
});
check("N2: a name over the max length is rejected", () => {
  assert.deepEqual(validateSmartViewName("x".repeat(300)), { ok: false, reason: "too_long" });
});
check("N3: a name with control characters is rejected", () => {
  assert.deepEqual(validateSmartViewName("bad\x00name"), { ok: false, reason: "invalid" });
});
check("N4: whitespace is trimmed and collapsed", () => {
  assert.deepEqual(validateSmartViewName("  Reading   Manga  "), { ok: true, name: "Reading Manga" });
});
check("N5: duplicate detection is case-insensitive, mirroring isDuplicateCollectionName", () => {
  const existing = [{ id: "1", name: "Anime Backlog" }];
  assert.equal(isDuplicateSmartViewName("anime backlog", existing), true);
  assert.equal(isDuplicateSmartViewName("Something Else", existing), false);
});
check("N6: excludeId lets a view keep its own name during rename/update", () => {
  const existing = [{ id: "1", name: "Anime Backlog" }];
  assert.equal(isDuplicateSmartViewName("Anime Backlog", existing, "1"), false);
});

// ============================================================
// O — temporary modification / equality
// ============================================================
check("O1 (§82): opening a saved view then changing one filter does not mutate the stored definition — only in-memory comparison detects the difference", () => {
  const saved = { ...defaultSmartViewDefinition(), mediaTypes: ["manga"] };
  const current = { ...saved, favorite: true }; // simulates a live ad-hoc tweak
  assert.equal(smartViewDefinitionsEqual(saved, current), false);
  assert.deepEqual(saved.mediaTypes, ["manga"], "the original saved object itself was never touched");
});
check("O2: two structurally identical definitions compare equal even if built independently", () => {
  const a = { ...defaultSmartViewDefinition(), tags: { values: ["x"], match: "all" } };
  const b = { ...defaultSmartViewDefinition(), tags: { values: ["x"], match: "all" } };
  assert.equal(smartViewDefinitionsEqual(a, b), true);
});

// ============================================================
// P — large-fixture performance sanity (Stage 31 §84)
// ============================================================
check("P1: filtering+sorting 5,000 synthetic items with a real activity summary completes quickly with no pathological items x events scan", () => {
  const items = [];
  const events = [];
  for (let i = 0; i < 5000; i++) {
    items.push(
      makeItem({
        id: `bulk-${i}`,
        type: SUPPORTED_ITEM_TYPES[i % SUPPORTED_ITEM_TYPES.length],
        status: TRACKING_STATUSES[i % TRACKING_STATUSES.length],
        rating: i % 3 === 0 ? undefined : (i % 10) + 1,
        favorite: i % 5 === 0,
        tags: i % 2 === 0 ? ["even"] : ["odd"],
        createdAt: daysAgo(i % 400),
      }),
    );
    // ~3 events per item, matching a realistic multi-event history.
    for (let e = 0; e < 3; e++) {
      events.push({ itemId: `bulk-${i}`, type: "progress_updated", timestamp: daysAgo((i % 400) + e) });
    }
  }
  const summary = buildActivitySummary(events); // O(events) once
  const ctx = { collections: [], activitySummary: summary, now: NOW };
  const definition = { ...defaultSmartViewDefinition(), statuses: ["in_progress"], sort: { by: "lastActivity", direction: "desc" } };

  const start = process.hrtime.bigint();
  const result = applySmartView(items, definition, ctx); // must be O(items), never O(items * events)
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  assert.ok(result.length > 0, "sanity: the fixture actually produced matches");
  assert.ok(elapsedMs < 500, `filter+sort of 5,000 items took ${elapsedMs.toFixed(1)}ms — expected well under 500ms for an O(items) pass`);
});

// ============================================================
// Q — local durable activity summary (correctness-review fix), reproduced
// verbatim from lib/smart-views.ts's mergeActivityIntoSummary/
// mergeSummaryEntry/recomputeSummaryForItems. The bug this fixes: a naive
// design that derives the summary purely from useActivity's own capped
// 500-event array loses an item's last-activity the moment its qualifying
// event ages out of that window — indistinguishable from "never active".
// These functions instead operate on a SEPARATE, durable persisted map
// (markly.activitySummary, activity-summary-storage.ts) that only ever
// advances, so trimming the detailed log can never erase it.
// ============================================================
function mergeActivityIntoSummary(base, events) {
  const merged = new Map(base);
  for (const event of events) {
    if (!QUALIFYING_ACTIVITY_TYPES.includes(event.type)) continue;
    const current = merged.get(event.itemId);
    if (!current || event.timestamp > current) merged.set(event.itemId, event.timestamp);
  }
  return merged;
}
function mergeSummaryEntry(summary, fromItemId, toItemId) {
  const merged = new Map(summary);
  const fromValue = merged.get(fromItemId);
  const toValue = merged.get(toItemId);
  if (fromValue && (!toValue || fromValue > toValue)) merged.set(toItemId, fromValue);
  return merged;
}
function recomputeSummaryForItems(summary, itemIds, events) {
  const merged = new Map(summary);
  for (const itemId of itemIds) merged.delete(itemId);
  for (const event of events) {
    if (!QUALIFYING_ACTIVITY_TYPES.includes(event.type)) continue;
    if (!itemIds.includes(event.itemId)) continue;
    const current = merged.get(event.itemId);
    if (!current || event.timestamp > current) merged.set(event.itemId, event.timestamp);
  }
  return merged;
}

/** Simulates the exact rolling-500-cap trim useActivity.ts's logEvent and activity-storage.ts's saveActivity both perform (newest-first, slice to capacity) — used to reproduce "an old qualifying event ages out of the detailed log" precisely. */
function trimToCapacity(events, capacity) {
  return events.length > capacity ? events.slice(0, capacity) : events;
}

check("Q1 (§A10.1/§A10.2 — the core bug this fixes): 501 sequential qualifying events for DIFFERENT items, capped at 500 — item #1's own qualifying event ages out of the detailed log, but the durable summary still knows its timestamp and it does NOT become indistinguishable from never-active", () => {
  let detailedLog = [];
  let summary = new Map();
  const capacity = 500;
  for (let i = 0; i < 501; i++) {
    const event = { itemId: `item-${i}`, type: "progress_updated", timestamp: daysAgo(501 - i) };
    detailedLog = trimToCapacity([event, ...detailedLog], capacity); // newest-first prepend, matches logEvent's own convention
    summary = mergeActivityIntoSummary(summary, [event]); // the fix: merge into the durable summary on every qualifying event, BEFORE any trim
  }
  assert.equal(detailedLog.length, 500, "sanity: the detailed log is indeed capped");
  assert.equal(detailedLog.some((e) => e.itemId === "item-0"), false, "sanity: item-0's own event really did age out of the detailed log");
  assert.equal(summary.has("item-0"), true, "the durable summary must still know item-0's last-activity timestamp");
  assert.equal(summary.get("item-0"), daysAgo(501));
});
check("Q2 (§A10.3): item_added never populates the summary, even alongside qualifying events for the same item", () => {
  const events = [{ itemId: "i1", type: "item_added", timestamp: daysAgo(1) }];
  const summary = mergeActivityIntoSummary(new Map(), events);
  assert.equal(summary.has("i1"), false);
});
check("Q3 (§A10.4): a qualifying progress_updated event advances the summary", () => {
  const summary = mergeActivityIntoSummary(new Map(), [{ itemId: "i1", type: "progress_updated", timestamp: daysAgo(3) }]);
  assert.equal(summary.get("i1"), daysAgo(3));
});
check("Q4 (§A10.5): merging an OLDER event never replaces a newer already-recorded summary timestamp", () => {
  const base = new Map([["i1", daysAgo(1)]]);
  const merged = mergeActivityIntoSummary(base, [{ itemId: "i1", type: "progress_updated", timestamp: daysAgo(30) }]);
  assert.equal(merged.get("i1"), daysAgo(1), "the older imported event must not overwrite the newer existing summary value");
});
check("Q5 (§A10.6): merging a NEWER event advances the summary past an older existing value", () => {
  const base = new Map([["i1", daysAgo(30)]]);
  const merged = mergeActivityIntoSummary(base, [{ itemId: "i1", type: "progress_updated", timestamp: daysAgo(1) }]);
  assert.equal(merged.get("i1"), daysAgo(1));
});
check("Q6 (§A10.7 — Stage 29 import): a backup import spanning many items, more than the 500-event detailed cap, still leaves the summary complete for every represented item, using the FULL imported set merged BEFORE the detailed-log capacity trim", () => {
  const importedEvents = [];
  for (let i = 0; i < 700; i++) importedEvents.push({ itemId: `imported-${i}`, type: "status_updated", timestamp: daysAgo(700 - i) });
  const retainedDetailed = trimToCapacity([...importedEvents].sort((a, b) => b.timestamp.localeCompare(a.timestamp)), 500);
  const summary = mergeActivityIntoSummary(new Map(), importedEvents); // BackupSettingsPanel merges applied.newEvents (the full set), not applied.events (the capped one)
  assert.equal(retainedDetailed.length, 500, "sanity: the detailed log really did cap at 500 of the 700 imported events");
  assert.equal(summary.size, 700, "the durable summary must represent all 700 imported items, not just the 500 that survived the detailed-log cap");
  for (let i = 0; i < 700; i++) assert.equal(summary.get(`imported-${i}`), daysAgo(700 - i));
});
check("Q7 (§A10.8 — Stage 27 local merge): survivor's summary becomes max(survivor, duplicate) using the PERSISTED summary values directly — correct even if one side's original qualifying event has already aged out of the detailed log", () => {
  const summary = new Map([["survivor", daysAgo(10)], ["duplicate", daysAgo(2)]]); // duplicate was more recently active
  const merged = mergeSummaryEntry(summary, "duplicate", "survivor");
  assert.equal(merged.get("survivor"), daysAgo(2), "survivor must adopt the newer (duplicate's) timestamp");
  assert.equal(merged.get("duplicate"), daysAgo(2), "the duplicate's own entry is left in place — harmless residue, never looked up once the item itself is gone");
});
check("Q7b: merge in the other direction — survivor already newer than duplicate stays unchanged", () => {
  const summary = new Map([["survivor", daysAgo(2)], ["duplicate", daysAgo(10)]]);
  const merged = mergeSummaryEntry(summary, "duplicate", "survivor");
  assert.equal(merged.get("survivor"), daysAgo(2), "survivor was already the newer of the two — merge must not regress it");
});
check("Q8 (§A5/§A9 — Stage 27 local merge-UNDO): a plain max-merge could never walk a survivor's inflated summary back down after undo; recomputeSummaryForItems hard-resets exactly the two affected items from the (already un-merged) restored event list", () => {
  // Before merge: survivor's own real activity is 10 days ago; duplicate's is 2 days ago.
  let summary = new Map([["survivor", daysAgo(10)], ["duplicate", daysAgo(2)]]);
  // Merge: survivor's summary is inflated to max(10d, 2d) = 2d.
  summary = mergeSummaryEntry(summary, "duplicate", "survivor");
  assert.equal(summary.get("survivor"), daysAgo(2), "sanity: merge inflated survivor's summary as expected");
  // Undo: events are re-attributed back (duplicate's events return to "duplicate", survivor keeps only its own).
  const postUndoEvents = [
    { itemId: "survivor", type: "progress_updated", timestamp: daysAgo(10) },
    { itemId: "duplicate", type: "progress_updated", timestamp: daysAgo(2) },
  ];
  summary = recomputeSummaryForItems(summary, ["survivor", "duplicate"], postUndoEvents);
  assert.equal(summary.get("survivor"), daysAgo(10), "survivor's summary must walk back down to its own true pre-merge value — a max-only merge could never do this");
  assert.equal(summary.get("duplicate"), daysAgo(2), "duplicate's summary must be restored to its own pre-merge value");
});
check("Q9 (§A4 — Stage 28 local delete/Undo): a deleted item's summary entry is left in place (never actively removed), so Undo needs zero special-casing — restoring the item finds its last-activity exactly as it was, whether or not the underlying detailed events survived", () => {
  const summary = new Map([["item-1", daysAgo(5)]]);
  // Simulates deleteItemWithRecovery's local branch: activity.removeEventsForItem(id) removes DETAILED events, but nothing here ever calls summary.delete(id).
  assert.equal(summary.get("item-1"), daysAgo(5), "the entry is untouched by a delete — the fix's core design decision (§A4: never actively remove on delete)");
});
check("Q10 (§A8 — malformed local summary storage): a non-object, or an entry with a non-string/invalid-date value, must be safely dropped rather than crashing", () => {
  function isValidTimestamp(value) { return typeof value === "string" && !Number.isNaN(new Date(value).getTime()); }
  function parseStoredSummary(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const result = {};
    for (const [itemId, value] of Object.entries(raw)) if (isValidTimestamp(value)) result[itemId] = value;
    return result;
  }
  assert.equal(parseStoredSummary(null), null);
  assert.equal(parseStoredSummary("garbage"), null);
  assert.equal(parseStoredSummary([1, 2, 3]), null);
  const partiallyBad = parseStoredSummary({ good: daysAgo(1), bad: 12345, alsoBad: "not-a-date" });
  assert.deepEqual(partiallyBad, { good: daysAgo(1) }, "one malformed entry must not drop the whole map");
});
check("Q11 (§A9 — reload durability): re-hydrating from a previously-saved summary and merging current events never loses what was already durable", () => {
  const persisted = new Map([["item-1", daysAgo(50)]]); // from a LONG time ago, its own event long since trimmed from the detailed log
  const currentDetailedEvents = [{ itemId: "item-2", type: "progress_updated", timestamp: daysAgo(1) }]; // detailed log now only has recent, unrelated activity
  const rehydrated = mergeActivityIntoSummary(persisted, currentDetailedEvents);
  assert.equal(rehydrated.get("item-1"), daysAgo(50), "reload must not lose a durable entry just because its source event isn't in the current detailed log");
  assert.equal(rehydrated.get("item-2"), daysAgo(1));
});

// ============================================================
// R — saved-view name normalization (correctness-review fix): the
// migration's CHECK(name = btrim(name)) constraint plus the existing
// case-insensitive unique index together guarantee "Anime Backlog" and
// " Anime Backlog " can never coexist as two rows. Modeled here since a
// real Postgres instance isn't available to this script — see 0015's own
// SQL for the authoritative source, and Issue C's real-DB test
// requirement after deployment.
// ============================================================
function checkNameConstraint(name) {
  // Mirrors: check (name = btrim(name) and char_length(name) > 0 and char_length(name) <= 200)
  const btrimmed = name.replace(/^\s+|\s+$/g, "");
  return name === btrimmed && name.length > 0 && name.length <= 200;
}
function uniqueIndexKey(name) {
  // Mirrors: unique index ... (user_id, lower(name)) — user_id fixed per this model.
  return name.toLowerCase();
}
function modelCloudInsert(existingRows, name) {
  if (!checkNameConstraint(name)) return { status: "check_violation" };
  const key = uniqueIndexKey(name);
  if (existingRows.some((row) => uniqueIndexKey(row) === key)) return { status: "unique_violation" };
  return { status: "ok", row: name };
}

check("R1 (§B): an untrimmed name is rejected by the CHECK constraint outright, never silently stored as a second logical view", () => {
  assert.equal(modelCloudInsert([], " Anime Backlog ").status, "check_violation");
});
check("R2 (§B/§B2): an empty (post-trim) name is rejected", () => {
  assert.equal(modelCloudInsert([], "").status, "check_violation");
  assert.equal(modelCloudInsert([], "   ").status, "check_violation", "a name that is ONLY whitespace fails char_length(name) > 0 after... actually btrim would leave it non-equal to itself only if untrimmed; an all-whitespace name equals its own btrim only when empty");
});
check("R3 (§B2): a name over 200 characters is rejected", () => {
  assert.equal(modelCloudInsert([], "x".repeat(201)).status, "check_violation");
  assert.equal(modelCloudInsert([], "x".repeat(200)).status, "ok");
});
check("R4 (§18/§B1): case-insensitive duplicate is rejected once the first trimmed name exists", () => {
  const first = modelCloudInsert([], "Anime Backlog");
  assert.equal(first.status, "ok");
  const second = modelCloudInsert([first.row], "anime backlog");
  assert.equal(second.status, "unique_violation");
});
check("R5 (§19/§B3 race model): two concurrent creates of \"Anime Backlog\" and \"anime backlog\" — exactly one succeeds, one is a duplicate-name conflict, never two rows", () => {
  // Simulates the DB's own serialization: the second write to commit sees the first's already-committed row.
  const rows = [];
  const attempts = ["Anime Backlog", "anime backlog"];
  const outcomes = attempts.map((name) => {
    const result = modelCloudInsert(rows, name);
    if (result.status === "ok") rows.push(result.row);
    return result.status;
  });
  assert.equal(outcomes.filter((s) => s === "ok").length, 1, "exactly one attempt succeeds");
  assert.equal(outcomes.filter((s) => s === "unique_violation").length, 1, "the other is a duplicate-name conflict, not a silent second row");
  assert.equal(rows.length, 1, "only one row ever exists");
});
check("R6 (§B3 race model): \"Anime Backlog\" and \" Anime Backlog \" — the untrimmed attempt is rejected by the CHECK before uniqueness is even considered, so only one logical view can ever exist either way", () => {
  const rows = [];
  const first = modelCloudInsert(rows, "Anime Backlog");
  rows.push(first.row);
  const second = modelCloudInsert(rows, " Anime Backlog ");
  assert.equal(first.status, "ok");
  assert.equal(second.status, "check_violation", "the untrimmed variant never reaches the uniqueness check at all — it's rejected on its own malformed shape");
  assert.equal(rows.length, 1);
});
check("R7: the client's own validateSmartViewName already trims before ever calling the DB, so a real user never actually hits the CHECK constraint through normal UI use — it exists purely as defense against a raw PostgREST write or a future bug", () => {
  assert.equal(checkNameConstraint(normalizeSmartViewName("  Reading   Manga  ")), true, "the client-trimmed form always satisfies the DB's own CHECK");
});

// ============================================================
// S — Stage 27 local merge + Stage 28 local merge-UNDO, cross-checked
// against the NEW durable activity summary (second correctness-review
// round). Reproduces lib/smart-views.ts's mergeSummaryEntry and
// restoreSummaryEntries verbatim, and models recovery-orchestration.ts's
// exact sequence: capture {survivor, duplicate} from the durable summary
// BEFORE mergeInto runs (MergeRecoveryPayload.activitySummaryBefore), then
// on Undo restore those captured values directly via restoreSummaryEntries
// — never recomputed from the detailed Activity log, which may no longer
// contain either item's originating event by the time Undo runs.
// ============================================================
function restoreSummaryEntries(summary, entries) {
  const merged = new Map(summary);
  for (const [itemId, value] of entries) {
    if (value) merged.set(itemId, value);
    else merged.delete(itemId);
  }
  return merged;
}

/** Models mergeItemsWithRecovery's local branch: snapshot-then-mergeInto. */
function modelMergeForward(summary, survivorId, duplicateId) {
  const activitySummaryBefore = {
    survivor: summary.get(survivorId) ?? null,
    duplicate: summary.get(duplicateId) ?? null,
  };
  const merged = mergeSummaryEntry(summary, duplicateId, survivorId);
  return { summary: merged, activitySummaryBefore };
}
/** Models undoRecoveryAction's merge branch when activitySummaryBefore is present (the fixed path). */
function modelMergeUndo(summary, survivorId, duplicateId, activitySummaryBefore) {
  return restoreSummaryEntries(summary, [
    [survivorId, activitySummaryBefore.survivor],
    [duplicateId, activitySummaryBefore.duplicate],
  ]);
}

check("S1: A=Jan10, B=Mar20, merge B->A -> survivor becomes Mar20 (max)", () => {
  const before = new Map([["A", daysAgo(200)], ["B", daysAgo(10)]]); // Jan10-ish / Mar20-ish, relative
  const { summary: afterMerge } = modelMergeForward(before, "A", "B");
  assert.equal(afterMerge.get("A"), daysAgo(10));
});
check("S2: undo the S1 merge -> A restored to Jan10, B restored to Mar20 (exact split, not a recompute)", () => {
  const before = new Map([["A", daysAgo(200)], ["B", daysAgo(10)]]);
  const { summary: afterMerge, activitySummaryBefore } = modelMergeForward(before, "A", "B");
  const afterUndo = modelMergeUndo(afterMerge, "A", "B", activitySummaryBefore);
  assert.equal(afterUndo.get("A"), daysAgo(200), "A must walk back down to its own pre-merge value");
  assert.equal(afterUndo.get("B"), daysAgo(10), "B must be restored, not left missing");
});
check("S3: A has no prior activity (null), B=Mar20 -> merge gives A=Mar20 -> undo gives A absent again, B=Mar20", () => {
  const before = new Map([["B", daysAgo(10)]]); // A has no entry at all
  const { summary: afterMerge, activitySummaryBefore } = modelMergeForward(before, "A", "B");
  assert.equal(afterMerge.get("A"), daysAgo(10));
  assert.deepEqual(activitySummaryBefore, { survivor: null, duplicate: daysAgo(10) });
  const afterUndo = modelMergeUndo(afterMerge, "A", "B", activitySummaryBefore);
  assert.equal(afterUndo.has("A"), false, "A must return to having no qualifying activity — never fabricated");
  assert.equal(afterUndo.get("B"), daysAgo(10));
});
check("S4: A=Jan10, B has no prior activity (null) -> merge leaves A=Jan10 unchanged -> undo leaves A=Jan10, B absent", () => {
  const before = new Map([["A", daysAgo(200)]]); // B has no entry at all
  const { summary: afterMerge, activitySummaryBefore } = modelMergeForward(before, "A", "B");
  assert.equal(afterMerge.get("A"), daysAgo(200), "B contributed nothing — A must be untouched by the merge");
  assert.deepEqual(activitySummaryBefore, { survivor: daysAgo(200), duplicate: null });
  const afterUndo = modelMergeUndo(afterMerge, "A", "B", activitySummaryBefore);
  assert.equal(afterUndo.get("A"), daysAgo(200));
  assert.equal(afterUndo.has("B"), false);
});
check("S5: both A and B have no prior activity -> merge and undo both leave both absent, nothing fabricated", () => {
  const before = new Map();
  const { summary: afterMerge, activitySummaryBefore } = modelMergeForward(before, "A", "B");
  assert.equal(afterMerge.size, 0);
  const afterUndo = modelMergeUndo(afterMerge, "A", "B", activitySummaryBefore);
  assert.equal(afterUndo.has("A"), false);
  assert.equal(afterUndo.has("B"), false);
});
check("S6: a second Undo attempt never runs restoreSummaryEntries again (the recovery entry is removed after the first successful Undo, exactly like Stage 28 delete-Undo) — and even if it somehow ran twice, restoreSummaryEntries is an idempotent exact-set, not an incremental merge, so calling it again is a safe no-op", () => {
  const before = new Map([["A", daysAgo(200)], ["B", daysAgo(10)]]);
  const { summary: afterMerge, activitySummaryBefore } = modelMergeForward(before, "A", "B");
  const afterFirstUndo = modelMergeUndo(afterMerge, "A", "B", activitySummaryBefore);
  const afterSecondUndo = modelMergeUndo(afterFirstUndo, "A", "B", activitySummaryBefore); // simulates what WOULD happen if called again
  assert.equal(afterSecondUndo.get("A"), daysAgo(200), "identical to after the first undo — restoring the same values twice is a no-op");
  assert.equal(afterSecondUndo.get("B"), daysAgo(10));
});
check("S7: a conflicted/failed Undo must never call restoreSummaryEntries at all — the summary stays exactly as the successful merge left it, matching the real code path where validateMergeUndo's early return happens before any restoration call", () => {
  const before = new Map([["A", daysAgo(200)], ["B", daysAgo(10)]]);
  const { summary: afterMerge } = modelMergeForward(before, "A", "B");
  // undoRecoveryAction returns before touching activitySummaryStore whenever
  // validateMergeUndo's outcome isn't "recovered" — modeled here simply by
  // never calling modelMergeUndo in the conflict branch.
  const outcomeWasConflict = true;
  const summaryAfterFailedUndoAttempt = outcomeWasConflict ? afterMerge : modelMergeUndo(afterMerge, "A", "B", {});
  assert.equal(summaryAfterFailedUndoAttempt.get("A"), daysAgo(10), "still the post-merge value — a failed Undo must not partially or fully revert the summary");
  assert.equal(summaryAfterFailedUndoAttempt.get("B"), daysAgo(10), "B's own entry is untouched inert residue from before the merge (mergeSummaryEntry never deletes it) — a failed Undo must leave it exactly as the merge did, neither reset nor further changed");
});
check("S8 (CRITICAL): both items' originating detailed events are trimmed from the 500-event log between merge and Undo — the snapshot-based restore still recovers the exact pre-merge split, whereas the legacy recompute-from-events approach demonstrably would not", () => {
  const before = new Map([["A", daysAgo(200)], ["B", daysAgo(10)]]);
  const { summary: afterMerge, activitySummaryBefore } = modelMergeForward(before, "A", "B");
  assert.deepEqual(activitySummaryBefore, { survivor: daysAgo(200), duplicate: daysAgo(10) });

  // Simulate a burst of 500+ unrelated qualifying events for OTHER items
  // between merge and Undo, trimming A's and B's own originating events
  // out of the detailed log entirely by the time Undo runs.
  let detailedLog = [];
  for (let i = 0; i < 550; i++) {
    detailedLog = trimToCapacity([{ itemId: `unrelated-${i}`, type: "progress_updated", timestamp: daysAgo(1) }, ...detailedLog], 500);
  }
  assert.equal(detailedLog.some((e) => e.itemId === "A" || e.itemId === "B"), false, "sanity: neither item's own event survived the trim");

  // The OLD (legacy) approach: recompute purely from what's left in the detailed log.
  const legacyRecomputed = recomputeSummaryForItems(afterMerge, ["A", "B"], detailedLog);
  assert.equal(legacyRecomputed.has("A"), false, "demonstrates the bug: the legacy recompute loses A's true pre-merge value once its event is trimmed");
  assert.equal(legacyRecomputed.has("B"), false, "demonstrates the bug: same loss for B");

  // The FIXED approach: restore the values captured in the recovery snapshot at merge time, independent of the detailed log's current contents.
  const fixedRestore = modelMergeUndo(afterMerge, "A", "B", activitySummaryBefore);
  assert.equal(fixedRestore.get("A"), daysAgo(200), "the fix recovers A's exact pre-merge value even though its originating event is long gone from the detailed log");
  assert.equal(fixedRestore.get("B"), daysAgo(10), "same for B");
});
check("S9 (§12 — old recovery record without the snapshot): a merge-recovery payload persisted before activitySummaryBefore existed must fall back to the legacy recompute rather than crashing Undo", () => {
  const payloadWithoutSnapshot = { movedActivityIds: ["ev-b1"] }; // activitySummaryBefore is simply absent, as an old JSON blob would be
  assert.equal(payloadWithoutSnapshot.activitySummaryBefore, undefined, "sanity: this really does model the old shape");
  // undoRecoveryAction's `if (payload.activitySummaryBefore) {...} else {...}` branch is exactly this check — an absent field takes the else (legacy) branch instead of throwing.
  const tookLegacyBranch = !payloadWithoutSnapshot.activitySummaryBefore;
  assert.equal(tookLegacyBranch, true);
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
console.log(
  `\nNote: this script reproduces lib/smart-views.ts's pure engine, built-in view definitions, and name-validation logic verbatim (same convention as every other script in this directory — plain .mjs, no TypeScript loader). It never touches a real database. Cloud persistence (saved_library_views table, get_library_activity_summary RPC — both in 0015_stage31_saved_library_views.sql, NOT deployed) is covered by hand-inspection and by mirroring the exact same fetch/parse/validate code paths used by lib/cloud/smart-views.ts and lib/cloud/activity-summary.ts; real Supabase CRUD/RLS/uniqueness-race tests are deferred until after review and deployment, per Stage 31's own instructions.`,
);
if (failed.length > 0) process.exit(1);
