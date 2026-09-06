"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Reminder, ReminderInput } from "@/types/reminder";
import { generateId } from "@/lib/utils";
import { findActiveReminderCollision } from "@/lib/reminders";
import { loadReminders, saveReminders } from "@/lib/local-reminder-storage";
import { getSupabaseClient } from "@/lib/supabase/client";
import { deleteReminderRow, fetchReminders, insertReminder, updateReminderRow, ReminderConflictError } from "@/lib/cloud/reminders";
import { getReminderChangeVersion, subscribeToReminderChanges, notifyRemindersChanged } from "@/lib/reminder-change-signal";

export type CreateReminderResult =
  | { status: "ok"; reminder: Reminder }
  | { status: "duplicate"; existing: Reminder }
  | { status: "error"; message: string };

export interface SaveResult {
  ok: boolean;
  message?: string;
}

/**
 * Owns Reminder rows: hydration, persistence, and CRUD — the same
 * local/cloud dual-mode shape as useCollections/useActivity. Signed out,
 * this is markly.reminders localStorage, unchanged across renders except
 * for real mutations. Signed in, it hydrates from and persists to
 * Supabase's `reminders` table (0016_stage34_reminders.sql).
 *
 * Duplicate-create/edit collapsing (§ "one logical reminder") is enforced
 * at TWO layers deliberately, not just one: findActiveReminderCollision
 * checks in-memory state first (fast, no round trip, catches the common
 * case), and the cloud insert/update additionally relies on 0016's two
 * partial unique indexes as the real authority for a genuine race between
 * two tabs/devices — a caught ReminderConflictError re-fetches and
 * resolves to the row that actually won, never a generic failure.
 *
 * This hook does NOT itself fetch AniList/Stage 33 data — see
 * lib/reminders.ts's resolveReminders and its `providerAvailable` param.
 * Callers that have fresh ReleaseEvents on hand (the /reminders page) pass
 * them into resolveReminders themselves; callers that don't (the Header
 * badge) resolve from stored snapshots only, by design — never a reason
 * for this hook to poll AniList on its own.
 *
 * Correctness-review fix — cross-component reactivity: this is called from
 * several independent places at once (Header's ReminderBell, Calendar,
 * item detail, /reminders itself), each getting its OWN useState. Without
 * more, a mutation in one instance would never be visible in another until
 * that other instance's next mount. Every instance subscribes to the
 * module-level signal in lib/reminder-change-signal.ts and re-hydrates
 * whenever any instance reports a CONFIRMED mutation (see the effect
 * below, which mirrors useActivitySummary's own cloudWriteVersion-guarded
 * re-fetch pattern) — never on its own initial mount, and hydrate() itself
 * never emits, so there is no reload -> emit -> reload loop.
 */
