"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { LibraryItem } from "@/types/library-item";
import type { Reminder, ReleaseReminderTarget } from "@/types/reminder";
import { Header } from "@/components/Header";
import { useAuth } from "@/components/AuthProvider";
import { DataErrorBanner, DataLoadingPlaceholder } from "@/components/DataStatus";
import { useLibraryItems } from "@/hooks/useLibraryItems";
import { useActivity } from "@/hooks/useActivity";
import { useReminders } from "@/hooks/useReminders";
import { useReleaseCalendar } from "@/hooks/useReleaseCalendar";
import { useTrackingSources } from "@/hooks/useTrackingSources";
import { useNow } from "@/hooks/useNow";
import {
  resolveReminders,
  sortDueReminders,
  sortUpcomingReminders,
  sortDismissedReminders,
  activeReleaseReminderLibraryItemIds,
  type ResolvedReminder,
} from "@/lib/reminders";
import { formatDueRelative } from "@/lib/reminder-format";
import { formatReleaseEventFullDateTime, getLocalTimeZone, DEFAULT_CALENDAR_RANGE_DAYS } from "@/lib/release-calendar";
import { getItemHref } from "@/lib/item-detail";
import { resolveResumeTarget } from "@/lib/dashboard";
import { RemindMeReleaseDialog } from "@/components/RemindMeReleaseDialog";
import { RemindMeContinueDialog } from "@/components/RemindMeContinueDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ClockIcon } from "@/components/icons";

interface ReminderCenterViewProps {
  items: LibraryItem[];
}

/**
 * Stage 34 — the Notification Center: what's Due, what's Upcoming, and
 * (behind a secondary toggle, never the default view) what's Dismissed.
 * This is the ONE place that performs the batched, read-only Stage 33
 * reuse fetch to reconcile fresh schedule data — every other reminder-
 * aware surface (the Header badge, Calendar's own "[Remind me]" state)
 * resolves from stored snapshots only, by design (see ReminderBell's own
 * doc comment for why).
 */
