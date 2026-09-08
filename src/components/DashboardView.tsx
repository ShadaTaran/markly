"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { LibraryItem } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { Header } from "@/components/Header";
import { ImportBanner } from "@/components/ImportBanner";
import { PageContainer } from "@/components/PageContainer";
import { useAuth } from "@/components/AuthProvider";
import { DataErrorBanner } from "@/components/DataStatus";
import { DashboardSkeleton } from "@/components/DashboardSkeleton";
import { useLibraryItems } from "@/hooks/useLibraryItems";
import { useActivity } from "@/hooks/useActivity";
import { useActivitySummary } from "@/hooks/useActivitySummary";
import { useTrackingSources } from "@/hooks/useTrackingSources";
import { useReleaseCalendar } from "@/hooks/useReleaseCalendar";
import type { ReleaseEvent } from "@/types/release-event";
import { getActivityDetail, getActivitySourceLabel, formatRelativeTime } from "@/lib/activity-format";
import { getCurrentlyTrackingCounts, getLibraryTypeCounts } from "@/lib/stats";
import { isMediaItem, getItemHref } from "@/lib/item-detail";
import { getStatusLabel, getProgressInfo } from "@/lib/tracking";
import { ProgressBar } from "@/components/ProgressBar";
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
      <ImportBanner />

      <PageContainer className="space-y-8">
        {loadError && <DataErrorBanner message={loadError} onRetry={retry} />}

        {loading ? (
          <DashboardSkeleton />
        ) : items.length === 0 ? (
          <EmptyLibraryState />
        ) : (
          <>
            {/* Round 6 — basic library context should be visible immediately,
                but Continue stays the strongest, most action-oriented
                section: this is a lightweight text strip, not a bordered
                analytics card, and it sits above Continue rather than
                competing with it for visual weight. Replaces the old
                bordered "Snapshot" section that used to sit below
                Recently Active. */}
            <div>
              <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                <OverviewStat value={items.length} label="Library" />
                <OverviewStat value={inProgressCount} label="In Progress" />
                <OverviewStat value={completedCount} label="Completed" />
                <OverviewStat value={favoriteCount} label="Favorites" />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {activitySummaryStore.error ? "—" : activeThisWeek} active in the last {ACTIVE_THIS_WEEK_DAYS} days
                {typeCounts.some(({ count }) => count > 0) &&
                  ` · ${typeCounts
                    .filter(({ count }) => count > 0)
                    .map(({ label, count }) => `${count} ${label}`)
                    .join(" · ")}`}
              </p>
            </div>

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
              <SectionHeading title="Recent Activity" />
              {recentActivity.length === 0 ? (
                <p className="text-sm text-muted-foreground">No activity yet.</p>
              ) : (
                <ul className="divide-y divide-border/60 rounded-lg border border-border bg-surface">
                  {recentActivity.map(({ event, item }) => {
                    const sourceLabel = getActivitySourceLabel(event);
                    return (
                      <li key={event.id} className="px-4 py-2.5">
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
      </PageContainer>
    </div>
  );
}

function SectionHeading({ title, viewAllHref }: { title: string; viewAllHref?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {viewAllHref && (
        <Link href={viewAllHref} className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
          View all
        </Link>
      )}
    </div>
  );
}

function OverviewStat({ label, value }: { label: string; value: number | string }) {
  return (
    <span className="text-sm">
      <span className="font-semibold text-foreground">{value}</span> <span className="text-muted-foreground">{label}</span>
    </span>
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
  const progressPercent = isMediaItem(item) ? getProgressInfo(item)?.percent : undefined;
  const typeLabel = ITEM_TYPE_LABELS[item.type];
  const isExternal = resumeTarget.kind === "external";
  const ctaLabel = isExternal ? "Continue" : "Open item";
  const imageUrl = "imageUrl" in item ? item.imageUrl : undefined;

  return (
    <article className="flex w-64 shrink-0 gap-3 rounded-lg border border-border bg-surface p-3 sm:w-auto">
      <Link
        href={getItemHref(item)}
        aria-label={`View details for ${item.title}`}
        className="flex h-20 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- user-provided cover art from arbitrary hosts; next/image's optimizer isn't a good fit for this (same convention as MediaItemCard).
          <img src={imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <ItemTypeIcon type={item.type} width={20} height={20} className="text-muted-foreground" aria-hidden="true" />
        )}
      </Link>

      <div className="flex min-w-0 flex-1 flex-col">
        <Link href={getItemHref(item)} className="outline-none focus-visible:underline">
          <h3 className="truncate text-sm font-medium leading-tight text-foreground hover:underline">{item.title}</h3>
        </Link>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{typeLabel}</p>

        {progressText && (
          <div className="mt-1.5">
            <p className="truncate text-xs text-foreground">{progressText}</p>
            {progressPercent !== undefined && <ProgressBar percent={progressPercent} className="mt-1" />}
          </div>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 pt-2">
          {lastActiveLabel ? (
            <span className="truncate text-[11px] text-muted-foreground" title={lastActiveLabel}>
              {lastActiveLabel}
            </span>
          ) : (
            <span />
          )}
          {isExternal ? (
            <a
              href={resumeTarget.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${ctaLabel} ${item.title}${resumeTarget.hostname ? ` on ${resumeTarget.sourceLabel ?? resumeTarget.hostname}` : ""}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {ctaLabel}
              <ExternalLinkIcon width={10} height={10} />
            </a>
          ) : (
            <Link
              href={resumeTarget.url}
              aria-label={`${ctaLabel} ${item.title}`}
              className="shrink-0 text-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:underline"
            >
              {ctaLabel}
            </Link>
          )}
        </div>
      </div>
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
        <ul className="divide-y divide-border/60 rounded-lg border border-border bg-surface">
          {items.map((item) => {
            const progressText = formatDashboardProgress(item);
            const lastActiveLabel = lastActiveLabelFor(item.id, activitySummary, now);
            return (
              <li key={item.id}>
                <Link href={getItemHref(item)} className="flex items-center gap-3 px-4 py-2 hover:bg-surface-hover">
                  <ItemTypeIcon type={item.type} width={14} height={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{item.title}</p>
                    {progressText && <p className="truncate text-xs text-muted-foreground">{progressText}</p>}
                  </div>
                  {lastActiveLabel && <span className="shrink-0 text-xs text-muted-foreground">{lastActiveLabel}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
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
  // Round 4 — when there's nothing stalled, the section renders nothing at
  // all (no heading, no "View all"). The Stalled Smart View stays reachable
  // from Library regardless; Stage 31 Stalled semantics are unaffected —
  // this only changes whether Dashboard shows an empty section for it.
  if (items.length === 0 && !activityError) return null;

  return (
    <section>
      <SectionHeading title="Stalled" viewAllHref="/library" />
      <ActivityErrorNotice activityError={activityError} onRetryActivity={onRetryActivity} />
      {items.length === 0 ? null : (
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
