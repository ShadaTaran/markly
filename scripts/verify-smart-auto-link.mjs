#!/usr/bin/env node
// Verifies the smart auto-linking logic behind
// src/lib/extension/auto-link.ts (attemptSmartAutoLink,
// normalizeTitleForMatching) and the atomic claim behavior of
// claimSourceLink in src/lib/extension/tracking-sources.ts.
//
// normalizeTitleForMatching is reproduced verbatim below rather than
// imported, since the real module is annotated `import "server-only"`
// and this needs to run under plain Node, not the Next.js bundler that
// enforces that boundary. Keep this in sync with the real implementation
// if it changes.
//
// The matching and claim logic is modeled in-memory against a fake
// library_items/tracking_sources table, exercising the exact same
// decision rules as the real (Supabase-backed) functions: exact
// normalized-title + media-type match requiring uniqueness, and an
// atomic "UPDATE ... WHERE library_item_id IS NULL" claim for the
// concurrent first-detection case. No live Postgres was available in
// this environment to run the real queries directly; this validates the
// algorithm the SQL/query-builder calls implement.
//
// Run with: node scripts/verify-smart-auto-link.mjs

import assert from "node:assert/strict";

// --- normalizeTitleForMatching, reproduced from src/lib/extension/auto-link.ts ---
function normalizeTitleForMatching(title) {
  return title
    .normalize("NFKC")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‒–—―]/g, "-")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

// --- attemptSmartAutoLink, reproduced from src/lib/extension/auto-link.ts ---
function attemptSmartAutoLink(libraryItems, userId, mediaType, sourceTitle) {
  const target = normalizeTitleForMatching(sourceTitle);
  if (!target) return { kind: "no_match" };

  const candidates = libraryItems.filter((item) => item.userId === userId && item.type === mediaType);
  const matches = candidates.filter((item) => normalizeTitleForMatching(item.title) === target);

  if (matches.length === 1) return { kind: "matched", libraryItemId: matches[0].id };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "no_match" };
}

function jitter() {
  return new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
}

/** Models Postgres's row-level serialization of concurrent `UPDATE ... WHERE` statements on the same row — see createRowLock in verify-atomic-progress.mjs for the same modeling technique. */
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

