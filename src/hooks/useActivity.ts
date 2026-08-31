"use client";

import { useEffect, useState } from "react";
import type { ActivityEvent, ActivityEventInput } from "@/types/activity";
import { generateId } from "@/lib/utils";
import { loadActivity, saveActivity, MAX_ACTIVITY_EVENTS } from "@/lib/activity-storage";

/**
 * Owns the markly.activity store: hydration, persistence, and logging.
 * Independent of useLibraryItems/useCollections — activity only ever
 * references items by id, so it has no dependency on the library store
 * (and avoids a circular dependency, since useLibraryItems takes this
 * hook's logEvent as an optional callback to record tracking changes).
 */
export function useActivity() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    const stored = loadActivity();
    if (stored) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from an external store (localStorage) on mount; the value cannot be derived during render because it isn't available at SSR/prerender time.
      setEvents(stored);
    }
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    saveActivity(events);
  }, [events, isHydrated]);

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
  }

  function removeEventsForItem(itemId: string) {
    setEvents((current) => current.filter((event) => event.itemId !== itemId));
  }

  function getEventsForItem(itemId: string): ActivityEvent[] {
    return events.filter((event) => event.itemId === itemId);
  }

  return { events, isHydrated, logEvent, removeEventsForItem, getEventsForItem };
}