export function useReminders(userId?: string | null) {
  const [reminders, setReminders] = useState<Reminder[]>([]);
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
        const cloudReminders = await fetchReminders(supabase, userId);
        if (hydrationToken.current === token) {
          setReminders(cloudReminders);
          setError(null);
        }
      } catch {
        if (hydrationToken.current === token) setError("Unable to load your reminders.");
      }
      if (hydrationToken.current === token) setIsHydrated(true);
      return;
    }

    const stored = loadReminders();
    if (hydrationToken.current === token) {
      if (stored) setReminders(stored);
      setIsHydrated(true);
    }
  }, [userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from an external store (localStorage or Supabase) whenever userId changes; the value can't be derived during render since both sources require an effect (localStorage isn't available at SSR/prerender time, and Supabase fetches are async).
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (userId || !isHydrated) return;
    saveReminders(reminders);
  }, [reminders, isHydrated, userId]);

  // Re-hydrate whenever ANY useReminders instance (this one included)
  // reports a confirmed mutation — never on this instance's own mount
  // (previousVersionRef starts equal to the first render's version, same
  // guard useActivitySummary's cloudWriteVersion effect already uses).
  const changeVersion = useSyncExternalStore(subscribeToReminderChanges, getReminderChangeVersion, getReminderChangeVersion);
  const previousChangeVersionRef = useRef(changeVersion);
  useEffect(() => {
    const changed = previousChangeVersionRef.current !== changeVersion;
    previousChangeVersionRef.current = changeVersion;
    if (!changed) return;
    hydrate();
  }, [changeVersion, hydrate]);

  async function createReminder(input: ReminderInput): Promise<CreateReminderResult> {
    const collision = findActiveReminderCollision(input, reminders);
    if (collision) return { status: "duplicate", existing: collision };

    const now = new Date().toISOString();
    const reminder: Reminder = { ...input, id: generateId(), createdAt: now };

    if (userId) {
      const supabase = getSupabaseClient();
      if (!supabase) return { status: "error", message: "Cloud sync isn't configured for this deployment." };
      try {
        const inserted = await insertReminder(supabase, reminder, userId);
        setReminders((current) => [inserted, ...current]);
        notifyRemindersChanged();
        return { status: "ok", reminder: inserted };
      } catch (err) {
        if (err instanceof ReminderConflictError) {
          try {
            const fresh = await fetchReminders(supabase, userId);
            setReminders(fresh);
            const existing = findActiveReminderCollision(input, fresh);
            if (existing) {
              // Not a failure — a genuine settled end state (someone else's
              // insert won the race). Other peers still benefit from
              // re-checking in case they haven't already converged.
              notifyRemindersChanged();
              return { status: "duplicate", existing };
            }
          } catch {
            // fall through to the generic error below
          }
        }
        // A genuine failure — never notify peers of a change that didn't happen.
        return { status: "error", message: "Unable to save this reminder." };
      }
    }

    const next = [reminder, ...reminders];
    setReminders(next);
    // Local mode's cross-instance hand-off channel IS localStorage — a
    // sibling's hydrate() reads it via loadReminders(), so it must already
    // hold this write BEFORE notifying, not just eventually via the
    // reactive persistence effect above (which runs asynchronously after
    // this render commits — too late for a listener that reacts
    // synchronously to notifyRemindersChanged()). Saving explicitly here
    // closes that race; the effect's own saveReminders call still fires
    // too and is a harmless, idempotent no-op rewrite of the same value.
    saveReminders(next);
    notifyRemindersChanged();
    return { status: "ok", reminder };
  }

  /**
   * Shared save path for every in-place edit (lead time, continue time,
   * dismiss). `apply` receives the CURRENT reminder and returns the next
   * value — switch-narrowed by each caller below rather than a blind
   * object-spread-plus-cast, so TypeScript verifies the result is really a
   * valid Reminder member with no assertion required (matches
   * useActivity.ts's logEvent's own reasoning for the same choice).
   */
  async function patchReminder(id: string, apply: (target: Reminder) => Reminder): Promise<SaveResult> {
    const target = reminders.find((candidate) => candidate.id === id);
    if (!target) return { ok: false, message: "This reminder no longer exists." };
    const updated = apply(target);

    if (userId) {
      const supabase = getSupabaseClient();
      if (!supabase) return { ok: false, message: "Cloud sync isn't configured for this deployment." };
      try {
        await updateReminderRow(supabase, updated, userId);
        setReminders((current) => current.map((candidate) => (candidate.id === id ? updated : candidate)));
        notifyRemindersChanged();
        return { ok: true };
      } catch (err) {
        // A genuine failure — never notify peers of a change that didn't happen.
        if (err instanceof ReminderConflictError) {
          return { ok: false, message: "A reminder already exists for that time." };
        }
        return { ok: false, message: "Unable to save this update." };
      }
    }

    const collision = findActiveReminderCollision(
      updated,
      reminders.filter((candidate) => candidate.id !== id),
    );
    if (collision) return { ok: false, message: "A reminder already exists for that time." };
    const next = reminders.map((candidate) => (candidate.id === id ? updated : candidate));
    setReminders(next);
    saveReminders(next); // see createReminder's identical comment on why this can't wait for the reactive persistence effect
    notifyRemindersChanged();
    return { ok: true };
  }

  function updateReleaseLeadTime(id: string, remindBeforeMinutes: number): Promise<SaveResult> {
    return patchReminder(id, (target) => {
      if (target.kind !== "release") return target;
      return { ...target, remindBeforeMinutes, updatedAt: new Date().toISOString() };
    });
  }

  function updateContinueTime(id: string, remindAt: string): Promise<SaveResult> {
    return patchReminder(id, (target) => {
      if (target.kind !== "continue") return target;
      return { ...target, remindAt, updatedAt: new Date().toISOString() };
    });
  }

  function dismissReminder(id: string): Promise<SaveResult> {
    return patchReminder(id, (target) => ({ ...target, dismissedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  }

  function deleteReminder(id: string): void {
    if (userId) {
      setReminders((current) => current.filter((candidate) => candidate.id !== id));
      const supabase = getSupabaseClient();
      if (supabase) {
        deleteReminderRow(supabase, id)
          // Only notify peers once the delete is CONFIRMED — this optimistic
          // local removal above is this instance's own UI only; if the
          // network call fails, the catch branch below reconciles this
          // instance from the server without ever telling peers a change
          // that didn't actually happen.
          .then(() => notifyRemindersChanged())
          .catch(() => {
            setError("Unable to save this update.");
            hydrate();
          });
      }
      return;
    }

    const next = reminders.filter((candidate) => candidate.id !== id);
    setReminders(next);
    saveReminders(next); // see createReminder's identical comment on why this can't wait for the reactive persistence effect
    notifyRemindersChanged();
  }

  /**
   * Stage 34 — local mode only: removes every reminder for `itemId`, used
   * by the delete-with-recovery orchestration right before the item itself
   * is removed. Cloud mode never calls this: reminders CASCADEs away
   * server-side inside delete_library_item_with_recovery, which also
   * captures the snapshot the Undo path needs — this hook just reloads
   * afterward like every other store.
   */
  function removeForItem(itemId: string): void {
    if (userId) return;
    const next = reminders.filter((candidate) => candidate.libraryItemId !== itemId);
    setReminders(next);
    saveReminders(next);
    notifyRemindersChanged();
  }

  /**
   * Stage 34 — local mode only: reinserts previously deleted reminders
   * verbatim, used by delete-Undo. The caller (recovery-orchestration.ts)
   * has already re-validated that the owning item id is free again before
   * this is ever invoked.
   */
  function restoreForItem(restored: Reminder[]): void {
    if (userId || restored.length === 0) return;
    const next = [...restored, ...reminders];
    setReminders(next);
    saveReminders(next);
    notifyRemindersChanged();
  }

  /**
   * Stage 34 — local mode only: applies a merge's already-computed
   * reminder plan (see recovery-orchestration.ts, which decides — using
   * findActiveReminderCollision — which of the duplicate's reminders move
   * to the survivor untouched vs. get dropped as an exact logical
   * duplicate of one the survivor already has). `dedupedIds` rows are
   * removed outright (their full data lives in the recovery snapshot for
   * Undo); `movedIds` rows are reassigned to the survivor, nothing else
   * about them changes.
   */
  function reassignForMerge(movedIds: readonly string[], dedupedIds: readonly string[], survivorId: string): void {
    if (userId) return;
    const moved = new Set(movedIds);
    const deduped = new Set(dedupedIds);
    const next = reminders
      .filter((candidate) => !deduped.has(candidate.id))
      .map((candidate) => (moved.has(candidate.id) ? { ...candidate, libraryItemId: survivorId } : candidate));
    setReminders(next);
    saveReminders(next);
    notifyRemindersChanged();
  }

  /**
   * Stage 34 — local mode only: reverses reassignForMerge exactly, used by
   * merge-Undo. `movedIds` rows move back to the duplicate (recreated with
   * its original id by the time this runs); `dedupedSnapshots` rows are
   * reinserted verbatim, including their original id.
   */
  function restoreForMerge(movedIds: readonly string[], dedupedSnapshots: readonly Reminder[], duplicateId: string): void {
    if (userId) return;
    const moved = new Set(movedIds);
    const next = [
      ...dedupedSnapshots,
      ...reminders.map((candidate) => (moved.has(candidate.id) ? { ...candidate, libraryItemId: duplicateId } : candidate)),
    ];
    setReminders(next);
    saveReminders(next);
    notifyRemindersChanged();
  }

  return {
    reminders,
    isHydrated,
    error,
    createReminder,
    updateReleaseLeadTime,
    updateContinueTime,
    dismissReminder,
    deleteReminder,
    removeForItem,
    restoreForItem,
    reassignForMerge,
    restoreForMerge,
    reload: hydrate,
  };
}
