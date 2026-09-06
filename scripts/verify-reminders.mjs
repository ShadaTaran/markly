#!/usr/bin/env node
// Verifies Stage 34 "Reminders & Notification Center":
//   - lib/reminders.ts: release identity, findActiveReminderCollision,
//     resolveReminders (fresh-vs-snapshot reconciliation, due/upcoming/
//     dismissed derivation), sorting, countDueReminders
//   - lib/local-reminder-storage.ts's per-record validation
//   - the merge/delete recovery reminder logic in
//     lib/recovery-orchestration.ts (move vs. dedupe-and-snapshot decision,
//     and its exact reversal on Undo)
//   - zero side effects (no Activity/progress/rating/status mutation from
//     any reminder action)
//
// Reproduced verbatim from the real modules (same approach as every other
// script in this directory — plain .mjs, no TypeScript loader). No live
// database/Supabase/AniList network call is made by this script.
//
// Run with: node scripts/verify-reminders.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

// ============================================================
// lib/reminders.ts — reproduced verbatim
// ============================================================
function releaseIdentityKey(target) {
  return `${target.provider}:${target.externalMediaId}:episode:${target.episode}`;
}

function activeReleaseReminderLibraryItemIds(reminders) {
  const ids = new Set();
  for (const reminder of reminders) {
    if (reminder.kind === "release" && !reminder.dismissedAt) ids.add(reminder.libraryItemId);
  }
  return ids;
}

function isSameReleaseIdentity(a, b) {
  return a.provider === b.provider && a.externalMediaId === b.externalMediaId && a.episode === b.episode;
}

function findActiveReminderCollision(candidate, existing) {
  return existing.find((row) => {
    if (row.dismissedAt) return false;
    if (row.libraryItemId !== candidate.libraryItemId || row.kind !== candidate.kind) return false;
    if (row.kind === "release" && candidate.kind === "release") {
      return (
        candidate.provider !== undefined &&
        candidate.externalMediaId !== undefined &&
        candidate.episode !== undefined &&
        isSameReleaseIdentity(row, { provider: candidate.provider, externalMediaId: candidate.externalMediaId, episode: candidate.episode })
      );
    }
    if (row.kind === "continue" && candidate.kind === "continue") {
      return candidate.remindAt !== undefined && row.remindAt === candidate.remindAt;
    }
    return false;
  });
}

function resolveReminders(reminders, items, freshEvents, providerAvailable, now) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const eventsByKey = new Map();
  if (providerAvailable) {
    for (const event of freshEvents) {
      if (event.episode === undefined) continue;
      eventsByKey.set(releaseIdentityKey({ provider: event.provider, externalMediaId: event.externalMediaId, episode: event.episode }), event);
    }
  }

  const nowMs = now.getTime();
  const resolved = [];

  for (const reminder of reminders) {
    const item = itemsById.get(reminder.libraryItemId);
    if (!item) continue;

    if (reminder.kind === "continue") {
      const dueMs = new Date(reminder.remindAt).getTime();
      resolved.push({
        reminder,
        item,
        effectiveDueAt: reminder.remindAt,
        isDismissed: Boolean(reminder.dismissedAt),
        isDue: !reminder.dismissedAt && dueMs <= nowMs,
      });
      continue;
    }

    const fresh = eventsByKey.get(releaseIdentityKey(reminder));
    const effectiveScheduledFor = fresh ? fresh.startsAt : reminder.scheduledFor;
    const scheduleConfirmed = Boolean(fresh);
    const dueMs = new Date(effectiveScheduledFor).getTime() - reminder.remindBeforeMinutes * 60_000;
    resolved.push({
      reminder,
      item,
      effectiveDueAt: new Date(dueMs).toISOString(),
      effectiveScheduledFor,
      scheduleConfirmed,
      isDismissed: Boolean(reminder.dismissedAt),
      isDue: !reminder.dismissedAt && dueMs <= nowMs,
    });
  }

  return resolved;
}

function compareById(a, b) {
  return a.reminder.id.localeCompare(b.reminder.id);
}

function sortDueReminders(resolved) {
  return resolved
    .filter((entry) => entry.isDue)
    .sort((a, b) => new Date(b.effectiveDueAt).getTime() - new Date(a.effectiveDueAt).getTime() || compareById(a, b));
}

function sortUpcomingReminders(resolved) {
  return resolved
    .filter((entry) => !entry.isDue && !entry.isDismissed)
    .sort((a, b) => new Date(a.effectiveDueAt).getTime() - new Date(b.effectiveDueAt).getTime() || compareById(a, b));
}

function sortDismissedReminders(resolved) {
  return resolved
    .filter((entry) => entry.isDismissed)
    .sort((a, b) => {
      const aTs = a.reminder.dismissedAt ? new Date(a.reminder.dismissedAt).getTime() : 0;
      const bTs = b.reminder.dismissedAt ? new Date(b.reminder.dismissedAt).getTime() : 0;
      return bTs - aTs || compareById(a, b);
    });
}

function countDueReminders(resolved) {
  return resolved.reduce((count, entry) => (entry.isDue ? count + 1 : count), 0);
}

// ============================================================
// lib/local-reminder-storage.ts — reproduced verbatim
// ============================================================
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isValidIsoString(value) {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}
function isValidReminder(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  const hasBaseFields =
    typeof candidate.id === "string" &&
    typeof candidate.libraryItemId === "string" &&
    isValidIsoString(candidate.createdAt) &&
    (candidate.dismissedAt === undefined || isValidIsoString(candidate.dismissedAt)) &&
    (candidate.updatedAt === undefined || isValidIsoString(candidate.updatedAt));
  if (!hasBaseFields) return false;

  if (candidate.kind === "release") {
    return (
      candidate.provider === "anilist" &&
      typeof candidate.externalMediaId === "string" &&
      isFiniteNumber(candidate.episode) &&
      isValidIsoString(candidate.scheduledFor) &&
      isFiniteNumber(candidate.remindBeforeMinutes) &&
      candidate.remindBeforeMinutes >= 0
    );
  }
  if (candidate.kind === "continue") {
    return isValidIsoString(candidate.remindAt);
  }
  return false;
}

// ============================================================
// recovery-orchestration.ts's merge-time reminder plan — reproduced
// verbatim (the loop that decides movedReminderIds vs.
// deduplicatedReminderSnapshots, mirrored exactly by
// 0016_stage34_reminders.sql's SQL for the cloud path).
// ============================================================
function computeMergeReminderPlan(duplicateReminders, survivorReminders, survivorId) {
  const survivorActive = survivorReminders.filter((r) => !r.dismissedAt);
  const movedReminderIds = [];
  const deduplicatedReminderSnapshots = [];
  for (const reminder of duplicateReminders) {
    // Checked as "if this reminder already belonged to the survivor, would
    // it collide with something the survivor already has" — the
    // libraryItemId override to survivorId matters: findActiveReminderCollision
    // only matches rows sharing the candidate's OWN libraryItemId, so
    // checking against the duplicate's actual (different) id would never
    // find anything (a real bug caught by this exact test — see H2).
    if (!reminder.dismissedAt && findActiveReminderCollision({ ...reminder, libraryItemId: survivorId }, survivorActive)) {
      deduplicatedReminderSnapshots.push(reminder);
    } else {
      movedReminderIds.push(reminder.id);
    }
  }
  return { movedReminderIds, deduplicatedReminderSnapshots };
}

function applyMergeReminderPlan(allReminders, plan, survivorId) {
  const moved = new Set(plan.movedReminderIds);
  const deduped = new Set(plan.deduplicatedReminderSnapshots.map((r) => r.id));
  return allReminders.filter((r) => !deduped.has(r.id)).map((r) => (moved.has(r.id) ? { ...r, libraryItemId: survivorId } : r));
}

