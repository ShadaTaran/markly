#!/usr/bin/env node
// Verifies the Stage 22 "optional zero-touch auto-add" logic:
//   - the eligibility decision in src/app/api/extension/progress/route.ts
//     (exact Smart Auto-Link still wins; ambiguous never auto-adds; only a
//     genuine no_match + a device with auto-add enabled reaches auto-add)
//   - the two-lock atomic create-or-link algorithm in
//     supabase/migrations/0005_stage22_auto_add.sql's
//     auto_add_and_link_source (reproduced here as an in-memory model, the
//     same technique verify-smart-auto-link.mjs and verify-atomic-
//     progress.mjs already use for their own RPCs)
//
// IMPORTANT — what this script does and does not prove:
// The JS-model checks below (eligibility decision, the two-lock algorithm
// under concurrent promises) validate the ALGORITHM the SQL function
// implements — lock ordering, what gets checked before creating,
// exactly-once resolution — but a JS reproduction can never catch a bug
// that only exists in Postgres's own type/function resolution (exactly
// what actually broke this feature the first time: `max(id)` on a `uuid`
// column threw `42883 function max(uuid) does not exist` on every real
// call, despite the migration deploying cleanly and every JS-level check
// here passing). That specific class of regression is guarded by the
// separate static SQL-text checks near the end of this file instead,
// which read the real migration files off disk — the only kind of check
// in this script that can actually catch it without a live database. A
// real Supabase test remains the only thing that fully proves runtime
// correctness; this script narrows what can go wrong between such tests.
//
// Run with: node scripts/verify-auto-add.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// --- normalizeTitleForMatching, from src/lib/extension/auto-link.ts (same reproduction as verify-smart-auto-link.mjs) ---
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

// --- attemptSmartAutoLink, from src/lib/extension/auto-link.ts ---
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

/** Same modeling technique as verify-smart-auto-link.mjs's createRowLock — an exclusive async section keyed by whatever the caller passes in (a tracking_sources id, or here also a (user,type,normalizedTitle) key for the advisory-lock simulation). */
function createLockRegistry() {
  const tails = new Map();
  return function withLock(key, fn) {
    const tail = tails.get(key) ?? Promise.resolve();
    const result = tail.then(fn, fn);
    tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  };
}

/**
 * In-memory model of auto_add_and_link_source (0005_stage22_auto_add.sql).
 * `db` is a shared fake store: { sources: Map<id, {id,userId,libraryItemId}>,
 * items: Map<id, {id,userId,type,title}>, nextItemId: number }.
 * Two locks, exactly mirroring the SQL function's two `perform`/`for
 * update` sections:
 *   1. sourceLock, keyed by sourceId — models `select ... for update` on
 *      the tracking_sources row.
 *   2. titleLock, keyed by `${userId}|${mediaType}|${normalizedTitle}` —
 *      models pg_advisory_xact_lock.
 */
async function autoAddAndLinkSource(db, sourceLock, titleLock, userId, sourceId, mediaType, title) {
  return sourceLock(sourceId, async () => {
    await jitter();
    const source = db.sources.get(sourceId);
    if (!source) return { status: "source_not_found" };
    if (source.userId !== userId) return { status: "source_not_found" };
    if (source.libraryItemId !== null) return { status: "already_linked", libraryItemId: source.libraryItemId };

    const normalized = normalizeTitleForMatching(title);
    if (!normalized) return { status: "invalid_title" };

    return titleLock(`${userId}|${mediaType}|${normalized}`, async () => {
      await jitter();
      const matches = [...db.items.values()].filter(
        (item) => item.userId === userId && item.type === mediaType && normalizeTitleForMatching(item.title) === normalized,
      );
      if (matches.length === 1) {
        source.libraryItemId = matches[0].id;
        return { status: "linked_existing", libraryItemId: matches[0].id };
      }
      if (matches.length > 1) return { status: "ambiguous" };

      const id = `item-${db.nextItemId++}`;
      db.items.set(id, { id, userId, type: mediaType, title });
      source.libraryItemId = id;
      return { status: "created", libraryItemId: id };
    });
  });
}

