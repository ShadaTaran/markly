"use client";

import { useEffect, useRef, useState } from "react";
import type { Collection } from "@/types/collection";
import { MoreHorizontalIcon, PencilIcon, TrashIcon } from "@/components/icons";

interface CollectionHeaderProps {
  collection: Collection;
  itemCount: number;
  onEdit: () => void;
  onDeleteRequest: () => void;
}

export function CollectionHeader({ collection, itemCount, onEdit, onDeleteRequest }: CollectionHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
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

  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold text-foreground">{collection.name}</h2>
          <span className="shrink-0 text-xs text-muted-foreground">
            {itemCount} item{itemCount === 1 ? "" : "s"}
          </span>
        </div>
        {collection.description && (
          <p className="mt-1 truncate text-xs text-muted-foreground">{collection.description}</p>
        )}
      </div>

      <div className="relative shrink-0" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Actions for ${collection.name}`}
          className="rounded p-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <MoreHorizontalIcon />
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-10 mt-1 w-40 overflow-hidden rounded-md border border-border bg-surface py-1 shadow-sm"
          >
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
    </div>
  );
}
