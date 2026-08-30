import { useEffect, useRef, useState } from "react";
import {
  CopyIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  TrashIcon,
} from "@/components/icons";

interface BookmarkActionsProps {
  url: string;
  onEdit: () => void;
  onDeleteRequest: () => void;
}

export function BookmarkActions({ url, onEdit, onDeleteRequest }: BookmarkActionsProps) {
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
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-foreground hover:bg-surface-hover"
          >
            <ExternalLinkIcon width={15} height={15} />
            Open link
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={handleCopyLink}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-surface-hover"
          >
            <CopyIcon width={15} height={15} />
            {copied ? "Copied!" : "Copy link"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onEdit();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-surface-hover"
          >
            <PencilIcon width={15} height={15} />
            Edit
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onDeleteRequest();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-danger hover:bg-surface-hover"
          >
            <TrashIcon width={15} height={15} />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
