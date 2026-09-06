import type { Reminder } from "@/types/reminder";

const REMINDERS_STORAGE_KEY = "markly.reminders";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidIsoString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function isValidReminder(value: unknown): value is Reminder {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;

  const hasBaseFields =
    typeof candidate.id === "string" &&
    typeof candidate.libraryItemId === "string" &&
    isValidIsoString(candidate.createdAt) &&
    (candidate.dismissedAt === undefined || isValidIsoString(candidate.dismissedAt)) &&
    (candidate.updatedAt === undefined || isValidIsoString(candidate.updatedAt));
  if (!hasBaseFields) return false;

  if (candidate.kind === "release") {
    return (
      candidate.provider === "anilist" &&
      typeof candidate.externalMediaId === "string" &&
      isFiniteNumber(candidate.episode) &&
      isValidIsoString(candidate.scheduledFor) &&
      isFiniteNumber(candidate.remindBeforeMinutes) &&
      candidate.remindBeforeMinutes >= 0
    );
  }
  if (candidate.kind === "continue") {
    return isValidIsoString(candidate.remindAt);
  }
  return false;
}

function readAll(): Reminder[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(REMINDERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidReminder);
  } catch {
    return [];
  }
}

function writeAll(reminders: Reminder[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REMINDERS_STORAGE_KEY, JSON.stringify(reminders));
  } catch {
    // Storage unavailable (private browsing, quota exceeded); the action
    // that produced this still happened in memory, it just won't persist —
    // no worse than not having local reminders at all.
  }
}

/** Missing key resolves to "no reminders yet" (null); malformed individual records are dropped, valid ones survive — same contract as loadActivity. */
export function loadReminders(): Reminder[] | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(REMINDERS_STORAGE_KEY);
  if (raw === null) return null;
  return readAll();
}

export function saveReminders(reminders: Reminder[]): void {
  writeAll(reminders);
}
