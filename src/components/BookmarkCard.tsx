import { useState } from "react";
import type { Bookmark } from "@/types/bookmark";
import { cn, getDomain, getFaviconUrl } from "@/lib/utils";
import { BookmarkActions } from "@/components/BookmarkActions";
import { GlobeIcon, StarIcon } from "@/components/icons";

interface BookmarkCardProps {
  bookmark: Bookmark;
  activeTag: string | null;
  onToggleFavorite: (id: string) => void;
  onEdit: (bookmark: Bookmark) => void;
  onDeleteRequest: (bookmark: Bookmark) => void;
  onTagClick: (tag: string) => void;
}

export function BookmarkCard({
  bookmark,
  activeTag,
  onToggleFavorite,
  onEdit,
  onDeleteRequest,
  onTagClick,
}: BookmarkCardProps) {
  const { title, url, description, category, tags, favorite } = bookmark;
  const domain = getDomain(url);
  const [faviconFailed, setFaviconFailed] = useState(false);

  return (
    <article className="group relative rounded-lg border border-border bg-surface p-4 transition-colors hover:border-foreground/25">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-background">
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
          </span>
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
            onClick={() => onToggleFavorite(bookmark.id)}
            aria-pressed={favorite}
            aria-label={favorite ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:text-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 data-[favorite=true]:text-amber-500"
            data-favorite={favorite}
          >
            <StarIcon filled={favorite} />
          </button>

          <BookmarkActions
            url={url}
            onEdit={() => onEdit(bookmark)}
            onDeleteRequest={() => onDeleteRequest(bookmark)}
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