export function ReminderCenterView({ items: initialItems }: ReminderCenterViewProps) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const activity = useActivity(userId);
  const library = useLibraryItems(initialItems, activity.logEvent, userId);
  const { items } = library;
  const remindersStore = useReminders(userId);
  const trackingSources = useTrackingSources(userId);
  // Correctness-review fix (Issue D) — never scales with library size:
  // only the LibraryItems behind an active release reminder are passed to
  // Stage 33's hook, never the user's entire (possibly large) AniList-
  // linked library. See activeReleaseReminderLibraryItemIds's own doc
  // comment. useReleaseCalendar itself is reused completely unchanged —
  // an empty input resolves to zero events with no fetch at all (its own
  // existing early-return), so a user with only Continue reminders never
  // triggers any AniList request here.
  const relevantItems = useMemo(() => {
    const ids = activeReleaseReminderLibraryItemIds(remindersStore.reminders);
    return items.filter((item) => ids.has(item.id));
  }, [items, remindersStore.reminders]);
  const calendar = useReleaseCalendar(relevantItems, DEFAULT_CALENDAR_RANGE_DAYS);
  const now = useNow();
  const timeZone = useMemo(() => getLocalTimeZone(), []);

  const [showDismissed, setShowDismissed] = useState(false);
  const [editingRelease, setEditingRelease] = useState<ResolvedReminder | null>(null);
  const [editingContinue, setEditingContinue] = useState<ResolvedReminder | null>(null);
  const [deleting, setDeleting] = useState<Reminder | null>(null);

  const loading = Boolean(userId) && !library.isHydrated;
  const remindersReady = remindersStore.isHydrated;
  const loadError = library.error ?? activity.error;

  // A release schedule fetch that's still loading contributes no fresh
  // data at all yet — resolving with providerAvailable=false in that
  // instant just means every release reminder shows its own last-known
  // snapshot, never a flash of "cancelled." A genuine provider failure
  // (rate-limited/network) behaves identically — see lib/reminders.ts's
  // own doc comment: absence of a fresh match is NEVER cancellation.
  const providerAvailable = !calendar.isLoading && !calendar.error;

  const resolved = useMemo(
    () => resolveReminders(remindersStore.reminders, items, calendar.events, providerAvailable, now),
    [remindersStore.reminders, items, calendar.events, providerAvailable, now],
  );

  const due = useMemo(() => sortDueReminders(resolved), [resolved]);
  const upcoming = useMemo(() => sortUpcomingReminders(resolved), [resolved]);
  const dismissed = useMemo(() => sortDismissedReminders(resolved), [resolved]);

  function retry() {
    library.reload();
    activity.reload();
    remindersStore.reload();
  }

  function handleEdit(entry: ResolvedReminder) {
    if (entry.reminder.kind === "release") setEditingRelease(entry);
    else setEditingContinue(entry);
  }

  async function handleConfirmDelete() {
    if (!deleting) return;
    remindersStore.deleteReminder(deleting.id);
    setDeleting(null);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header active="reminders" />

      <main className="mx-auto max-w-3xl space-y-8 px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold text-foreground">Reminders</h1>
        </div>

        {loadError && <DataErrorBanner message={loadError} onRetry={retry} />}

        {calendar.error && (
          <p className="rounded-md border border-border bg-surface px-3.5 py-2.5 text-xs text-muted-foreground">
            Couldn&rsquo;t reach AniList to confirm release times right now — showing each reminder&rsquo;s last known schedule instead.
          </p>
        )}

        {loading || !remindersReady ? (
          <DataLoadingPlaceholder label="Loading your reminders…" />
        ) : (
          <>
            <ReminderSection
              title="Due"
              emptyText="Nothing due right now."
              entries={due}
              now={now}
              timeZone={timeZone}
              trackingSources={trackingSources.sources}
              onEdit={handleEdit}
              onDismiss={(entry) => remindersStore.dismissReminder(entry.reminder.id)}
              onDelete={(entry) => setDeleting(entry.reminder)}
            />

            <ReminderSection
              title="Upcoming"
              emptyText="Nothing upcoming yet."
              entries={upcoming}
              now={now}
              timeZone={timeZone}
              trackingSources={trackingSources.sources}
              onEdit={handleEdit}
              onDismiss={(entry) => remindersStore.dismissReminder(entry.reminder.id)}
              onDelete={(entry) => setDeleting(entry.reminder)}
            />

            <section>
              <button
                type="button"
                onClick={() => setShowDismissed((current) => !current)}
                className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
              >
                {showDismissed ? "Hide dismissed" : `Show dismissed${dismissed.length > 0 ? ` (${dismissed.length})` : ""}`}
              </button>
              {showDismissed && (
                <div className="mt-3">
                  <ReminderSection
                    title="Dismissed"
                    emptyText="Nothing dismissed yet."
                    entries={dismissed}
                    now={now}
                    timeZone={timeZone}
                    trackingSources={trackingSources.sources}
                    onEdit={handleEdit}
                    onDelete={(entry) => setDeleting(entry.reminder)}
                    hideHeading
                  />
                </div>
              )}
            </section>
          </>
        )}
      </main>

      <RemindMeReleaseDialog
        isOpen={editingRelease !== null}
        target={editingRelease && editingRelease.reminder.kind === "release" ? releaseTargetFromReminder(editingRelease.reminder) : null}
        existing={editingRelease && editingRelease.reminder.kind === "release" ? editingRelease.reminder : null}
        onClose={() => setEditingRelease(null)}
        onCreate={() => Promise.resolve({ status: "error", message: "This reminder already exists." })}
        onUpdateLeadTime={remindersStore.updateReleaseLeadTime}
      />

      <RemindMeContinueDialog
        isOpen={editingContinue !== null}
        libraryItemId={editingContinue?.item.id ?? ""}
        itemTitle={editingContinue?.item.title ?? ""}
        existing={editingContinue && editingContinue.reminder.kind === "continue" ? editingContinue.reminder : null}
        onClose={() => setEditingContinue(null)}
        onCreate={() => Promise.resolve({ status: "error", message: "This reminder already exists." })}
        onUpdateTime={remindersStore.updateContinueTime}
      />

      <ConfirmDialog
        isOpen={deleting !== null}
        title="Delete reminder?"
        message="This removes the reminder rule. This can't be undone."
        confirmLabel="Delete"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}

