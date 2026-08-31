import type { ActivityEvent } from "@/types/activity";
import type { LibraryItem } from "@/types/library-item";
import { getActivityDetail, getActivityLabel, formatRelativeTime } from "@/lib/activity-format";

interface ItemActivitySectionProps {
  /** Already filtered to this item, newest first. */
  events: ActivityEvent[];
  item: LibraryItem;
}

const MAX_DISPLAYED = 8;

export function ItemActivitySection({ events, item }: ItemActivitySectionProps) {
  const visible = events.slice(0, MAX_DISPLAYED);

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Recent Activity
      </h2>
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {visible.map((event) => {
            const label = getActivityLabel(event, item);
            const detail = getActivityDetail(event, item);
            return (
              <li key={event.id} className="py-1.5 first:pt-0 last:pb-0">
                {label && <p className="text-xs text-muted-foreground">{label}</p>}
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-sm text-foreground">{detail}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(event.timestamp)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
