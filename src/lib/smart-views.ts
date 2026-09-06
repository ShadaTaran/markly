import type { LibraryItem, LibraryItemType, TrackingStatus } from "@/types/library-item";
import { SUPPORTED_ITEM_TYPES, ITEM_TYPE_LABELS } from "@/types/library-item";
import type { ActivityEvent, ActivityEventType } from "@/types/activity";
import type { Collection } from "@/types/collection";
import {
  SMART_VIEW_DEFINITION_VERSION,
  defaultSmartViewDefinition,
  type ActivityFilter,
  type ActivityFilterMode,
  type RatingFilter,
  type RatingFilterMode,
  type SmartView,
  type SmartViewDefinition,
  type SmartViewGroupBy,
  type SmartViewSort,
  type SmartViewSortBy,
  type SmartViewSortDirection,
  type TagFilter,
  type TagMatchMode,
} from "@/types/smart-view";
import { TRACKING_STATUSES, STATUS_FILTER_LABELS } from "@/lib/tracking";
import { getSearchableText } from "@/lib/library-items";
import { isMediaItem } from "@/lib/item-detail";

// ============================================================
// Activity summary — item_id -> latest QUALIFYING activity timestamp
// ============================================================

/**
 * Which ActivityEvent types count as genuine personal consumption/
 * interaction for Smart View purposes. `item_added` is deliberately
 * excluded — creation alone is never "recently consumed" (Stage 31 §14),
 * matching the existing precedent in DashboardView's own Recent Activity
 * list, which already filters out `item_added` there. Administrative
 * side-effects (Stage 27 merge reassigns existing events' itemId rather
 * than creating new ones; Stage 28 Undo reinserts real historical events
 * verbatim; Stage 29 import only ever creates `item_added` for newly
 * created items) never fabricate a progress/rating/status event, so no
 * further exclusion is needed beyond this one.
 */
export const QUALIFYING_ACTIVITY_TYPES: readonly ActivityEventType[] = ["progress_updated", "rating_updated", "status_updated"];

export type ActivitySummary = ReadonlyMap<string, string>;

/**
 * Builds itemId -> latest qualifying-activity ISO timestamp from a full
 * event list. Pure and cheap to call once per render (O(events)) — the
 * engine itself never re-scans raw events per item (Stage 31 §53).
 */
export function buildActivitySummary(events: readonly ActivityEvent[]): ActivitySummary {
  const summary = new Map<string, string>();
  for (const event of events) {
    if (!(QUALIFYING_ACTIVITY_TYPES as readonly string[]).includes(event.type)) continue;
    const current = summary.get(event.itemId);
    if (!current || event.timestamp > current) summary.set(event.itemId, event.timestamp);
  }
  return summary;
}

/**
 * Merges qualifying events into an EXISTING summary — only ever advances an
 * item's timestamp, never removes or decreases one. This is what makes the
 * local durable summary survive the 500-event detailed log trimming an old
 * qualifying event away: once an item's timestamp has been folded in here,
 * it stays until a genuinely newer qualifying event replaces it, regardless
 * of whether the original event that produced it is still in the detailed
 * store (Stage 31 correctness fix — see useActivitySummary.ts).
 */
export function mergeActivityIntoSummary(base: ActivitySummary, events: readonly ActivityEvent[]): Map<string, string> {
  const merged = new Map(base);
  for (const event of events) {
    if (!(QUALIFYING_ACTIVITY_TYPES as readonly string[]).includes(event.type)) continue;
    const current = merged.get(event.itemId);
    if (!current || event.timestamp > current) merged.set(event.itemId, event.timestamp);
  }
  return merged;
}

