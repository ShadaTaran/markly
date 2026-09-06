"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityEvent } from "@/types/activity";
import { mergeActivityIntoSummary, mergeSummaryEntry, recomputeSummaryForItems, restoreSummaryEntries, type ActivitySummary } from "@/lib/smart-views";
import { loadActivitySummary, saveActivitySummary } from "@/lib/activity-summary-storage";
import { getSupabaseClient } from "@/lib/supabase/client";
import { fetchActivitySummary } from "@/lib/cloud/activity-summary";

/**
 * Stage 31 — item_id -> latest qualifying-activity timestamp, for Smart
 * View filtering/sorting.
 *
 * Cloud mode: markly.activity's own fetch is capped at 500 rows against a
 * potentially much larger account history, so this calls the
 * get_library_activity_summary RPC (0015 migration) instead of reusing
 * that capped list — an aggregate over the ENTIRE server-side history.
 *
 * Local mode: markly.activity is ALSO capped at 500 events (a rolling
 * window, not a display slice of something larger — a prior version of
 * this comment incorrectly claimed otherwise). Deriving the summary purely
 * from `localEvents` on every render would make an item's last-activity
 * silently disappear the moment its qualifying event ages out of that
 * window — exactly the "infer from a truncated latest-500 list" failure
 * Stage 31 was built to avoid for cloud, and a real (if less obvious)
 * local-mode gap. This hook instead maintains a SEPARATE, durable
 * markly.activitySummary store (activity-summary-storage.ts) that only
 * ever advances — see lib/smart-views.ts's mergeActivityIntoSummary — so
 * an item's last-activity survives long after the event that produced it
 * has been trimmed from the detailed log. `mergeInto`/`restoreForMerge`/
 * `mergeEvents` are the explicit, imperative surface Stage 27
 * merge/merge-undo and Stage 29 import use to update it precisely (see
 * lib/recovery-orchestration.ts and BackupSettingsPanel.tsx) — the
 * automatic effects below react to Activity changing at all — re-fetching
 * the RPC for cloud mode, additively merging for local mode — so a caller
 * never needs to remember to call `reload()` itself after logging Activity
 * (a second correctness-review finding: only the local additive path
 * existed at first, leaving cloud's Recently Active/Stalled/Continue sort
 * stale until a full page reload).
 *
 * Cloud mode keys its re-fetch off `cloudWriteVersion` (from useActivity),
 * NOT off the `localEvents` array reference — a THIRD correctness-review
 * finding, verified live: `localEvents` updates the instant logEvent's
 * OPTIMISTIC `setEvents` runs, which is before the corresponding Supabase
 * insert has actually landed. Re-fetching the RPC right then races that
 * still-in-flight write and can read the aggregate a moment too early,
 * silently returning a stale last-activity timestamp. `cloudWriteVersion`
 * only increments once the write is CONFIRMED durable, so the RPC re-fetch
 * it triggers is guaranteed to see it. Cloud merge/merge-undo don't log
 * through here at all (activity_events is reassigned by a server-side RPC
 * instead) — recovery-orchestration.ts calls `reload()` explicitly for
 * those, the same way local mode calls `mergeInto`/`restoreForMerge`
 * explicitly.
 *
 * `recomputeForItems` is a legacy fallback kept only for a merge-recovery
 * record persisted before `restoreForMerge`'s snapshot-based approach
 * existed.
 */
