import { useState } from "react";
import type { MediaItem } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { cn } from "@/lib/utils";
import { LibraryItemActions } from "@/components/LibraryItemActions";
import { ItemTypeIcon } from "@/components/ItemTypeIcon";
import { StarIcon } from "@/components/icons";
import { getProgressInfo, getQuickIncrementInfo, getStatusLabel } from "@/lib/tracking";

interface MediaItemCardProps {
  item: MediaItem;
  activeTag: string | null;
  onToggleFavorite: (id: string) => void;
  onEdit: (item: MediaItem) => void;
  onDeleteRequest: (item: MediaItem) => void;
  onTagClick: (tag: string) => void;
  onQuickIncrement: (item: MediaItem) => void;
}

export function MediaItemCard({
  item,
  activeTag,
  onToggleFavorite,
  onEdit,
  onDeleteRequest,
  onTagClick,
  onQuickIncrement,
}: MediaItemCardProps) {
  const { title, description, category, tags, favorite, imageUrl, sourceUrl, type } = item;
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(imageUrl) && !imageFailed;
  const statusLabel = getStatusLabel(item);
  const progress = getProgressInfo(item);
  const quickIncrement = getQuickIncrementInfo(item);

  return (
    <article className="group relative rounded-lg border border-border bg-surface p-4 transition-colors hover:border-foreground/25">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-background">
            {showImage ? (
              // eslint-disable-next-line @next/next/no-img-element -- user-provided cover art from arbitrary hosts; next/image's optimizer isn't a good fit for this.
              <img
                src={imageUrl}
                alt={`${title} cover`}
                className="h-full w-full object-cover"
                onError={() => setImageFailed(true)}
              />
            ) : (
              <ItemTypeIcon
                type={type}
                width={18}
                height={18}
                className="text-muted-foreground"
                aria-hidden="true"
              />
            )}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium leading-tight">{title}</h3>
            <p className="truncate text-xs text-muted-foreground">
              {item.releaseYear ? `${ITEM_TYPE_LABELS[type]} • ${item.releaseYear}` : ITEM_TYPE_LABELS[type]}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => onToggleFavorite(item.id)}
            aria-pressed={favorite}
            aria-label={favorite ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:text-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 data-[favorite=true]:text-amber-500"
            data-favorite={favorite}
          >
            <StarIcon filled={favorite} />
          </button>

          <LibraryItemActions
            url={sourceUrl}
            linkLabel="Open Source"
            onEdit={() => onEdit(item)}
            onDeleteRequest={() => onDeleteRequest(item)}
          />
        </div>
      </div>

      {description && (
        <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{description}</p>
      )}

      {tags.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {tags.map((tag) => {
            const isActive = activeTag?.toLowerCase() === tag.toLowerCase();
            return (
              <button
                key={tag}
                type="button"
                onClick={() => onTagClick(tag)}
                aria-pressed={isActive}
                aria-label={`Filter by tag ${tag}`}
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                  isActive
                    ? "border-foreground/60 text-foreground"
                    : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
                )}
              >
                {tag}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium text-foreground">{statusLabel}</p>
          {quickIncrement && !quickIncrement.atMax && (
            <button
              type="button"
              onClick={() => onQuickIncrement(item)}
              aria-label={`Increment ${title} ${quickIncrement.unitLabel} progress`}
              className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              +1
            </button>
          )}
        </div>

        {progress && (
          <div>
            <p className="text-xs text-muted-foreground">{progress.text}</p>
            {progress.percent !== undefined && (
              <div
                role="img"
                aria-label={`${Math.round(progress.percent)}% complete`}
                className="mt-1 h-1 w-full overflow-hidden rounded-full bg-border"
              >
                <div
                  className="h-full rounded-full bg-foreground/50"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            )}
          </div>
        )}

        {item.rating !== undefined && (
          <p className="text-xs text-muted-foreground">{item.rating} / 10</p>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        <span className="truncate">{category}</span>
        {item.type === "game" && (item.developer || item.platform) && (
          <span className="shrink-0 truncate">{item.developer || item.platform}</span>
        )}
      </div>
    </article>
  );
}
