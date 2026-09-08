/**
 * Dashboard's loaded state (Continue cards, several list sections, a stat
 * grid) is dramatically taller and differently-shaped than its loading
 * placeholder was (a single centered line) — a real, visible layout jump
 * for any cloud fetch that takes more than an instant. This mirrors the
 * page's actual section shapes closely enough to keep that jump small,
 * without trying to be pixel-perfect.
 */
function SkeletonBlock({ className }: { className: string }) {
  return <div className={`rounded-md bg-surface-hover ${className}`} />;
}

export function DashboardSkeleton() {
  return (
    <div className="motion-safe:animate-pulse space-y-8" role="status" aria-label="Loading your dashboard">
      <section>
        <SkeletonBlock className="mb-3 h-5 w-24" />
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex w-64 shrink-0 gap-3 rounded-lg border border-border bg-surface p-3">
              <SkeletonBlock className="h-20 w-14 shrink-0" />
              <div className="min-w-0 flex-1 space-y-2 pt-1">
                <SkeletonBlock className="h-3.5 w-4/5" />
                <SkeletonBlock className="h-3 w-1/2" />
                <SkeletonBlock className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <SkeletonBlock className="mb-3 h-5 w-24" />
        <div className="space-y-2 rounded-lg border border-border bg-surface p-4">
          <SkeletonBlock className="h-3.5 w-2/3" />
          <SkeletonBlock className="h-3.5 w-1/2" />
        </div>
      </section>

      <section>
        <SkeletonBlock className="mb-3 h-5 w-36" />
        <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="space-y-1.5">
                <SkeletonBlock className="h-6 w-10" />
                <SkeletonBlock className="h-3 w-14" />
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
