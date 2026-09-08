import Link from "next/link";
import type { MediaItem } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { cn } from "@/lib/utils";
import { LibraryItemActions } from "@/components/LibraryItemActions";
import { IconButton } from "@/components/IconButton";
import { LibraryCoverThumb } from "@/components/LibraryCoverThumb";
import { StarIcon } from "@/components/icons";
import { getProgressInfo, getStatusLabel } from "@/lib/tracking";
import { getItemHref } from "@/lib/item-detail";
import { LIBRARY_COMPACT_CARD_HEIGHT_CLASS } from "@/lib/library-grid-constants";

interface MediaItemCompactCardProps {
  item: MediaItem;
  onToggleFavorite: (id: string) => void;
  onEdit: (item: MediaItem) => void;
  onAddToCollection: (item: MediaItem) => void;
  onDeleteRequest: (item: MediaItem) => void;
}

/** Compact mode's media card — same identity/state data as Grid's card (getProgressInfo/getStatusLabel, same handlers), just denser: no tags, no rating, smaller artwork, one metadata line. */
export function MediaItemCompactCard({ item, onToggleFavorite, onEdit, onAddToCollection, onDeleteRequest }: MediaItemCompactCardProps) {
  const { title, favorite, imageUrl, sourceUrl, type } = item;
  const statusLabel = getStatusLabel(item);
  const progress = getProgressInfo(item);

  return (
    <article
      className={cn(
        "flex items-center gap-2.5 overflow-hidden rounded-md border border-border bg-surface p-2.5 transition-colors hover:border-foreground/25",
        LIBRARY_COMPACT_CARD_HEIGHT_CLASS,
      )}
    >
      <Link
        href={getItemHref(item)}
        aria-label={`View details for ${title}`}
        className="shrink-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <LibraryCoverThumb imageUrl={imageUrl} type={type} className="h-14 w-10" iconSize={16} />
      </Link>

      <div className="min-w-0 flex-1">
        <h3 className="truncate text-xs font-medium leading-tight">
          <Link href={getItemHref(item)} className="outline-none hover:underline focus-visible:underline">
            {title}
          </Link>
        </h3>
        <p className="truncate text-[11px] text-muted-foreground">
          {ITEM_TYPE_LABELS[type]} · {statusLabel}
        </p>
        {progress && <p className="truncate text-[11px] text-muted-foreground">{progress.text}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton
          onClick={() => onToggleFavorite(item.id)}
          aria-pressed={favorite}
          aria-label={favorite ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
          active={favorite}
          icon={<StarIcon filled={favorite} width={14} height={14} />}
        />
        <LibraryItemActions
          url={sourceUrl}
          linkLabel="Open Source"
          onEdit={() => onEdit(item)}
          onAddToCollection={() => onAddToCollection(item)}
          onDeleteRequest={() => onDeleteRequest(item)}
        />
      </div>
    </article>
  );
}
