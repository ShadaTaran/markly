const ACTIVITY_SUMMARY_STORAGE_KEY = "markly.activitySummary";

/**
 * Stage 31 fix — a compact, durable itemId -> latest-qualifying-activity
 * timestamp map, stored SEPARATELY from markly.activity (activity-storage.ts,
 * capped at 500 events). The detailed event log is a rolling window and is
 * allowed to trim old entries; this summary is not — it only ever advances
 * (see lib/smart-views.ts's mergeActivityIntoSummary), so an item's
 * lastActivityAt survives long after its actual qualifying event has aged
 * out of the 500-event store. Plain `{itemId: isoTimestamp}` — one entry
 * per item, never a copy of the event itself.
 */
export type ActivitySummaryRecord = Record<string, string>;

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

/**
 * Loads the summary from markly.activitySummary. Missing key or malformed
 * top-level JSON both resolve to null ("not yet initialized" — the caller
 * bootstraps from current activity in that case, see useActivitySummary).
 * An individual malformed entry (bad key type is impossible for a plain
 * object's own keys, but a non-string/invalid-date value is dropped)
 * never fails the whole map.
 */
export function loadActivitySummary(): ActivitySummaryRecord | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(ACTIVITY_SUMMARY_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

    const result: ActivitySummaryRecord = {};
    for (const [itemId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidTimestamp(value)) result[itemId] = value;
    }
    return result;
  } catch {
    return null;
  }
}

export function saveActivitySummary(summary: ActivitySummaryRecord): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(ACTIVITY_SUMMARY_STORAGE_KEY, JSON.stringify(summary));
  } catch {
    // Storage unavailable (e.g. private browsing, quota exceeded); ignore.
    // This never touches any other markly.* store — each is saved independently.
  }
}
