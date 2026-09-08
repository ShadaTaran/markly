import Link from "next/link";
import type { WebsiteItem } from "@/types/library-item";
import { cn } from "@/lib/utils";
import { getDomain } from "@/lib/website";
import { getItemHref } from "@/lib/item-detail";
import { LibraryItemActions } from "@/components/LibraryItemActions";
import { IconButton } from "@/components/IconButton";
import { WebsiteFaviconThumb } from "@/components/WebsiteFaviconThumb";
import { StarIcon } from "@/components/icons";
import { LIBRARY_GRID_CARD_HEIGHT_CLASS } from "@/lib/library-grid-constants";

interface WebsiteItemCardProps {
  item: WebsiteItem;
  activeTag: string | null;
  onToggleFavorite: (id: string) => void;
  onEdit: (item: WebsiteItem) => void;
  onAddToCollection: (item: WebsiteItem) => void;
  onDeleteRequest: (item: WebsiteItem) => void;
  onTagClick: (tag: string) => void;
}

export function WebsiteItemCard({
  item,
  activeTag,
  onToggleFavorite,
  onEdit,
  onAddToCollection,
  onDeleteRequest,
  onTagClick,
}: WebsiteItemCardProps) {
  const { title, url, category, tags, favorite } = item;
  const domain = getDomain(url);

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
            className="mt-0.5 shrink-0 rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <WebsiteFaviconThumb domain={domain} className="h-8 w-8" />
          </Link>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium leading-tight">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="outline-none hover:underline focus-visible:underline"
              >
                {title}
              </a>
            </h3>
            <p className="truncate text-xs text-muted-foreground">{domain}</p>
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
            url={url}
            linkLabel="Open Website"
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

        {category && <div className="mt-auto pt-2 text-[11px] text-muted-foreground/70">{category}</div>}
      </div>
    </article>
  );
}
