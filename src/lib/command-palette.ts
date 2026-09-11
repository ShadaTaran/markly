/**
 * Stage 36 — pure Command Palette search/ranking/command-building logic.
 * Kept entirely free of React/DOM/network so it's deterministically
 * testable (see scripts/verify-command-palette.mjs) and so ranking logic
 * never lives inside a component (per the stage brief's own architecture
 * requirement).
 *
 * Search scope is deliberately narrower than Library's own in-page search
 * (lib/library-items.ts's getSearchableText, which also matches
 * description): title dominates, then a small set of other stored fields.
 * A command palette rewards being fast and precise over being exhaustive
 * — Library's own search box (unchanged by this stage) remains the place
 * for a broader, slower scan of everything.
 */

import type { LibraryItem } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { normalizeTitleForMatching } from "@/lib/title-normalization";
import { getDomain } from "@/lib/website";
import { isMediaItem } from "@/lib/item-detail";
import { getProgressInfo, getStatusLabel } from "@/lib/tracking";

// ============================================================
// Query normalization
// ============================================================

/** Generous but bounded — no reason to accept a pasted essay into a command palette input (Stage 36 §70). */
export const MAX_QUERY_LENGTH = 300;

/**
 * Reuses Stage 27's exact title-comparison normalizer (title-normalization.ts)
 * for both the query and every title compared against it — same
 * case-folding, whitespace-collapsing, smart-quote/dash folding, Unicode
 * NFKC normalization. This is search-ranking use only: it shares the
 * function, never the concept — duplicate-detection.ts's identity
 * semantics (lib/duplicate-detection.ts) are completely untouched by this
 * module and never invoked from here.
 */
export function normalizePaletteQuery(raw: string): string {
  return normalizeTitleForMatching(raw.slice(0, MAX_QUERY_LENGTH));
}

// ============================================================
// Result types — a discriminated union, not one object with many
// nullable fields (Stage 36 §44).
// ============================================================

export interface PaletteLibraryResult {
  kind: "library";
  item: LibraryItem;
  score: number;
}

export interface PaletteNavigationResult {
  kind: "navigation";
  id: string;
  label: string;
  href: string;
}

export interface PaletteActionResult {
  kind: "action";
  id: string;
  label: string;
}

export type PaletteResult = PaletteLibraryResult | PaletteNavigationResult | PaletteActionResult;

// ============================================================
// Library search — a precomputed "search document" per item (built once
// per items-array change via useMemo at the call site — see
// CommandPalette.tsx), then scored per keystroke without re-normalizing
// every field each time (Stage 36 §22).
// ============================================================

interface SearchDocument {
  item: LibraryItem;
  normalizedTitle: string;
  /** Individual normalized words of the title, for the "a title word starts with the query" ranking tier — matches a query like "mysteries" against "Lord of Mysteries" without that being a plain substring match at position 0. */
  titleWords: string[];
  normalizedTags: string[];
  normalizedCategory: string;
  normalizedTypeLabel: string;
  /** Website items only — the safely-parsed hostname (getDomain already falls back to the raw string on a malformed URL, so this never throws — Stage 36 §68). */
  normalizedDomain: string | null;
}

export function buildSearchDocument(item: LibraryItem): SearchDocument {
  return {
    item,
    normalizedTitle: normalizeTitleForMatching(item.title),
    titleWords: normalizeTitleForMatching(item.title).split(" ").filter(Boolean),
    normalizedTags: item.tags.map((tag) => normalizeTitleForMatching(tag)),
    normalizedCategory: normalizeTitleForMatching(item.category),
    normalizedTypeLabel: normalizeTitleForMatching(ITEM_TYPE_LABELS[item.type]),
    normalizedDomain: item.type === "website" ? normalizeTitleForMatching(getDomain(item.url)) : null,
  };
}

export function buildSearchDocuments(items: LibraryItem[]): SearchDocument[] {
  return items.map(buildSearchDocument);
}

// Ranking tiers (Stage 36 §8) — title dominates; metadata can never
// outrank even the weakest title match.
const SCORE_EXACT_TITLE = 100;
const SCORE_TITLE_PREFIX = 80;
const SCORE_TITLE_WORD_PREFIX = 60;
const SCORE_TITLE_CONTAINS = 40;
const SCORE_METADATA_MATCH = 20;
const NO_MATCH = 0;

