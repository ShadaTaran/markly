import type { LibraryItem } from "@/types/library-item";
import { applySmartView, findBuiltInSmartView, type ActivitySummary, type SmartViewContext } from "@/lib/smart-views";
import { getProgressInfo } from "@/lib/tracking";
import { isMediaItem } from "@/lib/item-detail";

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
// Resume/Continue resolution moved to lib/resume.ts (Stage 41) — see that
// file's own doc comment for why: this file being the only pre-Stage-41
// caller of resolveResumeTarget/selectBestTrackingSource is exactly what
// let Item Detail and Library's card overflow menu each grow their own
// SEPARATE, divergent "what URL do I open" logic instead of sharing one.
// Re-export removed deliberately (not `export { resolveResumeTarget } from
// "@/lib/resume"`) so every call site's import statement visibly points
// at the real, general-purpose home rather than this Dashboard-specific
// module.
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
