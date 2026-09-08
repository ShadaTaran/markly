import Link from "next/link";
import type { MediaItem } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { LibraryItemActions } from "@/components/LibraryItemActions";
import { IconButton } from "@/components/IconButton";
import { LibraryCoverThumb } from "@/components/LibraryCoverThumb";
import { ProgressBar } from "@/components/ProgressBar";
import { StarIcon } from "@/components/icons";
import { getProgressInfo, getStatusLabel } from "@/lib/tracking";
import { getItemHref } from "@/lib/item-detail";

interface MediaItemRowProps {
  item: MediaItem;
  onToggleFavorite: (id: string) => void;
  onEdit: (item: MediaItem) => void;
  onAddToCollection: (item: MediaItem) => void;
  onDeleteRequest: (item: MediaItem) => void;
}

/** List mode's media row — same identity/state data as Grid/Compact (getProgressInfo/getStatusLabel, same handlers); the strongest scanning hierarchy of the three modes, one row per item, no card-inside-card. */
export function MediaItemRow({ item, onToggleFavorite, onEdit, onAddToCollection, onDeleteRequest }: MediaItemRowProps) {
  const { title, favorite, imageUrl, sourceUrl, type } = item;
  const statusLabel = getStatusLabel(item);
  const progress = getProgressInfo(item);

  return (
    <li className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-hover">
      <Link
        href={getItemHref(item)}
        aria-label={`View details for ${title}`}
        className="shrink-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <LibraryCoverThumb imageUrl={imageUrl} type={type} className="h-12 w-9" iconSize={15} />
      </Link>

      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium leading-tight">
          <Link href={getItemHref(item)} className="outline-none hover:underline focus-visible:underline">
            {title}
          </Link>
        </h3>
        <p className="truncate text-xs text-muted-foreground">
          {ITEM_TYPE_LABELS[type]} · {statusLabel}
          {progress && ` · ${progress.text}`}
        </p>
        {progress?.percent !== undefined && <ProgressBar percent={progress.percent} className="mt-1 max-w-40" />}
      </div>

      {item.rating !== undefined && (
        <span className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
          <StarIcon width={10} height={10} filled className="text-muted-foreground/70" aria-hidden="true" />
          {item.rating} / 10
        </span>
      )}

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
    </li>
  );
}
