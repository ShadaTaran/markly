import type { LibraryItem } from "@/types/library-item";
import type { TrackingSourceSummary } from "@/lib/extension/types";
import { applySmartView, findBuiltInSmartView, type ActivitySummary, type SmartViewContext } from "@/lib/smart-views";
import { getProgressInfo } from "@/lib/tracking";
import { isMediaItem, getItemHref } from "@/lib/item-detail";
import { isValidUrl } from "@/lib/website";
import { getSafeOpenSourceUrl, getSourceDisplayName, getSourceHostname } from "@/lib/extension/source-display";

/**
 * Stage 32 — Dashboard-specific pure helpers. Deliberately thin: every piece
 * of logic here that already exists elsewhere (progress formatting, URL
 * safety, source display, built-in Smart View filtering/sorting) is reused
 * verbatim, never reimplemented, so Dashboard can never silently drift from
 * the Library page's own behavior for the same underlying data.
 */

// ============================================================
// Built-in view selection — zero-drift wrapper (Stage 32 §66)
// ============================================================

/** Filters+sorts `items` against a built-in Smart View by id, exactly as the Library page's Smart Views bar would — returns [] for an unknown id rather than throwing, since a Dashboard section should degrade quietly, never crash the page. */
export function getBuiltInViewItems(items: readonly LibraryItem[], viewId: string, context: SmartViewContext): LibraryItem[] {
  const view = findBuiltInSmartView(viewId);
  if (!view) return [];
  return applySmartView(items, view.definition, context);
}

// ============================================================
// Progress formatting (Stage 32 §5-§8, §49)
// ============================================================

/**
 * The Dashboard's one centralized "what's the current progress" formatter.
 * Delegates entirely to lib/tracking.ts's getProgressInfo — the SAME
 * function MediaItemCard already uses for every Library grid card — so a
 * Continue card and a Library card never disagree about how an item's
 * progress reads (e.g. "14 episodes", "Season 2, Episode 6", "Chapter
 * 12.5" for a fractional manga chapter, which needs no special rounding
 * logic at all: template-literal number interpolation already preserves
 * the decimal). Returns null when the type has no real progress concept
 * (Movie, Website, and any of the not-yet-built article/video/other
 * types) — never fabricated.
 */
export function formatDashboardProgress(item: LibraryItem): string | null {
  if (!isMediaItem(item)) return null;
  return getProgressInfo(item)?.text ?? null;
}

// ============================================================
// Resume target resolution (Stage 32 §11-§17, §34-§36, §48)
// ============================================================

export interface ResumeTarget {
  kind: "external" | "internal";
  url: string;
  /** Only set for an external target resolved from a TrackingSource — the optional subtle source indicator (§32/§33). Never set for a LibraryItem's own sourceUrl/url, since there's no adapter identity behind those to name. */
  sourceLabel?: string;
  hostname?: string;
}

/**
 * Picks the single best eligible TrackingSource for an item, or null if
 * none qualifies. Eligible = linked to this item (library_item_id ===
 * item.id) AND has a URL that survives getSafeOpenSourceUrl's own
 * validation (which already prefers a Stage 21 stable work URL over the
 * raw last-detected page, and rejects anything isValidUrl rejects).
 * Deterministic tie-break: most recently seen first (lastSeenAt is a real
 * column — never a fabricated "last used" signal), then id ascending so
 * two sources seen at the identical instant still resolve to one answer
 * every time.
 */
export function selectBestTrackingSource(sources: readonly TrackingSourceSummary[], itemId: string): TrackingSourceSummary | null {
  const eligible = sources.filter((source) => source.libraryItemId === itemId);
  const withSafeUrl = eligible.filter((source) => getSafeOpenSourceUrl(source) !== null);
  if (withSafeUrl.length === 0) return null;

  const sorted = [...withSafeUrl].sort((a, b) => {
    const byLastSeen = b.lastSeenAt.localeCompare(a.lastSeenAt);
    if (byLastSeen !== 0) return byLastSeen;
    return a.id.localeCompare(b.id);
  });
  return sorted[0];
}

/** The LibraryItem's own stored link — item.url for a Website (always present), item.sourceUrl for a MediaItem (optional, user-entered "where you found this or track this"). Undefined for GenericLibraryItem (article/video/other), which has neither field. */
function ownStoredUrl(item: LibraryItem): string | undefined {
  if (item.type === "website") return item.url;
  if (isMediaItem(item)) return item.sourceUrl;
  return undefined;
}

/**
 * The one place Dashboard ever decides where "Continue" navigates.
 * Priority (§12, confirmed against the real data model in Phase 0 — no
 * priority reordering was warranted):
 *   1. The best eligible TrackingSource (see selectBestTrackingSource) —
 *      real consumption history, not catalog metadata. Works identically
 *      for a source the extension created and one an adapter created;
 *      neither is treated as more or less authoritative (§34).
 *   2. The LibraryItem's own stored URL, ONLY if it passes the same
 *      isValidUrl check every external target must pass (§15) — never
 *      catalogSource (§35/§36: it has no url field at all, so it can
 *      never reach here regardless).
 *   3. The internal detail page — always available, never fails.
 * Never invents a URL (no /chapter/{progress} synthesis, no
 * anilist.co/... construction from catalogSource.provider).
 */
export function resolveResumeTarget(item: LibraryItem, trackingSources: readonly TrackingSourceSummary[]): ResumeTarget {
  const best = selectBestTrackingSource(trackingSources, item.id);
  if (best) {
    const url = getSafeOpenSourceUrl(best);
    if (url) {
      return {
        kind: "external",
        url,
        // Derived from `url` itself (the URL that will actually open), not
        // best.sourceUrl — so the displayed name/host can never disagree
        // with the href, even in principle (Stage 32 correctness review
        // §9). getSafeOpenSourceUrl's own trust invariant already
        // guarantees `url` shares sourceUrl's host whenever it's workUrl,
        // so this is never a behavior change, only a stronger guarantee.
        sourceLabel: getSourceDisplayName(best.adapterId, url, best.sourceTitle),
        hostname: getSourceHostname(url) ?? undefined,
      };
    }
  }

  const stored = ownStoredUrl(item);
  if (stored && isValidUrl(stored)) {
    return { kind: "external", url: stored, hostname: getSourceHostname(stored) ?? undefined };
  }

  return { kind: "internal", url: getItemHref(item) };
}

// ============================================================
// Activity snapshot (Stage 32 §24-§27) — item counts only, never event
// counts, so this is accurate for both local (durable summary) and cloud
// (full-history RPC) without any new migration.
// ============================================================

/** Count of items whose latest qualifying Activity falls within the last `days` days — an honest, durable-summary-backed number, distinct from (and narrower than) the 14-day Recently Active built-in view above it on the page. Never derived from a capped event list. */
export function countActiveWithinDays(items: readonly LibraryItem[], activitySummary: ActivitySummary, days: number, now: Date): number {
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const item of items) {
    const lastActivity = activitySummary.get(item.id);
    if (lastActivity !== undefined && new Date(lastActivity).getTime() >= cutoffMs) count += 1;
  }
  return count;
}
