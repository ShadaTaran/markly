import type { ActivityEvent, ProgressKind } from "@/types/activity";

const ACTIVITY_STORAGE_KEY = "markly.activity";

/**
 * Newest-first list, capped at 500 events. That's generous for "recent
 * activity" purposes (the UI only ever shows the newest handful) while
 * keeping the localStorage payload small — no pagination/database needed
 * at this scale.
 */
const MAX_ACTIVITY_EVENTS = 500;

export const PROGRESS_KINDS: readonly ProgressKind[] = ["episode", "chapter", "page", "percent", "playtime", "season_episode"];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidActivityEvent(value: unknown): value is ActivityEvent {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Record<string, unknown>;

  const hasBaseFields =
    typeof candidate.id === "string" &&
    typeof candidate.itemId === "string" &&
    typeof candidate.timestamp === "string" &&
    !Number.isNaN(new Date(candidate.timestamp).getTime());

  if (!hasBaseFields) return false;

  switch (candidate.type) {
    case "progress_updated":
      return (
        typeof candidate.progressKind === "string" &&
        (PROGRESS_KINDS as readonly string[]).includes(candidate.progressKind) &&
        isFiniteNumber(candidate.newValue) &&
        (candidate.previousValue === undefined || isFiniteNumber(candidate.previousValue)) &&
        // Stage 25 — previousSeason/newSeason only ever accompany a
        // "season_episode" progressKind (see ProgressActivityEvent); both
        // stay individually optional (a season's very first recorded
        // position has no previousSeason to report) but must be real
        // numbers whenever present, same as previousValue/newValue above.
        (candidate.previousSeason === undefined || isFiniteNumber(candidate.previousSeason)) &&
        (candidate.newSeason === undefined || isFiniteNumber(candidate.newSeason))
      );
    case "rating_updated":
      return (
        (candidate.previousValue === undefined || isFiniteNumber(candidate.previousValue)) &&
        (candidate.newValue === undefined || isFiniteNumber(candidate.newValue))
      );
    case "status_updated":
      return typeof candidate.newValue === "string";
    case "item_added":
      return true;
    default:
      return false;
  }
}

function readJsonArray(key: string): unknown[] | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Loads activity from markly.activity — a failure domain entirely separate
 * from markly.library. Missing key or malformed JSON both resolve to "no
 * activity yet" (an empty list); individually malformed records are
 * dropped rather than failing the whole array.
 */
export function loadActivity(): ActivityEvent[] | null {
  if (typeof window === "undefined") return null;

  const raw = readJsonArray(ACTIVITY_STORAGE_KEY);
  if (!raw) return null;

  return raw.filter(isValidActivityEvent);
}

export function saveActivity(events: ActivityEvent[]): void {
  if (typeof window === "undefined") return;

  try {
    const trimmed = events.length > MAX_ACTIVITY_EVENTS ? events.slice(0, MAX_ACTIVITY_EVENTS) : events;
    window.localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage unavailable (e.g. private browsing, quota exceeded); ignore.
    // This never touches markly.library — the two are saved independently.
  }
}

export { MAX_ACTIVITY_EVENTS };