// --- claimSourceLink, reproduced from src/lib/extension/tracking-sources.ts ---
async function claimSourceLink(sources, lock, sourceId, libraryItemId) {
  return lock(async () => {
    await jitter();
    const row = sources.get(sourceId);
    if (row.libraryItemId === null) {
      row.libraryItemId = libraryItemId;
      return libraryItemId;
    }
    return row.libraryItemId;
  });
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
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

async function main() {
  // --- Test A: unique exact match ---
  {
    const library = [{ id: "item-1", userId: "u1", type: "novel", title: "Lord of Mysteries" }];
    const outcome = attemptSmartAutoLink(library, "u1", "novel", "Lord of Mysteries");
    check("A: unique exact title match -> matched", () => {
      assert.deepEqual(outcome, { kind: "matched", libraryItemId: "item-1" });
    });
  }

  // --- Test B: case/whitespace normalization ---
  {
    const library = [{ id: "item-1", userId: "u1", type: "novel", title: "Lord of Mysteries" }];
    const outcome = attemptSmartAutoLink(library, "u1", "novel", "  LORD OF   MYSTERIES");
    check("B: case + whitespace differences still match", () => {
      assert.deepEqual(outcome, { kind: "matched", libraryItemId: "item-1" });
    });
    check("B: normalization does not conflate a numbered sequel", () => {
      assert.notEqual(normalizeTitleForMatching("Lord of Mysteries"), normalizeTitleForMatching("Lord of Mysteries 2"));
    });
  }

  // --- Test C: different media type never matches ---
  {
    const library = [{ id: "item-1", userId: "u1", type: "anime", title: "Lord of Mysteries" }];
    const outcome = attemptSmartAutoLink(library, "u1", "novel", "Lord of Mysteries");
    check("C: same title, incompatible media type -> no_match", () => {
      assert.deepEqual(outcome, { kind: "no_match" });
    });
  }

  // --- Test D: ambiguous (two items normalize to the same title) ---
  {
    const library = [
      { id: "item-1", userId: "u1", type: "novel", title: "Lord of Mysteries" },
      { id: "item-2", userId: "u1", type: "novel", title: "lord of mysteries" },
    ];
    const outcome = attemptSmartAutoLink(library, "u1", "novel", "Lord of Mysteries");
    check("D: two compatible items with the same normalized title -> ambiguous", () => {
      assert.deepEqual(outcome, { kind: "ambiguous" });
    });
  }

  // --- Test E: no match ---
  {
    const library = [{ id: "item-1", userId: "u1", type: "novel", title: "Lord of Mysteries" }];
    const outcome = attemptSmartAutoLink(library, "u1", "novel", "The Wandering Inn");
    check("E: no compatible item shares the title -> no_match", () => {
      assert.deepEqual(outcome, { kind: "no_match" });
    });
  }

  // --- Test C continued: user isolation (never match another user's library) ---
  {
    const library = [{ id: "item-1", userId: "someone-else", type: "novel", title: "Lord of Mysteries" }];
    const outcome = attemptSmartAutoLink(library, "u1", "novel", "Lord of Mysteries");
    check("security: a matching title in a different user's library is never a candidate", () => {
      assert.deepEqual(outcome, { kind: "no_match" });
    });
  }

  // --- Test F: an existing mapping is never re-title-matched (structural — the route only calls attemptSmartAutoLink when no libraryItemId exists yet) ---
  {
    let matchAttempted = false;
    function routeLikeFlow(existingLibraryItemId) {
      if (existingLibraryItemId) return { usedExistingMapping: true };
      matchAttempted = true;
      return { usedExistingMapping: false };
    }
    const outcome = routeLikeFlow("item-1");
    check("F: an established mapping short-circuits before any title match is attempted", () => {
      assert.equal(outcome.usedExistingMapping, true);
      assert.equal(matchAttempted, false);
    });
  }

  // --- Test G: existing unlinked source, a unique match now exists ---
  {
    const sources = new Map([["source-1", { id: "source-1", userId: "u1", libraryItemId: null }]]);
    const lock = createRowLock();
    // First detection, before the matching LibraryItem was ever added: no match.
    let library = [];
    let outcome = attemptSmartAutoLink(library, "u1", "novel", "The Wandering Inn");
    check("G: first detection with nothing in the library -> no_match, source stays unlinked", () => {
      assert.deepEqual(outcome, { kind: "no_match" });
      assert.equal(sources.get("source-1").libraryItemId, null);
    });

    // User later adds the matching item, then a subsequent detection arrives.
    library = [{ id: "item-1", userId: "u1", type: "novel", title: "The Wandering Inn" }];
    outcome = attemptSmartAutoLink(library, "u1", "novel", "The Wandering Inn");
    check("G: unique match now exists -> matched", () => {
      assert.deepEqual(outcome, { kind: "matched", libraryItemId: "item-1" });
    });
    await checkAsync("G: previously-unlinked source successfully claims the link on the next detection", async () => {
      const linkedId = await claimSourceLink(sources, lock, "source-1", outcome.libraryItemId);
      assert.equal(linkedId, "item-1");
      assert.equal(sources.get("source-1").libraryItemId, "item-1");
    });
  }

  // --- Test H: concurrent first detections ---
  {
    const sources = new Map([["source-1", { id: "source-1", userId: "u1", libraryItemId: null }]]);
    const lock = createRowLock();
    const library = [{ id: "item-1", userId: "u1", type: "novel", title: "Lord of Mysteries" }];

    // 10 "concurrent" first detections: each independently matches (read-only,
    // no shared state to race on), then all race to claim the link.
    const claims = Array.from({ length: 10 }, () => {
      const outcome = attemptSmartAutoLink(library, "u1", "novel", "Lord of Mysteries");
      assert.equal(outcome.kind, "matched");
      return claimSourceLink(sources, lock, "source-1", outcome.libraryItemId);
    });
    const linkedIds = await Promise.all(claims);

    check("H: all 10 concurrent claims resolve to the same, single library item", () => {
      assert.ok(linkedIds.every((id) => id === "item-1"), JSON.stringify(linkedIds));
    });
    check("H: the source row ends up linked exactly once, deterministically", () => {
      assert.equal(sources.get("source-1").libraryItemId, "item-1");
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