export function useActivitySummary(userId: string | null | undefined, localEvents: ActivityEvent[], cloudWriteVersion: number = 0) {
  const [cloudSummary, setCloudSummary] = useState<ActivitySummary>(new Map());
  const [localSummary, setLocalSummary] = useState<ActivitySummary>(new Map());
  const [isHydrated, setIsHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydrationToken = useRef(0);
  // True once local hydration/bootstrap has run — guards the automatic
  // merge effect below from firing (and persisting a partial result)
  // before the durable store has actually been loaded.
  const localHydratedRef = useRef(false);

  const hydrate = useCallback(async () => {
    if (!userId) {
      // Local mode: load the durable summary; if it has never been
      // initialized (first Stage 31 load for this browser), bootstrap it
      // from whatever qualifying events are CURRENTLY retained — this is
      // the one-time, honest best-effort described in Stage 31 §A7:
      // activity older than the 500-event cap that was ALREADY gone
      // before this feature existed cannot be reconstructed, and this
      // never fabricates a date for it.
      const stored = loadActivitySummary();
      const base: ActivitySummary = stored ? new Map(Object.entries(stored)) : new Map();
      const merged = mergeActivityIntoSummary(base, localEvents);
      setLocalSummary(merged);
      if (!stored || merged.size !== base.size) saveActivitySummary(Object.fromEntries(merged));
      localHydratedRef.current = true;
      setError(null);
      setIsHydrated(true);
      return;
    }

    const token = ++hydrationToken.current;
    setIsHydrated(false);

    const supabase = getSupabaseClient();
    if (!supabase) {
      if (hydrationToken.current === token) {
        setError("Cloud sync isn't configured for this deployment.");
        setIsHydrated(true);
      }
      return;
    }
    try {
      const summary = await fetchActivitySummary(supabase);
      if (hydrationToken.current === token) {
        setCloudSummary(summary);
        setError(null);
      }
    } catch {
      if (hydrationToken.current === token) setError("Unable to load activity summary.");
    }
    if (hydrationToken.current === token) setIsHydrated(true);
    // localEvents is intentionally excluded — hydrate's local branch only
    // needs it for the ONE-TIME bootstrap; ongoing additive updates are
    // handled by the effect below instead of re-running hydrate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from an external store (localStorage or Supabase RPC) whenever userId changes; can't be derived at render time since both sources require an effect.
    hydrate();
  }, [hydrate]);

  // Cloud mode: re-fetch the RPC once a write is CONFIRMED durable (see
  // cloudWriteVersion's doc comment on useActivity, and this hook's own
  // top comment for the race this avoids). `previousVersionRef` starts
  // equal to the first render's version, so this correctly no-ops on
  // mount (the hydrate-on-mount effect above already handles the initial
  // load) and only reacts to a REAL subsequent confirmed write.
  const previousVersionRef = useRef(cloudWriteVersion);
  useEffect(() => {
    if (!userId) return;
    const changed = previousVersionRef.current !== cloudWriteVersion;
    previousVersionRef.current = cloudWriteVersion;
    if (!changed) return;
    hydrate();
  }, [cloudWriteVersion, userId, hydrate]);

  // Local mode: additive-only merge (never a replace) whenever
  // `activity.events` changes reference — which useActivity guarantees on
  // every local mutation (logEvent, removeEventsForItem,
  // reassignEventsForItem, restoreEventsForItem/ForMerge, replaceAllLocal).
  // No race here (unlike cloud): local mode's optimistic array IS the
  // durable source of truth, persisted to localStorage synchronously with
  // no server round-trip to outrun. `previousEventsRef` starts equal to
  // the first render's `localEvents`, so this correctly no-ops on mount.
  const previousEventsRef = useRef(localEvents);
  useEffect(() => {
    if (userId) return;
    const changed = previousEventsRef.current !== localEvents;
    previousEventsRef.current = localEvents;
    if (!changed || !localHydratedRef.current) return;
    setLocalSummary((current) => {
      const merged = mergeActivityIntoSummary(current, localEvents);
      if (merged.size !== current.size || Array.from(merged).some(([id, ts]) => current.get(id) !== ts)) {
        saveActivitySummary(Object.fromEntries(merged));
        return merged;
      }
      return current;
    });
  }, [localEvents, userId]);

  /** Stage 27 local merge: survivor's entry becomes max(survivor, duplicate). No-op in cloud mode — the server-side RPC aggregate already follows activity_events' own reassignment there. */
  function mergeInto(fromItemId: string, toItemId: string) {
    if (userId) return;
    setLocalSummary((current) => {
      const merged = mergeSummaryEntry(current, fromItemId, toItemId);
      saveActivitySummary(Object.fromEntries(merged));
      return merged;
    });
  }

  /** LEGACY FALLBACK ONLY — see recomputeSummaryForItems's doc comment. Used by merge-undo only for a recovery record persisted before activitySummaryBefore existed. */
  function recomputeForItems(itemIds: string[], events: ActivityEvent[]) {
    if (userId) return;
    setLocalSummary((current) => {
      const merged = recomputeSummaryForItems(current, itemIds, events);
      saveActivitySummary(Object.fromEntries(merged));
      return merged;
    });
  }

  /** Stage 27 local merge-undo: restores the survivor's and duplicate's summary entries to their EXACT pre-merge values (captured in the recovery snapshot at merge time), never recomputed from the current detailed Activity log — see restoreSummaryEntries's doc comment for why that log can no longer be trusted to still contain the originating events by undo time. */
  function restoreForMerge(survivorId: string, duplicateId: string, survivorValue: string | null, duplicateValue: string | null) {
    if (userId) return;
    setLocalSummary((current) => {
      const merged = restoreSummaryEntries(current, [
        [survivorId, survivorValue],
        [duplicateId, duplicateValue],
      ]);
      saveActivitySummary(Object.fromEntries(merged));
      return merged;
    });
  }

  /** Stage 29 local import: folds in the FULL set of newly-imported qualifying events — deliberately BEFORE the detailed log's own capacity trim, so an item whose only imported qualifying event doesn't survive that trim is still represented here. */
  function mergeEvents(events: ActivityEvent[]) {
    if (userId) return;
    setLocalSummary((current) => {
      const merged = mergeActivityIntoSummary(current, events);
      saveActivitySummary(Object.fromEntries(merged));
      return merged;
    });
  }

  return {
    summary: userId ? cloudSummary : localSummary,
    isHydrated,
    error,
    reload: hydrate,
    mergeInto,
    recomputeForItems,
    restoreForMerge,
    mergeEvents,
  };
}
