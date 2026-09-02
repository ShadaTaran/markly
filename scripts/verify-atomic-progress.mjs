#!/usr/bin/env node
// Verifies the concurrency algorithm behind
// supabase/migrations/0004_stage18_atomic_progress.sql's
// apply_extension_progress() Postgres function.
//
// This is a faithful in-memory re-implementation of that function's logic
// (same compare-and-set, same monotonic rule, same auto-advance-status
// rule, same Activity insertion behavior) plus a row lock model that
// mirrors `select ... for update`: only one caller may be inside its
// read -> compare -> write -> insert-activity critical section per item
// at a time; a second concurrent caller queues until the first's
// simulated transaction resolves, then observes the already-updated
// state.
//
// It is not a substitute for running the real migration against a real
// Postgres — no local Postgres/Docker was available in this environment,
// and applying migration 0004 to the actual Supabase project was
// explicitly out of scope for this fix. What this DOES prove, rigorously
// and deterministically:
//   1. Without a lock around the read, N concurrent identical requests
//      reproduce exactly the reported bug (multiple "updated" results,
//      multiple duplicate Activity events) — i.e. this harness actually
//      detects the race, it doesn't just pass trivially.
//   2. With the lock (the actual algorithm now encoded in SQL), the same
//      N concurrent requests collapse into exactly one write and exactly
//      one Activity event, regardless of how many callers race.
//   3. The monotonic rule, unchanged-is-a-no-op rule, and single-fire
//      status auto-advance all hold under that same concurrency.
//
// Run with: node scripts/verify-atomic-progress.mjs

import assert from "node:assert/strict";

function jitter() {
  return new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
}

function autoAdvanceStatus(previousValue, nextValue, status) {
  const wasZero = (previousValue ?? 0) === 0;
  return wasZero && nextValue > 0 && status === "planned" ? "in_progress" : status;
}

function makeState(type, status, metadata) {
  return { item: { type, status, metadata: { ...metadata } }, activity: [] };
}

