/**
 * Item Detail currently rendered nothing at all while hydrating (just the
 * bare header) then popped in the full cover+identity+tracking layout in
 * one frame — the most abrupt of the app's loading transitions. This
 * mirrors that layout's actual shape closely enough to remove the blank
 * flash, without needing to be pixel-perfect.
 */
function SkeletonBlock({ className }: { className: string }) {
  return <div className={`rounded-md bg-surface-hover ${className}`} />;
}

export function ItemDetailSkeleton() {
  return (
    <div className="motion-safe:animate-pulse" role="status" aria-label="Loading item">
      <div className="flex flex-col gap-6 sm:flex-row">
        <SkeletonBlock className="aspect-[2/3] w-full max-w-[200px] shrink-0 sm:w-56 sm:max-w-[220px]" />
        <div className="min-w-0 flex-1 space-y-4">
          <div className="space-y-2">
            <SkeletonBlock className="h-3 w-24" />
            <SkeletonBlock className="h-6 w-3/4" />
          </div>
          <SkeletonBlock className="h-9 w-32" />
          <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
            <SkeletonBlock className="h-3 w-20" />
            <SkeletonBlock className="h-3.5 w-16" />
            <SkeletonBlock className="h-3.5 w-24" />
          </div>
        </div>
      </div>
    </div>
  );
}
