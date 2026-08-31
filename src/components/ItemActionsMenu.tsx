"use client";

import { useEffect, useRef, useState } from "react";
import { MoreHorizontalIcon, PencilIcon, TrashIcon } from "@/components/icons";

interface ItemActionsMenuProps {
  /** Used to build the trigger's accessible name: `Actions for ${label}`. */
  label: string;
  editLabel?: string;
  deleteLabel?: string;
  onEdit: () => void;
  onDeleteRequest: () => void;
}

/**
 * Compact "•••" actions menu offering Edit + Delete. Shared by the
 * collection header and the item detail page's title row so both stay
 * visually and behaviorally consistent rather than each rolling its own
 * dropdown.
 */
export function ItemActionsMenu({
  label,
  editLabel = "Edit",
  deleteLabel = "Delete",
  onEdit,
  onDeleteRequest,
}: ItemActionsMenuProps) {
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
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Actions for ${label}`}
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
            {editLabel}
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
            {deleteLabel}
          </button>
        </div>
      )}
    </div>
  );
}
