#!/usr/bin/env node
// Verifies Stage 28 "destructive action recovery & undo" logic:
//   - lib/library-recovery.ts: deepEqual, isRecoveryExpired,
//     validateDeleteUndo, validateMergeUndo, describeRecoveryAction
//     (Tests A-C, H)
//   - lib/local-recovery-storage.ts: the markly.recovery localStorage
//     model — add/load/get/remove, expiry sweep, malformed-entry
//     filtering, the MAX_RECOVERY_ENTRIES cap (Tests D)
//   - supabase/migrations/0010_stage28_library_recovery.sql: the atomic
//     RPCs' control flow — delete_library_item_with_recovery and both
//     branches of undo_library_recovery, including double-undo safety,
//     the source/collection conflict checks, and the "split back"
//     collection-topology restore (Tests E-F)
//   - The full local-mode Delete/Merge-with-recovery + Undo flow end to
//     end, including the exact Chapter-61 acceptance scenario from the
//     Stage 28 spec: a merge, followed by new tracking progress landing
//     on the survivor, followed by an Undo attempt that must refuse
//     rather than discard that progress (Tests G)
//
// Reproduced verbatim from the real modules/SQL rather than imported —
// same approach as every other script in this directory (see
// verify-duplicate-merge.mjs).
//
// IMPORTANT: the RPC-model checks (Tests E-G) validate the ALGORITHM —
// lock/ownership branching, conflict-detection logic — not real
// PostgreSQL transaction/locking behavior under genuinely concurrent
// connections. Real concurrent-undo and concurrent-tracking-during-undo
// behavior can only be proven against a real Supabase project after
// `npx.cmd supabase db push` applies 0010_stage28_library_recovery.sql —
// deliberately NOT run this stage; see the Stage 28 report for the
// planned post-approval real-database test matrix.
//
// Run with: node scripts/verify-library-recovery.mjs

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
// deepEqual, reproduced from lib/library-recovery.ts
// ============================================================
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => deepEqual(entry, b[index]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

const RECOVERY_TTL_MS = 15 * 60 * 1000;

function isRecoveryExpired(entry, now = Date.now()) {
  return new Date(entry.expiresAt).getTime() <= now;
}

function describeRecoveryAction(actionType, title) {
  return actionType === "delete_item" ? `"${title}" deleted.` : `Merged into "${title}".`;
}

function validateDeleteUndo(payload, items, collections) {
  if (items.some((item) => item.id === payload.item.id)) {
    return { status: "recovery_conflict", reason: "id_in_use" };
  }
  const missingCollection = payload.collectionIds.some((id) => !collections.some((c) => c.id === id));
  if (missingCollection) return { status: "recovery_conflict", reason: "collection_missing" };
  return { status: "recovered" };
}

function validateMergeUndo(payload, items, collections, events) {
  const survivor = items.find((item) => item.id === payload.survivorId);
  if (!survivor) return { status: "recovery_conflict", reason: "survivor_missing" };
  if (items.some((item) => item.id === payload.duplicateId)) {
    return { status: "recovery_conflict", reason: "id_in_use" };
  }
  if (!deepEqual(survivor, payload.survivorPostMergeExpected)) {
    return { status: "recovery_conflict", reason: "survivor_changed" };
  }
  const allCollectionIds = [...payload.survivorPreMergeCollectionIds, ...payload.duplicatePreMergeCollectionIds];
  const missingCollection = allCollectionIds.some((id) => !collections.some((c) => c.id === id));
  if (missingCollection) return { status: "recovery_conflict", reason: "collection_missing" };

  // Collection membership lives in Collection.itemIds, a separate array —
  // changing it never touches the LibraryItem object, so deepEqual above
  // can't see it. Compare the survivor's CURRENT membership set against
  // the expected post-merge union of both sides' pre-merge sets.
  const expectedPostMergeIds = new Set(allCollectionIds);
  const currentSurvivorIds = new Set(collections.filter((c) => c.itemIds.includes(payload.survivorId)).map((c) => c.id));
  const topologyChanged =
    expectedPostMergeIds.size !== currentSurvivorIds.size || [...expectedPostMergeIds].some((id) => !currentSurvivorIds.has(id));
  if (topologyChanged) return { status: "recovery_conflict", reason: "collections_changed" };

  // Activity lives in a separate array too, for the same reason — never
  // timestamp-based (see 0012's doc comment for why that was unreliable).
  const expectedActivityIds = new Set([...payload.survivorPreMergeActivityIds, ...payload.movedActivityIds]);
  const currentSurvivorActivityIds = new Set(events.filter((e) => e.itemId === payload.survivorId).map((e) => e.id));
  const activityChanged =
    expectedActivityIds.size !== currentSurvivorActivityIds.size || [...expectedActivityIds].some((id) => !currentSurvivorActivityIds.has(id));
  if (activityChanged) return { status: "recovery_conflict", reason: "survivor_changed" };

  return { status: "recovered" };
}

// ============================================================
// markly.recovery localStorage model, reproduced from
// lib/local-recovery-storage.ts, backed by an in-memory Map standing in
// for window.localStorage.
// ============================================================
const MAX_RECOVERY_ENTRIES = 20;

function makeStore() {
  const backing = new Map();
  return {
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => backing.set(key, value),
  };
}

function isValidRecoveryEntry(value) {
  if (!value || typeof value !== "object") return false;
  return (
    typeof value.id === "string" &&
    (value.actionType === "delete_item" || value.actionType === "merge_items") &&
    typeof value.title === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.expiresAt === "string" &&
    !!value.payload &&
    typeof value.payload === "object"
  );
}

function readAll(store) {
  const raw = store.getItem("markly.recovery");
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValidRecoveryEntry);
}

function writeAll(store, entries) {
  store.setItem("markly.recovery", JSON.stringify(entries));
}