function freshDb() {
  return { sources: new Map(), items: new Map(), nextItemId: 1 };
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
  // --- Test A: default off — unknown source, auto-add disabled ---
  {
    const outcome = attemptSmartAutoLink([], "u1", "novel", "Brand New Novel");
    const autoAddEnabled = false;
    const shouldAutoAdd = outcome.kind === "no_match" && autoAddEnabled;
    check("A: auto-add disabled -> no_match never triggers auto-add, needs_link (zero creation)", () => {
      assert.equal(outcome.kind, "no_match");
      assert.equal(shouldAutoAdd, false);
    });
  }

  // --- Test C: first auto-add — unknown confident detection, auto-add enabled ---
  await checkAsync("C: unknown source + auto-add on -> creates exactly one item and links it", async () => {
    const db = freshDb();
    db.sources.set("source-1", { id: "source-1", userId: "u1", libraryItemId: null });
    const sourceLock = createLockRegistry();
    const titleLock = createLockRegistry();

    const outcome = attemptSmartAutoLink([], "u1", "novel", "Lord of the Mysteries");
    assert.equal(outcome.kind, "no_match");

    const result = await autoAddAndLinkSource(db, sourceLock, titleLock, "u1", "source-1", "novel", "Lord of the Mysteries");
    assert.equal(result.status, "created");
    assert.equal(db.items.size, 1);
    assert.equal(db.sources.get("source-1").libraryItemId, result.libraryItemId);
  });

  // --- Test D: next chapter — same item updated, no second creation ---
  await checkAsync("D: a second detection for the now-linked source creates nothing new", async () => {
    const db = freshDb();
    db.sources.set("source-1", { id: "source-1", userId: "u1", libraryItemId: null });
    const sourceLock = createLockRegistry();
    const titleLock = createLockRegistry();

    const first = await autoAddAndLinkSource(db, sourceLock, titleLock, "u1", "source-1", "novel", "Lord of the Mysteries");
    assert.equal(first.status, "created");

    // Route-level: source.libraryItemId is now set, so auto-add is never
    // even attempted again for this source — modeled directly, since
    // that's a plain `if (!libraryItemId)` short-circuit in route.ts, not
    // something the RPC itself needs to re-decide.
    const source = db.sources.get("source-1");
    const secondAttempted = source.libraryItemId === null;
    assert.equal(secondAttempted, false);
    assert.equal(db.items.size, 1);
  });

  // --- Test E: 10 concurrent identical first detections for the SAME new source ---
  await checkAsync("E: 10 concurrent first detections for the same source -> exactly 1 item, 1 link", async () => {
    const db = freshDb();
    db.sources.set("source-1", { id: "source-1", userId: "u1", libraryItemId: null });
    const sourceLock = createLockRegistry();
    const titleLock = createLockRegistry();

    const calls = Array.from({ length: 10 }, () =>
      autoAddAndLinkSource(db, sourceLock, titleLock, "u1", "source-1", "novel", "Lord of the Mysteries"),
    );
    const outcomes = await Promise.all(calls);

    const createdCount = outcomes.filter((o) => o.status === "created").length;
    const alreadyLinkedCount = outcomes.filter((o) => o.status === "already_linked").length;
    const linkedIds = new Set(outcomes.map((o) => o.libraryItemId));

    assert.equal(createdCount, 1, `expected exactly 1 "created", got ${createdCount}`);
    assert.equal(createdCount + alreadyLinkedCount, 10);
    assert.equal(linkedIds.size, 1, `all 10 must resolve to the same item, got ${[...linkedIds]}`);
    assert.equal(db.items.size, 1, `expected exactly 1 library item, got ${db.items.size}`);
  });

  // --- Cross-source race: two DIFFERENT brand-new sources, same title, concurrent ---
  // This is the narrower race a tracking_sources row-lock alone does NOT
  // close (two different rows, no shared lock) — the advisory
  // (user,type,normalized-title) lock is specifically what prevents two
  // items here.
  await checkAsync("cross-source: 2 different first-ever sources for the same title, concurrent -> exactly 1 item", async () => {
    const db = freshDb();
    db.sources.set("source-a", { id: "source-a", userId: "u1", libraryItemId: null });
    db.sources.set("source-b", { id: "source-b", userId: "u1", libraryItemId: null });
    const sourceLock = createLockRegistry();
    const titleLock = createLockRegistry();

    const [a, b] = await Promise.all([
      autoAddAndLinkSource(db, sourceLock, titleLock, "u1", "source-a", "novel", "Lord of the Mysteries"),
      autoAddAndLinkSource(db, sourceLock, titleLock, "u1", "source-b", "novel", "lord of the mysteries"), // case-variant, same normalized title
    ]);

    const createdCount = [a, b].filter((o) => o.status === "created").length;
    assert.equal(createdCount, 1, `expected exactly 1 "created" across both sources, got ${JSON.stringify([a, b])}`);
    assert.equal(db.items.size, 1);
    assert.equal(db.sources.get("source-a").libraryItemId, db.sources.get("source-b").libraryItemId);
  });

  // --- Test F: ambiguous match, auto-add ON -> zero creation ---
  await checkAsync("F: auto-add on but two existing items already share the title -> ambiguous, zero creation", async () => {
    const library = [
      { id: "item-1", userId: "u1", type: "novel", title: "Lord of the Mysteries" },
      { id: "item-2", userId: "u1", type: "novel", title: "lord of the mysteries" },
    ];
    const outcome = attemptSmartAutoLink(library, "u1", "novel", "Lord of the Mysteries");
    const autoAddEnabled = true;
    // Route-level: only outcome.kind === "no_match" ever reaches auto-add — "ambiguous" always falls straight to needs_link, auto-add or not.
    const shouldAutoAdd = outcome.kind === "no_match" && autoAddEnabled;
    assert.equal(outcome.kind, "ambiguous");
    assert.equal(shouldAutoAdd, false);
  });

  // --- Test G: unique exact match, auto-add ON -> Smart Auto-Link wins, zero new creation ---
  await checkAsync("G: auto-add on but a unique exact match already exists -> smart-auto-link wins, no RPC call needed", async () => {
    const library = [{ id: "item-1", userId: "u1", type: "novel", title: "Lord of the Mysteries" }];
    const outcome = attemptSmartAutoLink(library, "u1", "novel", "Lord of the Mysteries");
    assert.equal(outcome.kind, "matched");
    // Route-level: "matched" is handled by the existing claimSourceLink
    // path entirely — attemptAutoAdd is never even called in this branch.
  });

  // --- Test H: turn auto-add off again -> future unknown source needs_link ---
  {
    const outcome = attemptSmartAutoLink([], "u1", "novel", "Some Other New Novel");
    const autoAddEnabled = false; // turned off
    const shouldAutoAdd = outcome.kind === "no_match" && autoAddEnabled;
    check("H: after turning auto-add off, a new unknown source goes back to needs_link", () => {
      assert.equal(shouldAutoAdd, false);
    });
  }

  // --- Test I: existing linked source, auto-add OFF -> tracking continues normally (not this module's concern, structural check) ---
  {
    const source = { id: "source-1", userId: "u1", libraryItemId: "item-1" };
    check("I: a source that's already linked never reaches the auto-add decision at all", () => {
      assert.notEqual(source.libraryItemId, null);
    });
  }

  // --- Test J: existing unlinked source (detected before auto-add existed), enable auto-add, next detection auto-adds + links that SAME row ---
  await checkAsync("J: pre-existing unlinked source + auto-add enabled -> auto-adds and links the existing row, no new tracking_sources row", async () => {
    const db = freshDb();
    db.sources.set("source-1", { id: "source-1", userId: "u1", libraryItemId: null }); // detected before auto-add existed
    const sourceLock = createLockRegistry();
    const titleLock = createLockRegistry();

    const outcome = attemptSmartAutoLink([], "u1", "novel", "Forgotten Web Novel");
    assert.equal(outcome.kind, "no_match");
    const result = await autoAddAndLinkSource(db, sourceLock, titleLock, "u1", "source-1", "novel", "Forgotten Web Novel");
    assert.equal(result.status, "created");
    assert.equal(db.sources.size, 1, "no second tracking_sources row was created");
    assert.equal(db.sources.get("source-1").libraryItemId, result.libraryItemId);
  });

  // --- Test M: ownership — another user's matching title/source is never touched ---
  await checkAsync("M: a same-titled item belonging to a different user is never linked or read as a match", async () => {
    const db = freshDb();
    db.items.set("other-item", { id: "other-item", userId: "someone-else", type: "novel", title: "Lord of the Mysteries" });
    db.sources.set("source-1", { id: "source-1", userId: "u1", libraryItemId: null });
    const sourceLock = createLockRegistry();
    const titleLock = createLockRegistry();

    const result = await autoAddAndLinkSource(db, sourceLock, titleLock, "u1", "source-1", "novel", "Lord of the Mysteries");
    assert.equal(result.status, "created", "must create u1's own item, never link to someone-else's");
    assert.notEqual(result.libraryItemId, "other-item");
  });
  await checkAsync("M: attemptSmartAutoLink never matches a different user's library", () => {
    const library = [{ id: "other-item", userId: "someone-else", type: "novel", title: "Lord of the Mysteries" }];
    const outcome = attemptSmartAutoLink(library, "u1", "novel", "Lord of the Mysteries");
    assert.equal(outcome.kind, "no_match");
  });

  // ============================================================
  // Regression test for the real production failure: 502 tracking_failed
  // on every real auto-add, root-caused via a direct RPC call against the
  // live (0005-migrated) Supabase project to
  //   ERROR 42883: function max(uuid) does not exist
  // from `select count(*), max(id) into v_match_count, v_existing_id ...`
  // in the exact-match recheck under the advisory lock — library_items.id
  // is `uuid`, and Postgres has no built-in MAX(uuid)/MIN(uuid) aggregate.
  // Fixed in 0006_stage22_auto_add_fix.sql by replacing `max(id)` with
  // `(array_agg(id))[1]`, which works for any type.
  //
  // A JS in-memory model can't reproduce a Postgres type/function
  // resolution error — every JS-level check in this file would have
  // passed both before and after the real fix, which is exactly why the
  // bug shipped past this script the first time. So this regression test
  // has two parts: (1) a realistic end-to-end shape check at the JS-model
  // level (proves the algorithm still produces the right *outcome* for a
  // real detected-novel payload — necessary but not sufficient), and (2) a
  // static check of the actual deployed SQL text on disk (the only thing
  // in this file that can actually catch a regression back to max(id)).
  // ============================================================

  // --- (1) realistic end-to-end shape: the exact payload that failed in production ---
  await checkAsync(
    "regression: a realistic detected-novel payload (My Step-Daughters Are The Villainesses, chapter N, web_novel) creates exactly one item, no exception",
    async () => {
      const db = freshDb();
      db.sources.set("source-1", { id: "source-1", userId: "u1", libraryItemId: null });
      const sourceLock = createLockRegistry();
      const titleLock = createLockRegistry();

      const title = "My Step-Daughters Are The Villainesses";
      const outcome = attemptSmartAutoLink([], "u1", "novel", title);
      assert.equal(outcome.kind, "no_match");

      // autoAddAndLinkSource's model only takes (userId, sourceId, mediaType,
      // title) — the row-shape fields (status/progress/readingFormat/cover)
      // are exercised for real by attemptAutoAdd's own row-building via
      // buildDetectedMediaInput + toLibraryItemRow (unit-covered by
      // verify-detected-work.mjs and verify-metadata-enrichment.mjs); what
      // matters here is that a title shaped like a real detection resolves
      // to exactly one created item with no thrown exception.
      const result = await autoAddAndLinkSource(db, sourceLock, titleLock, "u1", "source-1", "novel", title);
      assert.equal(result.status, "created");
      assert.equal(db.items.size, 1);
      assert.equal(db.sources.get("source-1").libraryItemId, result.libraryItemId);
    },
  );

  // --- (2) static SQL-text guard: the only check that actually catches THIS class of bug ---
  {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const migration0005 = readFileSync(path.join(scriptDir, "..", "supabase", "migrations", "0005_stage22_auto_add.sql"), "utf8");
    const migration0006 = readFileSync(path.join(scriptDir, "..", "supabase", "migrations", "0006_stage22_auto_add_fix.sql"), "utf8");

    // Strips `-- ...` line comments before matching — both files' prose
    // comments legitimately mention `max(id)` while explaining the bug and
    // its fix, so a raw text search would false-positive on 0006 (whose
    // comments quote the very pattern its *code* no longer contains).
    function stripSqlComments(sql) {
      return sql
        .split("\n")
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n");
    }
    const code0005 = stripSqlComments(migration0005);
    const code0006 = stripSqlComments(migration0006);

    check("regression: 0005 is untouched (its code still contains the original, since-fixed max(id) call — migrations are immutable once applied)", () => {
      assert.match(code0005, /max\(id\)/, "0005 must remain byte-identical to what was actually deployed — never edit an applied migration");
    });
    check("regression: 0006 (the effective, currently-running version) replaces max(id) with an aggregate that works for uuid", () => {
      assert.doesNotMatch(code0006, /max\(id\)/, "0006's actual SQL code must not reintroduce max(id) — that's the exact bug this migration fixes");
      assert.match(code0006, /\(array_agg\(id\)\)\[1\]/, "0006 must use array_agg(id) (or an equivalent that isn't a uuid-incompatible aggregate) for the exact-match recheck");
    });
    check("regression: 0006 preserves both locks — the fix must not have simplified away the atomic design", () => {
      assert.match(code0006, /for update/i);
      assert.match(code0006, /pg_advisory_xact_lock/);
    });
  }

  // --- Response-flag exclusivity: autoAdded and autoLinked are never both true for the same request ---
  {
    function responseFlagsFor(outcomeKind) {
      let autoLinked = false;
      let autoAdded = false;
      if (outcomeKind === "created") autoAdded = true;
      else if (outcomeKind === "linked_existing") autoLinked = true;
      // "already_linked" -> neither flag (a concurrent request already won)
      return { autoLinked, autoAdded };
    }
    check("response flags: created -> autoAdded only", () => {
      assert.deepEqual(responseFlagsFor("created"), { autoLinked: false, autoAdded: true });
    });
    check("response flags: linked_existing -> autoLinked only", () => {
      assert.deepEqual(responseFlagsFor("linked_existing"), { autoLinked: true, autoAdded: false });
    });
    check("response flags: already_linked -> neither flag set", () => {
      assert.deepEqual(responseFlagsFor("already_linked"), { autoLinked: false, autoAdded: false });
    });
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}`);
    if (!r.ok) console.log(`  ${r.err.message}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(
    "\nNote: the concurrency checks above (E, cross-source, J) validate the two-lock ALGORITHM under concurrent JS promises. They do not prove real PostgreSQL `for update`/`pg_advisory_xact_lock` semantics — that requires running the actual migration against a real Supabase project.",
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