/** Models `select ... for update`: serializes callers per item, does not serialize across items. */
function createRowLock() {
  let tail = Promise.resolve();
  return function withLock(fn) {
    const result = tail.then(fn, fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

/** Mirrors apply_extension_progress() in supabase/migrations/0004_stage18_atomic_progress.sql. */
async function applyFixed(state, lock, { mediaType, progressField, progressKind, newValue }) {
  return lock(async () => {
    await jitter(); // simulated read latency, held inside the lock

    const row = state.item;
    if (row.type !== mediaType) return { status: "incompatible_media_type" };

    if (progressField === "progressValue") {
      const unit = row.metadata.progressUnit;
      if (unit !== undefined && unit !== progressKind) return { status: "incompatible_media_type" };
    }

    const currentValue = row.metadata[progressField] ?? 0;
    if (newValue < currentValue) return { status: "behind_current_progress", currentValue };
    if (newValue === currentValue) return { status: "unchanged", currentValue };

    row.metadata[progressField] = newValue;
    if (progressField === "progressValue" && row.metadata.progressUnit === undefined) {
      row.metadata.progressUnit = progressKind;
    }

    const previousStatus = row.status;
    row.status = autoAdvanceStatus(currentValue, newValue, previousStatus);

    state.activity.push({ type: "progress_updated", progressKind, previousValue: currentValue, newValue });
    let statusChanged = false;
    if (row.status !== previousStatus) {
      state.activity.push({ type: "status_updated", previousValue: previousStatus, newValue: row.status });
      statusChanged = true;
    }

    return { status: "updated", currentValue: newValue, statusChanged };
  });
}

/** The pre-fix shape: read happens outside any lock, so concurrent callers can all read stale state before any of them writes. Used only to prove this harness actually detects the race. */
async function applyBuggy(state, { mediaType, progressField, progressKind, newValue }) {
  const row = state.item;
  if (row.type !== mediaType) return { status: "incompatible_media_type" };
  const currentValue = row.metadata[progressField] ?? 0;

  await jitter(); // the vulnerable window: read done, write not yet

  if (newValue < currentValue) return { status: "behind_current_progress", currentValue };
  if (newValue === currentValue) return { status: "unchanged", currentValue };

  row.metadata[progressField] = newValue;
  const previousStatus = row.status;
  row.status = autoAdvanceStatus(currentValue, newValue, previousStatus);
  state.activity.push({ type: "progress_updated", progressKind, previousValue: currentValue, newValue });
  if (row.status !== previousStatus) {
    state.activity.push({ type: "status_updated", previousValue: previousStatus, newValue: row.status });
  }
  return { status: "updated", currentValue: newValue };
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

async function main() {
  // --- Sanity check: prove the harness detects the race without the fix ---
  {
    const state = makeState("novel", "in_progress", { progressValue: 14, progressUnit: "chapter" });
    const calls = Array.from({ length: 10 }, () =>
      applyBuggy(state, { mediaType: "novel", progressField: "progressValue", progressKind: "chapter", newValue: 15 }),
    );
    const outcomes = await Promise.all(calls);
    const updatedCount = outcomes.filter((o) => o.status === "updated").length;
    check("sanity: unlocked read reproduces the reported bug (>1 updated or >1 activity event)", () => {
      assert.ok(
        updatedCount > 1 || state.activity.length > 1,
        `expected the race to reproduce, got updatedCount=${updatedCount} activity=${state.activity.length}`,
      );
    });
  }

  // --- Test 1: 10 concurrent identical requests, 14 -> 15 ---
  {
    const state = makeState("novel", "in_progress", { progressValue: 14, progressUnit: "chapter" });
    const lock = createRowLock();
    const calls = Array.from({ length: 10 }, () =>
      applyFixed(state, lock, { mediaType: "novel", progressField: "progressValue", progressKind: "chapter", newValue: 15 }),
    );
    const outcomes = await Promise.all(calls);
    const updated = outcomes.filter((o) => o.status === "updated");
    const unchanged = outcomes.filter((o) => o.status === "unchanged");

    check("test1: exactly one 'updated' among 10 concurrent identical requests", () => {
      assert.equal(updated.length, 1, `got ${updated.length}`);
    });
    check("test1: remaining 9 responses are 'unchanged'", () => {
      assert.equal(unchanged.length, 9, `got ${unchanged.length}`);
    });
    check("test1: LibraryItem lands on 15", () => {
      assert.equal(state.item.metadata.progressValue, 15);
    });
    check("test1: exactly one progress_updated Activity event", () => {
      const events = state.activity.filter((e) => e.type === "progress_updated");
      assert.equal(events.length, 1, `got ${events.length}`);
    });
    check("test1: zero status_updated events (item was already in_progress)", () => {
      const events = state.activity.filter((e) => e.type === "status_updated");
      assert.equal(events.length, 0, `got ${events.length}`);
    });

    // --- Test 2: repeat with 10 more requests for the now-current value (15) ---
    const activityCountBefore = state.activity.length;
    const repeatCalls = Array.from({ length: 10 }, () =>
      applyFixed(state, lock, { mediaType: "novel", progressField: "progressValue", progressKind: "chapter", newValue: 15 }),
    );
    const repeatOutcomes = await Promise.all(repeatCalls);
    check("test2: 10 more requests for the same (now-current) value all return 'unchanged'", () => {
      assert.ok(repeatOutcomes.every((o) => o.status === "unchanged"), JSON.stringify(repeatOutcomes));
    });
    check("test2: zero additional Activity events", () => {
      assert.equal(state.activity.length, activityCountBefore);
    });
  }

  // --- Test 3: sequential genuine progression, 14 -> 15 -> 16 -> 17 ---
  {
    const state = makeState("novel", "in_progress", { progressValue: 14, progressUnit: "chapter" });
    const lock = createRowLock();
    const r1 = await applyFixed(state, lock, { mediaType: "novel", progressField: "progressValue", progressKind: "chapter", newValue: 15 });
    const r2 = await applyFixed(state, lock, { mediaType: "novel", progressField: "progressValue", progressKind: "chapter", newValue: 16 });
    const r3 = await applyFixed(state, lock, { mediaType: "novel", progressField: "progressValue", progressKind: "chapter", newValue: 17 });

    check("test3: three genuine sequential transitions all report 'updated'", () => {
      assert.equal(r1.status, "updated");
      assert.equal(r2.status, "updated");
      assert.equal(r3.status, "updated");
    });
    check("test3: exactly three progress_updated events (no suppression of legitimate later chapters)", () => {
      const events = state.activity.filter((e) => e.type === "progress_updated");
      assert.equal(events.length, 3, `got ${events.length}`);
    });
    check("test3: LibraryItem lands on 17", () => {
      assert.equal(state.item.metadata.progressValue, 17);
    });
  }

  // --- Test 4: lower/behind-current progress must never move anything backward ---
  {
    const state = makeState("novel", "in_progress", { progressValue: 15, progressUnit: "chapter" });
    const lock = createRowLock();
    const same = await applyFixed(state, lock, { mediaType: "novel", progressField: "progressValue", progressKind: "chapter", newValue: 15 });
    const behind = await applyFixed(state, lock, { mediaType: "novel", progressField: "progressValue", progressKind: "chapter", newValue: 10 });

    check("test4: incoming == current -> 'unchanged'", () => {
      assert.equal(same.status, "unchanged");
    });
    check("test4: incoming < current -> 'behind_current_progress'", () => {
      assert.equal(behind.status, "behind_current_progress");
    });
    check("test4: LibraryItem stays at 15 (never moves backward)", () => {
      assert.equal(state.item.metadata.progressValue, 15);
    });
    check("test4: no Activity events for either case", () => {
      assert.equal(state.activity.length, 0);
    });
  }

  // --- Test 5: first detection (0 -> 1) must fire exactly one status_updated and one progress_updated, even under concurrency ---
  {
    const state = makeState("manga", "planned", { currentChapter: 0 });
    const lock = createRowLock();
    const calls = Array.from({ length: 10 }, () =>
      applyFixed(state, lock, { mediaType: "manga", progressField: "currentChapter", progressKind: "chapter", newValue: 1 }),
    );
    const outcomes = await Promise.all(calls);
    const updated = outcomes.filter((o) => o.status === "updated");

    check("test5: exactly one 'updated' among 10 concurrent first-detection requests", () => {
      assert.equal(updated.length, 1, `got ${updated.length}`);
    });
    check("test5: exactly one progress_updated event", () => {
      assert.equal(state.activity.filter((e) => e.type === "progress_updated").length, 1);
    });
    check("test5: exactly one status_updated event (planned -> in_progress), not two", () => {
      const events = state.activity.filter((e) => e.type === "status_updated");
      assert.equal(events.length, 1, `got ${events.length}`);
      assert.equal(events[0].previousValue, "planned");
      assert.equal(events[0].newValue, "in_progress");
    });
    check("test5: LibraryItem status actually advanced", () => {
      assert.equal(state.item.status, "in_progress");
      assert.equal(state.item.metadata.currentChapter, 1);
    });
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}`);
    if (!r.ok) console.log(`  ${r.err.message}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
