import type { MediaItem } from "@/types/library-item";
import { getProgressInfo, getStatusLabel } from "@/lib/tracking";
import { ProgressBar } from "@/components/ProgressBar";

interface ItemTrackingSectionProps {
  item: MediaItem;
}

export function ItemTrackingSection({ item }: ItemTrackingSectionProps) {
  const statusLabel = getStatusLabel(item);
  const progress = getProgressInfo(item);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Your Tracking
      </p>
      <dl className="space-y-3">
        <div>
          <dt className="text-xs text-muted-foreground">Status</dt>
          <dd className="text-sm font-medium text-foreground">{statusLabel}</dd>
        </div>

        {progress && (
          <div>
            <dt className="text-xs text-muted-foreground">Progress</dt>
            <dd className="text-sm font-medium text-foreground">{progress.text}</dd>
            {progress.percent !== undefined && <ProgressBar percent={progress.percent} className="mt-1.5" />}
          </div>
        )}

        <div>
          <dt className="text-xs text-muted-foreground">Your Rating</dt>
          <dd className="text-sm font-medium text-foreground">
            {item.rating !== undefined ? `${item.rating} / 10` : "Unrated"}
          </dd>
        </div>
      </dl>
    </div>
  );
}