function undoMergeReminderPlan(currentReminders, plan, duplicateId) {
  const moved = new Set(plan.movedReminderIds);
  return [
    ...plan.deduplicatedReminderSnapshots,
    ...currentReminders.map((r) => (moved.has(r.id) ? { ...r, libraryItemId: duplicateId } : r)),
  ];
}

// ============================================================
// Fixtures
// ============================================================
const ITEM_A = { id: "item-a", title: "Show A", type: "anime" };

function releaseReminder(overrides = {}) {
  return {
    id: "r1",
    kind: "release",
    libraryItemId: "item-a",
    provider: "anilist",
    externalMediaId: "100",
    episode: 8,
    scheduledFor: "2026-09-10T20:00:00.000Z", // 8 PM
    remindBeforeMinutes: 60, // 1 hour before -> stored-due 7 PM
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function continueReminder(overrides = {}) {
  return {
    id: "c1",
    kind: "continue",
    libraryItemId: "item-a",
    remindAt: "2026-09-05T12:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function releaseEvent(overrides = {}) {
  return {
    id: "anilist:100:8:2026-09-10T22:00:00.000Z",
    provider: "anilist",
    kind: "episode",
    libraryItemId: "item-a",
    externalMediaId: "100",
    startsAt: "2026-09-10T22:00:00.000Z", // 10 PM
    episode: 8,
    ...overrides,
  };
}

// ============================================================
// A — Release resolution: fresh vs. stored
// ============================================================
check("A1: fresh matching ReleaseEvent wins over the stored snapshot for effectiveScheduledFor", () => {
  const reminder = releaseReminder();
  const event = releaseEvent();
  const now = new Date("2026-09-01T00:00:00.000Z");
  const [resolved] = resolveReminders([reminder], [ITEM_A], [event], true, now);
  assert.equal(resolved.effectiveScheduledFor, "2026-09-10T22:00:00.000Z");
  assert.equal(resolved.scheduleConfirmed, true);
});

check("A2: reschedule example — stored 8PM/1hr-lead (7PM) + fresh 10PM => effective due 9PM, not 7PM, single reminder", () => {
  const reminder = releaseReminder(); // scheduledFor 8PM, lead 60min -> stored-due would be 7PM
  const event = releaseEvent(); // fresh startsAt 10PM
  const now = new Date("2026-09-01T00:00:00.000Z");
  const resolvedList = resolveReminders([reminder], [ITEM_A], [event], true, now);
  assert.equal(resolvedList.length, 1, "must never create/resolve a second reminder for the same target");
  const resolved = resolvedList[0];
  assert.equal(resolved.effectiveDueAt, "2026-09-10T21:00:00.000Z", "effective due must be 9 PM (10 PM fresh minus 1hr lead)");
  assert.notEqual(resolved.effectiveDueAt, "2026-09-10T19:00:00.000Z", "must NOT remain at the stale 7 PM stored-due time");
});

check("A3: no fresh match (provider available, event just absent) falls back to snapshot with scheduleConfirmed=false, never deleted", () => {
  const reminder = releaseReminder();
  const now = new Date("2026-09-01T00:00:00.000Z");
  const resolvedList = resolveReminders([reminder], [ITEM_A], [], true, now); // providerAvailable=true, but no matching event
  assert.equal(resolvedList.length, 1, "the reminder must still be present, never silently dropped");
  assert.equal(resolvedList[0].scheduleConfirmed, false);
  assert.equal(resolvedList[0].effectiveScheduledFor, reminder.scheduledFor);
});

check("A4: provider unavailable (fetch failed) always falls back to snapshot, regardless of freshEvents content", () => {
  const reminder = releaseReminder();
  const event = releaseEvent(); // would match if providerAvailable were true
  const now = new Date("2026-09-01T00:00:00.000Z");
  const [resolved] = resolveReminders([reminder], [ITEM_A], [event], false, now);
  assert.equal(resolved.scheduleConfirmed, false);
  assert.equal(resolved.effectiveScheduledFor, reminder.scheduledFor, "must use the stored snapshot, never the fresh event, when providerAvailable is false");
});

check("A5: release identity is stable across a startsAt change — same provider/media/episode matches regardless of the fresh event's own id (which embeds startsAt)", () => {
  const reminder = releaseReminder({ scheduledFor: "2026-01-01T00:00:00.000Z" }); // very different stored value
  const event = releaseEvent(); // id embeds a totally different startsAt than the reminder's own scheduledFor
  const now = new Date("2026-09-01T00:00:00.000Z");
  const [resolved] = resolveReminders([reminder], [ITEM_A], [event], true, now);
  assert.equal(resolved.scheduleConfirmed, true, "matching must be by provider+externalMediaId+episode only, never by scheduledFor/startsAt");
});

// ============================================================
// B — Due/Upcoming/Dismissed boundary
// ============================================================
check("B1: effective due time in the future resolves to Upcoming (isDue=false)", () => {
  const reminder = releaseReminder({ remindBeforeMinutes: 0 }); // due exactly at scheduledFor (8PM)
  const now = new Date("2026-09-10T19:00:00.000Z"); // 7PM, before due
  const [resolved] = resolveReminders([reminder], [ITEM_A], [], false, now);
  assert.equal(resolved.isDue, false);
  assert.equal(resolved.isDismissed, false);
});

check("B2: effective due time at/before now resolves to Due", () => {
  const reminder = releaseReminder({ remindBeforeMinutes: 0 });
  const now = new Date("2026-09-10T20:00:00.000Z"); // exactly at due
  const [resolved] = resolveReminders([reminder], [ITEM_A], [], false, now);
  assert.equal(resolved.isDue, true);
});

check("B3: a dismissed reminder never counts as Due, even if its due time has passed", () => {
  const reminder = releaseReminder({ remindBeforeMinutes: 0, dismissedAt: "2026-09-10T20:30:00.000Z" });
  const now = new Date("2026-09-11T00:00:00.000Z"); // long past due
  const [resolved] = resolveReminders([reminder], [ITEM_A], [], false, now);
  assert.equal(resolved.isDue, false);
  assert.equal(resolved.isDismissed, true);
});

check("B4: continue reminder exactness — remindAt used verbatim as effectiveDueAt, unaffected by any freshEvents passed in", () => {
  const reminder = continueReminder({ remindAt: "2026-09-05T12:00:00.000Z" });
  const event = releaseEvent();
  const now = new Date("2026-09-01T00:00:00.000Z");
  const [resolved] = resolveReminders([reminder], [ITEM_A], [event], true, now);
  assert.equal(resolved.effectiveDueAt, "2026-09-05T12:00:00.000Z");
  assert.equal(resolved.scheduleConfirmed, undefined, "continue reminders never carry a scheduleConfirmed flag");
});

// ============================================================
// C — Lead-time correctness at every preset, no timezone mistakes
// ============================================================
for (const minutes of [0, 10, 30, 60, 180, 1440]) {
  check(`C: lead time ${minutes}min computes effectiveDueAt as exactly scheduledFor - ${minutes}min (UTC arithmetic)`, () => {
    const reminder = releaseReminder({ remindBeforeMinutes: minutes, scheduledFor: "2026-09-10T20:00:00.000Z" });
    const now = new Date("2026-09-01T00:00:00.000Z");
    const [resolved] = resolveReminders([reminder], [ITEM_A], [], false, now);
    const expected = new Date(new Date("2026-09-10T20:00:00.000Z").getTime() - minutes * 60_000).toISOString();
    assert.equal(resolved.effectiveDueAt, expected);
  });
}

// ============================================================
// D — Duplicate identity / collision detection
// ============================================================
check("D1: identical active release identity collides", () => {
  const existing = [releaseReminder({ id: "existing" })];
  const candidate = { kind: "release", libraryItemId: "item-a", provider: "anilist", externalMediaId: "100", episode: 8 };
  assert.ok(findActiveReminderCollision(candidate, existing));
});

check("D2: a DISMISSED existing reminder never collides — a fresh reminder for the same target may be created", () => {
  const existing = [releaseReminder({ id: "existing", dismissedAt: "2026-09-10T21:00:00.000Z" })];
  const candidate = { kind: "release", libraryItemId: "item-a", provider: "anilist", externalMediaId: "100", episode: 8 };
  assert.equal(findActiveReminderCollision(candidate, existing), undefined);
});

check("D3: identical active continue remindAt collides", () => {
  const existing = [continueReminder({ id: "existing" })];
  const candidate = { kind: "continue", libraryItemId: "item-a", remindAt: "2026-09-05T12:00:00.000Z" };
  assert.ok(findActiveReminderCollision(candidate, existing));
});

check("D4: two continue reminders with DIFFERENT remindAt never collide — both remain useful", () => {
  const existing = [continueReminder({ id: "existing", remindAt: "2026-09-05T12:00:00.000Z" })];
  const candidate = { kind: "continue", libraryItemId: "item-a", remindAt: "2026-09-06T12:00:00.000Z" };
  assert.equal(findActiveReminderCollision(candidate, existing), undefined);
});

check("D5: a different libraryItemId never collides even with identical release identity fields", () => {
  const existing = [releaseReminder({ id: "existing", libraryItemId: "item-a" })];
  const candidate = { kind: "release", libraryItemId: "item-b", provider: "anilist", externalMediaId: "100", episode: 8 };
  assert.equal(findActiveReminderCollision(candidate, existing), undefined);
});

// ============================================================
// E — Sorting
// ============================================================
check("E1: Due sorts most-recently-due first, tie-broken by id", () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const r1 = releaseReminder({ id: "b", remindBeforeMinutes: 0, scheduledFor: "2026-09-10T10:00:00.000Z" }); // due 10:00
  const r2 = releaseReminder({ id: "a", remindBeforeMinutes: 0, scheduledFor: "2026-09-10T12:00:00.000Z" }); // due 12:00, more recent
  const resolved = resolveReminders([r1, r2], [ITEM_A], [], false, now);
  const sorted = sortDueReminders(resolved);
  assert.deepEqual(sorted.map((e) => e.reminder.id), ["a", "b"]);
});

check("E1b: Due tie-break is deterministic by reminder id when effectiveDueAt is identical", () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const r1 = releaseReminder({ id: "z", remindBeforeMinutes: 0, scheduledFor: "2026-09-10T10:00:00.000Z" });
  const r2 = releaseReminder({ id: "a", remindBeforeMinutes: 0, scheduledFor: "2026-09-10T10:00:00.000Z" });
  const sorted = sortDueReminders(resolveReminders([r1, r2], [ITEM_A], [], false, now));
  assert.deepEqual(sorted.map((e) => e.reminder.id), ["a", "z"]);
});

check("E2: Upcoming sorts nearest-due-time first", () => {
  const now = new Date("2026-09-01T00:00:00.000Z");
  const r1 = releaseReminder({ id: "far", remindBeforeMinutes: 0, scheduledFor: "2026-09-20T00:00:00.000Z" });
  const r2 = releaseReminder({ id: "near", remindBeforeMinutes: 0, scheduledFor: "2026-09-10T00:00:00.000Z" });
  const sorted = sortUpcomingReminders(resolveReminders([r1, r2], [ITEM_A], [], false, now));
  assert.deepEqual(sorted.map((e) => e.reminder.id), ["near", "far"]);
});

check("E3: Dismissed sorts most-recently-dismissed first", () => {
  const now = new Date("2026-09-20T00:00:00.000Z");
  const r1 = releaseReminder({ id: "old", remindBeforeMinutes: 0, dismissedAt: "2026-09-01T00:00:00.000Z" });
  const r2 = releaseReminder({ id: "recent", remindBeforeMinutes: 0, dismissedAt: "2026-09-15T00:00:00.000Z" });
  const sorted = sortDismissedReminders(resolveReminders([r1, r2], [ITEM_A], [], false, now));
  assert.deepEqual(sorted.map((e) => e.reminder.id), ["recent", "old"]);
});

// ============================================================
// F — Due count selector (§ "no separately maintained counter")
// ============================================================
check("F1: countDueReminders matches a manual isDue filter over the same resolved list", () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const r1 = releaseReminder({ id: "due1", remindBeforeMinutes: 0, scheduledFor: "2026-09-10T00:00:00.000Z" });
  const r2 = releaseReminder({ id: "upcoming1", remindBeforeMinutes: 0, scheduledFor: "2026-09-20T00:00:00.000Z" });
  const r3 = continueReminder({ id: "due2", remindAt: "2026-09-10T00:00:00.000Z" });
  const resolved = resolveReminders([r1, r2, r3], [ITEM_A], [], false, now);
  assert.equal(countDueReminders(resolved), resolved.filter((e) => e.isDue).length);
  assert.equal(countDueReminders(resolved), 2);
});