/** 0 means "no match at all" — the caller filters those out. */
export function scoreLibraryItem(doc: SearchDocument, normalizedQuery: string): number {
  if (!normalizedQuery) return NO_MATCH;

  if (doc.normalizedTitle === normalizedQuery) return SCORE_EXACT_TITLE;
  if (doc.normalizedTitle.startsWith(normalizedQuery)) return SCORE_TITLE_PREFIX;
  if (doc.titleWords.some((word) => word.startsWith(normalizedQuery))) return SCORE_TITLE_WORD_PREFIX;
  if (doc.normalizedTitle.includes(normalizedQuery)) return SCORE_TITLE_CONTAINS;

  const metadataMatch =
    doc.normalizedTags.some((tag) => tag.includes(normalizedQuery)) ||
    doc.normalizedCategory.includes(normalizedQuery) ||
    doc.normalizedTypeLabel.includes(normalizedQuery) ||
    (doc.normalizedDomain !== null && doc.normalizedDomain.includes(normalizedQuery));
  if (metadataMatch) return SCORE_METADATA_MATCH;

  return NO_MATCH;
}

/**
 * Scores and ranks every document against the query, returning at most
 * `limit` results. Ties (equal score) break deterministically on title
 * then id (Stage 36 §21) — never on input array order, which would make
 * result order silently depend on library sort/fetch order.
 */
