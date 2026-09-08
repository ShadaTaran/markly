"use client";

import { useEffect, useState } from "react";

export const LIBRARY_VIEW_MODES = ["grid", "compact", "list"] as const;
export type LibraryViewMode = (typeof LIBRARY_VIEW_MODES)[number];

const STORAGE_KEY = "markly.library.viewMode";
const DEFAULT_VIEW_MODE: LibraryViewMode = "grid";

function isLibraryViewMode(value: unknown): value is LibraryViewMode {
  return typeof value === "string" && (LIBRARY_VIEW_MODES as readonly string[]).includes(value);
}

function readStoredViewMode(): LibraryViewMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isLibraryViewMode(stored) ? stored : DEFAULT_VIEW_MODE;
  } catch {
    return DEFAULT_VIEW_MODE;
  }
}

/**
 * A UI preference only (which Library presentation the user prefers), not
 * Stage 29 backup data — never touches the backup format, never synced to
 * the cloud. Malformed or unrecognized stored values (an old build's
 * removed mode, hand-edited storage, etc.) fall back to "grid" rather than
 * failing — the safe default named for existing users.
 */
export function useLibraryViewMode() {
  // Deterministic default matches server-rendered markup (localStorage
  // isn't available at SSR time); the effect below syncs in the real
  // stored value right after mount, same pattern as ThemeToggle.
  const [viewMode, setViewModeState] = useState<LibraryViewMode>(DEFAULT_VIEW_MODE);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from localStorage, unavailable at SSR time.
    setViewModeState(readStoredViewMode());
  }, []);

  function setViewMode(mode: LibraryViewMode) {
    setViewModeState(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Best-effort only — the preference just won't survive a reload.
    }
  }

  return { viewMode, setViewMode };
}
