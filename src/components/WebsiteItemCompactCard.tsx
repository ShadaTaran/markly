import Link from "next/link";
import type { WebsiteItem } from "@/types/library-item";
import { cn } from "@/lib/utils";
import { getDomain } from "@/lib/website";
import { getItemHref } from "@/lib/item-detail";
import { LibraryItemActions } from "@/components/LibraryItemActions";
import { IconButton } from "@/components/IconButton";
import { WebsiteFaviconThumb } from "@/components/WebsiteFaviconThumb";
import { StarIcon } from "@/components/icons";
import { LIBRARY_COMPACT_CARD_HEIGHT_CLASS } from "@/lib/library-grid-constants";

interface WebsiteItemCompactCardProps {
  item: WebsiteItem;
  onToggleFavorite: (id: string) => void;
  onEdit: (item: WebsiteItem) => void;
  onAddToCollection: (item: WebsiteItem) => void;
  onDeleteRequest: (item: WebsiteItem) => void;
}

/** Compact mode's website card — same data/handlers as Grid's WebsiteItemCard, denser: no description, no tags. */
export function WebsiteItemCompactCard({ item, onToggleFavorite, onEdit, onAddToCollection, onDeleteRequest }: WebsiteItemCompactCardProps) {
  const { title, url, favorite } = item;
  const domain = getDomain(url);

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
        <WebsiteFaviconThumb domain={domain} className="h-7 w-7" iconSize={14} />
      </Link>

      <div className="min-w-0 flex-1">
        <h3 className="truncate text-xs font-medium leading-tight">
          <a href={url} target="_blank" rel="noopener noreferrer" className="outline-none hover:underline focus-visible:underline">
            {title}
          </a>
        </h3>
        <p className="truncate text-[11px] text-muted-foreground">{domain}</p>
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
          url={url}
          linkLabel="Open Website"
          onEdit={() => onEdit(item)}
          onAddToCollection={() => onAddToCollection(item)}
          onDeleteRequest={() => onDeleteRequest(item)}
        />
      </div>
    </article>
  );
}
