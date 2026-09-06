"use client";

import { useSyncExternalStore } from "react";

/** How often the shared clock ticks while at least one consumer is mounted — once a minute is enough to move Upcoming -> Due promptly without any second-perfect timing promise (§ "no promise of second-perfect timing"). */
const TICK_MS = 60_000;

/**
 * Correctness-review fix (Issue C) — a plain `useState`+`useEffect` hook
 * gives every CALLER its own independent interval: with ReminderBell (in
 * Header, present on every page) and ReminderCenterView (on /reminders)
 * both calling useNow(), a naive version would run TWO intervals
 * concurrently on /reminders, not the "one shared clock" this module
 * claims. This is a genuine module-level external store instead —
 * exactly one `setInterval` exists at a time, shared by every useNow()
 * call anywhere in the app, regardless of how many components render.
 * `useSyncExternalStore` is React's own built-in mechanism for exactly
 * this ("subscribe to external mutable state"), not custom machinery.
 *
 * Reference-counted lifecycle: the interval starts when the FIRST
 * subscriber mounts and stops when the LAST one unmounts — never leaks
 * under React Strict Mode's mount/unmount/remount double-invoke, since
 * `listeners` is a Set (double-subscribe is a no-op) and the interval is
 * only created when none already exists / cleared only when the set is
 * actually empty.
 */
let sharedNow = new Date();
let intervalId: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function tick() {
  sharedNow = new Date();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (intervalId === null) {
    intervalId = setInterval(tick, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

function getSnapshot(): Date {
  return sharedNow;
}

export function useNow(): Date {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
