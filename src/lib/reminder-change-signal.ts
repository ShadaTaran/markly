/**
 * Correctness-review fix — cross-component reminder reactivity.
 *
 * Root cause: every `useReminders(userId)` call owns a fully independent
 * `useState<Reminder[]>`, so Header's ReminderBell and (say) /reminders'
 * own ReminderCenterView never observe each other's writes — a mutation
 * only ever calls `setReminders` inside the ONE component instance that
 * performed it. This is a plain module-level pub/sub, the same shape as
 * useNow.ts's shared clock (Issue C of the prior review), except the
 * signal here means "reminder data changed" rather than "a minute
 * elapsed" — deliberately kept as a SEPARATE primitive from useNow's,
 * since they are different concerns (time vs. data) that must never be
 * conflated.
 *
 * `notifyRemindersChanged` must be called ONLY from a CONFIRMED mutation
 * (create/edit/dismiss/delete actually succeeding, including a duplicate-
 * create settling to the existing row) — NEVER from a read/hydrate path.
 * Every useReminders instance's own re-hydrate, triggered by this signal,
 * calls plain read functions that never call this function themselves —
 * breaking any possibility of a reload -> emit -> reload loop by
 * construction (see useReminders.ts's own effect for the consuming side).
 *
 * Deliberately framework-free (no React import) so it's trivial to
 * reproduce verbatim in scripts/verify-reminders.mjs, matching this
 * project's established test convention.
 */

const listeners = new Set<() => void>();
let version = 0;

export function getReminderChangeVersion(): number {
  return version;
}

export function subscribeToReminderChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Call ONLY after a reminder create/edit/dismiss/delete is confirmed to have actually changed something — never from hydrate/reload. */
export function notifyRemindersChanged(): void {
  version += 1;
  listeners.forEach((listener) => listener());
}
