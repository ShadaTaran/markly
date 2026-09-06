"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TrackingSourceSummary } from "@/lib/extension/types";

/**
 * Stage 32 — every TrackingSource the current user owns, fetched once (not
 * per-item — see Dashboard's Continue section, which needs an
 * itemId -> candidate sources lookup for potentially many cards at once
 * and must never do that as one query per card). Local (signed-out) mode
 * has no TrackingSources at all: Stage 18's device-pairing/extension-
 * tracking model is cloud-only, so this resolves to an empty, hydrated
 * list immediately rather than attempting a request that could never
 * succeed.
 *
 * Reuses the existing `GET /api/tracking-sources` route (no
 * `libraryItemId` query param, so it returns every source) — the same
 * endpoint /settings/tracking's server-rendered page already calls
 * server-side via listSources; this is simply the client-side path for a
 * client component. RLS on tracking_sources remains the actual
 * authority — this route does nothing more than run the session-scoped
 * query and return it.
 */
export function useTrackingSources(userId: string | null | undefined) {
  const [sources, setSources] = useState<TrackingSourceSummary[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydrationToken = useRef(0);

  const hydrate = useCallback(async () => {
    if (!userId) {
      setSources([]);
      setError(null);
      setIsHydrated(true);
      return;
    }

    const token = ++hydrationToken.current;
    setIsHydrated(false);
    try {
      const response = await fetch("/api/tracking-sources");
      if (!response.ok) throw new Error("request failed");
      const body: unknown = await response.json();
      const rows = body && typeof body === "object" && Array.isArray((body as { sources?: unknown }).sources)
        ? ((body as { sources: TrackingSourceSummary[] }).sources)
        : [];
      if (hydrationToken.current === token) {
        setSources(rows);
        setError(null);
      }
    } catch {
      // A failed source fetch must never take down the rest of the
      // Dashboard (§44) — callers fall back to resolveResumeTarget's
      // internal-link behavior when `sources` stays empty.
      if (hydrationToken.current === token) setError("Unable to load tracking sources.");
    }
    if (hydrationToken.current === token) setIsHydrated(true);
  }, [userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time fetch from an external store (a network round trip in cloud mode, a trivial empty result in local mode) whenever userId changes; can't be derived at render time since both paths require an effect.
    hydrate();
  }, [hydrate]);

  return { sources, isHydrated, error, reload: hydrate };
}