/** Folds one item's summary entry into another's, taking the later of the two — used for Stage 27 local merge, so the survivor's summary reflects max(survivor, duplicate) even if either original qualifying event has since aged out of the detailed 500-event log (the PERSISTED summary values are used directly, never re-derived from events, so trimming can't lose this). The duplicate's own entry is left in place — harmless, since the engine only ever looks up entries for ids present in the current LibraryItem list. */
export function mergeSummaryEntry(summary: ActivitySummary, fromItemId: string, toItemId: string): Map<string, string> {
  const merged = new Map(summary);
  const fromValue = merged.get(fromItemId);
  const toValue = merged.get(toItemId);
  if (fromValue && (!toValue || fromValue > toValue)) merged.set(toItemId, fromValue);
  return merged;
}

/**
 * LEGACY FALLBACK ONLY — do not call for new merge-undo code. Hard-
 * recomputes specific items' summary entries directly from a given event
 * list. This was merge-undo's original approach, but a correctness review
 * found it unsound in general: it can only see events still present in the
 * (500-event-capped) detailed Activity log at undo time, so if either
 * item's original qualifying event has since been trimmed — e.g. a bulk
 * import or a burst of unrelated activity during the recovery window — the
 * recomputed value silently comes back wrong (or absent) instead of
 * matching the true pre-merge value. restoreSummaryEntries (below) is the
 * correct replacement: it restores exact values captured at merge time,
 * immune to any trimming that happens afterward. This function is kept
 * only as the fallback for a merge-recovery record persisted before
 * MergeRecoveryPayload.activitySummaryBefore existed (see
 * recovery-orchestration.ts's undoRecoveryAction) — every new merge
 * captures that snapshot, so this path is never exercised going forward.
 */
export function recomputeSummaryForItems(summary: ActivitySummary, itemIds: readonly string[], events: readonly ActivityEvent[]): Map<string, string> {
  const merged = new Map(summary);
  for (const itemId of itemIds) merged.delete(itemId);
  for (const event of events) {
    if (!(QUALIFYING_ACTIVITY_TYPES as readonly string[]).includes(event.type)) continue;
    if (!itemIds.includes(event.itemId)) continue;
    const current = merged.get(event.itemId);
    if (!current || event.timestamp > current) merged.set(event.itemId, event.timestamp);
  }
  return merged;
}

/**
 * Restores summary entries to EXACT recorded values — a direct set/delete,
 * never a merge, max, or recompute from events. This is the correct way to
 * undo Stage 27 local merge's mergeSummaryEntry: the two original values
 * must be captured from the durable summary itself at merge time (see
 * MergeRecoveryPayload.activitySummaryBefore), because by the time Undo
 * runs the detailed Activity log may no longer contain the event either
 * value originally came from — recomputing from that log is exactly the
 * "infer from a truncated list" failure Stage 31 exists to avoid. A null
 * value means "no qualifying activity" and clears the entry; never
 * fabricated.
 */
export function restoreSummaryEntries(summary: ActivitySummary, entries: readonly (readonly [string, string | null])[]): Map<string, string> {
  const merged = new Map(summary);
  for (const [itemId, value] of entries) {
    if (value) merged.set(itemId, value);
    else merged.delete(itemId);
  }
  return merged;
}

/**
 * The reference point for "how long has this been untouched" — real last
 * activity when it exists, otherwise the item's creation date. This
 * fallback exists ONLY to measure the age of a never-active item (Stage 31
 * §17/§49); it never overrides a real activity timestamp, and it is never
 * exposed as if it were activity.
 */
function getInactivityReferenceMs(item: LibraryItem, activitySummary: ActivitySummary): number {
  const lastActivity = activitySummary.get(item.id);
  return new Date(lastActivity ?? item.createdAt).getTime();
}

// ============================================================
// Per-dimension matchers
// ============================================================

function matchesMediaTypes(item: LibraryItem, mediaTypes: readonly LibraryItemType[]): boolean {
  if (mediaTypes.length === 0) return true;
  return mediaTypes.includes(item.type);
}

function matchesStatuses(item: LibraryItem, statuses: readonly TrackingStatus[]): boolean {
  if (statuses.length === 0) return true;
  return "status" in item && statuses.includes(item.status);
}

function matchesFavorite(item: LibraryItem, favorite: boolean | null): boolean {
  if (favorite === null) return true;
  return item.favorite === favorite;
}

