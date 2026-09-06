"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SavedSmartView, SmartViewDefinition } from "@/types/smart-view";
import { generateId } from "@/lib/utils";
import { loadSmartViews, saveSmartViews } from "@/lib/smart-view-storage";
import { isDuplicateSmartViewName, validateSmartViewName } from "@/lib/smart-views";
import { getSupabaseClient } from "@/lib/supabase/client";
import { deleteSavedViewRow, fetchSavedViews, upsertSavedViewRow } from "@/lib/cloud/smart-views";

export type SaveSmartViewResult = { status: "ok"; view: SavedSmartView } | { status: "invalid_name"; reason: "empty" | "too_long" | "invalid" } | { status: "duplicate_name" } | { status: "error" };

/**
 * Owns user-saved Smart Views: hydration, persistence, and name-uniqueness
 * enforcement. Mirrors useCollections's exact local/cloud branching —
 * signed out, this is markly.smartViews localStorage, unchanged across
 * reloads; signed in, it hydrates from and persists to Supabase's
 * saved_library_views table (0015 migration) instead. Built-in Smart
 * Views (Continue, Recently Active, ...) are never stored here — see
 * lib/smart-views.ts's BUILT_IN_SMART_VIEWS (Stage 31 §21).
 */
export function useSmartViews(userId?: string | null) {
  const [views, setViews] = useState<SavedSmartView[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydrationToken = useRef(0);

  const hydrate = useCallback(async () => {
    const token = ++hydrationToken.current;
    setIsHydrated(false);

    if (userId) {
      const supabase = getSupabaseClient();
      if (!supabase) {
        if (hydrationToken.current === token) {
          setError("Cloud sync isn't configured for this deployment.");
          setIsHydrated(true);
        }
        return;
      }
      try {
        const cloudViews = await fetchSavedViews(supabase, userId);
        if (hydrationToken.current === token) {
          setViews(cloudViews);
          setError(null);
        }
      } catch {
        if (hydrationToken.current === token) setError("Unable to load your saved views.");
      }
      if (hydrationToken.current === token) setIsHydrated(true);
      return;
    }

    const stored = loadSmartViews();
    if (hydrationToken.current === token) {
      if (stored) setViews(stored);
      setIsHydrated(true);
    }
  }, [userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from an external store (localStorage or Supabase) whenever userId changes; can't be derived at render time since both sources require an effect.
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (userId || !isHydrated) return;
    saveSmartViews(views);
  }, [views, isHydrated, userId]);

  async function createView(name: string, definition: SmartViewDefinition): Promise<SaveSmartViewResult> {
    const validated = validateSmartViewName(name);
    if (!validated.ok) return { status: "invalid_name", reason: validated.reason };
    if (isDuplicateSmartViewName(validated.name, views)) return { status: "duplicate_name" };

    const newView: SavedSmartView = { id: generateId(), name: validated.name, definition, createdAt: new Date().toISOString() };

    if (userId) {
      const supabase = getSupabaseClient();
      if (!supabase) return { status: "error" };
      const result = await upsertSavedViewRow(supabase, newView, userId);
      if (result.status !== "ok") return result;
      await hydrate();
      return { status: "ok", view: newView };
    }

    setViews((current) => [...current, newView]);
    return { status: "ok", view: newView };
  }

  /** Used by "Update view" (definition change, same name) and by rename (name change, same definition) alike. */
  async function updateView(id: string, changes: { name?: string; definition?: SmartViewDefinition }): Promise<SaveSmartViewResult> {
    const target = views.find((view) => view.id === id);
    if (!target) return { status: "error" };

    let name = target.name;
    if (changes.name !== undefined) {
      const validated = validateSmartViewName(changes.name);
      if (!validated.ok) return { status: "invalid_name", reason: validated.reason };
      if (isDuplicateSmartViewName(validated.name, views, id)) return { status: "duplicate_name" };
      name = validated.name;
    }

    const updated: SavedSmartView = { ...target, name, definition: changes.definition ?? target.definition, updatedAt: new Date().toISOString() };

    if (userId) {
      const supabase = getSupabaseClient();
      if (!supabase) return { status: "error" };
      const result = await upsertSavedViewRow(supabase, updated, userId);
      if (result.status !== "ok") return result;
      await hydrate();
      return { status: "ok", view: updated };
    }

    setViews((current) => current.map((view) => (view.id === id ? updated : view)));
    return { status: "ok", view: updated };
  }

  function deleteView(id: string) {
    setViews((current) => current.filter((view) => view.id !== id));

    if (userId) {
      const supabase = getSupabaseClient();
      if (supabase) {
        deleteSavedViewRow(supabase, id).catch(() => {
          setError("Unable to save this update.");
          hydrate();
        });
      }
    }
  }

  return {
    views,
    isHydrated,
    error,
    createView,
    updateView,
    deleteView,
    reload: hydrate,
  };
}
