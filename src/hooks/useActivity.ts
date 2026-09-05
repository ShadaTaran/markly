"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityEvent, ActivityEventInput } from "@/types/activity";
import { generateId } from "@/lib/utils";
import { loadActivity, saveActivity, MAX_ACTIVITY_EVENTS } from "@/lib/activity-storage";
import { getSupabaseClient } from "@/lib/supabase/client";
import { deleteActivityEventsForItem, fetchActivityEvents, insertActivityEvent } from "@/lib/cloud/activity";

/**
 * Owns activity history: hydration, persistence, and logging. Signed out
 * (userId null/undefined), this is exactly the Stage 14 markly.activity
 * localStorage store, unchanged. Signed in, it hydrates from and persists
 * to Supabase's activity_events table instead — the local store is never
 * touched while signed in, and never read from again until sign-out.
 */
export function useActivity(userId?: string | null) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against a slow, now-stale hydration request (e.g. from just
  // before a sign-out) resolving after a newer one and clobbering it —
  // only the result whose token still matches the latest call is applied.
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
        const cloudEvents = await fetchActivityEvents(supabase, userId);
        if (hydrationToken.current === token) {
          setEvents(cloudEvents);
          setError(null);
        }
      } catch {
        if (hydrationToken.current === token) setError("Unable to load your activity history.");
      }
      if (hydrationToken.current === token) setIsHydrated(true);
      return;
    }

    const stored = loadActivity();
    if (hydrationToken.current === token) {
      if (stored) setEvents(stored);
      setIsHydrated(true);
    }
  }, [userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from an external store (localStorage or Supabase) whenever userId changes; the value can't be derived during render since both sources require an effect (localStorage isn't available at SSR/prerender time, and Supabase fetches are async).
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (userId || !isHydrated) return;
    saveActivity(events);
  }, [events, isHydrated, userId]);

  function logEvent(input: ActivityEventInput) {
    const id = generateId();
    const timestamp = new Date().toISOString();

    // Switch-narrowed reconstruction (rather than a generic spread) so
    // TypeScript verifies each branch actually produces a valid ActivityEvent
    // member, with no cast required.
    let event: ActivityEvent;
    switch (input.type) {
      case "progress_updated":
        event = { ...input, id, timestamp };
        break;
      case "rating_updated":
        event = { ...input, id, timestamp };
        break;
      case "status_updated":
        event = { ...input, id, timestamp };
        break;
      case "item_added":
        event = { ...input, id, timestamp };
        break;
    }

    setEvents((current) => {
      const next = [event, ...current];
      return next.length > MAX_ACTIVITY_EVENTS ? next.slice(0, MAX_ACTIVITY_EVENTS) : next;
    });

    if (userId) {
      const supabase = getSupabaseClient();
      if (supabase) {
        insertActivityEvent(supabase, event, userId).catch(() => {
          setError("Unable to save this update.");
          // Activity is append-only, so rolling back just means dropping
          // the one optimistic event that failed to persist.
          setEvents((current) => current.filter((existing) => existing.id !== event.id));
        });
      }
    }
  }

  function removeEventsForItem(itemId: string) {
    setEvents((current) => current.filter((event) => event.itemId !== itemId));

    if (userId) {
      const supabase = getSupabaseClient();
      if (supabase) {
        deleteActivityEventsForItem(supabase, itemId).catch(() => setError("Unable to save this update."));
      }
    }
  }

  function getEventsForItem(itemId: string): ActivityEvent[] {
    return events.filter((event) => event.itemId === itemId);
  }

  /**
   * Stage 27 — local mode only, the Activity-history half of the merge
   * orchestration (see useCollections.mergeItemReferences's identical
   * reasoning). Cloud mode never calls this: activity_events is
   * reassigned server-side, atomically, inside merge_library_items — the
   * caller reloads Activity from the server afterward instead. Every
   * event's historical value (type/progressKind/previousValue/newValue/
   * source) is preserved verbatim; only itemId changes.
   */
  function reassignEventsForItem(oldItemId: string, newItemId: string) {
    if (userId) return;
    setEvents((current) => current.map((event) => (event.itemId === oldItemId ? { ...event, itemId: newItemId } : event)));
  }

  /**
   * Stage 28 — local mode only: reinserts previously deleted events
   * verbatim (same id/timestamp/every field), used by delete-Undo. Never
   * synthesizes new "today" events — restoration must be exact, or the
   * history becomes a record of what Undo did instead of what actually
   * happened to the item.
   */
  function restoreEventsForItem(restored: ActivityEvent[]) {
    if (userId || restored.length === 0) return;
    setEvents((current) => {
      const next = [...restored, ...current];
      return next.length > MAX_ACTIVITY_EVENTS ? next.slice(0, MAX_ACTIVITY_EVENTS) : next;
    });
  }

  /**
   * Stage 28 — local mode only: moves back exactly the events that moved
   * during a merge (matched by id), used by merge-Undo. Deliberately more
   * precise than reassignEventsForItem's blanket "every event on this
   * item" — the survivor may have gained its own new events since the
   * merge, and those must stay put, not follow the duplicate back.
   */
  function restoreEventsForMerge(movedEventIds: string[], survivorId: string, duplicateId: string) {
    if (userId) return;
    const moved = new Set(movedEventIds);
    setEvents((current) =>
      current.map((event) => (moved.has(event.id) && event.itemId === survivorId ? { ...event, itemId: duplicateId } : event)),
    );
  }

  /**
   * Stage 29 — local mode only: replaces the entire events array in one
   * synchronous update, used by backup import. See
   * useLibraryItems.replaceAllLocal's doc comment. Does NOT itself enforce
   * MAX_ACTIVITY_EVENTS — the caller (apply-local.ts's
   * `applyImportPlanLocally`, via `computeLocalActivityRetention`) is
   * responsible for handing this an array already at or under capacity,
   * chronologically trimmed, BEFORE calling this. Relying on the
   * persistence effect's own blind `.slice(0, N)` to do that trimming
   * after the fact would silently drop whatever landed past position N
   * regardless of how recent it actually was, and would let the Import
   * Result UI report a restored count larger than what survives — exactly
   * the "restored then disappears" bug Stage 29 Part B fixed.
   */
  function replaceAllLocal(newEvents: ActivityEvent[]) {
    if (userId) return;
    setEvents(newEvents);
  }

  return {
    events,
    isHydrated,
    error,
    logEvent,
    removeEventsForItem,
    getEventsForItem,
    reassignEventsForItem,
    restoreEventsForItem,
    restoreEventsForMerge,
    replaceAllLocal,
    reload: hydrate,
  };
}
