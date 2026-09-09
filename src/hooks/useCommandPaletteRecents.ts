"use client";

import { useEffect, useState } from "react";
import type { LibraryItem } from "@/types/library-item";

/**
 * Stage 36 — the Command Palette's own "recently opened" history. This is
 * deliberately separate from Stage 31's Recently Active (qualifying
 * Activity) — palette recent means "opened through the palette," nothing
 * about tracking activity. Local-only presentation history: never synced
 * to the cloud, never part of the Stage 29 backup format, never sent
 * anywhere. Stores ids only, never titles or any other item data — the id
 * is resolved against the CURRENT authoritative library at render time
 * (see resolveRecentItems), which is also what makes an account switch
 * safe: a different account's library simply won't contain the old ids,
 * so nothing from the previous account is ever shown.
 */

const STORAGE_KEY = "markly.commandPalette";
const STORAGE_VERSION = 1;
const MAX_RECENTS = 8;

interface RecentsStorageShape {
  version: number;
  recentItemIds: string[];
}

function isRecentsStorageShape(value: unknown): value is RecentsStorageShape {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === STORAGE_VERSION &&
    Array.isArray(candidate.recentItemIds) &&
    candidate.recentItemIds.every((id) => typeof id === "string")
  );
}

function readRecentIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return isRecentsStorageShape(parsed) ? parsed.recentItemIds.slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

function persistRecentIds(ids: string[]): void {
  try {
    const shape: RecentsStorageShape = { version: STORAGE_VERSION, recentItemIds: ids.slice(0, MAX_RECENTS) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
  } catch {
    // Best-effort only — worst case recent history doesn't survive a reload.
  }
}

/** Moves `id` to the front, de-duplicating rather than allowing a second entry (Stage 36 §58/§79). */
function withRecordedId(current: string[], id: string): string[] {
  return [id, ...current.filter((existing) => existing !== id)].slice(0, MAX_RECENTS);
}

export function useCommandPaletteRecents() {
  const [recentIds, setRecentIds] = useState<string[]>([]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from localStorage, unavailable at SSR time.
    setRecentIds(readRecentIds());
  }, []);

  function recordOpened(id: string) {
    setRecentIds((current) => {
      const next = withRecordedId(current, id);
      persistRecentIds(next);
      return next;
    });
  }

  return { recentIds, recordOpened };
}

/**
 * Resolves stored ids against the CURRENT authoritative library — an
 * unknown/deleted id (or one belonging to a different signed-in account
 * entirely) is silently filtered out, never rendered as a broken entry
 * and never a reason to show stale/leaked information (Stage 36 §72).
 * Preserves recency order (most-recently-opened first).
 */
export function resolveRecentItems(recentIds: string[], items: LibraryItem[]): LibraryItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const resolved: LibraryItem[] = [];
  for (const id of recentIds) {
    const item = byId.get(id);
    if (item) resolved.push(item);
  }
  return resolved;
}
