"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { LibraryItem } from "@/types/library-item";
import type { ReleaseEvent } from "@/types/release-event";
import type { Reminder, ReleaseReminder, ReleaseReminderTarget } from "@/types/reminder";
import { Header } from "@/components/Header";
import { useAuth } from "@/components/AuthProvider";
import { DataErrorBanner, DataLoadingPlaceholder } from "@/components/DataStatus";
import { useLibraryItems } from "@/hooks/useLibraryItems";
import { useActivity } from "@/hooks/useActivity";
import { useReleaseCalendar } from "@/hooks/useReleaseCalendar";
import { useReminders } from "@/hooks/useReminders";
import { findActiveReminderCollision } from "@/lib/reminders";
import { RemindMeReleaseDialog } from "@/components/RemindMeReleaseDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  CALENDAR_RANGE_OPTIONS,
  DEFAULT_CALENDAR_RANGE_DAYS,
  buildAniListMediaAssociation,
  groupReleaseEventsByLocalDay,
  formatReleaseDayLabel,
  formatReleaseEventTime,
  formatReleaseEventFullDateTime,
  getLocalTimeZone,
  type CalendarRangeDays,
} from "@/lib/release-calendar";
import { formatDashboardProgress } from "@/lib/dashboard";
import { getItemHref, getProviderLabel } from "@/lib/item-detail";
import { ItemTypeIcon } from "@/components/ItemTypeIcon";
import { BellIcon } from "@/components/icons";

interface CalendarViewProps {
  items: LibraryItem[];
}