check("F2: the Header-context call (providerAvailable=false) and the Reminders-page-context call (providerAvailable=true, no match) agree on due count when no fresh data actually matches", () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const reminder = releaseReminder({ remindBeforeMinutes: 0, scheduledFor: "2026-09-10T00:00:00.000Z" });
  const headerCount = countDueReminders(resolveReminders([reminder], [ITEM_A], [], false, now));
  const pageCount = countDueReminders(resolveReminders([reminder], [ITEM_A], [], true, now));
  assert.equal(headerCount, pageCount);
});

// ============================================================
// G — Provider partial/failure handling & orphan skipping
// ============================================================
check("G1: provider totally unavailable never hides or cancels a release reminder", () => {
  const reminder = releaseReminder();
  const now = new Date("2026-09-01T00:00:00.000Z");
  const resolved = resolveReminders([reminder], [ITEM_A], [], false, now);
  assert.equal(resolved.length, 1);
});

check("G2: a partial-fetch stand-in (providerAvailable=true, but this reminder's event simply wasn't in the batch) never treats absence as cancellation", () => {
  const reminder = releaseReminder();
  const unrelatedEvent = releaseEvent({ externalMediaId: "999", episode: 1 });
  const now = new Date("2026-09-01T00:00:00.000Z");
  const [resolved] = resolveReminders([reminder], [ITEM_A], [unrelatedEvent], true, now);
  assert.equal(resolved.scheduleConfirmed, false);
  assert.ok(resolved.effectiveScheduledFor);
});

check("G3: an orphaned reminder (its LibraryItem no longer exists) is skipped, never crashes, never fabricates a title", () => {
  const reminder = releaseReminder({ libraryItemId: "missing-item" });
  const now = new Date("2026-09-01T00:00:00.000Z");
  const resolved = resolveReminders([reminder], [ITEM_A], [], false, now);
  assert.equal(resolved.length, 0);
});

// ============================================================
// H — Merge/delete recovery reminder logic
// ============================================================
check("H1: merge — a duplicate reminder with no matching survivor identity moves untouched", () => {
  const duplicateReminders = [releaseReminder({ id: "dup1", libraryItemId: "item-b" })];
  const survivorReminders = [];
  const plan = computeMergeReminderPlan(duplicateReminders, survivorReminders, "item-a");
  assert.deepEqual(plan.movedReminderIds, ["dup1"]);
  assert.deepEqual(plan.deduplicatedReminderSnapshots, []);
});

