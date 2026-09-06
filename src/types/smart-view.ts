import type { LibraryItemType, TrackingStatus } from "@/types/library-item";

/**
 * Stage 31 — a Smart View is a saved QUERY, never a saved list of item ids.
 * As the library changes, a view's membership is recomputed from this
 * definition every time (see lib/smart-views.ts's engine) — nothing here
 * ever references a LibraryItem by id. Bumping `version` is required for
 * any future incompatible shape change; parseSmartViewDefinition (in
 * lib/smart-views.ts) is the only place allowed to trust unvalidated JSON
 * (a localStorage record, or a signed-in user's own Supabase row) into
 * this type.
 */
export const SMART_VIEW_DEFINITION_VERSION = 1;

export type RatingFilterMode = "any" | "rated" | "unrated" | "min" | "range";

export interface RatingFilter {
  mode: RatingFilterMode;
  /** Only meaningful for mode "min" and "range". */
  min: number | null;
  /** Only meaningful for mode "range". */
  max: number | null;
}

export type TagMatchMode = "any" | "all";

export interface TagFilter {
  /** Already-lowercase tag values, matching the app's existing tag storage convention (see lib/utils.ts's parseTags). */
  values: string[];
  match: TagMatchMode;
}

/**
 * "inactive_for"/"never" both use createdAt as a fallback reference point
 * ONLY for measuring how long a never-active item has existed — never as a
 * substitute for genuine activity. See lib/smart-views.ts's
 * getEffectiveInactivityReference for the one place this fallback is
 * applied.
 */
export type ActivityFilterMode = "any" | "active_within" | "inactive_for" | "never";

export interface ActivityFilter {
  mode: ActivityFilterMode;
  /** Required (and only meaningful) for "active_within"/"inactive_for". */
  days: number | null;
}

/**
 * "lastActivity" and "rating" both need explicit null-placement handling
 * (an item with no qualifying activity, or no rating) — see
 * lib/smart-views.ts's compareForSort for the exact deterministic rule.
 */
export type SmartViewSortBy = "title" | "createdAt" | "lastActivity" | "rating";
export type SmartViewSortDirection = "asc" | "desc";

export interface SmartViewSort {
  by: SmartViewSortBy;
  direction: SmartViewSortDirection;
}

export type SmartViewGroupBy = "none" | "mediaType" | "status";

export interface SmartViewDefinition {
  version: typeof SMART_VIEW_DEFINITION_VERSION;
  /** Free-text search — same fields as the existing Library search (lib/library-items.ts's getSearchableText). */
  query: string;
  /** Empty array means "every type" — never a sentinel like "all" mixed into the list. */
  mediaTypes: LibraryItemType[];
  /** Empty array means "every status". */
  statuses: TrackingStatus[];
  /** null = any, true = favorites only, false = not favorite. Never conflate false with "disabled". */
  favorite: boolean | null;
  rating: RatingFilter;
  /** Collection ids — ANY semantics (an item matches if it belongs to at least one). Empty means "no collection restriction". Independent of the Library page's existing single-select Collection tab. */
  collections: string[];
  tags: TagFilter;
  activity: ActivityFilter;
  sort: SmartViewSort;
  groupBy: SmartViewGroupBy;
}

export function defaultSmartViewDefinition(): SmartViewDefinition {
  return {
    version: SMART_VIEW_DEFINITION_VERSION,
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

/** A built-in (Continue, Recently Active, ...) or user-saved Smart View, already resolved to a definition — the shape the engine and UI both consume. */
export interface SmartView {
  id: string;
  name: string;
  definition: SmartViewDefinition;
  /** Built-ins are code-defined presets — never stored, never editable, never deletable (see lib/smart-views.ts's BUILT_IN_SMART_VIEWS). */
  builtIn: boolean;
}

/** A user-saved Smart View's persisted record — local (markly.smartViews) and cloud (saved_library_views) both converge on this shape. */
export interface SavedSmartView {
  id: string;
  name: string;
  definition: SmartViewDefinition;
  createdAt: string;
  updatedAt?: string;
}

export type SavedSmartViewInput = Pick<SavedSmartView, "name" | "definition">;
