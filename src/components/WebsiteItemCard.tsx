import { useState } from "react";
import Link from "next/link";
import type { WebsiteItem } from "@/types/library-item";
import { cn } from "@/lib/utils";
import { getDomain, getFaviconUrl } from "@/lib/website";
import { getItemHref } from "@/lib/item-detail";
import { LibraryItemActions } from "@/components/LibraryItemActions";
import { GlobeIcon, StarIcon } from "@/components/icons";

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
  const { title, url, description, category, tags, favorite } = item;
  const domain = getDomain(url);
  const [faviconFailed, setFaviconFailed] = useState(false);

  return (
    <article className="group relative rounded-lg border border-border bg-surface p-4 transition-colors hover:border-foreground/25">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <Link
            href={getItemHref(item)}
            aria-label={`View details for ${title}`}
            className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-background transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {faviconFailed ? (
              <GlobeIcon width={16} height={16} className="text-muted-foreground" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- favicons are third-party, per-domain images; next/image's optimizer isn't a good fit here.
              <img
                src={getFaviconUrl(domain)}
                alt=""
                width={18}
                height={18}
                onError={() => setFaviconFailed(true)}
              />
            )}
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
            url={url}
            linkLabel="Open Website"
            onEdit={() => onEdit(item)}
            onAddToCollection={() => onAddToCollection(item)}
            onDeleteRequest={() => onDeleteRequest(item)}
          />
        </div>
      </div>

      <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">
        {description}
      </p>

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

      <div className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {category}
      </div>
    </article>
  );
}
