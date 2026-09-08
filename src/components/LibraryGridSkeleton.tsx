/**
 * UI/UX quality pass — the Library grid is the highest-traffic,
 * most content-shaped surface in the app, so it's the one place a
 * layout-preserving skeleton earns its keep (§21 "skeletons sparingly" —
 * every other loading state in the app stays a plain, short message,
 * deliberately not converted). `motion-safe:` (a standard Tailwind
 * variant, not custom CSS) means the pulse itself respects
 * prefers-reduced-motion; without it the cards just render static, still
 * fully layout-preserving.
 */
export function LibraryGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading your library">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="motion-safe:animate-pulse rounded-lg border border-border bg-surface p-4">
          <div className="flex items-start gap-3">
            <div className="h-16 w-12 shrink-0 rounded-md bg-surface-hover" />
            <div className="min-w-0 flex-1 space-y-2 pt-1">
              <div className="h-3.5 w-3/4 rounded bg-surface-hover" />
              <div className="h-3 w-1/2 rounded bg-surface-hover" />
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <div className="h-3 w-full rounded bg-surface-hover" />
            <div className="h-3 w-5/6 rounded bg-surface-hover" />
          </div>
        </div>
      ))}
    </div>
  );
}
