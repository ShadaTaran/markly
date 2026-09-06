"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryItem } from "@/types/library-item";
import type { ReleaseEvent } from "@/types/release-event";
import { LatestRequestGuard } from "@/lib/latest-request-guard";
import { fetchAniListAiringSchedules, AniListCalendarRateLimitError } from "@/lib/integrations/anilist/calendar";
import { buildAniListMediaAssociation, normalizeAniListSchedules, sortReleaseEvents, type CalendarRangeDays } from "@/lib/release-calendar";

export type ReleaseCalendarErrorKind = "rate_limited" | "network_error";

export interface ReleaseCalendarError {
  kind: ReleaseCalendarErrorKind;
  message: string;
}

/**
 * Stage 33 — the ONE hook both /calendar and Dashboard's Upcoming section
 * use (§42: never two separate AniList-schedule implementations). Public,
 * unauthenticated AniList data — no userId/connection dependency at all,
 * so this works identically signed in or signed out (§43/§44), and never
 * touches the user's stored AniList access token.
 *
 * Guards against overlapping requests (a range change, a retry while a
 * prior fetch is still in flight, or a route remount/Strict Mode double
 * effect-invoke) with the same LatestRequestGuard AniListReconcilePanel
 * already uses — only the request that's still current when it resolves
 * is ever allowed to touch state (§31/§85).
 */
export function useReleaseCalendar(items: readonly LibraryItem[], rangeDays: CalendarRangeDays) {
  const [events, setEvents] = useState<ReleaseEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ReleaseCalendarError | null>(null);
  // True when `events` is real but the underlying fetch stopped before
  // every chunk/page could be retrieved (a per-chunk pagination cap or
  // the global request budget) — a correctness-review finding: this must
  // never be silently indistinguishable from "the calendar is genuinely
  // this size." See fetchAniListAiringSchedules's own doc comment.
  const [isPartial, setIsPartial] = useState(false);

  const guardRef = useRef<LatestRequestGuard | null>(null);
  if (guardRef.current === null) guardRef.current = new LatestRequestGuard();

  const load = useCallback(async () => {
    const guard = guardRef.current!;
    const token = guard.start();

    setIsLoading(true);
    setError(null);

    const association = buildAniListMediaAssociation(items);
    const mediaIds = [...association.keys()];

    if (mediaIds.length === 0) {
      if (guard.isCurrent(token)) {
        setEvents([]);
        setIsPartial(false);
        setIsLoading(false);
      }
      return;
    }

    const now = new Date();
    const nowMs = now.getTime();
    const rangeEndMs = nowMs + rangeDays * 24 * 60 * 60 * 1000;
    // A small buffer on both sides: the exact >/<=  boundary is enforced
    // by normalizeAniListSchedules itself (§83), never trusted to be
    // AniList's own airingAt_greater/airingAt_lesser semantics — this
    // over-fetches slightly rather than risk the server-side filter
    // silently excluding something at the edge.
    const fromEpochSeconds = Math.floor(nowMs / 1000) - 60;
    const toEpochSeconds = Math.ceil(rangeEndMs / 1000) + 60;

    try {
      const result = await fetchAniListAiringSchedules(mediaIds, fromEpochSeconds, toEpochSeconds, token.signal);
      if (!guard.isCurrent(token)) return;
      const normalized = normalizeAniListSchedules(result.schedules, association, { nowMs, rangeEndMs });
      setEvents(sortReleaseEvents(normalized));
      setIsPartial(result.isPartial);
      setIsLoading(false);
    } catch (err) {
      if (!guard.isCurrent(token)) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof AniListCalendarRateLimitError) {
        setError({ kind: "rate_limited", message: "AniList is rate-limiting schedule requests right now." });
      } else {
        setError({ kind: "network_error", message: "Couldn't load AniList schedules." });
      }
      setEvents([]);
      setIsPartial(false);
      setIsLoading(false);
    }
  }, [items, rangeDays]);

  useEffect(() => {
    const guard = guardRef.current!;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time (per items/rangeDays change) fetch from an external, unauthenticated public API; the result can't be derived at render time since it's a network round trip.
    void load();
    return () => guard.cancel();
  }, [load]);

  return { events, isLoading, error, isPartial, reload: load };
}
