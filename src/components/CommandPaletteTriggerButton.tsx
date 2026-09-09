"use client";

import { useEffect, useState } from "react";
import { useCommandPalette } from "@/components/CommandPaletteProvider";
import { SearchIcon } from "@/components/icons";

/**
 * Stage 36 §2 — the Header's search affordance. This is deliberately a
 * NEW, separate control from LibraryView's existing inline SearchBar
 * (which filters the items already visible on the Library page in place
 * — that stays exactly as it is, on Library only). This button is the
 * one global entry point present on every page, and — together with
 * Ctrl/Cmd+K — the two ways to reach the same single Command Palette
 * instance (see CommandPaletteProvider).
 */
export function CommandPaletteTriggerButton() {
  const { open } = useCommandPalette();
  const [shortcutLabel, setShortcutLabel] = useState("Ctrl K");

  useEffect(() => {
    // Client-only platform check (navigator isn't available at SSR time) —
    // the SSR-safe default above renders fine either way until this runs.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync of a platform-dependent label, unavailable at SSR time (same pattern as ThemeToggle/useLibraryViewMode).
    if (/Mac|iPhone|iPod|iPad/.test(navigator.platform)) setShortcutLabel("⌘K");
  }, []);

  return (
    <button
      type="button"
      onClick={open}
      aria-label="Search Markly"
      title="Search Markly"
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <SearchIcon width={15} height={15} aria-hidden="true" />
      <span className="hidden sm:inline">Search</span>
      <kbd className="hidden rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
        {shortcutLabel}
      </kbd>
    </button>
  );
}
