import { useEffect, useRef, useState } from "react";
import type { Bookmark } from "@/types/bookmark";
import { getDomain, getFaviconUrl } from "@/lib/utils";
import {
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  MoreHorizontalIcon,
  PencilIcon,
  StarIcon,
  TrashIcon,
} from "@/components/icons";

interface BookmarkCardProps {
  bookmark: Bookmark;
  onToggleFavorite: (id: string) => void;
}

export function BookmarkCard({ bookmark, onToggleFavorite }: BookmarkCardProps) {
  const { title, url, description, category, tags, favorite } = bookmark;
  const domain = getDomain(url);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access unavailable; no-op.
    }
    setMenuOpen(false);
  }

  return (
    <article className="group relative rounded-lg border border-border bg-surface p-4 transition-colors hover:border-foreground/25">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-background">
            {faviconFailed ? (
              <GlobeIcon width={16} height={16} className="text-muted-foreground" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
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
            aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:text-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 data-[favorite=true]:text-amber-500"
            data-favorite={favorite}
          >
            <StarIcon filled={favorite} />
          </button>

          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Bookmark actions"
              className="rounded p-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <MoreHorizontalIcon />
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-10 mt-1 w-40 overflow-hidden rounded-md border border-border bg-surface py-1 shadow-sm"
              >
                <a
                  role="menuitem"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-foreground hover:bg-background"
                >
                  <ExternalLinkIcon width={15} height={15} />
                  Open link
                </a>
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleCopyLink}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-background"
                >
                  <CopyIcon width={15} height={15} />
                  {copied ? "Copied!" : "Copy link"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-background"
                >
                  <PencilIcon width={15} height={15} />
                  Edit
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-500 hover:bg-background"
                >
                  <TrashIcon width={15} height={15} />
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">
        {description}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
          >
            {tag}
          </span>
        ))}
      </div>

      <div className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {category}
      </div>
    </article>
  );
}