function matchesRating(item: LibraryItem, rating: RatingFilter): boolean {
  const value = isMediaItem(item) ? item.rating : undefined;
  switch (rating.mode) {
    case "any":
      return true;
    case "rated":
      return value !== undefined;
    case "unrated":
      return value === undefined;
    case "min":
      return value !== undefined && rating.min !== null && value >= rating.min;
    case "range":
      return (
        value !== undefined &&
        (rating.min === null || value >= rating.min) &&
        (rating.max === null || value <= rating.max)
      );
  }
}

/** ANY semantics: an item matches if it belongs to at least one of the selected collections (Stage 31 §8). `selectedItemIds` is precomputed once per definition, never per item. */
function matchesCollections(item: LibraryItem, selectedItemIds: ReadonlySet<string> | null): boolean {
  if (selectedItemIds === null) return true;
  return selectedItemIds.has(item.id);
}

function matchesTags(item: LibraryItem, tags: TagFilter): boolean {
  if (tags.values.length === 0) return true;
  const itemTags = new Set(item.tags.map((tag) => tag.toLowerCase()));
  const wanted = tags.values.map((tag) => tag.toLowerCase());
  return tags.match === "all" ? wanted.every((tag) => itemTags.has(tag)) : wanted.some((tag) => itemTags.has(tag));
}

function matchesActivity(item: LibraryItem, activity: ActivityFilter, activitySummary: ActivitySummary, nowMs: number): boolean {
  const lastActivity = activitySummary.get(item.id);
  switch (activity.mode) {
    case "any":
      return true;
    case "never":
      return lastActivity === undefined;
    case "active_within": {
      if (lastActivity === undefined || activity.days === null) return false;
      const elapsedMs = nowMs - new Date(lastActivity).getTime();
      return elapsedMs <= activity.days * 24 * 60 * 60 * 1000;
    }
    case "inactive_for": {
      if (activity.days === null) return true;
      const elapsedMs = nowMs - getInactivityReferenceMs(item, activitySummary);
      return elapsedMs >= activity.days * 24 * 60 * 60 * 1000;
    }
  }
}

function matchesQuery(item: LibraryItem, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  return getSearchableText(item).includes(trimmed);
}

// ============================================================
// The engine
// ============================================================

export interface SmartViewContext {
  collections: readonly Collection[];
  activitySummary: ActivitySummary;
  /** Injected rather than read from Date.now() internally, so every activity-boundary predicate is deterministic and testable (Stage 31 §16/§48). */
  now: Date;
}

function buildSelectedCollectionItemIds(collections: readonly Collection[], selectedIds: readonly string[]): ReadonlySet<string> | null {
  if (selectedIds.length === 0) return null;
  const selected = new Set(selectedIds);
  const itemIds = new Set<string>();
  for (const collection of collections) {
    if (!selected.has(collection.id)) continue;
    for (const id of collection.itemIds) itemIds.add(id);
  }
  return itemIds;
}