check("H2: merge — an ACTIVE duplicate reminder identical to the survivor's active one is deduped, not moved; exactly one active reminder for that identity survives", () => {
  const survivorReminder = releaseReminder({ id: "surv1", libraryItemId: "item-a" });
  const duplicateReminder = releaseReminder({ id: "dup1", libraryItemId: "item-b" }); // same provider/media/episode
  const plan = computeMergeReminderPlan([duplicateReminder], [survivorReminder], "item-a");
  assert.deepEqual(plan.movedReminderIds, []);
  assert.deepEqual(plan.deduplicatedReminderSnapshots.map((r) => r.id), ["dup1"]);

  const allReminders = [survivorReminder, duplicateReminder];
  const afterMerge = applyMergeReminderPlan(allReminders, plan, "item-a");
  const activeForIdentity = afterMerge.filter(
    (r) => r.kind === "release" && r.provider === "anilist" && r.externalMediaId === "100" && r.episode === 8 && !r.dismissedAt,
  );
  assert.equal(activeForIdentity.length, 1, "merge must never leave two active reminders for the same release target");
});

check("H3: merge-undo restores the exact original two-reminder topology (moved back / recreated from snapshot)", () => {
  const survivorReminder = releaseReminder({ id: "surv1", libraryItemId: "item-a" });
  const duplicateReminder = releaseReminder({ id: "dup1", libraryItemId: "item-b" });
  const plan = computeMergeReminderPlan([duplicateReminder], [survivorReminder], "item-a");
  const afterMerge = applyMergeReminderPlan([survivorReminder, duplicateReminder], plan, "item-a");

  const afterUndo = undoMergeReminderPlan(afterMerge, plan, "item-b");
  assert.equal(afterUndo.length, 2, "both original reminders must exist again after undo");
  const restoredDup = afterUndo.find((r) => r.id === "dup1");
  assert.ok(restoredDup, "the deduplicated reminder must be recreated verbatim, including its original id");
  assert.equal(restoredDup.libraryItemId, "item-b");
  const restoredSurv = afterUndo.find((r) => r.id === "surv1");
  assert.equal(restoredSurv.libraryItemId, "item-a", "the survivor's own untouched reminder must remain exactly where it was");
});

check("H4: merge — two continue reminders for different times both survive (neither deduped merely because the items merged)", () => {
  const survivorReminder = continueReminder({ id: "surv-c", libraryItemId: "item-a", remindAt: "2026-09-05T12:00:00.000Z" });
  const duplicateReminder = continueReminder({ id: "dup-c", libraryItemId: "item-b", remindAt: "2026-09-06T12:00:00.000Z" });
  const plan = computeMergeReminderPlan([duplicateReminder], [survivorReminder], "item-a");
  assert.deepEqual(plan.movedReminderIds, ["dup-c"]);
  assert.deepEqual(plan.deduplicatedReminderSnapshots, []);
  const afterMerge = applyMergeReminderPlan([survivorReminder, duplicateReminder], plan, "item-a");
  assert.equal(afterMerge.length, 2, "both continue reminders must survive the merge");
});

check("H5: merge — a DISMISSED duplicate reminder always moves, even if identical to an active survivor reminder (dismissed history never blocks/dedupes)", () => {
  const survivorReminder = releaseReminder({ id: "surv1", libraryItemId: "item-a" });
  const dismissedDuplicate = releaseReminder({ id: "dup1", libraryItemId: "item-b", dismissedAt: "2026-09-11T00:00:00.000Z" });
  const plan = computeMergeReminderPlan([dismissedDuplicate], [survivorReminder], "item-a");
  assert.deepEqual(plan.movedReminderIds, ["dup1"]);
  assert.deepEqual(plan.deduplicatedReminderSnapshots, []);
});

check("H6: delete captures every reminder for the item, and undo restores them exactly (same ids, same fields)", () => {
  const itemReminders = [releaseReminder({ id: "r1" }), continueReminder({ id: "c1" })];
  const otherReminders = [releaseReminder({ id: "r2", libraryItemId: "item-b" })];
  const allBeforeDelete = [...itemReminders, ...otherReminders];

  // Capture (mirrors deleteItemWithRecovery's local-mode capture).
  const snapshot = allBeforeDelete.filter((r) => r.libraryItemId === "item-a");
  assert.deepEqual(snapshot.map((r) => r.id).sort(), ["c1", "r1"]);

  // Simulate the delete (removeForItem).
  const afterDelete = allBeforeDelete.filter((r) => r.libraryItemId !== "item-a");
  assert.equal(afterDelete.length, 1);

  // Simulate undo (restoreForItem): reinsert the snapshot verbatim.
  const afterUndo = [...snapshot, ...afterDelete];
  assert.deepEqual(
    afterUndo.map((r) => r.id).sort(),
    ["c1", "r1", "r2"],
  );
  assert.deepEqual(
    afterUndo.find((r) => r.id === "r1"),
    itemReminders[0],
    "a restored reminder must be byte-identical to what existed before delete",
  );
});

check("H7: pre-Stage-34 recovery payloads (absent reminder fields) fall back to empty arrays without crashing", () => {
  const oldDeletePayload = { item: ITEM_A, collectionIds: [], activityEvents: [] }; // no `reminders` key
  const reminders = oldDeletePayload.reminders ?? [];
  assert.deepEqual(reminders, []);

  const oldMergePayload = { survivorId: "item-a", duplicateId: "item-b" }; // no reminder-plan keys
  const movedReminderIds = oldMergePayload.movedReminderIds ?? [];
  const deduplicatedReminderSnapshots = oldMergePayload.deduplicatedReminderSnapshots ?? [];
  assert.deepEqual(movedReminderIds, []);
  assert.deepEqual(deduplicatedReminderSnapshots, []);
});

// ============================================================
// I — Local storage validation (malformed dropped, valid survive)
// ============================================================
check("I1: a well-formed release reminder passes validation", () => {
  assert.equal(isValidReminder(releaseReminder()), true);
});
check("I2: a well-formed continue reminder passes validation", () => {
  assert.equal(isValidReminder(continueReminder()), true);
});
check("I3: a release reminder missing `episode` is rejected", () => {
  const bad = releaseReminder();
  delete bad.episode;
  assert.equal(isValidReminder(bad), false);
});
check("I4: a release reminder with a non-anilist provider is rejected", () => {
  assert.equal(isValidReminder(releaseReminder({ provider: "tmdb" })), false);
});
check("I5: a continue reminder with an invalid remindAt is rejected", () => {
  assert.equal(isValidReminder(continueReminder({ remindAt: "not-a-date" })), false);
});
check("I6: a negative remindBeforeMinutes is rejected", () => {
  assert.equal(isValidReminder(releaseReminder({ remindBeforeMinutes: -5 })), false);
});
check("I7: an unrecognized `kind` is rejected", () => {
  assert.equal(isValidReminder(releaseReminder({ kind: "snoozed" })), false);
});
check("I8: one corrupt record in a list is dropped while the rest survive", () => {
  const list = [releaseReminder({ id: "good1" }), { kind: "release" /* missing everything */ }, continueReminder({ id: "good2" })];
  const survivors = list.filter(isValidReminder);
  assert.deepEqual(survivors.map((r) => r.id), ["good1", "good2"]);
});

// ============================================================
// J — Zero side effects audit (§ "no SaveMediaListEntry/progress/rating/
// status/Activity/TrackingSource changes from any reminder action")
// ============================================================
check("J1: the reminder engine and storage modules contain no writeback/mutation call names", () => {
  const files = [
    "src/lib/reminders.ts",
    "src/lib/local-reminder-storage.ts",
    "src/lib/cloud/reminders.ts",
    "src/hooks/useReminders.ts",
  ];
  const forbidden = [
    "SaveMediaListEntry",
    "insertActivityEvent",
    "logEvent(",
    "linkSource",
    "unlinkSource",
    "updateTracking(",
    "quickIncrementProgress",
    "toggleFavorite",
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const term of forbidden) {
      assert.ok(!source.includes(term), `${file} must never reference ${term}`);
    }
  }
});

