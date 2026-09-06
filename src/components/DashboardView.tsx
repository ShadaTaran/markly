"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { LibraryItem } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { Header } from "@/components/Header";
import { useAuth } from "@/components/AuthProvider";
import { DataErrorBanner, DataLoadingPlaceholder } from "@/components/DataStatus";
import { useLibraryItems } from "@/hooks/useLibraryItems";
import { useActivity } from "@/hooks/useActivity";
import { useActivitySummary } from "@/hooks/useActivitySummary";
import { useTrackingSources } from "@/hooks/useTrackingSources";
import { useReleaseCalendar } from "@/hooks/useReleaseCalendar";
import type { ReleaseEvent } from "@/types/release-event";
import { getActivityDetail, getActivitySourceLabel, formatRelativeTime } from "@/lib/activity-format";
import { getCurrentlyTrackingCounts, getLibraryTypeCounts } from "@/lib/stats";
import { isMediaItem, getItemHref } from "@/lib/item-detail";
import { getStatusLabel } from "@/lib/tracking";
import {
  getBuiltInViewItems,
  formatDashboardProgress,
  resolveResumeTarget,
  countActiveWithinDays,
} from "@/lib/dashboard";
import { DEFAULT_CALENDAR_RANGE_DAYS, formatReleaseDayLabel, formatReleaseEventTime, getLocalDayKey, getLocalTimeZone } from "@/lib/release-calendar";
import { CONTINUE_VIEW_ID, RECENTLY_ACTIVE_VIEW_ID, STALLED_VIEW_ID, type SmartViewContext } from "@/lib/smart-views";
import { ItemTypeIcon } from "@/components/ItemTypeIcon";
import { ExternalLinkIcon, StarIcon } from "@/components/icons";

interface DashboardViewProps {
  items: LibraryItem[];
}

const MAX_RECENT_ACTIVITY = 5;
const CONTINUE_LIMIT = 6;
const RECENTLY_ACTIVE_LIMIT = 6;
const STALLED_LIMIT = 5;
const ACTIVE_THIS_WEEK_DAYS = 7;

