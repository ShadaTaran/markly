/**
 * Stage 34 — two reminder kinds, exactly as the spec calls for: a RELEASE
 * reminder tied to an authoritative Stage 33 ReleaseEvent target, and a
 * CONTINUE reminder, a manual "come back to this" alarm with no provider
 * involvement at all. A discriminated union (never one giant nullable-field
 * row) so every call site that only handles one kind gets a compile error
 * if it forgets the other — see lib/reminders.ts for the pure resolution
 * logic that reads these.
 */

interface BaseReminder {
  id: string;
  libraryItemId: string;
  /** Set once Dismiss is used; the row is never deleted for a dismiss (see README-equivalent doc comment on lib/reminders.ts) — only Delete removes the row. */
  dismissedAt?: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * A release reminder is identified by a STABLE provider/media/episode
 * target — never by `scheduledFor` (a schedule can change; see
 * types/release-event.ts's own doc comment for why ReleaseEvent.id, which
 * embeds startsAt, is NOT reused here). `scheduledFor` is only ever a
 * fallback snapshot: lib/reminders.ts's resolveReminders prefers a fresh
 * Stage 33 ReleaseEvent for the same target whenever one is available, and
 * falls back to this stored value (with scheduleConfirmed: false) whenever
 * it isn't — never a DB write merely because the provider's time changed.
 */
export interface ReleaseReminder extends BaseReminder {
  kind: "release";
  provider: "anilist";
  externalMediaId: string;
  episode: number;
  /** ISO UTC — the release time as last known, either at creation or the last time a fresh provider match was reconciled. */
  scheduledFor: string;
  remindBeforeMinutes: number;
}

/** A manual "remind me to continue this" alarm — an explicit, user-chosen absolute UTC instant, no provider data involved at any point. */
export interface ContinueReminder extends BaseReminder {
  kind: "continue";
  /** ISO UTC. */
  remindAt: string;
}

export type Reminder = ReleaseReminder | ContinueReminder;
export type ReminderKind = Reminder["kind"];

type WithoutBase<T> = Omit<T, "id" | "createdAt" | "updatedAt" | "dismissedAt">;

/** What callers pass to create a reminder — id/createdAt are assigned when it's actually recorded, dismissedAt/updatedAt start absent. */
export type ReminderInput = WithoutBase<ReleaseReminder> | WithoutBase<ContinueReminder>;

/**
 * The display-relevant identity of a release target, independent of
 * whether it comes from a live Stage 33 ReleaseEvent (Calendar's
 * "[Remind me]") or an existing ReleaseReminder's own stored snapshot
 * (Reminder Center's Edit) — lets RemindMeReleaseDialog render/submit the
 * same way regardless of which one it was opened from.
 */
export interface ReleaseReminderTarget {
  libraryItemId: string;
  provider: "anilist";
  externalMediaId: string;
  episode: number;
  scheduledFor: string;
  title?: string;
}

/** Fixed lead-time choices (Stage 34 §5) — a real radio/select list, never freeform text input for the common case. */
export const LEAD_TIME_PRESETS: readonly { minutes: number; label: string }[] = [
  { minutes: 0, label: "At release time" },
  { minutes: 10, label: "10 minutes before" },
  { minutes: 30, label: "30 minutes before" },
  { minutes: 60, label: "1 hour before" },
  { minutes: 180, label: "3 hours before" },
  { minutes: 1440, label: "1 day before" },
];