export function CalendarView({ items: initialItems }: CalendarViewProps) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const activity = useActivity(userId);
  const library = useLibraryItems(initialItems, activity.logEvent, userId);
  const { items } = library;

  const [rangeDays, setRangeDays] = useState<CalendarRangeDays>(DEFAULT_CALENDAR_RANGE_DAYS);
  const timeZone = useMemo(() => getLocalTimeZone(), []);

  const calendar = useReleaseCalendar(items, rangeDays);
  const remindersStore = useReminders(userId);
  const [remindDialog, setRemindDialog] = useState<{ event: ReleaseEvent; existing: ReleaseReminder | null } | null>(null);
  const [removingReminder, setRemovingReminder] = useState<ReleaseReminder | null>(null);

  const hasAnyEligibleItem = useMemo(() => buildAniListMediaAssociation(items).size > 0, [items]);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const groups = useMemo(() => groupReleaseEventsByLocalDay(calendar.events, timeZone), [calendar.events, timeZone]);

  const loading = Boolean(userId) && !library.isHydrated;
  const loadError = library.error ?? activity.error;

  function retry() {
    library.reload();
    activity.reload();
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header active="calendar" />

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold text-foreground">Calendar</h1>
          <RangeSelect value={rangeDays} onChange={setRangeDays} />
        </div>

        {loadError && <DataErrorBanner message={loadError} onRetry={retry} />}

        {loading ? (
          <DataLoadingPlaceholder label="Loading your library…" />
        ) : !hasAnyEligibleItem ? (
          <NoEligibleSourcesState />
        ) : calendar.isLoading ? (
          <DataLoadingPlaceholder label="Loading upcoming episodes…" />
        ) : calendar.error ? (
          <ProviderErrorState message={calendar.error.message} onRetry={calendar.reload} />
        ) : (
          <>
            {calendar.isPartial && (
              <PartialResultsNotice rangeDays={rangeDays} onNarrow={rangeDays > 7 ? () => setRangeDays(rangeDays === 30 ? 14 : 7) : undefined} />
            )}
            {groups.length === 0 ? (
              <EmptyWindowState rangeDays={rangeDays} onWiden={() => setRangeDays(30)} />
            ) : (
              <div className="space-y-6">
                {groups.map((group) => (
                  <section key={group.dayKey}>
                    <h2 className="mb-2 text-sm font-semibold text-foreground">
                      {formatReleaseDayLabel(group.dayKey, timeZone, new Date())}
                    </h2>
                    <ul className="divide-y divide-border/60 rounded-lg border border-border bg-surface">
                      {group.events.map((event) => (
                        <EventRow
                          key={event.id}
                          event={event}
                          item={itemsById.get(event.libraryItemId)}
                          timeZone={timeZone}
                          existingReminder={findReleaseReminder(event, remindersStore.reminders)}
                          onRemind={(existing) => setRemindDialog({ event, existing })}
                          onRemoveReminder={setRemovingReminder}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      <RemindMeReleaseDialog
        isOpen={remindDialog !== null}
        target={remindDialog ? releaseTargetFromEvent(remindDialog.event) : null}
        existing={remindDialog?.existing ?? null}
        onClose={() => setRemindDialog(null)}
        onCreate={(target, remindBeforeMinutes) =>
          remindersStore.createReminder({
            kind: "release",
            libraryItemId: target.libraryItemId,
            provider: target.provider,
            externalMediaId: target.externalMediaId,
            episode: target.episode,
            scheduledFor: target.scheduledFor,
            remindBeforeMinutes,
          })
        }
        onUpdateLeadTime={remindersStore.updateReleaseLeadTime}
      />

      <ConfirmDialog
        isOpen={removingReminder !== null}
        title="Remove reminder?"
        message="This removes the reminder rule for this episode. This can't be undone."
        confirmLabel="Remove"
        danger
        onCancel={() => setRemovingReminder(null)}
        onConfirm={() => {
          if (removingReminder) remindersStore.deleteReminder(removingReminder.id);
          setRemovingReminder(null);
        }}
      />
    </div>
  );
}

function releaseTargetFromEvent(event: ReleaseEvent): ReleaseReminderTarget | null {
  if (event.episode === undefined) return null;
  return {
    libraryItemId: event.libraryItemId,
    provider: event.provider,
    externalMediaId: event.externalMediaId,
    episode: event.episode,
    scheduledFor: event.startsAt,
    title: event.title,
  };
}

function findReleaseReminder(event: ReleaseEvent, reminders: readonly Reminder[]): ReleaseReminder | null {
  if (event.episode === undefined) return null;
  const collision = findActiveReminderCollision(
    { kind: "release", libraryItemId: event.libraryItemId, provider: event.provider, externalMediaId: event.externalMediaId, episode: event.episode },
    reminders,
  );
  return collision && collision.kind === "release" ? collision : null;
}

function RangeSelect({ value, onChange }: { value: CalendarRangeDays; onChange: (value: CalendarRangeDays) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
      {CALENDAR_RANGE_OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={value === option}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            value === option ? "bg-surface-hover text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {option}d
        </button>
      ))}
    </div>
  );
}

function EventRow({
  event,
  item,
  timeZone,
  existingReminder,
  onRemind,
  onRemoveReminder,
}: {
  event: ReleaseEvent;
  item: LibraryItem | undefined;
  timeZone: string;
  existingReminder: ReleaseReminder | null;
  onRemind: (existing: ReleaseReminder | null) => void;
  onRemoveReminder: (reminder: ReleaseReminder) => void;
}) {
  const title = event.title ?? item?.title ?? "Untitled";
  const href = item ? getItemHref(item) : undefined;
  const progressText = item ? formatDashboardProgress(item) : null;
  const time = formatReleaseEventTime(event.startsAt, timeZone);
  const fullDateTime = formatReleaseEventFullDateTime(event.startsAt, timeZone);

  const content = (
    <>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-background">
        {item && "imageUrl" in item && item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- user-provided cover art from arbitrary hosts; next/image's optimizer isn't a good fit for this (same convention as MediaItemCard).
          <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <ItemTypeIcon type={item?.type ?? "anime"} width={16} height={16} className="text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        <p className="truncate text-xs text-muted-foreground">
          Episode {event.episode}
          {progressText && ` · You're on ${progressText}`}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-xs font-medium text-foreground" title={fullDateTime}>
          <time dateTime={event.startsAt}>{time}</time>
        </p>
        <p className="text-[10px] text-muted-foreground/70">{getProviderLabel("anilist")}</p>
      </div>
    </>
  );

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      {href ? (
        <Link href={href} className="flex min-w-0 flex-1 items-center gap-3 hover:bg-surface-hover" aria-label={`Open ${title}, Episode ${event.episode}, ${fullDateTime}`}>
          {content}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3 opacity-70">{content}</div>
      )}
      {event.episode !== undefined && (
        <div className="flex w-full shrink-0 items-center gap-2 pl-12 text-xs font-medium sm:w-auto sm:pl-0">
          {existingReminder ? (
            <>
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <BellIcon width={13} height={13} aria-hidden="true" />
                Reminder set
              </span>
              <button type="button" onClick={() => onRemind(existingReminder)} className="text-foreground hover:underline">
                Edit
              </button>
              <button type="button" onClick={() => onRemoveReminder(existingReminder)} className="text-muted-foreground hover:text-danger hover:underline">
                Remove
              </button>
            </>
          ) : (
            <button type="button" onClick={() => onRemind(null)} className="inline-flex items-center gap-1 text-foreground hover:underline">
              <BellIcon width={13} height={13} aria-hidden="true" />
              Remind me
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function NoEligibleSourcesState() {
  return (
    <div className="rounded-lg border border-border bg-surface p-6 text-center">
      <p className="text-sm text-muted-foreground">Nothing upcoming yet.</p>
      <p className="mx-auto mt-1.5 max-w-sm text-xs text-muted-foreground/80">
        Upcoming schedules appear when Markly has reliable release information for a Library item — currently that means
        anime linked to an AniList catalog match.
      </p>
    </div>
  );
}

function EmptyWindowState({ rangeDays, onWiden }: { rangeDays: number; onWiden: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface p-6 text-center">
      <p className="text-sm text-muted-foreground">Nothing scheduled in the next {rangeDays} days.</p>
      {rangeDays < 30 && (
        <button type="button" onClick={onWiden} className="text-xs font-medium text-foreground hover:underline">
          Show next 30 days
        </button>
      )}
    </div>
  );
}

/**
 * Shown whenever useReleaseCalendar reports isPartial (§2/§6 of the
 * correctness review) — a per-chunk pagination cap or the global request
 * budget stopped the fetch early. Never hides the events that WERE
 * fetched; never silently narrows the user's own range selection —
 * `onNarrow` is only offered, the user still has to click it.
 */
function PartialResultsNotice({ rangeDays, onNarrow }: { rangeDays: number; onNarrow?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface px-3.5 py-2.5 text-xs text-muted-foreground">
      <span>Some upcoming releases couldn&apos;t be loaded for the next {rangeDays} days.</span>
      {onNarrow && (
        <button type="button" onClick={onNarrow} className="shrink-0 font-medium text-foreground hover:underline">
          Try a shorter range
        </button>
      )}
    </div>
  );
}

function ProviderErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface p-6 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <button type="button" onClick={onRetry} className="text-xs font-medium text-foreground hover:underline">
        Try again
      </button>
    </div>
  );
}