function loadRecoveryActions(store) {
  const all = readAll(store);
  const live = all.filter((entry) => !isRecoveryExpired(entry));
  if (live.length !== all.length) writeAll(store, live);
  return live.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function addRecoveryAction(store, entry) {
  const live = readAll(store).filter((existing) => !isRecoveryExpired(existing));
  writeAll(store, [entry, ...live].slice(0, MAX_RECOVERY_ENTRIES));
}

function removeRecoveryAction(store, id) {
  writeAll(store, readAll(store).filter((entry) => entry.id !== id));
}

function getRecoveryAction(store, id) {
  const entry = readAll(store).find((candidate) => candidate.id === id);
  if (!entry) return null;
  if (isRecoveryExpired(entry)) {
    removeRecoveryAction(store, id);
    return null;
  }
  return entry;
}

// ============================================================
// Test helpers
// ============================================================
function futureIso(msFromNow = RECOVERY_TTL_MS) {
  return new Date(Date.now() + msFromNow).toISOString();
}
function pastIso(msAgo = 1000) {
  return new Date(Date.now() - msAgo).toISOString();
}

function baseItem(overrides = {}) {
  return {
    id: "item-1",
    type: "novel",
    title: "Lord of the Mysteries",
    description: "",
    category: "",
    tags: ["horror"],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "in_progress",
    progressValue: 50,
    progressUnit: "chapter",
    ...overrides,
  };
}

// ============================================================
// A/B/C — validateDeleteUndo / validateMergeUndo / isRecoveryExpired
// ============================================================

check("A1: delete undo recovers when id free and collections exist", () => {
  const payload = { item: baseItem(), collectionIds: ["c1", "c2"], activityEvents: [] };
  const items = [];
  const collections = [{ id: "c1" }, { id: "c2" }];
  assert.deepEqual(validateDeleteUndo(payload, items, collections), { status: "recovered" });
});

check("A2: delete undo conflicts when the original id is back in use", () => {
  const payload = { item: baseItem(), collectionIds: [], activityEvents: [] };
  const items = [baseItem()];
  assert.deepEqual(validateDeleteUndo(payload, items, []), { status: "recovery_conflict", reason: "id_in_use" });
});

check("A3: delete undo conflicts when a collection no longer exists", () => {
  const payload = { item: baseItem(), collectionIds: ["c1", "gone"], activityEvents: [] };
  assert.deepEqual(validateDeleteUndo(payload, [], [{ id: "c1" }]), {
    status: "recovery_conflict",
    reason: "collection_missing",
  });
});

check("A4: delete undo recovers with no collections at all", () => {
  const payload = { item: baseItem(), collectionIds: [], activityEvents: [] };
  assert.deepEqual(validateDeleteUndo(payload, [], []), { status: "recovered" });
});

check("A5 (Task 9 confirmation): delete undo needs no topology-equality check — a deleted item can have no current collection membership at all (it doesn't exist), so existence-of-the-collection is the only thing left to verify", () => {
  // Unlike merge-undo, there is no "current survivor membership" to
  // compare against here — the item's collection_items rows were
  // cascade-deleted along with it (0001), and can't reappear until
  // Undo itself reinserts them. validateDeleteUndo intentionally never
  // reads a per-item current-membership set for this reason.
  const payload = { item: baseItem(), collectionIds: ["c1"], activityEvents: [] };
  assert.deepEqual(validateDeleteUndo(payload, [], [{ id: "c1" }]), { status: "recovered" });
});

check("B1: merge undo recovers when survivor is byte-identical and current collection/activity topology matches the expected post-merge union", () => {
  const survivor = baseItem({ progressValue: 60 });
  const payload = {
    survivorId: "item-1",
    duplicateId: "item-2",
    survivorPostMergeExpected: survivor,
    survivorPreMergeCollectionIds: ["c1"],
    duplicatePreMergeCollectionIds: ["c2"],
    movedActivityIds: ["ev-moved"],
    survivorPreMergeActivityIds: ["ev-own"],
  };
  const collections = [
    { id: "c1", itemIds: ["item-1"] },
    { id: "c2", itemIds: ["item-1"] },
  ];
  const events = [
    { id: "ev-own", itemId: "item-1" },
    { id: "ev-moved", itemId: "item-1" },
  ];
  assert.deepEqual(validateMergeUndo(payload, [survivor], collections, events), { status: "recovered" });
});

check("B2: merge undo conflicts when the survivor no longer exists", () => {
  const payload = {
    survivorId: "item-1",
    duplicateId: "item-2",
    survivorPostMergeExpected: baseItem(),
    survivorPreMergeCollectionIds: [],
    duplicatePreMergeCollectionIds: [],
    movedActivityIds: [],
    survivorPreMergeActivityIds: [],
  };
  assert.deepEqual(validateMergeUndo(payload, [], [], []), { status: "recovery_conflict", reason: "survivor_missing" });
});

check("B3: merge undo conflicts when the duplicate's original id is back in use", () => {
  const survivor = baseItem();
  const payload = {
    survivorId: "item-1",
    duplicateId: "item-2",
    survivorPostMergeExpected: survivor,
    survivorPreMergeCollectionIds: [],
    duplicatePreMergeCollectionIds: [],
    movedActivityIds: [],
    survivorPreMergeActivityIds: [],
  };
  const items = [survivor, baseItem({ id: "item-2" })];
  assert.deepEqual(validateMergeUndo(payload, items, [], []), { status: "recovery_conflict", reason: "id_in_use" });
});

check("B4 (Chapter-61 scenario): merge undo conflicts when the survivor's progress advanced since the merge", () => {
  const survivorAtMergeTime = baseItem({ progressValue: 60 });
  const survivorNow = baseItem({ progressValue: 61 }); // a real tracking update landed after the merge
  const payload = {
    survivorId: "item-1",
    duplicateId: "item-2",
    survivorPostMergeExpected: survivorAtMergeTime,
    survivorPreMergeCollectionIds: [],
    duplicatePreMergeCollectionIds: [],
    movedActivityIds: [],
    survivorPreMergeActivityIds: [],
  };
  const outcome = validateMergeUndo(payload, [survivorNow], [], []);
  assert.deepEqual(outcome, { status: "recovery_conflict", reason: "survivor_changed" });
  // And critically: the newer progress must still be there — nothing here mutates `items`.
  assert.equal(survivorNow.progressValue, 61);
});

check("B5: merge undo conflicts on any field change, not just progress (e.g. rating)", () => {
  const survivorAtMergeTime = baseItem({ rating: 8 });
  const survivorNow = baseItem({ rating: 9 });
  const payload = {
    survivorId: "item-1",
    duplicateId: "item-2",
    survivorPostMergeExpected: survivorAtMergeTime,
    survivorPreMergeCollectionIds: [],
    duplicatePreMergeCollectionIds: [],
    movedActivityIds: [],
    survivorPreMergeActivityIds: [],
  };
  assert.deepEqual(validateMergeUndo(payload, [survivorNow], [], []), { status: "recovery_conflict", reason: "survivor_changed" });
});

check("B6: merge undo conflicts when a collection from either side's pre-merge set is gone", () => {
  const survivor = baseItem();
  const payload = {
    survivorId: "item-1",
    duplicateId: "item-2",
    survivorPostMergeExpected: survivor,
    survivorPreMergeCollectionIds: ["c1"],
    duplicatePreMergeCollectionIds: ["c2-deleted"],
    movedActivityIds: [],
    survivorPreMergeActivityIds: [],
  };
  assert.deepEqual(validateMergeUndo(payload, [survivor], [{ id: "c1" }], []), {
    status: "recovery_conflict",
    reason: "collection_missing",
  });
});

check("B7: a second, different merge on the survivor is caught by the same survivor-changed check", () => {
  // Recovery A recorded the survivor right after the FIRST merge.
  const survivorAfterFirstMerge = baseItem({ progressValue: 60, title: "Merged Title A" });
  // A second merge then changed it again.
  const survivorAfterSecondMerge = baseItem({ progressValue: 65, title: "Merged Title B" });
  const payload = {
    survivorId: "item-1",
    duplicateId: "item-2",
    survivorPostMergeExpected: survivorAfterFirstMerge,
    survivorPreMergeCollectionIds: [],
    duplicatePreMergeCollectionIds: [],
    movedActivityIds: [],
    survivorPreMergeActivityIds: [],
  };
  assert.deepEqual(validateMergeUndo(payload, [survivorAfterSecondMerge], [], []), {
    status: "recovery_conflict",
    reason: "survivor_changed",
  });
});

check("B8 (local mode): merge → survivor added to a brand-new collection after the merge → Undo is blocked", () => {
  const survivor = baseItem({ id: "s" });
  const payload = {
    survivorId: "s",
    duplicateId: "d",
    survivorPostMergeExpected: survivor,
    survivorPreMergeCollectionIds: ["common"],
    duplicatePreMergeCollectionIds: [],
    movedActivityIds: [],
    survivorPreMergeActivityIds: [],
  };
  // Expected post-merge topology is just "common", but the user has
  // since also added the survivor to "new-collection".
  const collections = [
    { id: "common", itemIds: ["s"] },
    { id: "new-collection", itemIds: ["s"] },
  ];
  assert.deepEqual(validateMergeUndo(payload, [survivor], collections, []), {
    status: "recovery_conflict",
    reason: "collections_changed",
  });
  // Nothing here mutates `collections` — the new membership is untouched.
  assert.ok(collections.find((c) => c.id === "new-collection").itemIds.includes("s"));
});

check("B9 (local mode): merge → survivor manually removed from a unioned collection after the merge → Undo is blocked", () => {
  const survivor = baseItem({ id: "s" });
  const payload = {
    survivorId: "s",
    duplicateId: "d",
    survivorPostMergeExpected: survivor,
    survivorPreMergeCollectionIds: ["common"],
    duplicatePreMergeCollectionIds: ["b"],
    movedActivityIds: [],
    survivorPreMergeActivityIds: [],
  };
  // Expected post-merge topology is {common, b}, but the user has since
  // manually removed the survivor from "b".
  const collections = [
    { id: "common", itemIds: ["s"] },
    { id: "b", itemIds: [] },
  ];
  assert.deepEqual(validateMergeUndo(payload, [survivor], collections, []), {
    status: "recovery_conflict",
    reason: "collections_changed",
  });
  // The removal must not have been silently reverted.
  assert.ok(!collections.find((c) => c.id === "b").itemIds.includes("s"));
});

check("B10 (local mode, 0012 fix): a new Activity event on the survivor after the merge blocks Undo — clock-independent, no timestamp involved at all", () => {
  const survivor = baseItem({ id: "s" });
  const payload = {
    survivorId: "s",
    duplicateId: "d",
    survivorPostMergeExpected: survivor,
    survivorPreMergeCollectionIds: [],
    duplicatePreMergeCollectionIds: [],
    movedActivityIds: ["ev-moved"],
    survivorPreMergeActivityIds: ["ev-own"],
  };
  // A genuinely new event, deliberately given an EARLIER id-less/undated
  // shape (no timestamp field used anywhere in this check) — proves the
  // detection is purely id-set-based, immune to whatever clock produced it.
  const events = [
    { id: "ev-own", itemId: "s" },
    { id: "ev-moved", itemId: "s" },
    { id: "ev-new", itemId: "s" },
  ];
  assert.deepEqual(validateMergeUndo(payload, [survivor], [], events), {
    status: "recovery_conflict",
    reason: "survivor_changed",
  });
  // The new event is untouched — nothing here mutates `events`.
  assert.ok(events.some((e) => e.id === "ev-new" && e.itemId === "s"));
});

check("B11 (local mode): unchanged activity topology → Undo succeeds", () => {
  const survivor = baseItem({ id: "s" });
  const payload = {
    survivorId: "s",
    duplicateId: "d",
    survivorPostMergeExpected: survivor,
    survivorPreMergeCollectionIds: [],
    duplicatePreMergeCollectionIds: [],
    movedActivityIds: ["ev-moved"],
    survivorPreMergeActivityIds: ["ev-own"],
  };
  const events = [
    { id: "ev-own", itemId: "s" },
    { id: "ev-moved", itemId: "s" },
  ];
  assert.deepEqual(validateMergeUndo(payload, [survivor], [], events), { status: "recovered" });
});

check("C1: isRecoveryExpired is false for a future expiry", () => {
  assert.equal(isRecoveryExpired({ expiresAt: futureIso() }), false);
});

check("C2: isRecoveryExpired is true for a past expiry", () => {
  assert.equal(isRecoveryExpired({ expiresAt: pastIso() }), true);
});

check("C3: isRecoveryExpired is true exactly at the boundary (inclusive)", () => {
  const now = Date.now();
  assert.equal(isRecoveryExpired({ expiresAt: new Date(now).toISOString() }, now), true);
});

check("H1: describeRecoveryAction phrases delete_item and merge_items distinctly", () => {
  assert.equal(describeRecoveryAction("delete_item", "Foo"), `"Foo" deleted.`);
  assert.equal(describeRecoveryAction("merge_items", "Foo"), `Merged into "Foo".`);
});

// ============================================================
// D — markly.recovery localStorage model
// ============================================================

check("D1: addRecoveryAction then loadRecoveryActions returns it, newest first", () => {
  const store = makeStore();
  addRecoveryAction(store, { id: "r1", actionType: "delete_item", title: "A", payload: {}, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: futureIso() });
  addRecoveryAction(store, { id: "r2", actionType: "delete_item", title: "B", payload: {}, createdAt: "2026-01-02T00:00:00.000Z", expiresAt: futureIso() });
  const loaded = loadRecoveryActions(store);
  assert.deepEqual(loaded.map((e) => e.id), ["r2", "r1"]);
});

check("D2: loadRecoveryActions filters out and sweeps expired entries", () => {
  const store = makeStore();
  writeAll(store, [
    { id: "live", actionType: "delete_item", title: "Live", payload: {}, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: futureIso() },
    { id: "dead", actionType: "delete_item", title: "Dead", payload: {}, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: pastIso() },
  ]);
  const loaded = loadRecoveryActions(store);
  assert.deepEqual(loaded.map((e) => e.id), ["live"]);
  // Swept from storage too, not just filtered on read.
  assert.deepEqual(readAll(store).map((e) => e.id), ["live"]);
});

check("D3: addRecoveryAction caps at MAX_RECOVERY_ENTRIES, keeping the newest", () => {
  const store = makeStore();
  for (let i = 0; i < 25; i++) {
    addRecoveryAction(store, { id: `r${i}`, actionType: "delete_item", title: `Item ${i}`, payload: {}, createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(), expiresAt: futureIso() });
  }
  const stored = readAll(store);
  assert.equal(stored.length, MAX_RECOVERY_ENTRIES);
  assert.equal(stored[0].id, "r24"); // most recently added stays at the front
  assert.ok(!stored.some((e) => e.id === "r0")); // oldest evicted
});

check("D4: getRecoveryAction returns null and evicts an expired entry", () => {
  const store = makeStore();
  writeAll(store, [{ id: "r1", actionType: "delete_item", title: "A", payload: {}, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: pastIso() }]);
  assert.equal(getRecoveryAction(store, "r1"), null);
  assert.deepEqual(readAll(store), []);
});

check("D5: removeRecoveryAction removes exactly the one entry", () => {
  const store = makeStore();
  addRecoveryAction(store, { id: "r1", actionType: "delete_item", title: "A", payload: {}, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: futureIso() });
  addRecoveryAction(store, { id: "r2", actionType: "delete_item", title: "B", payload: {}, createdAt: "2026-01-02T00:00:00.000Z", expiresAt: futureIso() });
  removeRecoveryAction(store, "r1");
  assert.deepEqual(readAll(store).map((e) => e.id), ["r2"]);
});

check("D6: malformed entries in storage are dropped, not fatal", () => {
  const store = makeStore();
  store.setItem("markly.recovery", JSON.stringify([{ id: "ok", actionType: "delete_item", title: "A", payload: {}, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: futureIso() }, { not: "valid" }, null, "garbage"]));
  assert.deepEqual(readAll(store).map((e) => e.id), ["ok"]);
});

check("D7: double-undo safety — getRecoveryAction after removeRecoveryAction returns null (second concurrent undo sees nothing)", () => {
  const store = makeStore();
  addRecoveryAction(store, { id: "r1", actionType: "delete_item", title: "A", payload: {}, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: futureIso() });
  const first = getRecoveryAction(store, "r1");
  assert.ok(first);
  removeRecoveryAction(store, "r1"); // what a successful undo does on completion
  const second = getRecoveryAction(store, "r1");
  assert.equal(second, null);
});

// ============================================================
// E/F — RPC control-flow model, reproduced from
// supabase/migrations/0010_stage28_library_recovery.sql
// ============================================================

/** A tiny in-memory stand-in for the four tables the RPCs touch, keyed like the real schema. */
function makeDb() {
  return { libraryItems: new Map(), collectionItems: [], activityEvents: [], trackingSources: new Map(), recoveryActions: new Map() };
}

function deleteWithRecovery(db, itemId) {
  const item = db.libraryItems.get(itemId);
  if (!item) return { status: "not_found" };
  const collectionIds = db.collectionItems.filter((ci) => ci.itemId === itemId).map((ci) => ci.collectionId);
  const activityEvents = db.activityEvents.filter((ae) => ae.itemId === itemId).map((ae) => ({ ...ae }));
  const sourceIds = [...db.trackingSources.values()].filter((s) => s.libraryItemId === itemId).map((s) => s.id);
  const recoveryId = `rec-${db.recoveryActions.size + 1}`;
  db.recoveryActions.set(recoveryId, {
    id: recoveryId,
    actionType: "delete_item",
    payload: { item: { ...item }, collectionIds, activityEvents, sourceIds },
    expiresAt: futureIso(),
  });
  db.libraryItems.delete(itemId);
  db.collectionItems = db.collectionItems.filter((ci) => ci.itemId !== itemId);
  db.activityEvents = db.activityEvents.filter((ae) => ae.itemId !== itemId);
  return { status: "deleted", recoveryId };
}

function undoRecovery(db, recoveryId) {
  const recovery = db.recoveryActions.get(recoveryId);
  if (!recovery) return { status: "not_found" };
  if (isRecoveryExpired(recovery)) {
    db.recoveryActions.delete(recoveryId);
    return { status: "expired" };
  }

  if (recovery.actionType === "delete_item") {
    const { item, collectionIds, activityEvents, sourceIds } = recovery.payload;
    if (db.libraryItems.has(item.id)) return { status: "recovery_conflict", reason: "id_in_use" };
    // (collection-existence modeling omitted here — covered by validateDeleteUndo above, which this RPC mirrors)
    const sourceConflict = sourceIds.some((id) => {
      const source = db.trackingSources.get(id);
      return source && source.libraryItemId !== null;
    });
    if (sourceConflict) return { status: "recovery_conflict", reason: "source_claimed_elsewhere" };

    db.libraryItems.set(item.id, item);
    collectionIds.forEach((cid) => db.collectionItems.push({ collectionId: cid, itemId: item.id }));
    activityEvents.forEach((ae) => db.activityEvents.push(ae));
    sourceIds.forEach((id) => {
      const source = db.trackingSources.get(id);
      if (source && source.libraryItemId === null) source.libraryItemId = item.id;
    });
    db.recoveryActions.delete(recoveryId);
    return { status: "recovered", actionType: "delete_item", itemId: item.id };
  }

  const { survivorId, duplicateId, survivorPreMerge, duplicatePreMerge, survivorPostMergeExpected, survivorPreMergeCollectionIds, duplicatePreMergeCollectionIds, movedSourceIds, movedActivityIds, survivorPreMergeActivityIds } = recovery.payload;
  const currentSurvivor = db.libraryItems.get(survivorId);
  if (!currentSurvivor) return { status: "recovery_conflict", reason: "survivor_missing" };
  if (db.libraryItems.has(duplicateId)) return { status: "recovery_conflict", reason: "id_in_use" };
  if (!deepEqual(currentSurvivor, survivorPostMergeExpected)) return { status: "recovery_conflict", reason: "survivor_changed" };

  // 0012 fix: activity_events lives in a separate table too — deepEqual
  // above can't see a new event added to the survivor since the merge.
  // Deliberately id-set-based, NEVER timestamp-based (the original design
  // compared ae.created_at > recovery.created_at, which a real live test
  // proved unreliable under real clock skew between the client that
  // stamps Activity timestamps and the Postgres server that stamps the
  // recovery row — see 0012's own doc comment). Compare the survivor's
  // CURRENT full activity-id set against the expected post-merge union of
  // its own pre-merge ids (which never move) and the ids moved in from
  // the duplicate.
  const expectedActivityIds = new Set([...survivorPreMergeActivityIds, ...movedActivityIds]);
  const currentSurvivorActivityIds = new Set(db.activityEvents.filter((ae) => ae.itemId === survivorId).map((ae) => ae.id));
  const activityChanged =
    expectedActivityIds.size !== currentSurvivorActivityIds.size || [...expectedActivityIds].some((id) => !currentSurvivorActivityIds.has(id));
  if (activityChanged) return { status: "recovery_conflict", reason: "survivor_changed" };

  const sourceConflict = movedSourceIds.some((id) => {
    const source = db.trackingSources.get(id);
    return !source || source.libraryItemId !== survivorId;
  });
  if (sourceConflict) return { status: "recovery_conflict", reason: "source_claimed_elsewhere" };

  // Collection membership lives in collection_items, a separate table —
  // changing it never touches the library_items row, so deepEqual above
  // can't see it. Compare the survivor's CURRENT membership set against
  // the expected post-merge union of both sides' pre-merge sets, BEFORE
  // any mutation below — a mismatch either direction (added or removed
  // since the merge) is real user intent Undo must never discard or
  // resurrect.
  const expectedPostMergeCollectionIds = new Set([...survivorPreMergeCollectionIds, ...duplicatePreMergeCollectionIds]);
  const currentSurvivorCollectionIds = new Set(db.collectionItems.filter((ci) => ci.itemId === survivorId).map((ci) => ci.collectionId));
  const topologyChanged =
    expectedPostMergeCollectionIds.size !== currentSurvivorCollectionIds.size ||
    [...expectedPostMergeCollectionIds].some((id) => !currentSurvivorCollectionIds.has(id));
  if (topologyChanged) return { status: "recovery_conflict", reason: "collections_changed" };

  db.libraryItems.set(duplicateId, { ...duplicatePreMerge });
  db.libraryItems.set(survivorId, { ...survivorPreMerge });

  // "Split back": survivor's current membership is reset to precisely its
  // own recorded set; duplicate gets precisely its own recorded set —
  // never a blind copy of the union.
  db.collectionItems = db.collectionItems.filter((ci) => ci.itemId !== survivorId);
  survivorPreMergeCollectionIds.forEach((cid) => db.collectionItems.push({ collectionId: cid, itemId: survivorId }));
  duplicatePreMergeCollectionIds.forEach((cid) => db.collectionItems.push({ collectionId: cid, itemId: duplicateId }));

  db.activityEvents = db.activityEvents.map((ae) => (movedActivityIds.includes(ae.id) && ae.itemId === survivorId ? { ...ae, itemId: duplicateId } : ae));

  movedSourceIds.forEach((id) => {
    const source = db.trackingSources.get(id);
    if (source && source.libraryItemId === survivorId) source.libraryItemId = duplicateId;
  });

  db.recoveryActions.delete(recoveryId);
  return { status: "recovered", actionType: "merge_items", survivorId, duplicateId };
}

check("E1: delete_library_item_with_recovery snapshots and removes the item", () => {
  const db = makeDb();
  db.libraryItems.set("item-1", baseItem());
  db.collectionItems.push({ collectionId: "c1", itemId: "item-1" });
  db.activityEvents.push({ id: "ev1", itemId: "item-1", type: "progress_updated" });
  const result = deleteWithRecovery(db, "item-1");
  assert.equal(result.status, "deleted");
  assert.ok(!db.libraryItems.has("item-1"));
  assert.equal(db.collectionItems.length, 0);
  assert.equal(db.activityEvents.length, 0);
  assert.ok(db.recoveryActions.has(result.recoveryId));
});

check("E2: undo_library_recovery restores the exact item/collection/activity rows", () => {
  const db = makeDb();
  db.libraryItems.set("item-1", baseItem());
  db.collectionItems.push({ collectionId: "c1", itemId: "item-1" });
  db.activityEvents.push({ id: "ev1", itemId: "item-1", type: "progress_updated", timestamp: "2026-01-01T00:00:00.000Z" });
  const { recoveryId } = deleteWithRecovery(db, "item-1");
  const undo = undoRecovery(db, recoveryId);
  assert.deepEqual(undo, { status: "recovered", actionType: "delete_item", itemId: "item-1" });
  assert.deepEqual(db.libraryItems.get("item-1"), baseItem());
  assert.deepEqual(db.collectionItems, [{ collectionId: "c1", itemId: "item-1" }]);
  assert.deepEqual(db.activityEvents, [{ id: "ev1", itemId: "item-1", type: "progress_updated", timestamp: "2026-01-01T00:00:00.000Z" }]);
});

check("E3: undo of a delete refuses to restore a source that's been claimed by another item since", () => {
  const db = makeDb();
  db.libraryItems.set("item-1", baseItem());
  db.trackingSources.set("src-1", { id: "src-1", libraryItemId: "item-1" });
  const { recoveryId } = deleteWithRecovery(db, "item-1");
  // In the interim, the source gets linked to a different (unrelated) item.
  db.trackingSources.get("src-1").libraryItemId = "item-2";
  const undo = undoRecovery(db, recoveryId);
  assert.deepEqual(undo, { status: "recovery_conflict", reason: "source_claimed_elsewhere" });
  // And the source must NOT have been stolen back.
  assert.equal(db.trackingSources.get("src-1").libraryItemId, "item-2");
});

check("E4: double-undo of a delete — first succeeds, immediate second finds nothing", () => {
  const db = makeDb();
  db.libraryItems.set("item-1", baseItem());
  const { recoveryId } = deleteWithRecovery(db, "item-1");
  const first = undoRecovery(db, recoveryId);
  assert.equal(first.status, "recovered");
  const second = undoRecovery(db, recoveryId);
  assert.deepEqual(second, { status: "not_found" });
});

function mergeModel(db, survivorId, duplicateId) {
  const survivor = db.libraryItems.get(survivorId);
  const duplicate = db.libraryItems.get(duplicateId);
  const survivorPreMerge = { ...survivor };
  const duplicatePreMerge = { ...duplicate };
  const survivorPreMergeCollectionIds = db.collectionItems.filter((ci) => ci.itemId === survivorId).map((ci) => ci.collectionId);
  const duplicatePreMergeCollectionIds = db.collectionItems.filter((ci) => ci.itemId === duplicateId).map((ci) => ci.collectionId);
  const movedSourceIds = [...db.trackingSources.values()].filter((s) => s.libraryItemId === duplicateId).map((s) => s.id);
  const movedActivityIds = db.activityEvents.filter((ae) => ae.itemId === duplicateId).map((ae) => ae.id);
  // 0012: survivor's own pre-merge activity ids — never move, but Undo
  // needs them to compute the exact expected post-merge activity set.
  const survivorPreMergeActivityIds = db.activityEvents.filter((ae) => ae.itemId === survivorId).map((ae) => ae.id);

  // Apply the merge (mirrors merge_library_items's non-recovery mechanics).
  const merged = { ...survivor, progressValue: Math.max(survivor.progressValue ?? 0, duplicate.progressValue ?? 0) };
  db.libraryItems.set(survivorId, merged);
  db.libraryItems.delete(duplicateId);
  db.collectionItems = db.collectionItems.map((ci) => (ci.itemId === duplicateId ? { ...ci, itemId: survivorId } : ci));
  // Dedupe survivor's own membership (a collection both belonged to collapses to one row).
  const seen = new Set();
  db.collectionItems = db.collectionItems.filter((ci) => {
    const key = `${ci.collectionId}::${ci.itemId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  db.activityEvents = db.activityEvents.map((ae) => (ae.itemId === duplicateId ? { ...ae, itemId: survivorId } : ae));
  movedSourceIds.forEach((id) => {
    db.trackingSources.get(id).libraryItemId = survivorId;
  });

  const survivorPostMergeExpected = { ...db.libraryItems.get(survivorId) };
  const recoveryId = `rec-${db.recoveryActions.size + 1}`;
  db.recoveryActions.set(recoveryId, {
    id: recoveryId,
    actionType: "merge_items",
    payload: {
      survivorId,
      duplicateId,
      survivorPreMerge,
      duplicatePreMerge,
      survivorPostMergeExpected,
      survivorPreMergeCollectionIds,
      duplicatePreMergeCollectionIds,
      movedSourceIds,
      movedActivityIds,
      survivorPreMergeActivityIds,
    },
    expiresAt: futureIso(),
  });
  return recoveryId;
}

check("F1/F2: undo of a merge restores both the exact survivor and exact recreated duplicate rows", () => {
  const db = makeDb();
  db.libraryItems.set("s", baseItem({ id: "s", title: "Survivor", progressValue: 50 }));
  db.libraryItems.set("d", baseItem({ id: "d", title: "Duplicate", progressValue: 60 }));
  const recoveryId = mergeModel(db, "s", "d");
  assert.equal(db.libraryItems.get("s").progressValue, 60); // furthest-wins applied
  const undo = undoRecovery(db, recoveryId);
  assert.equal(undo.status, "recovered");
  assert.deepEqual(db.libraryItems.get("s"), baseItem({ id: "s", title: "Survivor", progressValue: 50 }));
  assert.deepEqual(db.libraryItems.get("d"), baseItem({ id: "d", title: "Duplicate", progressValue: 60 }));
});

check("F3 (Chapter-61 scenario, RPC level): undo of a merge refuses once new progress landed on the survivor", () => {
  const db = makeDb();
  db.libraryItems.set("s", baseItem({ id: "s", progressValue: 50 }));
  db.libraryItems.set("d", baseItem({ id: "d", progressValue: 60 }));
  const recoveryId = mergeModel(db, "s", "d");
  // A TrackingSource commits real new progress after the merge.
  db.libraryItems.set("s", { ...db.libraryItems.get("s"), progressValue: 61 });
  const undo = undoRecovery(db, recoveryId);
  assert.deepEqual(undo, { status: "recovery_conflict", reason: "survivor_changed" });
  assert.equal(db.libraryItems.get("s").progressValue, 61); // never overwritten
});

check("F4: undo of a merge splits collection topology back exactly, never a blind copy", () => {
  const db = makeDb();
  db.libraryItems.set("s", baseItem({ id: "s" }));
  db.libraryItems.set("d", baseItem({ id: "d" }));
  db.collectionItems.push({ collectionId: "common", itemId: "s" });
  db.collectionItems.push({ collectionId: "a", itemId: "s" });
  db.collectionItems.push({ collectionId: "common", itemId: "d" });
  db.collectionItems.push({ collectionId: "b", itemId: "d" });
  const recoveryId = mergeModel(db, "s", "d");
  // Post-merge: survivor is in Common/A/B, duplicate is gone.
  const postMerge = db.collectionItems.filter((ci) => ci.itemId === "s").map((ci) => ci.collectionId).sort();
  assert.deepEqual(postMerge, ["a", "b", "common"]);

  undoRecovery(db, recoveryId);
  const survivorSets = db.collectionItems.filter((ci) => ci.itemId === "s").map((ci) => ci.collectionId).sort();
  const duplicateSets = db.collectionItems.filter((ci) => ci.itemId === "d").map((ci) => ci.collectionId).sort();
  assert.deepEqual(survivorSets, ["a", "common"]);
  assert.deepEqual(duplicateSets, ["b", "common"]);
});

check("F5 (0012 fix): a new Activity event on the survivor after the merge blocks Undo — clock-independent, no partial mutation", () => {
  const db = makeDb();
  db.libraryItems.set("s", baseItem({ id: "s" }));
  db.libraryItems.set("d", baseItem({ id: "d" }));
  db.activityEvents.push({ id: "ev-dup", itemId: "d", type: "progress_updated" });
  const recoveryId = mergeModel(db, "s", "d");
  // Survivor gains a brand-new event after the merge (unrelated to the moved one).
  db.activityEvents.push({ id: "ev-new", itemId: "s", type: "rating_updated" });

  const beforeItems = new Map(db.libraryItems);
  const beforeActivity = [...db.activityEvents];
  const beforeCollectionItems = [...db.collectionItems];

  const undo = undoRecovery(db, recoveryId);
  assert.deepEqual(undo, { status: "recovery_conflict", reason: "survivor_changed" });

  // No partial mutation: everything is exactly what it was before the attempt.
  assert.deepEqual(db.libraryItems, beforeItems);
  assert.deepEqual(db.activityEvents, beforeActivity);
  assert.deepEqual(db.collectionItems, beforeCollectionItems);
  assert.ok(db.activityEvents.some((ae) => ae.id === "ev-new" && ae.itemId === "s"), "new event untouched");
});

check("F5b: unchanged activity topology — undo succeeds and moves back only the events that actually moved", () => {
  const db = makeDb();
  db.libraryItems.set("s", baseItem({ id: "s" }));
  db.libraryItems.set("d", baseItem({ id: "d" }));
  db.activityEvents.push({ id: "ev-own", itemId: "s", type: "item_added" });
  db.activityEvents.push({ id: "ev-dup", itemId: "d", type: "progress_updated" });
  const recoveryId = mergeModel(db, "s", "d");
  // Nothing touches activity between merge and undo.
  const undo = undoRecovery(db, recoveryId);
  assert.equal(undo.status, "recovered");
  const survivorEvents = db.activityEvents.filter((ae) => ae.itemId === "s").map((ae) => ae.id);
  const duplicateEvents = db.activityEvents.filter((ae) => ae.itemId === "d").map((ae) => ae.id);
  assert.deepEqual(survivorEvents, ["ev-own"]);
  assert.deepEqual(duplicateEvents, ["ev-dup"]);
});

check("F6: undo of a merge refuses to steal back a source claimed elsewhere since", () => {
  const db = makeDb();
  db.libraryItems.set("s", baseItem({ id: "s" }));
  db.libraryItems.set("d", baseItem({ id: "d" }));
  db.trackingSources.set("src-1", { id: "src-1", libraryItemId: "d" });
  const recoveryId = mergeModel(db, "s", "d");
  assert.equal(db.trackingSources.get("src-1").libraryItemId, "s"); // moved to survivor by the merge
  // Someone unlinks it from survivor and links it to a third item.
  db.trackingSources.get("src-1").libraryItemId = "item-3";
  const undo = undoRecovery(db, recoveryId);
  assert.deepEqual(undo, { status: "recovery_conflict", reason: "source_claimed_elsewhere" });
  assert.equal(db.trackingSources.get("src-1").libraryItemId, "item-3");
});

check("F7: double-undo of a merge — first succeeds, immediate second finds nothing", () => {
  const db = makeDb();
  db.libraryItems.set("s", baseItem({ id: "s" }));
  db.libraryItems.set("d", baseItem({ id: "d" }));
  const recoveryId = mergeModel(db, "s", "d");
  const first = undoRecovery(db, recoveryId);
  assert.equal(first.status, "recovered");
  const second = undoRecovery(db, recoveryId);
  assert.deepEqual(second, { status: "not_found" });
});

check("F8: undo of a merge refuses when the duplicate's original id has been reused", () => {
  const db = makeDb();
  db.libraryItems.set("s", baseItem({ id: "s" }));
  db.libraryItems.set("d", baseItem({ id: "d" }));
  const recoveryId = mergeModel(db, "s", "d");
  db.libraryItems.set("d", baseItem({ id: "d", title: "Some unrelated new item" }));
  const undo = undoRecovery(db, recoveryId);
  assert.deepEqual(undo, { status: "recovery_conflict", reason: "id_in_use" });
});

// ============================================================
// F9-F11 — collection-topology gap reported by review: changing
// collection_items never touches the library_items row, so the
// deepEqual/to_jsonb survivor-changed check alone cannot see a
// membership added or removed after the merge. These confirm the fix
// (the dedicated topology-equality check added to both undo_library_
// recovery's merge branch and validateMergeUndo) actually blocks Undo
// in both directions, and that a blocked Undo leaves every table
// completely untouched — no partial mutation.
// ============================================================

check("F9: merge → survivor added to a brand-new collection after the merge → Undo is blocked and the new membership survives", () => {
  const db = makeDb();
  db.libraryItems.set("s", baseItem({ id: "s" }));
  db.libraryItems.set("d", baseItem({ id: "d" }));
  db.collectionItems.push({ collectionId: "common", itemId: "s" }, { collectionId: "common", itemId: "d" });
  const recoveryId = mergeModel(db, "s", "d");
  // Real user action after the merge: survivor joins a new collection.
  db.collectionItems.push({ collectionId: "new-collection", itemId: "s" });

  const beforeItems = new Map(db.libraryItems);
  const beforeCollectionItems = [...db.collectionItems];
  const beforeActivity = [...db.activityEvents];
  const beforeRecoveryActions = new Map(db.recoveryActions);

  const undo = undoRecovery(db, recoveryId);
  assert.deepEqual(undo, { status: "recovery_conflict", reason: "collections_changed" });

  // No partial mutation: every table is byte-for-byte what it was right
  // before the undo attempt — survivor still merged, duplicate still
  // gone, the new membership intact, nothing recreated or dropped.
  assert.deepEqual(db.libraryItems, beforeItems);
  assert.deepEqual(db.collectionItems, beforeCollectionItems);
  assert.deepEqual(db.activityEvents, beforeActivity);
  assert.deepEqual(db.recoveryActions, beforeRecoveryActions);
  assert.ok(!db.libraryItems.has("d"));
  assert.ok(db.collectionItems.some((ci) => ci.itemId === "s" && ci.collectionId === "new-collection"));
});

check("F10: merge → survivor manually removed from a unioned collection after the merge → Undo is blocked and the removal survives", () => {
  const db = makeDb();
  db.libraryItems.set("s", baseItem({ id: "s" }));
  db.libraryItems.set("d", baseItem({ id: "d" }));
  db.collectionItems.push({ collectionId: "common", itemId: "s" }, { collectionId: "b", itemId: "d" });
  const recoveryId = mergeModel(db, "s", "d");
  assert.ok(db.collectionItems.some((ci) => ci.itemId === "s" && ci.collectionId === "b")); // moved in by the merge
  // Real user action after the merge: survivor is manually taken out of "b".
  db.collectionItems = db.collectionItems.filter((ci) => !(ci.itemId === "s" && ci.collectionId === "b"));

  const beforeItems = new Map(db.libraryItems);
  const beforeCollectionItems = [...db.collectionItems];
  const beforeRecoveryActions = new Map(db.recoveryActions);

  const undo = undoRecovery(db, recoveryId);
  assert.deepEqual(undo, { status: "recovery_conflict", reason: "collections_changed" });

  assert.deepEqual(db.libraryItems, beforeItems);
  assert.deepEqual(db.collectionItems, beforeCollectionItems);
  assert.deepEqual(db.recoveryActions, beforeRecoveryActions);
  // The removal must not have been silently reverted.
  assert.ok(!db.collectionItems.some((ci) => ci.itemId === "s" && ci.collectionId === "b"));
});

check("F11: merge → collection topology genuinely unchanged → Undo succeeds and restores the exact pre-merge split", () => {
  const db = makeDb();
  db.libraryItems.set("s", baseItem({ id: "s" }));
  db.libraryItems.set("d", baseItem({ id: "d" }));
  db.collectionItems.push({ collectionId: "common", itemId: "s" }, { collectionId: "a", itemId: "s" }, { collectionId: "common", itemId: "d" }, { collectionId: "b", itemId: "d" });
  const recoveryId = mergeModel(db, "s", "d");
  // Nothing touches collections between merge and undo.
  const undo = undoRecovery(db, recoveryId);
  assert.equal(undo.status, "recovered");
  const survivorSets = db.collectionItems.filter((ci) => ci.itemId === "s").map((ci) => ci.collectionId).sort();
  const duplicateSets = db.collectionItems.filter((ci) => ci.itemId === "d").map((ci) => ci.collectionId).sort();
  assert.deepEqual(survivorSets, ["a", "common"]);
  assert.deepEqual(duplicateSets, ["b", "common"]);
});

check("G1 (full local-mode round trip): delete then undo restores items/collections/activity exactly and clears the recovery entry", () => {
  const store = makeStore();
  const items = [baseItem()];
  const collections = [{ id: "c1", itemIds: ["item-1"] }];
  const events = [{ id: "ev1", itemId: "item-1", type: "item_added" }];

  // "Delete": snapshot, then remove from the in-memory app state.
  const payload = { item: items[0], collectionIds: ["c1"], activityEvents: events };
  addRecoveryAction(store, { id: "r1", actionType: "delete_item", title: items[0].title, payload, createdAt: new Date().toISOString(), expiresAt: futureIso() });
  const itemsAfterDelete = items.filter((i) => i.id !== "item-1");
  const collectionsAfterDelete = collections.map((c) => ({ ...c, itemIds: c.itemIds.filter((id) => id !== "item-1") }));
  const eventsAfterDelete = events.filter((e) => e.itemId !== "item-1");

  // "Undo": validate against current state, then restore.
  const entry = getRecoveryAction(store, "r1");
  const outcome = validateDeleteUndo(entry.payload, itemsAfterDelete, collectionsAfterDelete);
  assert.deepEqual(outcome, { status: "recovered" });
  const restoredItems = [entry.payload.item, ...itemsAfterDelete];
  const restoredCollections = collectionsAfterDelete.map((c) =>
    entry.payload.collectionIds.includes(c.id) ? { ...c, itemIds: [...c.itemIds, entry.payload.item.id] } : c,
  );
  const restoredEvents = [...entry.payload.activityEvents, ...eventsAfterDelete];
  removeRecoveryAction(store, "r1");

  assert.deepEqual(restoredItems, items);
  assert.deepEqual(restoredCollections, collections);
  assert.deepEqual(restoredEvents, events); // Activity restored verbatim, not as new "today" events
  assert.equal(getRecoveryAction(store, "r1"), null);
});

check("G2 (acceptance scenario, full local-mode round trip): merge, then new progress, then Undo must refuse and preserve the new progress", () => {
  const store = makeStore();
  const survivor = baseItem({ id: "s", progressValue: 50 });
  const duplicate = baseItem({ id: "d", progressValue: 60 });
  const survivorPostMergeExpected = { ...survivor, progressValue: 60 };
  const payload = {
    survivorId: "s",
    duplicateId: "d",
    survivorPreMerge: survivor,
    duplicatePreMerge: duplicate,
    survivorPostMergeExpected,
    survivorPreMergeCollectionIds: [],
    duplicatePreMergeCollectionIds: [],
    movedActivityIds: [],
    survivorPreMergeActivityIds: [],
  };
  addRecoveryAction(store, { id: "r1", actionType: "merge_items", title: survivor.title, payload, createdAt: new Date().toISOString(), expiresAt: futureIso() });

  let items = [survivorPostMergeExpected]; // duplicate removed, survivor now at 60
  // Real browser tracking advances it further before Undo is ever clicked.
  items = items.map((i) => (i.id === "s" ? { ...i, progressValue: 61 } : i));

  const entry = getRecoveryAction(store, "r1");
  const outcome = validateMergeUndo(entry.payload, items, [], []);
  assert.deepEqual(outcome, { status: "recovery_conflict", reason: "survivor_changed" });
  // Nothing was restored, and the survivor's 61 is untouched.
  assert.equal(items.find((i) => i.id === "s").progressValue, 61);
  assert.equal(getRecoveryAction(store, "r1").id, "r1"); // recovery entry NOT consumed by a refused undo
});

// ============================================================
// I — STATIC security-hardening checks (Task 13 of the Stage 28 security
// review). These read the actual migration files' SQL TEXT and assert
// structural properties — they are NOT live RLS/grant tests (those can
// only be proven against the real deployed database; see the Stage 28
// security review report for why a live UPDATE-policy experiment was
// deliberately not run against production). Their job is to catch a
// future accidental regression (e.g. someone re-adding an UPDATE policy,
// or reintroducing a `for update`/follow-up `update` against
// library_recovery_actions) at review time, in a plain `git diff`-visible
// way, before it would ever reach a real database.
// ============================================================
function stripSqlComments(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const migration0010 = readFileSync(new URL("../supabase/migrations/0010_stage28_library_recovery.sql", import.meta.url), "utf8");
const migration0011 = readFileSync(new URL("../supabase/migrations/0011_stage28_library_recovery_fix.sql", import.meta.url), "utf8");
// Comments freely discuss "FOR UPDATE" and "library_recovery_actions" in
// prose (explaining exactly why they must NOT appear together in real
// DDL) — strip comments first so the structural checks below can't be
// fooled by their own explanatory text.
const combinedSql = stripSqlComments(`${migration0010}\n${migration0011}`);

function extractFunctionBody(sql, functionName) {
  const start = sql.indexOf(`create or replace function public.${functionName}(`);
  if (start === -1) throw new Error(`function ${functionName} not found`);
  const end = sql.indexOf("\n$$;", start);
  if (end === -1) throw new Error(`end of function ${functionName} not found`);
  return sql.slice(start, end);
}

check("I1 (static): no UPDATE policy exists anywhere for library_recovery_actions — recovery rows stay client-immutable", () => {
  const updatePolicyPattern = /create policy[^;]*library_recovery_actions[^;]*for update/is;
  assert.equal(updatePolicyPattern.test(combinedSql), false, "found an UPDATE policy on library_recovery_actions");
  // Also the inverse-direction phrasing, in case of "for update ... on library_recovery_actions" ordering.
  const altPattern = /for update[^;]*library_recovery_actions/is;
  assert.equal(altPattern.test(combinedSql), false);
});

check("I2 (static): undo_library_recovery no longer takes `for update` on library_recovery_actions, and uses an advisory lock instead", () => {
  // The LATEST definition wins at deploy time (create or replace), so
  // only 0011's body reflects real runtime behavior — checked here
  // directly rather than via the combined text.
  const body = extractFunctionBody(migration0011, "undo_library_recovery");
  assert.ok(body.includes("pg_advisory_xact_lock"), "expected an advisory lock");
  assert.ok(
    body.includes("from public.library_recovery_actions where id = p_recovery_id and user_id = v_uid;"),
    "expected a plain (non-locking) select of the recovery row",
  );
  assert.equal(
    body.includes("from public.library_recovery_actions where id = p_recovery_id and user_id = v_uid for update"),
    false,
    "must not lock library_recovery_actions with FOR UPDATE",
  );
});

check("I3 (static): merge_library_items writes library_recovery_actions exactly once (a single INSERT), never a follow-up UPDATE", () => {
  const body = extractFunctionBody(migration0011, "merge_library_items");
  const insertCount = (body.match(/insert into public\.library_recovery_actions/g) ?? []).length;
  const updateCount = (body.match(/update public\.library_recovery_actions/g) ?? []).length;
  assert.equal(insertCount, 1, `expected exactly one insert, found ${insertCount}`);
  assert.equal(updateCount, 0, `expected zero updates, found ${updateCount}`);
  assert.ok(body.includes("'survivorPostMergeExpected', to_jsonb(v_survivor_after)"), "survivorPostMergeExpected must be in that one insert");
});

check("I4 (static): SELECT and DELETE policies on library_recovery_actions remain owner-scoped (auth.uid() = user_id)", () => {
  assert.ok(/library_recovery_actions_select_own[\s\S]*?using \(auth\.uid\(\) = user_id\)/.test(migration0010));
  assert.ok(/library_recovery_actions_delete_own[\s\S]*?using \(auth\.uid\(\) = user_id\)/.test(migration0010));
});

check("I5 (static): undo_library_recovery stays SECURITY INVOKER — it never needs to write library_recovery_actions beyond SELECT/DELETE, both already permitted", () => {
  const undoBody = extractFunctionBody(migration0011, "undo_library_recovery");
  assert.ok(undoBody.includes("security invoker"), "undo_library_recovery must be security invoker");
  assert.equal(undoBody.toLowerCase().includes("security definer"), false, "undo_library_recovery must not be security definer");
});

// ============================================================
// I6-I13 — second security review (Task 13, items 1-10): the direct
// client INSERT/forged-recovery-row issue and its fix. Still static SQL
// text analysis, not live database behavior — see the second security
// review report for the live-grant-inference reasoning these checks
// encode structurally.
// ============================================================

check("I6 (static, item 1/2): the INSERT policy on library_recovery_actions is dropped, and never replaced — no client can directly INSERT a recovery row", () => {
  assert.ok(
    /drop policy if exists "library_recovery_actions_insert_own" on public\.library_recovery_actions/.test(migration0011),
    "expected 0011 to drop the INSERT policy 0010 created",
  );
  const createInsertPolicy = /create policy[^;]*library_recovery_actions[^;]*for insert/is;
  assert.equal(createInsertPolicy.test(combinedSql.replace(migration0010.match(/create policy "library_recovery_actions_insert_own"[\s\S]*?;/)?.[0] ?? "", "")), false);
  // The 0010-original policy is expected to exist in 0010's own text (it
  // was real, deployed, and only 0011's DROP undoes it) — assert that too,
  // so this check would fail loudly if 0010 ever silently lost it instead
  // of 0011 explicitly dropping it.
  assert.ok(/create policy "library_recovery_actions_insert_own"/.test(migration0010), "0010 should still show the original policy 0011 is dropping");
});

check("I7 (static, items 4-9): direct client UPDATE/INSERT are blocked at the GRANT layer for PUBLIC, anon, AND authenticated — not just via RLS", () => {
  assert.ok(
    /revoke insert, update on public\.library_recovery_actions from public, authenticated, anon/.test(migration0011),
    "expected an explicit REVOKE of table-level INSERT/UPDATE from public, authenticated, and anon",
  );
});

check("I8 (static, items 4/5): expires_at and payload can only ever be set by the trusted RPCs — no code path accepts either as a client parameter", () => {
  const deleteBody = extractFunctionBody(migration0011, "delete_library_item_with_recovery");
  const mergeBody = extractFunctionBody(migration0011, "merge_library_items");
  // Only ever `v_now + interval '15 minutes'`, computed server-side —
  // never a parameter, never client-suppliable.
  for (const [name, body] of [["delete_library_item_with_recovery", deleteBody], ["merge_library_items", mergeBody]]) {
    assert.ok(body.includes("v_now + interval '15 minutes'"), `${name} must compute expires_at itself`);
    assert.equal(/create or replace function[^)]*p_expires_at/i.test(body), false, `${name} must not accept expires_at as a parameter`);
  }
});

check("I9 (static, item 6): delete_library_item_with_recovery is SECURITY DEFINER, so it can still create a recovery row now that direct INSERT is blocked", () => {
  const body = extractFunctionBody(migration0011, "delete_library_item_with_recovery");
  assert.ok(body.includes("security definer"), "expected security definer");
  assert.ok(body.includes("set search_path ="), "expected a fixed search_path (definer-hijacking protection — exact hardened value checked by I14)");
  assert.ok(body.includes("if v_uid is null then"), "expected explicit null-auth.uid() rejection");
});

check("I10 (static, item 7): merge_library_items is SECURITY DEFINER for the same reason", () => {
  const body = extractFunctionBody(migration0011, "merge_library_items");
  assert.ok(body.includes("security definer"), "expected security definer");
  assert.ok(body.includes("set search_path ="), "expected a fixed search_path (exact hardened value checked by I14)");
  assert.ok(body.includes("if v_uid is null then"), "expected explicit null-auth.uid() rejection");
});

check("I11 (static, item 8): every library_items/collection_items/activity_events/tracking_sources statement in both DEFINER functions still carries an explicit ownership predicate — RLS bypass removes no real protection", () => {
  const deleteBody = extractFunctionBody(migration0011, "delete_library_item_with_recovery");
  const mergeBody = extractFunctionBody(migration0011, "merge_library_items");
  // Spot-check the exact statements audited by hand in the security
  // review report — every one must show its explicit user_id predicate.
  const deleteExpectations = [
    "from public.library_items where id = p_item_id and user_id = v_uid",
    "from public.collection_items where item_id = p_item_id and user_id = v_uid",
    "from public.activity_events ae where ae.item_id = p_item_id and ae.user_id = v_uid",
    "from public.tracking_sources where library_item_id = p_item_id and user_id = v_uid",
    "from public.library_items where id = p_item_id and user_id = v_uid", // the final delete
  ];
  for (const fragment of deleteExpectations) assert.ok(deleteBody.includes(fragment), `missing explicit ownership predicate: ${fragment}`);

  const mergeExpectations = [
    "where id = p_survivor_id and user_id = v_uid for update",
    "where id = p_duplicate_id and user_id = v_uid for update",
    "from public.collection_items where item_id = p_survivor_id and user_id = v_uid",
    "from public.collection_items where item_id = p_duplicate_id and user_id = v_uid",
    "from public.tracking_sources where library_item_id = p_duplicate_id and user_id = v_uid",
    "from public.activity_events where item_id = p_duplicate_id and user_id = v_uid",
    "where id = p_survivor_id and user_id = v_uid", // survivor UPDATE
    "where library_item_id = p_duplicate_id and user_id = v_uid", // tracking_sources move
    "where ci.item_id = p_duplicate_id and ci.user_id = v_uid", // collection_items move (source side)
    "where item_id = p_duplicate_id and user_id = v_uid", // collection_items delete + activity move + final item delete (shared fragment, checked for presence)
  ];
  for (const fragment of mergeExpectations) assert.ok(mergeBody.includes(fragment), `missing explicit ownership predicate: ${fragment}`);
});

check("I12 (static, item 8 continued): EXECUTE is granted to authenticated only — never anon — for all three recovery functions", () => {
  for (const fn of ["delete_library_item_with_recovery(uuid)", "merge_library_items(uuid, uuid, jsonb)", "undo_library_recovery(uuid)"]) {
    assert.ok(combinedSql.includes(`grant execute on function public.${fn} to authenticated`), `expected authenticated EXECUTE grant for ${fn}`);
    assert.ok(combinedSql.includes(`revoke all on function public.${fn} from public`), `expected PUBLIC EXECUTE revoked for ${fn}`);
    assert.equal(combinedSql.includes(`grant execute on function public.${fn} to anon`), false, `must not grant anon EXECUTE on ${fn}`);
  }
});

check("I13 (static, item 9): SELECT and DELETE remain available to the owner (Task 7/8) — only INSERT/UPDATE are blocked", () => {
  assert.ok(/library_recovery_actions_select_own[\s\S]*?using \(auth\.uid\(\) = user_id\)/.test(migration0010));
  assert.ok(/library_recovery_actions_delete_own[\s\S]*?using \(auth\.uid\(\) = user_id\)/.test(migration0010));
  // And these two are never dropped by 0011.
  assert.equal(/drop policy if exists "library_recovery_actions_select_own"/.test(migration0011), false);
  assert.equal(/drop policy if exists "library_recovery_actions_delete_own"/.test(migration0011), false);
});

// ============================================================
// I14-I16 — third security review (SECURITY DEFINER search_path audit,
// Task 9 items 1-3). Static SQL text analysis only — whether PUBLIC/anon/
// authenticated actually hold CREATE on the public schema could not be
// confirmed by live catalog inspection (see the third security review
// report); these checks instead prove the hardening that makes that
// question moot: no unqualified application-object reference exists for
// search_path to mis-resolve in the first place.
// ============================================================

check("I14 (static, item 1): both SECURITY DEFINER functions exclude `public` from search_path (pg_catalog, pg_temp only)", () => {
  const deleteBody = extractFunctionBody(migration0011, "delete_library_item_with_recovery");
  const mergeBody = extractFunctionBody(migration0011, "merge_library_items");
  for (const [name, body] of [["delete_library_item_with_recovery", deleteBody], ["merge_library_items", mergeBody]]) {
    assert.ok(body.includes("set search_path = pg_catalog, pg_temp"), `${name} must use the hardened search_path`);
    assert.equal(/set search_path = public\b/.test(body), false, `${name} must not include public in search_path`);
  }
});

check("I15 (static, item 2): every application-table reference inside both DEFINER functions is schema-qualified with public. — none left for search_path to resolve", () => {
  const deleteBody = extractFunctionBody(migration0011, "delete_library_item_with_recovery");
  const mergeBody = extractFunctionBody(migration0011, "merge_library_items");
  const applicationTables = ["library_items", "library_recovery_actions", "collection_items", "collections", "activity_events", "tracking_sources"];
  for (const [name, body] of [["delete_library_item_with_recovery", deleteBody], ["merge_library_items", mergeBody]]) {
    const bodyNoComments = body
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    for (const table of applicationTables) {
      // Every occurrence of the bare table name must be immediately
      // preceded by "public." — this catches "from library_items" (bad)
      // while accepting "from public.library_items" (good) and
      // "public.library_items%rowtype" (good).
      const bareOccurrence = new RegExp(`(?<!public\\.)\\b${table}\\b`, "g");
      const matches = bodyNoComments.match(bareOccurrence) ?? [];
      assert.equal(matches.length, 0, `${name} has ${matches.length} unqualified reference(s) to ${table}`);
    }
  }
});

check("I16 (static, item 3): auth.uid() is explicitly schema-qualified in every function, never a bare uid() call", () => {
  const deleteBody = extractFunctionBody(migration0011, "delete_library_item_with_recovery");
  const mergeBody = extractFunctionBody(migration0011, "merge_library_items");
  const undoBody = extractFunctionBody(migration0011, "undo_library_recovery");
  for (const [name, body] of [["delete_library_item_with_recovery", deleteBody], ["merge_library_items", mergeBody], ["undo_library_recovery", undoBody]]) {
    assert.ok(body.includes("auth.uid()"), `${name} must call auth.uid()`);
    assert.equal(/(?<!auth\.)\buid\(\)/.test(body), false, `${name} must never call a bare, unqualified uid()`);
  }
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
if (failed.length > 0) process.exit(1);
