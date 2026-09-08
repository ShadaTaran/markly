import Link from "next/link";
import type { WebsiteItem } from "@/types/library-item";
import { getDomain } from "@/lib/website";
import { getItemHref } from "@/lib/item-detail";
import { LibraryItemActions } from "@/components/LibraryItemActions";
import { IconButton } from "@/components/IconButton";
import { WebsiteFaviconThumb } from "@/components/WebsiteFaviconThumb";
import { StarIcon } from "@/components/icons";

interface WebsiteItemRowProps {
  item: WebsiteItem;
  onToggleFavorite: (id: string) => void;
  onEdit: (item: WebsiteItem) => void;
  onAddToCollection: (item: WebsiteItem) => void;
  onDeleteRequest: (item: WebsiteItem) => void;
}

/** List mode's website row — same data/handlers as Grid/Compact's website cards. */
export function WebsiteItemRow({ item, onToggleFavorite, onEdit, onAddToCollection, onDeleteRequest }: WebsiteItemRowProps) {
  const { title, url, category, favorite } = item;
  const domain = getDomain(url);

  return (
    <li className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-hover">
      <Link
        href={getItemHref(item)}
        aria-label={`View details for ${title}`}
        className="shrink-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <WebsiteFaviconThumb domain={domain} className="h-9 w-9" />
      </Link>

      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium leading-tight">
          <a href={url} target="_blank" rel="noopener noreferrer" className="outline-none hover:underline focus-visible:underline">
            {title}
          </a>
        </h3>
        <p className="truncate text-xs text-muted-foreground">
          {domain}
          {category && ` · ${category}`}
        </p>
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
          url={url}
          linkLabel="Open Website"
          onEdit={() => onEdit(item)}
          onAddToCollection={() => onAddToCollection(item)}
          onDeleteRequest={() => onDeleteRequest(item)}
        />
      </div>
    </li>
  );
}
