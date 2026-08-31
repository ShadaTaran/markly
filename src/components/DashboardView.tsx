"use client";

import { useMemo } from "react";
import type { LibraryItem } from "@/types/library-item";
import { Header } from "@/components/Header";
import { useAuth } from "@/components/AuthProvider";
import { DataErrorBanner, DataLoadingPlaceholder } from "@/components/DataStatus";
import { useLibraryItems } from "@/hooks/useLibraryItems";
import { useActivity } from "@/hooks/useActivity";
import { getActivityDetail, formatRelativeTime } from "@/lib/activity-format";
import { getCurrentlyTrackingCounts, getLibraryTypeCounts, getMonthlyStats } from "@/lib/stats";

interface DashboardViewProps {
  items: LibraryItem[];
}

const MAX_RECENT_ACTIVITY = 5;

export function DashboardView({ items: initialItems }: DashboardViewProps) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const activity = useActivity(userId);
  const library = useLibraryItems(initialItems, activity.logEvent, userId);
  const { items } = library;

  // In cloud mode, hydration is a real network round-trip — showing the
  // starter/placeholder items and then swapping to the real ones would
  // flash wrong data, so a loading state is shown instead until both
  // cloud-backed stores have resolved. Local mode hydrates effectively
  // instantly, so it never shows this.
  const loading = Boolean(userId) && (!library.isHydrated || !activity.isHydrated);
  const loadError = library.error ?? activity.error;

  function retry() {
    library.reload();
    activity.reload();
  }

  const currentlyTracking = useMemo(() => getCurrentlyTrackingCounts(items), [items]);
  const typeCounts = useMemo(() => getLibraryTypeCounts(items), [items]);
  const monthlyStats = useMemo(() => getMonthlyStats(activity.events, items), [activity.events, items]);

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

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        {loadError && <DataErrorBanner message={loadError} onRetry={retry} />}

        {loading ? (
          <DataLoadingPlaceholder label="Loading your library…" />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {items.length} item{items.length === 1 ? "" : "s"} in your library
            </p>

            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                title="Currently"
                rows={[
                  { label: "Watching", value: currentlyTracking.watching },
                  { label: "Reading", value: currentlyTracking.reading },
                  { label: "Playing", value: currentlyTracking.playing },
                ]}
              />

              <StatCard title="Library" rows={typeCounts.map(({ label, count }) => ({ label, value: count }))} />

              <StatCard
                title="This Month"
                rows={[
                  { label: "Progress updates", value: monthlyStats.progressUpdates },
                  { label: "Items completed", value: monthlyStats.itemsCompleted },
                  {
                    label: "Average rating",
                    value: monthlyStats.averageRating !== undefined ? monthlyStats.averageRating.toFixed(1) : "—",
                  },
                ]}
              />
            </div>

            <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
              <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Recent Activity
              </h2>
              {recentActivity.length === 0 ? (
                <p className="text-sm text-muted-foreground">No activity yet.</p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {recentActivity.map(({ event, item }) => (
                    <li key={event.id} className="py-1.5 first:pt-0 last:pb-0">
                      <p className="text-xs text-muted-foreground">{item?.title ?? "Deleted item"}</p>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="text-sm text-foreground">{getActivityDetail(event, item)}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {formatRelativeTime(event.timestamp)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

interface StatRow {
  label: string;
  value: number | string;
}

function StatCard({ title, rows }: { title: string; rows: StatRow[] }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{title}</h2>
      <dl className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-sm text-muted-foreground">{row.label}</dt>
            <dd className="text-sm font-medium text-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
