import Link from "next/link";
import type { MediaItem } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { cn } from "@/lib/utils";
import { LibraryItemActions } from "@/components/LibraryItemActions";
import { IconButton } from "@/components/IconButton";
import { LibraryCoverThumb } from "@/components/LibraryCoverThumb";
import { ProgressBar } from "@/components/ProgressBar";
import { StarIcon } from "@/components/icons";
import { getProgressInfo, getQuickIncrementInfo, getStatusLabel } from "@/lib/tracking";
import { getItemHref } from "@/lib/item-detail";
import { LIBRARY_GRID_CARD_HEIGHT_CLASS } from "@/lib/library-grid-constants";

interface MediaItemCardProps {
  item: MediaItem;
  activeTag: string | null;
  onToggleFavorite: (id: string) => void;
  onEdit: (item: MediaItem) => void;
  onAddToCollection: (item: MediaItem) => void;
  onDeleteRequest: (item: MediaItem) => void;
  onTagClick: (tag: string) => void;
  onQuickIncrement: (item: MediaItem) => void;
}

/** Grid mode's media card — the "same component family" composition: identity, then state/progress, then a footer pinned to the bottom via flex so sparse and rich cards align without inventing placeholder content. */
export function MediaItemCard({
  item,
  activeTag,
  onToggleFavorite,
  onEdit,
  onAddToCollection,
  onDeleteRequest,
  onTagClick,
  onQuickIncrement,
}: MediaItemCardProps) {
  const { title, category, tags, favorite, imageUrl, sourceUrl, type } = item;
  const statusLabel = getStatusLabel(item);
  const progress = getProgressInfo(item);
  const quickIncrement = getQuickIncrementInfo(item);

  // Library cards are for scanning, not full information (Item Detail is
  // for that) — a very small number of tags, only if they'd genuinely help
  // scanning, plus the currently-active filter tag even if it would
  // otherwise be cut.
  const TAG_DISPLAY_LIMIT = 3;
  const activeTagLower = activeTag?.toLowerCase();
  const orderedTags =
    activeTagLower && tags.some((tag) => tag.toLowerCase() === activeTagLower)
      ? [tags.find((tag) => tag.toLowerCase() === activeTagLower)!, ...tags.filter((tag) => tag.toLowerCase() !== activeTagLower)]
      : tags;
  const visibleTags = orderedTags.slice(0, TAG_DISPLAY_LIMIT);
  const hiddenTagCount = orderedTags.length - visibleTags.length;

  return (
    <article
      className={cn(
        "group flex flex-col overflow-hidden rounded-lg border border-border bg-surface p-4 transition-colors hover:border-foreground/25",
        LIBRARY_GRID_CARD_HEIGHT_CLASS,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <Link
            href={getItemHref(item)}
            aria-label={`View details for ${title}`}
            className="shrink-0 rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <LibraryCoverThumb imageUrl={imageUrl} type={type} className="h-24 w-16" iconSize={22} />
          </Link>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium leading-tight">
              <Link href={getItemHref(item)} className="outline-none hover:underline focus-visible:underline">
                {title}
              </Link>
            </h3>
            <p className="truncate text-xs text-muted-foreground">
              {item.releaseYear ? `${ITEM_TYPE_LABELS[type]} • ${item.releaseYear}` : ITEM_TYPE_LABELS[type]}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            onClick={() => onToggleFavorite(item.id)}
            aria-pressed={favorite}
            aria-label={favorite ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
            active={favorite}
            icon={<StarIcon filled={favorite} />}
          />

          <LibraryItemActions
            url={sourceUrl}
            linkLabel="Open Source"
            onEdit={() => onEdit(item)}
            onAddToCollection={() => onAddToCollection(item)}
            onDeleteRequest={() => onDeleteRequest(item)}
          />
        </div>
      </div>

      <div className="flex flex-1 flex-col">
        {tags.length > 0 && (
          <div className="mt-3 flex h-6 items-center gap-1.5 overflow-hidden">
            {visibleTags.map((tag) => {
              const isActive = activeTag?.toLowerCase() === tag.toLowerCase();
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => onTagClick(tag)}
                  aria-pressed={isActive}
                  aria-label={`Filter by tag ${tag}`}
                  className={cn(
                    "shrink-0 truncate rounded border px-1.5 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                    isActive
                      ? "border-foreground/60 text-foreground"
                      : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
                  )}
                >
                  {tag}
                </button>
              );
            })}
            {hiddenTagCount > 0 && <span className="shrink-0 text-[11px] text-muted-foreground/70">+{hiddenTagCount}</span>}
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
              {progress.percent !== undefined && <ProgressBar percent={progress.percent} className="mt-1" />}
            </div>
          )}

          {item.rating !== undefined && <p className="text-xs text-muted-foreground">{item.rating} / 10</p>}
        </div>

        <div className="mt-auto flex items-center justify-between gap-2 pt-2 text-[11px] text-muted-foreground/70">
          <span className="truncate">{category}</span>
          {item.type === "game" && (item.developer || item.platform) && (
            <span className="shrink-0 truncate">{item.developer || item.platform}</span>
          )}
        </div>
      </div>
    </article>
  );
}
