import type { LibraryItem } from "@/types/library-item";
import type { ReleaseEvent } from "@/types/release-event";
import type { Reminder } from "@/types/reminder";

/**
 * Stage 34 — the reminder engine. Pure functions only: given the current
 * Reminder rows, the current LibraryItems, whatever fresh Stage 33
 * ReleaseEvents happen to be available, and "now", compute what should
 * actually be shown. Every UI surface (the /reminders page, the Header
 * badge, Calendar's "[Remind me]" state) calls THIS, never re-derives
 * due/upcoming/dismissed logic itself — see README "Reminders &
 * Notification Center" for the full design.
 *
 * Central invariant this file exists to protect: a release reminder's
 * identity is `provider + externalMediaId + episode`, NEVER `scheduledFor`
 * (a stored snapshot) and never ReleaseEvent.id (which embeds startsAt —
 * see types/release-event.ts). A schedule change is reflected by finding a
 * FRESH ReleaseEvent for the same stable target and using ITS startsAt for
 * the effective time — computed here, in memory, on every call. No fresh
 * match (the provider fetch failed, hasn't run, or genuinely no longer
 * lists that episode — including a Stage 33 PARTIAL batch that simply
 * didn't cover it) NEVER means "cancelled": it only means
 * `scheduleConfirmed: false` and a fall-back to the last stored snapshot.
 * The reminder row itself is never deleted or hidden for this reason.
 */

/** Stable key for a release reminder's target — the identity a fresh ReleaseEvent is matched against. Never includes startsAt/scheduledFor. */
export function releaseIdentityKey(target: { provider: string; externalMediaId: string; episode: number }): string {
  return `${target.provider}:${target.externalMediaId}:episode:${target.episode}`;
}

/**
 * Correctness-review fix (Issue D) — the LibraryItem ids that ACTUALLY
 * need a fresh schedule check: only items behind an active (non-dismissed)
 * release reminder. Passing every AniList-linked LibraryItem in the whole
 * library to useReleaseCalendar would scale the fetch with library size
 * (potentially hundreds of media ids, chunked across many requests,
 * risking Stage 33's own partial/request-budget path) when only a
 * handful of reminders — often far fewer — actually need reconciling.
 * Dismissed release reminders are deliberately excluded: a dismissed
 * reminder never needs its schedule refreshed for display (it isn't shown
 * unless "Show dismissed" is toggled, and even then it renders from its
 * own stored snapshot, never a fresh fetch).
 */
export function activeReleaseReminderLibraryItemIds(reminders: readonly Reminder[]): Set<string> {
  const ids = new Set<string>();
  for (const reminder of reminders) {
    if (reminder.kind === "release" && !reminder.dismissedAt) ids.add(reminder.libraryItemId);
  }
  return ids;
}

function isSameReleaseIdentity(
  a: { provider: string; externalMediaId: string; episode: number },
  b: { provider: string; externalMediaId: string; episode: number },
): boolean {
  return a.provider === b.provider && a.externalMediaId === b.externalMediaId && a.episode === b.episode;
}

/**
 * The subset of fields that determine a reminder's logical identity —
 * deliberately its own narrow discriminated union (never the awkward
 * `Partial<ReleaseReminder> & Partial<ContinueReminder>` intersection,
 * which TypeScript can't cleanly narrow by `kind` once both sides are
 * Partial). Every real Reminder/ReminderInput already has more fields than
 * this needs, so passing one directly is always valid.
 */
export type ReminderIdentity =
  | { kind: "release"; libraryItemId: string; provider: string; externalMediaId: string; episode: number }
  | { kind: "continue"; libraryItemId: string; remindAt: string };

/**
 * Whether `candidate` (about to be created, or an existing reminder about
 * to be edited into this shape) is logically identical to an existing,
 * still-ACTIVE (non-dismissed) reminder in `existing`. Mirrors the two
 * partial unique indexes in 0016_stage34_reminders.sql exactly, so local
 * mode enforces the identical invariant the cloud DB constraint does:
 *   - release: same libraryItemId + provider + externalMediaId + episode.
 *   - continue: same libraryItemId + remindAt (exact instant).
 * A DISMISSED historical row is never a collision (§ "dismissed rows
 * should not necessarily block creating a new reminder") — matches the
 * DB indexes' own `WHERE dismissed_at IS NULL` filter.
 */
export function findActiveReminderCollision(candidate: ReminderIdentity, existing: readonly Reminder[]): Reminder | undefined {
  return existing.find((row) => {
    if (row.dismissedAt) return false;
    if (row.libraryItemId !== candidate.libraryItemId || row.kind !== candidate.kind) return false;
    if (row.kind === "release" && candidate.kind === "release") {
      return isSameReleaseIdentity(row, candidate);
    }
    if (row.kind === "continue" && candidate.kind === "continue") {
      return row.remindAt === candidate.remindAt;
    }
    return false;
  });
}