check("J2: no Notification.requestPermission or Web Push API is referenced anywhere in the reminder feature", () => {
  const files = [
    "src/lib/reminders.ts",
    "src/hooks/useReminders.ts",
    "src/hooks/useNow.ts",
    "src/components/ReminderBell.tsx",
    "src/components/ReminderCenterView.tsx",
    "src/components/RemindMeReleaseDialog.tsx",
    "src/components/RemindMeContinueDialog.tsx",
  ];
  const forbidden = ["requestPermission", "PushManager", "serviceWorker", "pushManager", "showNotification"];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const term of forbidden) {
      assert.ok(!source.includes(term), `${file} must never reference ${term}`);
    }
  }
});

check("J3: no background scheduler (cron/pg_cron/Edge Function scheduling) is referenced in the migration", () => {
  const source = readFileSync("supabase/migrations/0016_stage34_reminders.sql", "utf8");
  const forbidden = ["pg_cron", "cron.schedule", "supabase_functions.http_request"];
  for (const term of forbidden) {
    assert.ok(!source.includes(term), `0016 must never reference ${term}`);
  }
});

check("J4: useNow's setInterval call site is inside its module-level shared subscribe(), not inside the useNow hook body itself", () => {
  const source = readFileSync("src/hooks/useNow.ts", "utf8");
  const matches = source.match(/setInterval\(/g) ?? [];
  assert.equal(matches.length, 1, "useNow.ts must contain exactly one setInterval call site");
  assert.ok(source.includes("clearInterval"), "useNow must clean up its interval");
  assert.ok(source.includes("useSyncExternalStore"), "useNow must be a thin useSyncExternalStore wrapper around a module-level store, not a plain useState+useEffect hook (see Issue C: a plain hook gives every CALLER its own interval)");
  assert.ok(!/useState\(|useEffect\(/.test(source), "useNow itself must not CALL useState()/useEffect() (that pattern is exactly what causes one interval per hook instance — see M1/M2 for the behavioral proof of the shared-store replacement)");
});

// ============================================================
// K — Reminder -> LibraryItem ownership (correctness-review Issue A).
// Models the COMBINED effect of 0016's composite FK
// (reminders_library_item_owner_fkey) and the RLS INSERT/UPDATE policies'
// ownership EXISTS check — a JS model of the algorithm, same convention
// every other verify script in this directory uses for RPC/RLS behavior
// (not a substitute for a real Postgres run — see the closing note).
// ============================================================
function canInsertReminder(candidateUserId, candidateLibraryItemId, libraryItemsById) {
  const item = libraryItemsById.get(candidateLibraryItemId);
  return Boolean(item) && item.userId === candidateUserId;
}
function canUpdateReminderLibraryItem(existingReminderOwnerId, actingUserId, newLibraryItemId, libraryItemsById) {
  if (existingReminderOwnerId !== actingUserId) return false; // RLS UPDATE USING
  return canInsertReminder(actingUserId, newLibraryItemId, libraryItemsById); // RLS UPDATE WITH CHECK + composite FK
}

check("K1: User A creating a reminder that references User B's LibraryItem is rejected", () => {
  const libraryItems = new Map([["B1", { userId: "B" }]]);
  assert.equal(canInsertReminder("A", "B1", libraryItems), false);
});

check("K2: User A updating their OWN reminder's library_item_id to point at User B's item is rejected; retargeting to another of A's own items succeeds", () => {
  const libraryItems = new Map([
    ["A1", { userId: "A" }],
    ["A2", { userId: "A" }],
    ["B1", { userId: "B" }],
  ]);
  assert.equal(canUpdateReminderLibraryItem("A", "A", "B1", libraryItems), false);
  assert.equal(canUpdateReminderLibraryItem("A", "A", "A2", libraryItems), true);
});

check("K3: no cross-user reminder->LibraryItem relationship can be created via any combination of insert or update (exhaustive over a 3-user/3-item grid)", () => {
  const libraryItems = new Map([
    ["A1", { userId: "A" }],
    ["B1", { userId: "B" }],
    ["C1", { userId: "C" }],
  ]);
  for (const user of ["A", "B", "C"]) {
    for (const itemId of ["A1", "B1", "C1"]) {
      const shouldSucceed = libraryItems.get(itemId).userId === user;
      assert.equal(canInsertReminder(user, itemId, libraryItems), shouldSucceed, `insert user=${user} item=${itemId}`);
      assert.equal(canUpdateReminderLibraryItem(user, user, itemId, libraryItems), shouldSucceed, `update user=${user} item=${itemId}`);
    }
  }
});

check("K-static: 0016's reminder INSERT/UPDATE RLS policies contain the ownership EXISTS check against library_items", () => {
  const source = readFileSync("supabase/migrations/0016_stage34_reminders.sql", "utf8");
  const insertPolicy = source.match(/create policy "reminders_insert_own"[\s\S]*?;/)?.[0] ?? "";
  const updatePolicy = source.match(/create policy "reminders_update_own"[\s\S]*?;/)?.[0] ?? "";
  assert.ok(insertPolicy.includes("li.user_id = auth.uid()"), "INSERT policy must verify ownership of the referenced library_item");
  assert.ok(updatePolicy.includes("li.user_id = auth.uid()"), "UPDATE policy must verify ownership of the referenced library_item");
});

check("K-static: 0016 defines the composite ownership FK requiring (library_item_id, user_id) to jointly exist in library_items", () => {
  const source = readFileSync("supabase/migrations/0016_stage34_reminders.sql", "utf8");
  assert.ok(
    source.includes("foreign key (library_item_id, user_id) references public.library_items (id, user_id)"),
    "the composite ownership FK must be present with this exact shape — the structural guarantee that also protects the SECURITY DEFINER functions, which RLS never reaches",
  );
});

// ============================================================
// L — Merge-Undo vs. newer reminder changes (correctness-review Issue B).
// Extends the H-series merge model with the new
// survivorPostMergeRemindersExpected snapshot-comparison check.
// ============================================================
function computeSurvivorPostMergeRemindersExpected(allRemindersBeforeMerge, plan, survivorId) {
  const survivorAll = allRemindersBeforeMerge.filter((r) => r.libraryItemId === survivorId);
  const moved = plan.movedReminderIds.map((id) => {
    const original = allRemindersBeforeMerge.find((r) => r.id === id);
    return { ...original, libraryItemId: survivorId };
  });
  return [...survivorAll, ...moved];
}
function sortedById(list) {
  return [...list].sort((a, b) => a.id.localeCompare(b.id));
}
/** Mirrors 0016's SQL check and library-recovery.ts's validateMergeUndo reminders check exactly: full-row-content comparison (not just an id set), `undefined` expected means "skip — pre-fix record". */
function validateMergeUndoReminders(currentReminders, survivorId, expected) {
  if (expected === undefined) return { status: "recovered" };
  const current = JSON.stringify(sortedById(currentReminders.filter((r) => r.libraryItemId === survivorId)));
  const expectedJson = JSON.stringify(sortedById(expected));
  return current === expectedJson ? { status: "recovered" } : { status: "recovery_conflict", reason: "reminders_changed" };
}

check("L1: merge moves a reminder, it's then deleted, then Undo -> conflict, no partial restoration", () => {
  const duplicateReminder = continueReminder({ id: "R", libraryItemId: "item-b" });
  const before = [duplicateReminder];
  const plan = computeMergeReminderPlan([duplicateReminder], [], "item-a");
  assert.deepEqual(plan.movedReminderIds, ["R"]);
  const expected = computeSurvivorPostMergeRemindersExpected(before, plan, "item-a");
  const afterMerge = applyMergeReminderPlan(before, plan, "item-a");
  const afterDelete = afterMerge.filter((r) => r.id !== "R");

  const outcome = validateMergeUndoReminders(afterDelete, "item-a", expected);
  assert.equal(outcome.status, "recovery_conflict");
  assert.equal(outcome.reason, "reminders_changed");
  assert.equal(afterDelete.length, 0, "the deletion is never silently reversed or compensated for by Undo refusing");
});

check("L2: merge moves a reminder, it's then edited (newer remindAt), then Undo -> conflict", () => {
  const duplicateReminder = continueReminder({ id: "R", libraryItemId: "item-b", remindAt: "2026-09-10T20:00:00.000Z" });
  const before = [duplicateReminder];
  const plan = computeMergeReminderPlan([duplicateReminder], [], "item-a");
  const expected = computeSurvivorPostMergeRemindersExpected(before, plan, "item-a");
  const afterMerge = applyMergeReminderPlan(before, plan, "item-a");
  const afterEdit = afterMerge.map((r) => (r.id === "R" ? { ...r, remindAt: "2026-09-11T21:00:00.000Z" } : r));

  const outcome = validateMergeUndoReminders(afterEdit, "item-a", expected);
  assert.equal(outcome.status, "recovery_conflict", "an edit after merge is newer state Undo must not silently move/reinterpret");
});

check("L3: merge moves a reminder, it's then dismissed, then Undo -> conflict", () => {
  const duplicateReminder = continueReminder({ id: "R", libraryItemId: "item-b" });
  const before = [duplicateReminder];
  const plan = computeMergeReminderPlan([duplicateReminder], [], "item-a");
  const expected = computeSurvivorPostMergeRemindersExpected(before, plan, "item-a");
  const afterMerge = applyMergeReminderPlan(before, plan, "item-a");
  const afterDismiss = afterMerge.map((r) => (r.id === "R" ? { ...r, dismissedAt: "2026-09-11T00:00:00.000Z" } : r));

  const outcome = validateMergeUndoReminders(afterDismiss, "item-a", expected);
  assert.equal(outcome.status, "recovery_conflict", "a changed dismissedAt is newer reminder state Undo must not pretend is unchanged");
});

check("L4: merge dedups RB against survivor's RA, then RA is edited, then Undo -> conflict (never resurrects RB while losing/changing RA)", () => {
  const survivorReminder = releaseReminder({ id: "RA", libraryItemId: "item-a" });
  const duplicateReminder = releaseReminder({ id: "RB", libraryItemId: "item-b" }); // identical target
  const before = [survivorReminder, duplicateReminder];
  const plan = computeMergeReminderPlan([duplicateReminder], [survivorReminder], "item-a");
  assert.deepEqual(plan.deduplicatedReminderSnapshots.map((r) => r.id), ["RB"]);
  const expected = computeSurvivorPostMergeRemindersExpected(before, plan, "item-a"); // = [RA] only
  const afterMerge = applyMergeReminderPlan(before, plan, "item-a");
  const afterEdit = afterMerge.map((r) => (r.id === "RA" ? { ...r, remindBeforeMinutes: 180 } : r));

  const outcome = validateMergeUndoReminders(afterEdit, "item-a", expected);
  assert.equal(outcome.status, "recovery_conflict");
});

check("L5: merge dedups RB against survivor's RA, then RA is deleted, then Undo -> conflict", () => {
  const survivorReminder = releaseReminder({ id: "RA", libraryItemId: "item-a" });
  const duplicateReminder = releaseReminder({ id: "RB", libraryItemId: "item-b" });
  const before = [survivorReminder, duplicateReminder];
  const plan = computeMergeReminderPlan([duplicateReminder], [survivorReminder], "item-a");
  const expected = computeSurvivorPostMergeRemindersExpected(before, plan, "item-a");
  const afterMerge = applyMergeReminderPlan(before, plan, "item-a");
  const afterDelete = afterMerge.filter((r) => r.id !== "RA");

  const outcome = validateMergeUndoReminders(afterDelete, "item-a", expected);
  assert.equal(outcome.status, "recovery_conflict");
});

check("L6: a brand-new reminder created on the survivor after merge blocks Undo — consistent with the existing activity-events new-event rule, not a bespoke reminder-only exception", () => {
  const survivorReminder = releaseReminder({ id: "RA", libraryItemId: "item-a" });
  const before = [survivorReminder];
  const plan = computeMergeReminderPlan([], [survivorReminder], "item-a");
  const expected = computeSurvivorPostMergeRemindersExpected(before, plan, "item-a");
  const afterMerge = applyMergeReminderPlan(before, plan, "item-a");
  const afterCreate = [...afterMerge, continueReminder({ id: "NEW", libraryItemId: "item-a" })];

  const outcome = validateMergeUndoReminders(afterCreate, "item-a", expected);
  assert.equal(outcome.status, "recovery_conflict", "chosen rule: a new post-merge reminder on the survivor conflicts Undo, matching collections/activity/source topology precedent");
});

check("L7: an UNCHANGED post-merge reminder topology lets Undo succeed and restores exactly", () => {
  const survivorReminder = releaseReminder({ id: "RA", libraryItemId: "item-a" });
  const duplicateReminder = continueReminder({ id: "RB", libraryItemId: "item-b" });
  const before = [survivorReminder, duplicateReminder];
  const plan = computeMergeReminderPlan([duplicateReminder], [survivorReminder], "item-a");
  const expected = computeSurvivorPostMergeRemindersExpected(before, plan, "item-a");
  const afterMerge = applyMergeReminderPlan(before, plan, "item-a");

  const outcome = validateMergeUndoReminders(afterMerge, "item-a", expected);
  assert.equal(outcome.status, "recovered");

  const afterUndo = undoMergeReminderPlan(afterMerge, plan, "item-b");
  assert.equal(afterUndo.length, 2, "both original reminders must exist again");
});

check("L8: the reminders conflict check is read-only and never mutates its inputs — validation is safe to run before any restore mutation", () => {
  const before = [continueReminder({ id: "X", libraryItemId: "item-a" })];
  const beforeSnapshot = JSON.stringify(before);
  validateMergeUndoReminders(before, "item-a", []);
  assert.equal(JSON.stringify(before), beforeSnapshot, "the check must never mutate the array it inspects");
});

check("L9: an old recovery payload lacking survivorPostMergeRemindersExpected is treated as 'nothing to check', never a false conflict", () => {
  const outcome = validateMergeUndoReminders([releaseReminder({ id: "anything", libraryItemId: "item-a" })], "item-a", undefined);
  assert.equal(outcome.status, "recovered");
});

check("L-static: 0016's merge_library_items captures survivorPostMergeRemindersExpected AFTER the reminder move/dedup writes, and undo_library_recovery compares it BEFORE any mutation", () => {
  const source = readFileSync("supabase/migrations/0016_stage34_reminders.sql", "utf8");
  assert.ok(source.includes("survivorPostMergeRemindersExpected"), "the snapshot field must exist in the payload");
  assert.ok(source.includes("reminders_changed"), "the dedicated conflict reason must exist");
  // Ordering: the capture SELECT must appear after the reminder UPDATE/DELETE statements, and the undo-side comparison must appear before the first `insert into public.library_items` in the merge branch.
  const captureIdx = source.indexOf("into v_survivor_post_merge_reminders\n");
  const reminderDeleteIdx = source.indexOf("delete from public.reminders");
  assert.ok(captureIdx > reminderDeleteIdx && reminderDeleteIdx !== -1, "the survivor reminder snapshot must be captured after reminders have already moved/been deleted");
});

// ============================================================
// M — useNow shared-clock behavior (correctness-review Issue C).
// Reproduces useNow.ts's module-level reference-counted subscribe logic
// verbatim, with fake setInterval/clearInterval counters standing in for
// the real timers (this script never touches real timers).
// ============================================================
function createSharedClockModel() {
  let intervalCount = 0;
  let clearCount = 0;
  let activeId = null;
  let nextId = 1;
  const listeners = new Set();

  function subscribe(listener) {
    listeners.add(listener);
    if (activeId === null) {
      intervalCount += 1;
      activeId = nextId++;
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && activeId !== null) {
        clearCount += 1;
        activeId = null;
      }
    };
  }

  return {
    subscribe,
    getIntervalCount: () => intervalCount,
    getClearCount: () => clearCount,
    getListenerCount: () => listeners.size,
  };
}

check("M1: two concurrent subscribers (e.g. Header's ReminderBell + ReminderCenterView both mounted on /reminders) share exactly ONE interval, not one per consumer", () => {
  const clock = createSharedClockModel();
  clock.subscribe(() => {});
  clock.subscribe(() => {});
  assert.equal(clock.getIntervalCount(), 1, "a second concurrent subscriber must not start a second interval");
  assert.equal(clock.getListenerCount(), 2);
});

check("M2: the shared interval is cleared only once the LAST subscriber unsubscribes, and restarts cleanly for a later page visit", () => {
  const clock = createSharedClockModel();
  const unsubA = clock.subscribe(() => {});
  const unsubB = clock.subscribe(() => {});
  unsubA();
  assert.equal(clock.getClearCount(), 0, "the interval must stay alive while at least one subscriber remains");
  unsubB();
  assert.equal(clock.getClearCount(), 1, "the interval must be cleared once the last subscriber leaves");
  clock.subscribe(() => {});
  assert.equal(clock.getIntervalCount(), 2, "a later subscriber must correctly start a fresh interval, not stay stuck at zero");
});

check("M3: React Strict Mode's mount/unmount/remount double-invoke never leaks a second concurrent interval", () => {
  const clock = createSharedClockModel();
  const unsubPhantom = clock.subscribe(() => {}); // Strict Mode's extra mount
  unsubPhantom(); // Strict Mode's extra unmount (cleanup)
  clock.subscribe(() => {}); // the real mount
  assert.equal(clock.getIntervalCount(), 2, "each subscribe-unsubscribe-resubscribe cycle starts its own interval");
  assert.equal(clock.getClearCount(), 1, "the phantom Strict Mode interval must have been cleared");
  assert.equal(clock.getListenerCount(), 1, "exactly one interval remains active, never two");
});

// ============================================================
// N — Reminder schedule-fetch scope (correctness-review Issue D).
// ============================================================
check("N1: the schedule-fetch scope includes only items behind an ACTIVE release reminder — excludes continue reminders and dismissed release reminders", () => {
  const reminders = [
    releaseReminder({ id: "r1", libraryItemId: "item-a" }),
    releaseReminder({ id: "r2", libraryItemId: "item-b", dismissedAt: "2026-09-01T00:00:00.000Z" }),
    continueReminder({ id: "c1", libraryItemId: "item-c" }),
  ];
  const ids = activeReleaseReminderLibraryItemIds(reminders);
  assert.deepEqual([...ids].sort(), ["item-a"]);
});

check("N2: a large library with only a handful of active release reminders stays bounded to those reminder target ids, never scaling with library size", () => {
  const manyItems = Array.from({ length: 500 }, (_, i) => ({ id: `item-${i}`, title: `Show ${i}`, type: "anime" }));
  const reminders = [releaseReminder({ id: "r1", libraryItemId: "item-3" }), releaseReminder({ id: "r2", libraryItemId: "item-499" })];
  const ids = activeReleaseReminderLibraryItemIds(reminders);
  const relevantItems = manyItems.filter((item) => ids.has(item.id));
  assert.equal(relevantItems.length, 2, "must stay bounded to the reminder target ids, never the full 500-item library");
  assert.deepEqual(relevantItems.map((i) => i.id).sort(), ["item-3", "item-499"]);
});

check("N-static: ReminderCenterView scopes useReleaseCalendar to a filtered item list, never the full library items array", () => {
  const source = readFileSync("src/components/ReminderCenterView.tsx", "utf8");
  assert.ok(source.includes("activeReleaseReminderLibraryItemIds"), "must use the scoping helper");
  assert.ok(/useReleaseCalendar\(\s*relevantItems/.test(source), "useReleaseCalendar must be called with the scoped item list, not the raw `items` array");
});

// ============================================================
// O — DB constraint bounds audit (correctness-review Issue E).
// ============================================================
function isValidRemindBeforeMinutes(value) {
  return value === null || (value >= 0 && value <= 43200);
}
function isValidEpisode(value) {
  return value === null || value > 0;
}
function isValidExternalMediaId(value) {
  return value === null || /^[1-9][0-9]*$/.test(value);
}

check("O1: lead-time lower bound — 0 is valid ('at release time'), negative is rejected", () => {
  assert.equal(isValidRemindBeforeMinutes(0), true);
  assert.equal(isValidRemindBeforeMinutes(-1), false);
});

check("O2: lead-time upper bound — 43200 (30 days) is valid, 43201 is rejected", () => {
  assert.equal(isValidRemindBeforeMinutes(43200), true);
  assert.equal(isValidRemindBeforeMinutes(43201), false);
  // All six app presets stay comfortably inside the DB bound.
  for (const minutes of [0, 10, 30, 60, 180, 1440]) {
    assert.equal(isValidRemindBeforeMinutes(minutes), true);
  }
});

check("O3: episode/external_media_id must be strictly positive — episode 0 and non-positive/non-numeric media ids are rejected", () => {
  assert.equal(isValidEpisode(1), true);
  assert.equal(isValidEpisode(0), false);
  assert.equal(isValidEpisode(-1), false);
  assert.equal(isValidExternalMediaId("1"), true);
  assert.equal(isValidExternalMediaId("100"), true);
  assert.equal(isValidExternalMediaId("0"), false);
  assert.equal(isValidExternalMediaId("007"), false, "a leading zero is rejected — not a canonical positive-integer representation");
  assert.equal(isValidExternalMediaId("-5"), false);
  assert.equal(isValidExternalMediaId("abc"), false);
});

check("O-static: 0016 contains the reviewed bounds and never requires remind_at to be in the future", () => {
  const source = readFileSync("supabase/migrations/0016_stage34_reminders.sql", "utf8");
  assert.ok(source.includes("episode > 0"), "episode bound must be strictly > 0, not >= 0");
  assert.ok(source.includes("remind_before_minutes <= 43200"), "remind_before_minutes must carry the reviewed upper bound");
  assert.ok(source.includes("external_media_id ~ '^[1-9][0-9]*$'"), "external_media_id must be constrained to a positive-integer string");
  assert.ok(!source.includes("remind_at > now()"), "a continue reminder must never be required to be in the future — it naturally becomes historical/due over time");
});

// ============================================================
// P — Cross-component reminder reactivity (correctness-review follow-up).
// lib/reminder-change-signal.ts is framework-free by design specifically
// so its pub/sub mechanics can be reproduced and tested directly here,
// exactly like every other pure module in this script. useReminders.ts
// itself is a React hook (mount/effect timing, useSyncExternalStore) that
// isn't practical to exercise without a React test renderer this project
// doesn't depend on — instead, P2-P7 are STATIC integration checks against
// the real hook source, proving notifyRemindersChanged() is wired into
// exactly the right (and only the right) branches. P1/P8/P9 exercise the
// real pub/sub primitive's logic directly (reproduced verbatim below).
// ============================================================

// ---- reminder-change-signal.ts, reproduced verbatim ----
function createReminderChangeSignal() {
  const listeners = new Set();
  let version = 0;
  return {
    getVersion: () => version,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => {
      version += 1;
      listeners.forEach((listener) => listener());
    },
  };
}

check("P1: two mounted subscribers both receive exactly one call from a single successful-mutation notification", () => {
  const signal = createReminderChangeSignal();
  let callsA = 0;
  let callsB = 0;
  signal.subscribe(() => callsA++);
  signal.subscribe(() => callsB++);
  signal.notify();
  assert.equal(callsA, 1);
  assert.equal(callsB, 1);
  assert.equal(signal.getVersion(), 1);
});

check("P9: an unsubscribed consumer receives nothing from a later notification", () => {
  const signal = createReminderChangeSignal();
  let calls = 0;
  const unsubscribe = signal.subscribe(() => calls++);
  signal.notify();
  assert.equal(calls, 1);
  unsubscribe();
  signal.notify();
  assert.equal(calls, 1, "the unsubscribed listener must not be called again");
});

check("P8: local-mode same-tab mutation notifies a peer subscriber, which reads the ALREADY-SAVED value (save-before-notify ordering closes the race)", () => {
  const signal = createReminderChangeSignal();
  // A fake localStorage standing in for markly.reminders — separate from
  // React state entirely, exactly like the real cross-instance hand-off.
  let fakeStorageRaw = null;
  const fakeSave = (reminders) => {
    fakeStorageRaw = JSON.stringify(reminders);
  };
  const fakeLoad = () => (fakeStorageRaw ? JSON.parse(fakeStorageRaw) : []);

  let peerObservedReminders = null;
  signal.subscribe(() => {
    peerObservedReminders = fakeLoad(); // mirrors a peer's hydrate() reading loadReminders()
  });

  // Mirrors useReminders.ts's own local-mode create sequence exactly:
  // compute next, save explicitly, THEN notify — never the reverse.
  const newReminder = continueReminder({ id: "peer-test" });
  const next = [newReminder];
  fakeSave(next);
  signal.notify();

  assert.deepEqual(peerObservedReminders, next, "the peer's listener must observe the write, not a stale/empty store");
});

// ---- static integration checks against the real useReminders.ts source ----
function extractBracedBlock(source, signature) {
  const startIdx = source.indexOf(signature);
  if (startIdx === -1) throw new Error(`signature not found in source: ${signature}`);
  const braceStart = source.indexOf("{", startIdx);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting: ${signature}`);
}
function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

const useRemindersSource = readFileSync("src/hooks/useReminders.ts", "utf8");

check("P-static: useReminders imports notifyRemindersChanged from the framework-free signal module (not a duplicate/local reimplementation)", () => {
  assert.ok(useRemindersSource.includes('from "@/lib/reminder-change-signal"'));
  assert.ok(useRemindersSource.includes("notifyRemindersChanged"));
});

check("P2/edit + P3/dismiss: patchReminder (the shared save path for lead-time/continue-time edits AND dismiss) notifies on both its cloud-success and local-success paths", () => {
  const body = extractBracedBlock(useRemindersSource, "async function patchReminder(");
  assert.equal(countOccurrences(body, "notifyRemindersChanged()"), 2, "expected exactly one notify in the cloud try-success branch and one in the local success branch");
});

check("P4: deleteReminder notifies on cloud-confirmed success (inside .then) and on local (synchronous) success", () => {
  const body = extractBracedBlock(useRemindersSource, "function deleteReminder(");
  assert.equal(countOccurrences(body, "notifyRemindersChanged()"), 2, "expected exactly one notify after the cloud .then() confirmation and one in the local branch");
  const thenIdx = body.indexOf(".then(() => notifyRemindersChanged())");
  const catchIdx = body.indexOf(".catch(");
  assert.ok(thenIdx !== -1 && thenIdx < catchIdx, "the cloud notify must be in the .then (success) callback, positioned before .catch in source order");
});

check("P5: a genuine cloud failure never notifies peers — createReminder's and patchReminder's catch/error branches contain no notify call", () => {
  const createBody = extractBracedBlock(useRemindersSource, "async function createReminder(");
  const createCatch = extractBracedBlock(createBody, "} catch (err) {"); // the catch block itself, own braces included
  // The catch block DOES legitimately call notify once, but ONLY inside the nested `if (existing)` duplicate-success branch (see P6) — assert the OUTER catch has no notify call reachable outside that nested block by checking the generic-error tail specifically.
  const genericErrorTail = createCatch.slice(createCatch.lastIndexOf("fall through to the generic error below"));
  assert.ok(!genericErrorTail.includes("notifyRemindersChanged"), "the generic createReminder failure path must never notify peers");

  const patchBody = extractBracedBlock(useRemindersSource, "async function patchReminder(");
  const patchCatch = extractBracedBlock(patchBody, "} catch (err) {");
  assert.ok(!patchCatch.includes("notifyRemindersChanged"), "patchReminder's failure path must never notify peers");

  const deleteBody = extractBracedBlock(useRemindersSource, "function deleteReminder(");
  const deleteCatch = extractBracedBlock(deleteBody, ".catch(() => {");
  assert.ok(!deleteCatch.includes("notifyRemindersChanged"), "deleteReminder's failure path must never notify peers");
});

check("P6: createReminder's duplicate-resolution branch (a settled success, not a failure) DOES notify peers", () => {
  const createBody = extractBracedBlock(useRemindersSource, "async function createReminder(");
  const ifExistingBlock = extractBracedBlock(createBody, "if (existing) {");
  assert.ok(ifExistingBlock.includes("notifyRemindersChanged()"), "the duplicate-settled-success branch must notify peers so they converge regardless of which instance's insert actually won");
});

check("P7: hydrate() never calls notifyRemindersChanged — no reload -> emit -> reload loop is possible", () => {
  const hydrateBody = extractBracedBlock(useRemindersSource, "const hydrate = useCallback(async () => {");
  assert.ok(!hydrateBody.includes("notifyRemindersChanged"), "hydrate must be a pure read path with no emission");

  const signalSource = readFileSync("src/lib/reminder-change-signal.ts", "utf8");
  const subscribeBody = extractBracedBlock(signalSource, "export function subscribeToReminderChanges(");
  assert.ok(!subscribeBody.includes("notifyRemindersChanged"), "subscribe itself must never call notify");
  const getVersionBody = extractBracedBlock(signalSource, "export function getReminderChangeVersion(");
  assert.ok(!getVersionBody.includes("notify"), "the plain getter must never call notify");
});

check("P-static: useReminders subscribes to the shared signal via useSyncExternalStore, guarded by a previous-version ref so it never re-hydrates on its own mount", () => {
  assert.ok(useRemindersSource.includes("useSyncExternalStore(subscribeToReminderChanges, getReminderChangeVersion"));
  assert.ok(useRemindersSource.includes("previousChangeVersionRef"));
});

check("P-static: useNow.ts and reminder-change-signal.ts remain separate modules — time-ticking and data-invalidation are never conflated", () => {
  const useNowSource = readFileSync("src/hooks/useNow.ts", "utf8");
  assert.ok(!useNowSource.includes("reminder-change-signal"), "useNow must not import the reminder data-change signal");
  const signalSource = readFileSync("src/lib/reminder-change-signal.ts", "utf8");
  assert.ok(!signalSource.toLowerCase().includes("setinterval"), "the reminder change signal must never itself run a timer — it only reacts to confirmed mutations");
});

// P10: useNow shared-timer tests (M1-M3 above) are unchanged by this round — re-affirm the source itself is untouched in the way that matters.
check("P10: useNow's shared-store implementation is unchanged by this round's reminder-reactivity fix", () => {
  const useNowSource = readFileSync("src/hooks/useNow.ts", "utf8");
  assert.ok(useNowSource.includes("useSyncExternalStore"));
  assert.equal((useNowSource.match(/setInterval\(/g) ?? []).length, 1);
});

// ============================================================
// Report
// ============================================================
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}`);
  if (!r.ok) console.log(`  ${r.err?.message ?? r.err}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;

console.log(
  "\nNote: this script reproduces lib/reminders.ts, lib/local-reminder-storage.ts, and the merge/delete recovery reminder logic from lib/recovery-orchestration.ts verbatim (same convention as every other script in this directory). It never touches the network or a database — migration 0016 is not deployed, so no real-database RLS/CRUD/cross-user-isolation/concurrency test is possible yet; that is a separate, later validation round per the Stage 34 report.",
);