export function DashboardView({ items: initialItems }: DashboardViewProps) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const activity = useActivity(userId);
  const library = useLibraryItems(initialItems, activity.logEvent, userId);
  const { items } = library;
  const activitySummaryStore = useActivitySummary(userId, activity.events, activity.cloudWriteVersion);
  const trackingSources = useTrackingSources(userId);
  const calendar = useReleaseCalendar(items, DEFAULT_CALENDAR_RANGE_DAYS);
  const timeZone = useMemo(() => getLocalTimeZone(), []);

  // Mirrors LibraryView's own gating: cloud mode is a real network round
  // trip for both stores, so a loading state is shown until the library
  // itself has resolved — the same rule DashboardView already used before
  // Stage 32. Activity summary and tracking sources are treated as
  // SECONDARY below (§43/§44): a slow or failed fetch for either narrows
  // what a section can show, it never blocks the whole page.
  const loading = Boolean(userId) && (!library.isHydrated || !activitySummaryStore.isHydrated);
  const loadError = library.error ?? activity.error;

  function retry() {
    library.reload();
    activity.reload();
    activitySummaryStore.reload();
    trackingSources.reload();
  }

  const smartViewContext: SmartViewContext = useMemo(
    () => ({ collections: [], activitySummary: activitySummaryStore.summary, now: new Date() }),
    [activitySummaryStore.summary],
  );

  const continueItems = useMemo(
    () => getBuiltInViewItems(items, CONTINUE_VIEW_ID, smartViewContext).slice(0, CONTINUE_LIMIT),
    [items, smartViewContext],
  );
  const recentlyActiveItems = useMemo(
    () => getBuiltInViewItems(items, RECENTLY_ACTIVE_VIEW_ID, smartViewContext).slice(0, RECENTLY_ACTIVE_LIMIT),
    [items, smartViewContext],
  );
  const stalledItems = useMemo(
    () => getBuiltInViewItems(items, STALLED_VIEW_ID, smartViewContext).slice(0, STALLED_LIMIT),
    [items, smartViewContext],
  );

  const activeThisWeek = useMemo(
    () => countActiveWithinDays(items, activitySummaryStore.summary, ACTIVE_THIS_WEEK_DAYS, smartViewContext.now),
    [items, activitySummaryStore.summary, smartViewContext.now],
  );

  const currentlyTracking = useMemo(() => getCurrentlyTrackingCounts(items), [items]);
  const typeCounts = useMemo(() => getLibraryTypeCounts(items), [items]);
  const completedCount = useMemo(() => items.filter((item) => "status" in item && item.status === "completed").length, [items]);
  const favoriteCount = useMemo(() => items.filter((item) => item.favorite).length, [items]);
  const inProgressCount = currentlyTracking.watching + currentlyTracking.reading + currentlyTracking.playing;

  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const recentActivity = useMemo(
    () =>
      activity.events
        .filter((event) => event.type !== "item_added")
        .slice(0, MAX_RECENT_ACTIVITY)
        .map((event) => ({ event, item: itemsById.get(event.itemId) })),
    [activity.events, itemsById],
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header active="dashboard" />

      <main className="mx-auto max-w-6xl space-y-8 px-4 py-6 sm:px-6 lg:px-8">
        {loadError && <DataErrorBanner message={loadError} onRetry={retry} />}

        {loading ? (
          <DataLoadingPlaceholder label="Loading your library…" />
        ) : items.length === 0 ? (
          <EmptyLibraryState />
        ) : (
          <>
            <ContinueSection
              items={continueItems}
              trackingSources={trackingSources.sources}
              activitySummary={activitySummaryStore.summary}
              now={smartViewContext.now}
              activityError={activitySummaryStore.error}
              onRetryActivity={() => activitySummaryStore.reload()}
            />

            <UpcomingSection
              events={calendar.events}
              itemsById={itemsById}
              timeZone={timeZone}
              isLoading={calendar.isLoading}
              error={calendar.error}
              isPartial={calendar.isPartial}
              onRetry={calendar.reload}
            />

            <RecentlyActiveSection
              items={recentlyActiveItems}
              activitySummary={activitySummaryStore.summary}
              now={smartViewContext.now}
              activityError={activitySummaryStore.error}
              onRetryActivity={() => activitySummaryStore.reload()}
            />

            <StalledSection
              items={stalledItems}
              activitySummary={activitySummaryStore.summary}
              now={smartViewContext.now}
              activityError={activitySummaryStore.error}
              onRetryActivity={() => activitySummaryStore.reload()}
            />

            <section>
              <SectionHeading title="Activity Snapshot" />
              <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
                <StatRow label={`Active in the last ${ACTIVE_THIS_WEEK_DAYS} days`} value={activitySummaryStore.error ? "—" : activeThisWeek} />
              </div>
            </section>

            <section>
              <SectionHeading title="Library Snapshot" />
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
                  <dl className="space-y-1.5">
                    <StatRow label="Total" value={items.length} />
                    <StatRow label="In Progress" value={inProgressCount} />
                    <StatRow label="Completed" value={completedCount} />
                    <StatRow label="Favorites" value={favoriteCount} />
                  </dl>
                </div>
                <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
                  <dl className="space-y-1.5">
                    {typeCounts.map(({ label, count }) => (
                      <StatRow key={label} label={label} value={count} />
                    ))}
                  </dl>
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
              <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Recent Activity
              </h2>
              {recentActivity.length === 0 ? (
                <p className="text-sm text-muted-foreground">No activity yet.</p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {recentActivity.map(({ event, item }) => {
                    const sourceLabel = getActivitySourceLabel(event);
                    return (
                      <li key={event.id} className="py-1.5 first:pt-0 last:pb-0">
                        <p className="text-xs text-muted-foreground">
                          {item?.title ?? "Deleted item"}
                          {sourceLabel && ` · ${sourceLabel}`}
                        </p>
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <span className="text-sm text-foreground">{getActivityDetail(event, item)}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {formatRelativeTime(event.timestamp)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function SectionHeading({ title, viewAllHref }: { title: string; viewAllHref?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {viewAllHref && (
        <Link href={viewAllHref} className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
          View all
        </Link>
      )}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

function EmptyLibraryState() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface py-16 text-center">
      <p className="text-sm text-muted-foreground">Your library is empty.</p>
      <Link
        href="/library"
        className="rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
      >
        Add your first item
      </Link>
    </div>
  );
}

interface ActivityDependentSectionProps {
  activityError: string | null;
  onRetryActivity: () => void;
}

function ActivityErrorNotice({ activityError, onRetryActivity }: ActivityDependentSectionProps) {
  if (!activityError) return null;
  return (
    <p className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>Couldn&apos;t load recent activity for this section.</span>
      <button type="button" onClick={onRetryActivity} className="font-medium text-foreground hover:underline">
        Retry
      </button>
    </p>
  );
}

// ============================================================
// Continue
// ============================================================

interface ContinueSectionProps extends ActivityDependentSectionProps {
  items: LibraryItem[];
  trackingSources: Parameters<typeof resolveResumeTarget>[1];
  activitySummary: ReadonlyMap<string, string>;
  now: Date;
}

function ContinueSection({ items, trackingSources, activitySummary, now, activityError, onRetryActivity }: ContinueSectionProps) {
  return (
    <section>
      <SectionHeading title="Continue" viewAllHref="/library" />
      <ActivityErrorNotice activityError={activityError} onRetryActivity={onRetryActivity} />
      {items.length === 0 ? (
        <EmptySectionNotice message="Nothing in progress right now." actionHref="/library" actionLabel="Browse Library" />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-1 sm:grid sm:grid-cols-2 sm:overflow-visible lg:grid-cols-3">
          {items.map((item) => (
            <ContinueCard
              key={item.id}
              item={item}
              resumeTarget={resolveResumeTarget(item, trackingSources)}
              lastActiveLabel={lastActiveLabelFor(item.id, activitySummary, now)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function lastActiveLabelFor(itemId: string, activitySummary: ReadonlyMap<string, string>, now: Date): string | null {
  const timestamp = activitySummary.get(itemId);
  return timestamp ? formatRelativeTime(timestamp, now) : null;
}

function ContinueCard({
  item,
  resumeTarget,
  lastActiveLabel,
}: {
  item: LibraryItem;
  resumeTarget: ReturnType<typeof resolveResumeTarget>;
  lastActiveLabel: string | null;
}) {
  const progressText = formatDashboardProgress(item);
  const typeLabel = ITEM_TYPE_LABELS[item.type];
  const isExternal = resumeTarget.kind === "external";
  const ctaLabel = isExternal ? "Continue" : "Open item";

  return (
    <article className="w-56 shrink-0 rounded-lg border border-border bg-surface p-3 sm:w-auto">
      <Link href={getItemHref(item)} className="block outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-md">
        <h3 className="truncate text-sm font-medium leading-tight text-foreground hover:underline">{item.title}</h3>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{typeLabel}</p>
      </Link>

      {progressText && <p className="mt-2 truncate text-xs text-foreground">{progressText}</p>}

      {lastActiveLabel && (
        <p className="mt-1 text-[11px] text-muted-foreground" title={lastActiveLabel}>
          Last active {lastActiveLabel}
        </p>
      )}

      <div className="mt-3">
        {isExternal ? (
          <a
            href={resumeTarget.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${ctaLabel} ${item.title}${resumeTarget.hostname ? ` on ${resumeTarget.sourceLabel ?? resumeTarget.hostname}` : ""}`}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {ctaLabel}
            <ExternalLinkIcon width={11} height={11} />
          </a>
        ) : (
          <Link
            href={resumeTarget.url}
            aria-label={`${ctaLabel} ${item.title}`}
            className="flex w-full items-center justify-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {ctaLabel}
          </Link>
        )}
      </div>

      {isExternal && (resumeTarget.sourceLabel ?? resumeTarget.hostname) && (
        <p className="mt-1.5 truncate text-center text-[10px] text-muted-foreground/70">
          {resumeTarget.sourceLabel ?? resumeTarget.hostname}
        </p>
      )}
    </article>
  );
}

// ============================================================
// Upcoming (Stage 33) — a small preview of the same public, unauthenticated
// AniList schedule data /calendar shows in full. A failed/loading fetch
// here never touches loadError/loading above — Continue, Recently Active,
// Stalled, and Library Snapshot all render normally regardless (§41).
// ============================================================

const DASHBOARD_UPCOMING_LIMIT = 5;

function UpcomingSection({
  events,
  itemsById,
  timeZone,
  isLoading,
  error,
  isPartial,
  onRetry,
}: {
  events: ReleaseEvent[];
  itemsById: Map<string, LibraryItem>;
  timeZone: string;
  isLoading: boolean;
  error: { message: string } | null;
  isPartial: boolean;
  onRetry: () => void;
}) {
  const upcoming = events.slice(0, DASHBOARD_UPCOMING_LIMIT);

  return (
    <section>
      <SectionHeading title="Upcoming" viewAllHref="/calendar" />
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading upcoming episodes…</p>
      ) : error ? (
        <p className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{error.message}</span>
          <button type="button" onClick={onRetry} className="font-medium text-foreground hover:underline">
            Try again
          </button>
        </p>
      ) : upcoming.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing upcoming yet.</p>
      ) : (
        <>
          {/* isPartial: a correctness-review invariant — never let a fetch that stopped early (pagination/budget cap) read as a complete calendar; see fetchAniListAiringSchedules's own doc comment. The full /calendar page is where a user can act on this (narrow the range); Dashboard's compact preview just discloses it. */}
          {isPartial && <p className="mb-1.5 text-[11px] text-muted-foreground/80">Showing partial results — see Calendar for details.</p>}
          <ul className="divide-y divide-border/60 rounded-lg border border-border bg-surface">
          {upcoming.map((event) => {
            const item = itemsById.get(event.libraryItemId);
            const title = event.title ?? item?.title ?? "Untitled";
            const dayKey = getLocalDayKey(new Date(event.startsAt), timeZone);
            return (
              <li key={event.id}>
                <Link
                  href={item ? getItemHref(item) : "/calendar"}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-surface-hover"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{title}</p>
                    <p className="truncate text-xs text-muted-foreground">Episode {event.episode}</p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatReleaseDayLabel(dayKey, timeZone, new Date())} · {formatReleaseEventTime(event.startsAt, timeZone)}
                  </span>
                </Link>
              </li>
            );
          })}
          </ul>
        </>
      )}
    </section>
  );
}

// ============================================================
// Recently Active
// ============================================================

interface RecentlyActiveSectionProps extends ActivityDependentSectionProps {
  items: LibraryItem[];
  activitySummary: ReadonlyMap<string, string>;
  now: Date;
}

function RecentlyActiveSection({ items, activitySummary, now, activityError, onRetryActivity }: RecentlyActiveSectionProps) {
  return (
    <section>
      <SectionHeading title="Recently Active" viewAllHref="/library" />
      <ActivityErrorNotice activityError={activityError} onRetryActivity={onRetryActivity} />
      {items.length === 0 && !activityError ? (
        <p className="text-sm text-muted-foreground">No recent activity yet.</p>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-1 sm:grid sm:grid-cols-2 sm:overflow-visible lg:grid-cols-3">
          {items.map((item) => (
            <CompactActivityCard key={item.id} item={item} lastActiveLabel={lastActiveLabelFor(item.id, activitySummary, now)} />
          ))}
        </div>
      )}
    </section>
  );
}

function CompactActivityCard({ item, lastActiveLabel }: { item: LibraryItem; lastActiveLabel: string | null }) {
  const progressText = formatDashboardProgress(item);
  return (
    <Link
      href={getItemHref(item)}
      className="block w-48 shrink-0 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-foreground/25 sm:w-auto"
    >
      <div className="flex items-center gap-2">
        <ItemTypeIcon type={item.type} width={14} height={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        <h3 className="truncate text-sm font-medium text-foreground">{item.title}</h3>
      </div>
      {progressText && <p className="mt-1 truncate text-xs text-muted-foreground">{progressText}</p>}
      {lastActiveLabel && <p className="mt-1 text-[11px] text-muted-foreground/80">{lastActiveLabel}</p>}
    </Link>
  );
}

// ============================================================
// Stalled
// ============================================================

interface StalledSectionProps extends ActivityDependentSectionProps {
  items: LibraryItem[];
  activitySummary: ReadonlyMap<string, string>;
  now: Date;
}

function StalledSection({ items, activitySummary, now, activityError, onRetryActivity }: StalledSectionProps) {
  return (
    <section>
      <SectionHeading title="Stalled" viewAllHref="/library" />
      <ActivityErrorNotice activityError={activityError} onRetryActivity={onRetryActivity} />
      {items.length === 0 && !activityError ? (
        <p className="text-sm text-muted-foreground">Nothing stalled.</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border bg-surface">
          {items.map((item) => {
            const label = lastActiveLabelFor(item.id, activitySummary, now);
            const statusLabel = isMediaItem(item) ? getStatusLabel(item) : undefined;
            return (
              <li key={item.id}>
                <Link href={getItemHref(item)} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-surface-hover">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {statusLabel}
                      {item.favorite && (
                        <span className="ml-1 inline-flex align-text-bottom">
                          <StarIcon filled width={10} height={10} />
                        </span>
                      )}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{label ?? "Not started recently"}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function EmptySectionNotice({ message, actionHref, actionLabel }: { message: string; actionHref: string; actionLabel: string }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <span>{message}</span>
      <Link href={actionHref} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-hover">
        {actionLabel}
      </Link>
    </div>
  );
}