export function searchLibraryItems(docs: SearchDocument[], query: string, limit: number): PaletteLibraryResult[] {
  const normalizedQuery = normalizePaletteQuery(query);
  if (!normalizedQuery) return [];

  const scored: PaletteLibraryResult[] = [];
  for (const doc of docs) {
    const score = scoreLibraryItem(doc, normalizedQuery);
    if (score > NO_MATCH) scored.push({ kind: "library", item: doc.item, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const titleCompare = a.item.title.localeCompare(b.item.title, undefined, { sensitivity: "base" });
    if (titleCompare !== 0) return titleCompare;
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
  });

  return scored.slice(0, limit);
}

// ============================================================
// Display formatting — reuses existing status/progress formatters
// verbatim (Stage 36 §33/§34); never invents a new progress conversion.
// ============================================================

/**
 * The secondary line under a Library result's title. Media items:
 * "Anime · Watching · 12 / 24 episodes" (progress segment omitted
 * entirely when getProgressInfo has nothing to say — never a fabricated
 * "0 / ?"). Website items get their hostname shown separately by the
 * component (via getDomain), not through this text line.
 */
export function describeLibraryResult(item: LibraryItem): string {
  if (!isMediaItem(item)) return ITEM_TYPE_LABELS[item.type];
  const progress = getProgressInfo(item);
  const parts = [ITEM_TYPE_LABELS[item.type], getStatusLabel(item)];
  if (progress) parts.push(progress.text);
  return parts.join(" · ");
}

// ============================================================
// Static commands — built centrally so route labels/ids are never
// hardcoded in more than one place (Stage 36 §46), each with a stable id
// never derived from its displayed label (Stage 36 §43).
// ============================================================

const NAVIGATION_COMMANDS: readonly PaletteNavigationResult[] = [
  { kind: "navigation", id: "nav.dashboard", label: "Dashboard", href: "/" },
  { kind: "navigation", id: "nav.library", label: "Library", href: "/library" },
  { kind: "navigation", id: "nav.calendar", label: "Calendar", href: "/calendar" },
  { kind: "navigation", id: "nav.reminders", label: "Reminders", href: "/reminders" },
  { kind: "navigation", id: "nav.settings.connections", label: "Settings · Connections", href: "/settings/connections" },
  { kind: "navigation", id: "nav.settings.tracking", label: "Settings · Auto Tracking", href: "/settings/tracking" },
  { kind: "navigation", id: "nav.settings.notifications", label: "Settings · Notifications", href: "/settings/notifications" },
  { kind: "navigation", id: "nav.settings.recovery", label: "Settings · Recently Changed", href: "/settings/recovery" },
  { kind: "navigation", id: "nav.settings.backup", label: "Settings · Data & Backup", href: "/settings/backup" },
  { kind: "navigation", id: "nav.settings.app", label: "Settings · App", href: "/settings/app" },
];

/** A fixed, known-safe allowlist — never built from searchable data, so a Library item's title/tags/category can never be interpreted as a route (Stage 36 §48). */
export function getNavigationCommands(): readonly PaletteNavigationResult[] {
  return NAVIGATION_COMMANDS;
}

const ADD_ITEM_ACTION: PaletteActionResult = { kind: "action", id: "action.add-item", label: "Add Item" };

/** Stage 36 §42 — the only write-like command in v1; it opens the existing canonical Add Item dialog, never a second implementation. */
export function getActionCommands(): readonly PaletteActionResult[] {
  return [ADD_ITEM_ACTION];
}

export const ADD_ITEM_ACTION_ID = ADD_ITEM_ACTION.id;

// ============================================================
// Result assembly — the empty-query view and the searching view build
// different, deliberately small result sets (Stage 36 §15/§19/§20).
// ============================================================

const LIBRARY_RESULT_LIMIT = 10;
const NAVIGATION_RESULT_LIMIT = 5;
const RECENT_RESULT_LIMIT = 8;

export interface PaletteResultGroups {
  library: PaletteLibraryResult[];
  navigation: PaletteNavigationResult[];
  actions: PaletteActionResult[];
  /** Only populated for the empty-query view. */
  recent: PaletteLibraryResult[];
}

function matchesNavigationOrAction(label: string, normalizedQuery: string): boolean {
  return normalizeTitleForMatching(label).includes(normalizedQuery);
}

/** Stage 36 §15 — the curated default "Quick Actions" navigation subset shown alongside Add Item when the palette opens with no query. A small, deliberate set, not every route (Settings is reachable by typing "settings", not shown by default, to keep the empty state compact). */
const QUICK_ACTION_NAVIGATION_IDS = ["nav.dashboard", "nav.library", "nav.calendar", "nav.reminders"];

/**
 * The one function both the empty-query view and the active-search view
 * go through — empty query returns recent items + a small curated set of
 * quick actions and no Library/Navigation search noise; a real query
 * searches Library plus filters the same static command list, always
 * capped (Stage 36 §20).
 */
export function buildPaletteResults({
  query,
  docs,
  recentItems,
}: {
  query: string;
  docs: SearchDocument[];
  /** Already resolved against the CURRENT authoritative library and capped by the caller (see useCommandPaletteRecents + the account-switch filtering it performs) — this function trusts the list it's given. */
  recentItems: LibraryItem[];
}): PaletteResultGroups {
  const trimmed = query.trim();

  if (!trimmed) {
    return {
      library: [],
      navigation: NAVIGATION_COMMANDS.filter((command) => QUICK_ACTION_NAVIGATION_IDS.includes(command.id)),
      actions: getActionCommands().slice(0, NAVIGATION_RESULT_LIMIT),
      recent: recentItems.slice(0, RECENT_RESULT_LIMIT).map((item) => ({ kind: "library", item, score: 0 })),
    };
  }

  const normalizedQuery = normalizePaletteQuery(trimmed);
  const library = searchLibraryItems(docs, trimmed, LIBRARY_RESULT_LIMIT);
  const navigation = NAVIGATION_COMMANDS.filter((command) => matchesNavigationOrAction(command.label, normalizedQuery)).slice(0, NAVIGATION_RESULT_LIMIT);
  const actions = getActionCommands().filter((command) => matchesNavigationOrAction(command.label, normalizedQuery));

  return { library, navigation, actions, recent: [] };
}

/** Flattens the grouped results into one activation-order list for keyboard navigation — Recent, then Library, then Quick Actions (Add Item before the curated navigation shortcuts, matching the "Add Item, Library, Calendar, Reminders" example order). Only one of {library} vs. {recent} is ever non-empty at a time, see buildPaletteResults. */
export function flattenPaletteResults(groups: PaletteResultGroups): PaletteResult[] {
  return [...groups.recent, ...groups.library, ...groups.actions, ...groups.navigation];
}