/** Filters (never sorts or groups — see sortSmartViewItems/groupSmartViewItems) items against one definition. AND across dimensions; within a multi-select dimension (mediaTypes, statuses), OR (Stage 31 §51). */
export function filterSmartViewItems(items: readonly LibraryItem[], definition: SmartViewDefinition, context: SmartViewContext): LibraryItem[] {
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

function ratingOf(item: LibraryItem): number | undefined {
  return isMediaItem(item) ? item.rating : undefined;
}

/**
 * Deterministic comparator: the named `sort.by` first, then title, then id
 * — two items are never considered equal, so result order never depends on
 * the sort algorithm's stability (Stage 31 §34/§78). Null placement:
 * items with no qualifying activity sort after items that have some
 * (regardless of direction); unrated items sort after rated ones
 * (regardless of direction) — a "highest rated" and a "lowest rated" sort
 * both push unrated to the bottom, they just disagree on the order of the
 * rated items above it.
 */
function compareForSort(a: LibraryItem, b: LibraryItem, sort: SmartViewSort, activitySummary: ActivitySummary): number {
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
      else if (aTime === undefined) primary = 1; // no activity always sorts last, regardless of direction
      else if (bTime === undefined) primary = -1;
      else primary = aTime.localeCompare(bTime) * dir;
      break;
    }
    case "rating": {
      const aRating = ratingOf(a);
      const bRating = ratingOf(b);
      if (aRating === undefined && bRating === undefined) primary = 0;
      else if (aRating === undefined) primary = 1; // unrated always sorts last, regardless of direction
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

export function sortSmartViewItems(items: readonly LibraryItem[], sort: SmartViewSort, activitySummary: ActivitySummary): LibraryItem[] {
  return [...items].sort((a, b) => compareForSort(a, b, sort, activitySummary));
}

/** Filter + sort in one call — what most callers want (see the per-step exports above for grouping/preview-count use). */
export function applySmartView(items: readonly LibraryItem[], definition: SmartViewDefinition, context: SmartViewContext): LibraryItem[] {
  return sortSmartViewItems(filterSmartViewItems(items, definition, context), definition.sort, context.activitySummary);
}

export interface SmartViewGroup {
  key: string;
  label: string;
  items: LibraryItem[];
}

/** Canonical, human-friendly group order — never an alphabetized enum dump (Stage 31 §36). Every item appears in exactly one group. */
export function groupSmartViewItems(items: readonly LibraryItem[], groupBy: SmartViewGroupBy): SmartViewGroup[] {
  if (groupBy === "none") return items.length > 0 ? [{ key: "all", label: "All", items: [...items] }] : [];

  if (groupBy === "mediaType") {
    return SUPPORTED_ITEM_TYPES.map((type) => ({ key: type, label: ITEM_TYPE_LABELS[type], items: items.filter((item) => item.type === type) })).filter(
      (group) => group.items.length > 0,
    );
  }

  // groupBy === "status" — items with no status (website/generic) form their own trailing group rather than being silently dropped.
  const statusGroups: SmartViewGroup[] = TRACKING_STATUSES.map((status) => ({
    key: status,
    label: STATUS_FILTER_LABELS[status],
    items: items.filter((item) => "status" in item && item.status === status),
  })).filter((group) => group.items.length > 0);
  const untracked = items.filter((item) => !("status" in item));
  return untracked.length > 0 ? [...statusGroups, { key: "none", label: "No status", items: untracked }] : statusGroups;
}

// ============================================================
// Built-in Smart Views — one source of truth (Stage 31 §64)
// ============================================================

function buildInDefinition(overrides: Partial<SmartViewDefinition>): SmartViewDefinition {
  return { ...defaultSmartViewDefinition(), ...overrides };
}

export const CONTINUE_VIEW_ID = "builtin-continue";
export const RECENTLY_ACTIVE_VIEW_ID = "builtin-recently-active";
export const STALLED_VIEW_ID = "builtin-stalled";
export const FAVORITES_VIEW_ID = "builtin-favorites";
export const UNRATED_VIEW_ID = "builtin-unrated";

/**
 * The five built-in Smart Views (Stage 31 §15-§19). "Completed Recently"
 * is deliberately NOT included (§20): the activity summary records only
 * the latest qualifying event of ANY kind per item, not specifically the
 * last transition into "completed" — an item completed long ago but rated
 * again recently would otherwise be misreported as "recently completed".
 * Building a second, transition-specific aggregate just for this one view
 * isn't justified for Stage 31; omitting it is the documented, honest
 * choice rather than inventing an approximate completion date.
 */
export const BUILT_IN_SMART_VIEWS: SmartView[] = [
  {
    id: CONTINUE_VIEW_ID,
    name: "Continue",
    builtIn: true,
    // Status is the primary meaning (§15) — never inferred from incompatible numeric progress fields across types. Items with no activity yet still appear, just sorted last.
    definition: buildInDefinition({ statuses: ["in_progress"], sort: { by: "lastActivity", direction: "desc" } }),
  },
  {
    id: RECENTLY_ACTIVE_VIEW_ID,
    name: "Recently Active",
    builtIn: true,
    definition: buildInDefinition({ activity: { mode: "active_within", days: 14 }, sort: { by: "lastActivity", direction: "desc" } }),
  },
  {
    id: STALLED_VIEW_ID,
    name: "Stalled",
    builtIn: true,
    // in_progress AND no qualifying activity for >=30 days — a never-active item counts once it's existed that long (createdAt fallback, never fabricated activity). on_hold/dropped/etc. are deliberately excluded: a paused item isn't "stalled", it's intentionally set aside.
    definition: buildInDefinition({ statuses: ["in_progress"], activity: { mode: "inactive_for", days: 30 }, sort: { by: "lastActivity", direction: "asc" } }),
  },
  {
    id: FAVORITES_VIEW_ID,
    name: "Favorites",
    builtIn: true,
    definition: buildInDefinition({ favorite: true, sort: { by: "title", direction: "asc" } }),
  },
  {
    id: UNRATED_VIEW_ID,
    name: "Unrated",
    builtIn: true,
    // Literal semantics per §19: rating absent, no status exclusion (an unstarted "planned" item having no rating is entirely expected, not a special case).
    definition: buildInDefinition({ rating: { mode: "unrated", min: null, max: null }, sort: { by: "title", direction: "asc" } }),
  },
];

export function findBuiltInSmartView(id: string): SmartView | undefined {
  return BUILT_IN_SMART_VIEWS.find((view) => view.id === id);
}

// ============================================================
// Safe parsing — malformed local/cloud definitions must never crash
// rendering (Stage 31 §29/§45/§72/§73)
// ============================================================

const RATING_MODES: readonly RatingFilterMode[] = ["any", "rated", "unrated", "min", "range"];
const TAG_MATCH_MODES: readonly TagMatchMode[] = ["any", "all"];
const ACTIVITY_MODES: readonly ActivityFilterMode[] = ["any", "active_within", "inactive_for", "never"];
const SORT_BY_VALUES: readonly SmartViewSortBy[] = ["title", "createdAt", "lastActivity", "rating"];
const SORT_DIRECTIONS: readonly SmartViewSortDirection[] = ["asc", "desc"];
const GROUP_BY_VALUES: readonly SmartViewGroupBy[] = ["none", "mediaType", "status"];

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * The one place allowed to trust unvalidated JSON into SmartViewDefinition
 * — used for both a localStorage record and a signed-in user's own
 * Supabase row (either could be hand-edited or corrupted outside the
 * app). Returns null for anything that doesn't fully match: an unknown
 * `version`, a wrong field type, an out-of-range enum value. Never casts
 * partially-valid JSON into the type and never crashes.
 */
export function parseSmartViewDefinition(raw: unknown): SmartViewDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;

  if (d.version !== SMART_VIEW_DEFINITION_VERSION) return null;
  if (typeof d.query !== "string") return null;
  if (!isStringArray(d.mediaTypes) || !d.mediaTypes.every((type) => (SUPPORTED_ITEM_TYPES as readonly string[]).includes(type))) return null;
  if (!isStringArray(d.statuses) || !d.statuses.every((status) => (TRACKING_STATUSES as readonly string[]).includes(status))) return null;
  if (d.favorite !== null && typeof d.favorite !== "boolean") return null;

  const rating = d.rating as Record<string, unknown> | undefined;
  if (!rating || typeof rating !== "object") return null;
  if (!RATING_MODES.includes(rating.mode as RatingFilterMode)) return null;
  if (!isFiniteNumberOrNull(rating.min) || !isFiniteNumberOrNull(rating.max)) return null;

  if (!isStringArray(d.collections)) return null;

  const tags = d.tags as Record<string, unknown> | undefined;
  if (!tags || typeof tags !== "object") return null;
  if (!isStringArray(tags.values)) return null;
  if (!TAG_MATCH_MODES.includes(tags.match as TagMatchMode)) return null;

  const activity = d.activity as Record<string, unknown> | undefined;
  if (!activity || typeof activity !== "object") return null;
  if (!ACTIVITY_MODES.includes(activity.mode as ActivityFilterMode)) return null;
  if (!isFiniteNumberOrNull(activity.days)) return null;

  const sort = d.sort as Record<string, unknown> | undefined;
  if (!sort || typeof sort !== "object") return null;
  if (!SORT_BY_VALUES.includes(sort.by as SmartViewSortBy)) return null;
  if (!SORT_DIRECTIONS.includes(sort.direction as SmartViewSortDirection)) return null;

  if (!GROUP_BY_VALUES.includes(d.groupBy as SmartViewGroupBy)) return null;

  return {
    version: SMART_VIEW_DEFINITION_VERSION,
    query: d.query,
    mediaTypes: d.mediaTypes as LibraryItemType[],
    statuses: d.statuses as TrackingStatus[],
    favorite: d.favorite as boolean | null,
    rating: { mode: rating.mode as RatingFilterMode, min: rating.min as number | null, max: rating.max as number | null },
    collections: d.collections,
    tags: { values: tags.values, match: tags.match as TagMatchMode },
    activity: { mode: activity.mode as ActivityFilterMode, days: activity.days as number | null },
    sort: { by: sort.by as SmartViewSortBy, direction: sort.direction as SmartViewSortDirection },
    groupBy: d.groupBy as SmartViewGroupBy,
  };
}

// ============================================================
// Saved-view name validation — mirrors lib/collections.ts's
// isDuplicateCollectionName exactly (Stage 31 §23)
// ============================================================

export const MAX_SMART_VIEW_NAME_LENGTH = 200;

function normalizeSmartViewName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function smartViewNameKey(name: string): string {
  return normalizeSmartViewName(name).toLowerCase();
}

/** Trimmed non-empty, no control characters, within the max length. Does not check for duplicates — see isDuplicateSmartViewName. */
export function validateSmartViewName(name: string): { ok: true; name: string } | { ok: false; reason: "empty" | "too_long" | "invalid" } {
  const normalized = normalizeSmartViewName(name);
  // Deliberately checking FOR control characters to reject them, not matching normal text.
  if (/[\x00-\x1f\x7f]/.test(normalized)) return { ok: false, reason: "invalid" };
  if (normalized.length === 0) return { ok: false, reason: "empty" };
  if (normalized.length > MAX_SMART_VIEW_NAME_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, name: normalized };
}

/** True if another saved view already has this name, ignoring case/whitespace — client-side mirror of the DB's own case-insensitive unique index (Stage 31 §28). */
export function isDuplicateSmartViewName(name: string, existing: readonly { id: string; name: string }[], excludeId?: string): boolean {
  const key = smartViewNameKey(name);
  return existing.some((view) => view.id !== excludeId && smartViewNameKey(view.name) === key);
}

// ============================================================
// Filter chips — a compact human-readable summary, never a raw JSON dump
// (Stage 31 §38)
// ============================================================

/** Structural equality, not reference equality — used to detect "the user tweaked filters after opening a saved view" (Stage 31 §24/§47/§82) without depending on object key insertion order matching. */
export function smartViewDefinitionsEqual(a: SmartViewDefinition, b: SmartViewDefinition): boolean {
  return (
    a.version === b.version &&
    a.query === b.query &&
    arraysEqual(a.mediaTypes, b.mediaTypes) &&
    arraysEqual(a.statuses, b.statuses) &&
    a.favorite === b.favorite &&
    a.rating.mode === b.rating.mode &&
    a.rating.min === b.rating.min &&
    a.rating.max === b.rating.max &&
    arraysEqual(a.collections, b.collections) &&
    arraysEqual(a.tags.values, b.tags.values) &&
    a.tags.match === b.tags.match &&
    a.activity.mode === b.activity.mode &&
    a.activity.days === b.activity.days &&
    a.sort.by === b.sort.by &&
    a.sort.direction === b.sort.direction &&
    a.groupBy === b.groupBy
  );
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function isDefaultSmartViewDefinition(definition: SmartViewDefinition): boolean {
  const empty = defaultSmartViewDefinition();
  return (
    definition.query.trim() === "" &&
    definition.mediaTypes.length === 0 &&
    definition.statuses.length === 0 &&
    definition.favorite === null &&
    definition.rating.mode === "any" &&
    definition.collections.length === 0 &&
    definition.tags.values.length === 0 &&
    definition.activity.mode === "any" &&
    definition.groupBy === empty.groupBy
  );
}

export interface FilterChip {
  id: string;
  label: string;
}

/** One chip per active filter dimension (sort/groupBy are display preferences, not filters, so they never get a chip). */
export function describeActiveFilters(definition: SmartViewDefinition): FilterChip[] {
  const chips: FilterChip[] = [];

  for (const type of definition.mediaTypes) chips.push({ id: `type-${type}`, label: ITEM_TYPE_LABELS[type] });
  for (const status of definition.statuses) chips.push({ id: `status-${status}`, label: STATUS_FILTER_LABELS[status] });
  if (definition.favorite === true) chips.push({ id: "favorite", label: "Favorites" });
  if (definition.favorite === false) chips.push({ id: "not-favorite", label: "Not favorite" });

  switch (definition.rating.mode) {
    case "rated":
      chips.push({ id: "rating", label: "Rated" });
      break;
    case "unrated":
      chips.push({ id: "rating", label: "Unrated" });
      break;
    case "min":
      if (definition.rating.min !== null) chips.push({ id: "rating", label: `Rating ≥ ${definition.rating.min}` });
      break;
    case "range":
      if (definition.rating.min !== null || definition.rating.max !== null) {
        chips.push({ id: "rating", label: `Rating ${definition.rating.min ?? "0"}–${definition.rating.max ?? "10"}` });
      }
      break;
  }

  if (definition.collections.length > 0) chips.push({ id: "collections", label: `${definition.collections.length} collection${definition.collections.length === 1 ? "" : "s"}` });
  for (const tag of definition.tags.values) chips.push({ id: `tag-${tag}`, label: tag });

  switch (definition.activity.mode) {
    case "active_within":
      if (definition.activity.days !== null) chips.push({ id: "activity", label: `Active ≤ ${definition.activity.days}d` });
      break;
    case "inactive_for":
      if (definition.activity.days !== null) chips.push({ id: "activity", label: `Inactive ≥ ${definition.activity.days}d` });
      break;
    case "never":
      chips.push({ id: "activity", label: "Never active" });
      break;
  }

  if (definition.query.trim()) chips.push({ id: "query", label: `"${definition.query.trim()}"` });

  return chips;
}

/** Removes exactly the one dimension a given chip (from describeActiveFilters) represents, leaving every other filter untouched. */
export function removeFilterChip(definition: SmartViewDefinition, chipId: string): SmartViewDefinition {
  if (chipId.startsWith("type-")) {
    const type = chipId.slice("type-".length) as LibraryItemType;
    return { ...definition, mediaTypes: definition.mediaTypes.filter((t) => t !== type) };
  }
  if (chipId.startsWith("status-")) {
    const status = chipId.slice("status-".length) as TrackingStatus;
    return { ...definition, statuses: definition.statuses.filter((s) => s !== status) };
  }
  if (chipId === "favorite" || chipId === "not-favorite") return { ...definition, favorite: null };
  if (chipId === "rating") return { ...definition, rating: { mode: "any", min: null, max: null } };
  if (chipId === "collections") return { ...definition, collections: [] };
  if (chipId.startsWith("tag-")) {
    const tag = chipId.slice("tag-".length);
    return { ...definition, tags: { ...definition.tags, values: definition.tags.values.filter((t) => t !== tag) } };
  }
  if (chipId === "activity") return { ...definition, activity: { mode: "any", days: null } };
  if (chipId === "query") return { ...definition, query: "" };
  return definition;
}