export interface ResolvedReminder {
  reminder: Reminder;
  item: LibraryItem;
  /** ISO UTC — the instant this reminder becomes Due. For a release reminder, effectiveScheduledFor minus remindBeforeMinutes; for a continue reminder, exactly remindAt. */
  effectiveDueAt: string;
  /** Release reminders only — the release time actually used to compute effectiveDueAt (fresh ReleaseEvent.startsAt when matched, otherwise the stored snapshot). */
  effectiveScheduledFor?: string;
  /** Release reminders only — true when a fresh Stage 33 ReleaseEvent for this exact target was available and used; false means the stored snapshot is being shown/used instead ("Schedule not currently confirmed"), never treated as cancellation. */
  scheduleConfirmed?: boolean;
  isDue: boolean;
  isDismissed: boolean;
}

/**
 * Resolves every reminder against current state. Orphaned reminders (their
 * LibraryItem no longer exists) are skipped outright — never shown, never
 * crash, never a fabricated title (§ orphan handling). `freshEvents` should
 * be [] and `providerAvailable` false whenever no live Stage 33 fetch was
 * performed for this call (e.g. the Header badge, which deliberately never
 * triggers its own AniList fetch — see useReminders' own doc comment) —
 * every release reminder then simply resolves from its own stored
 * snapshot, which is always well-defined.
 */
export function resolveReminders(
  reminders: readonly Reminder[],
  items: readonly LibraryItem[],
  freshEvents: readonly ReleaseEvent[],
  providerAvailable: boolean,
  now: Date,
): ResolvedReminder[] {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const eventsByKey = new Map<string, ReleaseEvent>();
  if (providerAvailable) {
    for (const event of freshEvents) {
      if (event.episode === undefined) continue;
      eventsByKey.set(releaseIdentityKey({ provider: event.provider, externalMediaId: event.externalMediaId, episode: event.episode }), event);
    }
  }

  const nowMs = now.getTime();
  const resolved: ResolvedReminder[] = [];

  for (const reminder of reminders) {
    const item = itemsById.get(reminder.libraryItemId);
    if (!item) continue;

    if (reminder.kind === "continue") {
      const dueMs = new Date(reminder.remindAt).getTime();
      resolved.push({
        reminder,
        item,
        effectiveDueAt: reminder.remindAt,
        isDismissed: Boolean(reminder.dismissedAt),
        isDue: !reminder.dismissedAt && dueMs <= nowMs,
      });
      continue;
    }

    const fresh = eventsByKey.get(releaseIdentityKey(reminder));
    const effectiveScheduledFor = fresh ? fresh.startsAt : reminder.scheduledFor;
    const scheduleConfirmed = Boolean(fresh);
    const dueMs = new Date(effectiveScheduledFor).getTime() - reminder.remindBeforeMinutes * 60_000;
    resolved.push({
      reminder,
      item,
      effectiveDueAt: new Date(dueMs).toISOString(),
      effectiveScheduledFor,
      scheduleConfirmed,
      isDismissed: Boolean(reminder.dismissedAt),
      isDue: !reminder.dismissedAt && dueMs <= nowMs,
    });
  }

  return resolved;
}

function compareById(a: ResolvedReminder, b: ResolvedReminder): number {
  return a.reminder.id.localeCompare(b.reminder.id);
}

/** Most recently due first (§ sorting) — deterministic tie-break by reminder id. */
export function sortDueReminders(resolved: readonly ResolvedReminder[]): ResolvedReminder[] {
  return resolved
    .filter((entry) => entry.isDue)
    .sort((a, b) => new Date(b.effectiveDueAt).getTime() - new Date(a.effectiveDueAt).getTime() || compareById(a, b));
}

/** Nearest due time first, excludes anything already Due or Dismissed. */
export function sortUpcomingReminders(resolved: readonly ResolvedReminder[]): ResolvedReminder[] {
  return resolved
    .filter((entry) => !entry.isDue && !entry.isDismissed)
    .sort((a, b) => new Date(a.effectiveDueAt).getTime() - new Date(b.effectiveDueAt).getTime() || compareById(a, b));
}

/** Most recently dismissed first. */
export function sortDismissedReminders(resolved: readonly ResolvedReminder[]): ResolvedReminder[] {
  return resolved
    .filter((entry) => entry.isDismissed)
    .sort((a, b) => {
      const aTs = a.reminder.dismissedAt ? new Date(a.reminder.dismissedAt).getTime() : 0;
      const bTs = b.reminder.dismissedAt ? new Date(b.reminder.dismissedAt).getTime() : 0;
      return bTs - aTs || compareById(a, b);
    });
}

/** The ONE due-count selector — powers both the Header badge and the /reminders page, so neither can ever disagree (§ "no separately maintained counter"). */
export function countDueReminders(resolved: readonly ResolvedReminder[]): number {
  return resolved.reduce((count, entry) => (entry.isDue ? count + 1 : count), 0);
}