function releaseTargetFromReminder(reminder: Extract<Reminder, { kind: "release" }>): ReleaseReminderTarget {
  return {
    libraryItemId: reminder.libraryItemId,
    provider: reminder.provider,
    externalMediaId: reminder.externalMediaId,
    episode: reminder.episode,
    scheduledFor: reminder.scheduledFor,
  };
}

interface ReminderSectionProps {
  title: string;
  emptyText: string;
  entries: ResolvedReminder[];
  now: Date;
  timeZone: string;
  trackingSources: Parameters<typeof resolveResumeTarget>[1];
  onEdit: (entry: ResolvedReminder) => void;
  onDismiss?: (entry: ResolvedReminder) => void;
  onDelete: (entry: ResolvedReminder) => void;
  hideHeading?: boolean;
}

function ReminderSection({ title, emptyText, entries, now, timeZone, trackingSources, onEdit, onDismiss, onDelete, hideHeading }: ReminderSectionProps) {
  return (
    <section>
      {!hideHeading && <h2 className="mb-2 text-sm font-semibold text-foreground">{title}</h2>}
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border bg-surface">
          {entries.map((entry) => (
            <ReminderRow
              key={entry.reminder.id}
              entry={entry}
              now={now}
              timeZone={timeZone}
              trackingSources={trackingSources}
              onEdit={onEdit}
              onDismiss={onDismiss}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReminderRow({
  entry,
  now,
  timeZone,
  trackingSources,
  onEdit,
  onDismiss,
  onDelete,
}: {
  entry: ResolvedReminder;
  now: Date;
  timeZone: string;
  trackingSources: Parameters<typeof resolveResumeTarget>[1];
  onEdit: (entry: ResolvedReminder) => void;
  onDismiss?: (entry: ResolvedReminder) => void;
  onDelete: (entry: ResolvedReminder) => void;
}) {
  const { reminder, item } = entry;
  const subtitle =
    reminder.kind === "release"
      ? `Episode ${reminder.episode}${entry.scheduleConfirmed === false ? " · Schedule not currently confirmed" : ""}`
      : "Continue reminder";
  const resume = reminder.kind === "continue" ? resolveResumeTarget(item, trackingSources) : null;

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
          <ClockIcon width={15} height={15} aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          <p className="text-xs text-muted-foreground" title={formatReleaseEventFullDateTime(entry.effectiveDueAt, timeZone)}>
            {entry.isDismissed && reminder.dismissedAt
              ? `Dismissed ${formatDueRelative(reminder.dismissedAt, now)}`
              : `Due ${formatDueRelative(entry.effectiveDueAt, now)}`}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 pl-11 text-xs font-medium sm:pl-0">
        <Link href={getItemHref(item)} className="text-foreground hover:underline">
          Open item
        </Link>
        {resume && resume.kind === "external" && (
          <a href={resume.url} target="_blank" rel="noopener noreferrer" className="text-foreground hover:underline">
            Continue
          </a>
        )}
        {!entry.isDismissed && onDismiss && (
          <button type="button" onClick={() => onDismiss(entry)} className="text-muted-foreground hover:text-foreground hover:underline">
            Dismiss
          </button>
        )}
        <button type="button" onClick={() => onEdit(entry)} className="text-muted-foreground hover:text-foreground hover:underline">
          Edit
        </button>
        <button type="button" onClick={() => onDelete(entry)} className="text-muted-foreground hover:text-danger hover:underline">
          Delete
        </button>
      </div>
    </li>
  );
}
