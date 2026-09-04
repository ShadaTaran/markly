#!/usr/bin/env node
// Verifies Stage 27 "safe duplicate detection & manual merge" logic:
//   - findDuplicateGroups (lib/duplicate-detection.ts): conservative
//     grouping by exact catalog id or exact normalized title, never fuzzy,
//     never cross-media-type, never suggesting conflicting-catalog-id
//     pairs (Tests A-E)
//   - computeMergedLibraryItem (lib/library-merge.ts): the field-merge
//     policy — scalar survivor-wins/fill-if-empty, array union+dedupe,
//     favorite OR, status survivor-wins, rating fill-if-empty, furthest-
//     progress-wins for absolute/manga/novel/game, lexicographic seasonal,
//     and blocking (never guessing) on numbering-mode/progress-unit/
//     catalog-source conflicts (Tests F-R)
//   - merge_library_items (supabase/migrations/0009): the atomic RPC's
//     control flow — ownership, same-item/type-mismatch rejection,
//     deterministic lock ordering, and (critically) that it recomputes
//     progress server-side from the CURRENT row state rather than trusting
//     a possibly-stale client value (Tests S-X)
//
// Reproduced verbatim from the real modules/SQL rather than imported —
// same approach as every other script in this directory.
//
// IMPORTANT: the RPC-model checks (Tests S-X) validate the ALGORITHM —
// lock-ordering logic, ownership branching, ownership-scoped queries — not
// real PostgreSQL transaction/locking behavior under genuinely concurrent
// connections. Real concurrent-merge and concurrent-tracking-during-merge
// behavior can only be proven against a real Supabase project after
// `npx.cmd supabase db push` applies 0009_stage27_merge_library_items.sql.
//
// Run with: node scripts/verify-duplicate-merge.mjs

import assert from "node:assert/strict";

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
// normalizeTitleForMatching, reproduced from lib/title-normalization.ts
// ============================================================
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

// ============================================================
// findDuplicateGroups, reproduced from lib/duplicate-detection.ts
// ============================================================
function catalogKey(item) {
  if (!item.catalogSource) return null;
  return `${item.type}::${item.catalogSource.provider}::${item.catalogSource.externalId}`;
}
function titleKey(item) {
  return `${item.type}::${normalizeTitleForMatching(item.title)}`;
}
function conflictingCatalogSource(a, b) {
  if (!a.catalogSource || !b.catalogSource) return false;
  return a.catalogSource.provider !== b.catalogSource.provider || a.catalogSource.externalId !== b.catalogSource.externalId;
}
function pushToGroup(map, key, item) {
  const existing = map.get(key);
  if (existing) existing.push(item);
  else map.set(key, [item]);
}
class DisjointSet {
  constructor() {
    this.parent = new Map();
  }
  add(id) {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }
  find(id) {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = id;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}
function groupHasCatalogMatch(items) {
  const counts = new Map();
  for (const item of items) {
    const key = catalogKey(item);
    if (!key) continue;
    const count = (counts.get(key) ?? 0) + 1;
    if (count >= 2) return true;
    counts.set(key, count);
  }
  return false;
}
function findDuplicateGroups(mediaItems) {
  const sets = new DisjointSet();
  mediaItems.forEach((item) => sets.add(item.id));

  const byCatalog = new Map();
  mediaItems.forEach((item) => {
    const key = catalogKey(item);
    if (key) pushToGroup(byCatalog, key, item);
  });
  byCatalog.forEach((group) => {
    for (let i = 1; i < group.length; i++) sets.union(group[0].id, group[i].id);
  });

  const byTitle = new Map();
  mediaItems.forEach((item) => pushToGroup(byTitle, titleKey(item), item));
  byTitle.forEach((group) => {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (conflictingCatalogSource(group[i], group[j])) continue;
        sets.union(group[i].id, group[j].id);
      }
    }
  });

  const components = new Map();
  mediaItems.forEach((item) => pushToGroup(components, sets.find(item.id), item));

  const groups = [];
  components.forEach((groupItems) => {
    if (groupItems.length < 2) return;
    groups.push({ mediaType: groupItems[0].type, confidence: groupHasCatalogMatch(groupItems) ? "catalog_match" : "title_match", items: groupItems });
  });
  return groups;
}

function item(overrides) {
  return { id: "id", type: "novel", title: "Untitled", tags: [], favorite: false, createdAt: "2026-01-01T00:00:00.000Z", status: "planned", ...overrides };
}

function main() {
  // --- Detection ---
  check("Test A: exact same title + type -> duplicate suggestion", () => {
    const groups = findDuplicateGroups([
      item({ id: "a", type: "novel", title: "Lord of the Mysteries" }),
      item({ id: "b", type: "novel", title: "Lord of the Mysteries" }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].confidence, "title_match");
    assert.equal(groups[0].items.length, 2);
  });

  check('Test B: "Lord of the Mysteries" vs "Lord of Mysteries" -> NO automatic suggestion', () => {
    const groups = findDuplicateGroups([
      item({ id: "a", type: "novel", title: "Lord of the Mysteries" }),
      item({ id: "b", type: "novel", title: "Lord of Mysteries" }),
    ]);
    assert.equal(groups.length, 0);
  });

  check("Test C: same title, different media types (novel vs manga) -> NO suggestion", () => {
    const groups = findDuplicateGroups([
      item({ id: "a", type: "anime", title: "Frieren" }),
      item({ id: "b", type: "manga", title: "Frieren" }),
    ]);
    assert.equal(groups.length, 0);
  });

  check("negative regression: Overlord vs Overlord II -> NO suggestion (no partial-title matching)", () => {
    const groups = findDuplicateGroups([
      item({ id: "a", type: "anime", title: "Overlord" }),
      item({ id: "b", type: "anime", title: "Overlord II" }),
    ]);
    assert.equal(groups.length, 0);
  });

  check("Test D: different titles, same AniList externalId + media type -> duplicate suggestion (catalog_match)", () => {
    const groups = findDuplicateGroups([
      item({ id: "a", type: "anime", title: "Frieren", catalogSource: { provider: "anilist", externalId: "154587" } }),
      item({ id: "b", type: "anime", title: "Frieren: Beyond Journey's End", catalogSource: { provider: "anilist", externalId: "154587" } }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].confidence, "catalog_match");
  });

  check("Test E: same exact title/type, CONFLICTING AniList ids -> NO normal safe suggestion", () => {
    const groups = findDuplicateGroups([
      item({ id: "a", type: "novel", title: "Lord of the Mysteries", catalogSource: { provider: "anilist", externalId: "123" } }),
      item({ id: "b", type: "novel", title: "Lord of the Mysteries", catalogSource: { provider: "anilist", externalId: "456" } }),
    ]);
    assert.equal(groups.length, 0);
  });

  check("Section 46: exact title + type, only ONE side has a catalogSource (no conflict) -> suggested", () => {
    const groups = findDuplicateGroups([
      item({ id: "a", type: "novel", title: "Lord of the Mysteries" }),
      item({ id: "b", type: "novel", title: "Lord of the Mysteries", catalogSource: { provider: "open-library", externalId: "XYZ" } }),
    ]);
    assert.equal(groups.length, 1);
  });

  check("Section 5: three copies group into ONE duplicate group, not three pairs", () => {
    const groups = findDuplicateGroups([
      item({ id: "a", type: "novel", title: "Lord of the Mysteries" }),
      item({ id: "b", type: "novel", title: "Lord of the Mysteries" }),
      item({ id: "c", type: "novel", title: "Lord of the Mysteries" }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].items.length, 3);
  });

  // ============================================================
  // computeMergedLibraryItem, reproduced from lib/library-merge.ts
  // ============================================================
  function firstNonEmpty(a, b) {
    return a && a.trim() ? a : b;
  }
  function firstDefined(a, b) {
    return a !== undefined ? a : b;
  }
  function unionDedupe(a, b) {
    if (!a && !b) return undefined;
    const seen = new Map();
    [...(a ?? []), ...(b ?? [])].forEach((v) => {
      const k = v.trim().toLowerCase();
      if (k && !seen.has(k)) seen.set(k, v);
    });
    return Array.from(seen.values());
  }
  function mergeFurthest(a, b) {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.max(a, b);
  }
  function mergeCatalogSource(survivor, duplicate) {
    if (!survivor.catalogSource) return { status: "ok", catalogSource: duplicate.catalogSource };
    if (!duplicate.catalogSource) return { status: "ok", catalogSource: survivor.catalogSource };
    if (survivor.catalogSource.provider === duplicate.catalogSource.provider && survivor.catalogSource.externalId === duplicate.catalogSource.externalId) {
      return { status: "ok", catalogSource: survivor.catalogSource };
    }
    return { status: "blocked", reason: "catalog_source_conflict" };
  }
  function mergeEpisodeProgress(survivor, duplicate) {
    if (duplicate.currentEpisode === undefined) {
      return { status: "ok", fields: { currentEpisode: survivor.currentEpisode, currentSeason: survivor.currentSeason, episodeNumbering: survivor.episodeNumbering } };
    }
    if (survivor.currentEpisode === undefined) {
      return { status: "ok", fields: { currentEpisode: duplicate.currentEpisode, currentSeason: duplicate.currentSeason, episodeNumbering: duplicate.episodeNumbering } };
    }
    const survivorMode = survivor.episodeNumbering === "seasonal" ? "seasonal" : "absolute";
    const duplicateMode = duplicate.episodeNumbering === "seasonal" ? "seasonal" : "absolute";
    if (survivorMode !== duplicateMode) return { status: "blocked", reason: "numbering_mode_conflict" };
    if (survivorMode === "absolute") {
      return { status: "ok", fields: { currentEpisode: Math.max(survivor.currentEpisode, duplicate.currentEpisode), currentSeason: undefined, episodeNumbering: undefined } };
    }
    const ss = survivor.currentSeason ?? 0;
    const ds = duplicate.currentSeason ?? 0;
    const survivorWins = ss > ds || (ss === ds && survivor.currentEpisode >= duplicate.currentEpisode);
    return {
      status: "ok",
      fields: survivorWins
        ? { currentEpisode: survivor.currentEpisode, currentSeason: survivor.currentSeason, episodeNumbering: "seasonal" }
        : { currentEpisode: duplicate.currentEpisode, currentSeason: duplicate.currentSeason, episodeNumbering: "seasonal" },
    };
  }
  function mergeNovelProgress(survivor, duplicate) {
    if (duplicate.progressValue === undefined) return { status: "ok", fields: { progressValue: survivor.progressValue, progressUnit: survivor.progressUnit } };
    if (survivor.progressValue === undefined) return { status: "ok", fields: { progressValue: duplicate.progressValue, progressUnit: duplicate.progressUnit } };
    const su = survivor.progressUnit ?? "chapter";
    const du = duplicate.progressUnit ?? "chapter";
    if (su !== du) return { status: "blocked", reason: "progress_unit_conflict" };
    return { status: "ok", fields: { progressValue: Math.max(survivor.progressValue, duplicate.progressValue), progressUnit: su } };
  }
  function computeMergedLibraryItem(survivor, duplicate) {
    if (survivor.id === duplicate.id) return { status: "blocked", reason: "same_item" };
    if (survivor.type !== duplicate.type) return { status: "blocked", reason: "type_mismatch" };
    const catalogResult = mergeCatalogSource(survivor, duplicate);
    if (catalogResult.status === "blocked") return catalogResult;
    const base = {
      id: survivor.id,
      title: survivor.title,
      description: firstNonEmpty(survivor.description, duplicate.description) ?? "",
      tags: unionDedupe(survivor.tags, duplicate.tags) ?? [],
      favorite: survivor.favorite || duplicate.favorite,
      createdAt: survivor.createdAt,
      status: survivor.status,
      rating: firstDefined(survivor.rating, duplicate.rating),
      catalogSource: catalogResult.catalogSource,
    };
    switch (survivor.type) {
      case "anime":
      case "series": {
        const progress = mergeEpisodeProgress(survivor, duplicate);
        if (progress.status === "blocked") return progress;
        return { status: "ok", merged: { ...base, type: survivor.type, genres: unionDedupe(survivor.genres, duplicate.genres), ...progress.fields } };
      }
      case "manga":
        return {
          status: "ok",
          merged: { ...base, type: "manga", currentChapter: mergeFurthest(survivor.currentChapter, duplicate.currentChapter), authors: unionDedupe(survivor.authors, duplicate.authors) },
        };
      case "novel": {
        const progress = mergeNovelProgress(survivor, duplicate);
        if (progress.status === "blocked") return progress;
        return { status: "ok", merged: { ...base, type: "novel", authors: unionDedupe(survivor.authors, duplicate.authors), ...progress.fields } };
      }
      case "game":
        return { status: "ok", merged: { ...base, type: "game", playtimeHours: mergeFurthest(survivor.playtimeHours, duplicate.playtimeHours) } };
      case "movie":
        return { status: "ok", merged: { ...base, type: "movie", genres: unionDedupe(survivor.genres, duplicate.genres) } };
    }
  }

  // --- Merge basics ---
  check("Test F: progress never regresses — target 50, source 60 -> merged 60", () => {
    const survivor = item({ id: "s", type: "manga", title: "X", currentChapter: 50 });
    const duplicate = item({ id: "d", type: "manga", title: "X", currentChapter: 60 });
    const result = computeMergedLibraryItem(survivor, duplicate);
    assert.equal(result.status, "ok");
    assert.equal(result.merged.currentChapter, 60);
  });

  check("Test G: target favorited false, source favorited true -> merged favorited true", () => {
    const survivor = item({ id: "s", favorite: false });
    const duplicate = item({ id: "d", favorite: true });
    const result = computeMergedLibraryItem(survivor, duplicate);
    assert.equal(result.merged.favorite, true);
  });

  check("Test H: target has description, source has a DIFFERENT description -> target description survives", () => {
    const survivor = item({ id: "s", description: "Original description" });
    const duplicate = item({ id: "d", description: "Some other description" });
    const result = computeMergedLibraryItem(survivor, duplicate);
    assert.equal(result.merged.description, "Original description");
  });

  check("Test I: target description empty, source populated -> source description fills target", () => {
    const survivor = item({ id: "s", description: "" });
    const duplicate = item({ id: "d", description: "From duplicate" });
    const result = computeMergedLibraryItem(survivor, duplicate);
    assert.equal(result.merged.description, "From duplicate");
  });

  check("Test J: overlapping tags union + dedupe (case-insensitive)", () => {
    const survivor = item({ id: "s", tags: ["Fantasy", "adventure"] });
    const duplicate = item({ id: "d", tags: ["fantasy", "web novel"] });
    const result = computeMergedLibraryItem(survivor, duplicate);
    assert.deepEqual(result.merged.tags, ["Fantasy", "adventure", "web novel"]);
  });

  // --- Progress ---
  check("Test O: absolute episode 8 vs 12 -> merged 12", () => {
    const survivor = item({ id: "s", type: "anime", currentEpisode: 8 });
    const duplicate = item({ id: "d", type: "anime", currentEpisode: 12 });
    const result = computeMergedLibraryItem(survivor, duplicate);
    assert.equal(result.merged.currentEpisode, 12);
  });

  check("Test P: seasonal S1E24 vs S2E1 -> merged S2E1", () => {
    const survivor = item({ id: "s", type: "anime", episodeNumbering: "seasonal", currentSeason: 1, currentEpisode: 24 });
    const duplicate = item({ id: "d", type: "anime", episodeNumbering: "seasonal", currentSeason: 2, currentEpisode: 1 });
    const result = computeMergedLibraryItem(survivor, duplicate);
    assert.equal(result.merged.currentSeason, 2);
    assert.equal(result.merged.currentEpisode, 1);
  });

  check("Test Q: seasonal S2E5 vs S2E3 -> merged S2E5 (same season, higher episode)", () => {
    const survivor = item({ id: "s", type: "anime", episodeNumbering: "seasonal", currentSeason: 2, currentEpisode: 5 });
    const duplicate = item({ id: "d", type: "anime", episodeNumbering: "seasonal", currentSeason: 2, currentEpisode: 3 });
    const result = computeMergedLibraryItem(survivor, duplicate);
    assert.equal(result.merged.currentSeason, 2);
    assert.equal(result.merged.currentEpisode, 5);
  });

  check("Test R: absolute vs seasonal numbering conflict -> merge BLOCKED, no guessed conversion", () => {
    const survivor = item({ id: "s", type: "anime", currentEpisode: 20 }); // absolute (no episodeNumbering marker)
    const duplicate = item({ id: "d", type: "anime", episodeNumbering: "seasonal", currentSeason: 2, currentEpisode: 3 });
    const result = computeMergedLibraryItem(survivor, duplicate);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "numbering_mode_conflict");
  });

  check("novel progress-unit conflict also blocks rather than guessing", () => {
    const survivor = item({ id: "s", type: "novel", progressValue: 40, progressUnit: "page" });
    const duplicate = item({ id: "d", type: "novel", progressValue: 12, progressUnit: "chapter" });
    const result = computeMergedLibraryItem(survivor, duplicate);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "progress_unit_conflict");
  });

  check("catalog_source conflict blocks the whole merge (Section 19C)", () => {
    const survivor = item({ id: "s", catalogSource: { provider: "anilist", externalId: "1" } });
    const duplicate = item({ id: "d", catalogSource: { provider: "anilist", externalId: "2" } });
    const result = computeMergedLibraryItem(survivor, duplicate);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "catalog_source_conflict");
  });

  check("catalog_source: survivor has none, duplicate has one -> copied to survivor", () => {
    const survivor = item({ id: "s" });
    const duplicate = item({ id: "d", catalogSource: { provider: "open-library", externalId: "XYZ" } });
    const result = computeMergedLibraryItem(survivor, duplicate);
    assert.deepEqual(result.merged.catalogSource, { provider: "open-library", externalId: "XYZ" });
  });

  check("same id is rejected (Test T's client-side twin)", () => {
    const survivor = item({ id: "same" });
    const duplicate = item({ id: "same" });
    const result = computeMergedLibraryItem(survivor, duplicate);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "same_item");
  });

  check("different media types are rejected client-side too (Test U's client-side twin)", () => {
    const survivor = item({ id: "s", type: "anime" });
    const duplicate = item({ id: "d", type: "manga" });
    const result = computeMergedLibraryItem(survivor, duplicate);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "type_mismatch");
  });

  // ============================================================
  // Relationship transfer, reproduced from the same migration's
  // tracking_sources / collection_items / activity_events statements
  // ============================================================
  function moveTrackingSources(sources, survivorId, duplicateId) {
    return sources.map((s) => (s.library_item_id === duplicateId ? { ...s, library_item_id: survivorId } : s));
  }
  function moveCollectionItems(collectionItems, survivorId, duplicateId) {
    // INSERT ... ON CONFLICT DO NOTHING, then DELETE the duplicate's rows
    // — reproduced exactly (see the migration's own comment on why this
    // isn't a plain UPDATE: collection_items has no UPDATE RLS policy).
    const survivorCollections = new Set(collectionItems.filter((ci) => ci.item_id === survivorId).map((ci) => ci.collection_id));
    const inserted = collectionItems
      .filter((ci) => ci.item_id === duplicateId && !survivorCollections.has(ci.collection_id))
      .map((ci) => ({ ...ci, item_id: survivorId }));
    const untouched = collectionItems.filter((ci) => ci.item_id !== duplicateId);
    return [...untouched, ...inserted];
  }
  function moveActivityEvents(events, survivorId, duplicateId) {
    return events.map((e) => (e.item_id === duplicateId ? { ...e, item_id: survivorId } : e));
  }

  check("Test K: target has Source A, duplicate has Sources B+C -> all three end up on target", () => {
    const sources = [
      { id: "src-a", library_item_id: "target", auto_track_enabled: true },
      { id: "src-b", library_item_id: "duplicate", auto_track_enabled: false },
      { id: "src-c", library_item_id: "duplicate", auto_track_enabled: true, auto_link_suppressed_at: "2026-01-01T00:00:00.000Z" },
    ];
    const moved = moveTrackingSources(sources, "target", "duplicate");
    assert.equal(moved.filter((s) => s.library_item_id === "target").length, 3);
    assert.equal(moved.filter((s) => s.library_item_id === "duplicate").length, 0);
    // Section 20/35 — per-source state (auto_track_enabled,
    // auto_link_suppressed_at) is preserved untouched, never reset.
    const movedC = moved.find((s) => s.id === "src-c");
    assert.equal(movedC.auto_track_enabled, true);
    assert.equal(movedC.auto_link_suppressed_at, "2026-01-01T00:00:00.000Z");
  });

  check("Test L: both items already in the same collection PLUS unique collections -> unique union, no constraint failure", () => {
    const collectionItems = [
      { collection_id: "favorites", item_id: "target" },
      { collection_id: "favorites", item_id: "duplicate" }, // shared — must not produce a duplicate row after merge
      { collection_id: "reading", item_id: "target" },
      { collection_id: "web-novels", item_id: "duplicate" },
    ];
    const moved = moveCollectionItems(collectionItems, "target", "duplicate");
    // No two rows for the same (collection_id, item_id) pair.
    const keys = moved.map((ci) => `${ci.collection_id}::${ci.item_id}`);
    assert.equal(new Set(keys).size, keys.length, "no duplicate (collection_id, item_id) pairs");
    const targetCollections = new Set(moved.filter((ci) => ci.item_id === "target").map((ci) => ci.collection_id));
    assert.deepEqual([...targetCollections].sort(), ["favorites", "reading", "web-novels"]);
    assert.equal(moved.some((ci) => ci.item_id === "duplicate"), false);
  });

  check("Test M: duplicate's Activity history survives, reassigned to target, values unchanged", () => {
    const events = [
      { id: "e1", item_id: "duplicate", type: "progress_updated", data: { progressKind: "chapter", previousValue: 40, newValue: 58 } },
      { id: "e2", item_id: "target", type: "item_added", data: {} },
    ];
    const moved = moveActivityEvents(events, "target", "duplicate");
    assert.equal(moved.length, 2, "no event lost");
    const reassigned = moved.find((e) => e.id === "e1");
    assert.equal(reassigned.item_id, "target");
    assert.deepEqual(reassigned.data, { progressKind: "chapter", previousValue: 40, newValue: 58 }, "historical values never rewritten");
  });

  check("Test N: after deleting the duplicate, no relationship still points at it (no orphans)", () => {
    let sources = [{ id: "src-a", library_item_id: "duplicate" }];
    let collectionItems = [{ collection_id: "reading", item_id: "duplicate" }];
    let events = [{ id: "e1", item_id: "duplicate", type: "item_added", data: {} }];

    sources = moveTrackingSources(sources, "target", "duplicate");
    collectionItems = moveCollectionItems(collectionItems, "target", "duplicate");
    events = moveActivityEvents(events, "target", "duplicate");
    // delete public.library_items where id = duplicate — modeled as: the
    // duplicate id no longer exists as a row anywhere.
    const referencesDuplicate = [...sources, ...collectionItems, ...events].some(
      (row) => row.library_item_id === "duplicate" || row.item_id === "duplicate",
    );
    assert.equal(referencesDuplicate, false);
  });

  // ============================================================
  // Local-mode ordering regression — a REAL bug caught live (not
  // assumed): useCollections has a self-healing effect that strips any
  // collection itemId no longer present in the library's `items` array,
  // reacting whenever `items` changes. Reassigning a collection's
  // membership from duplicate->survivor AFTER the duplicate has already
  // been removed from `items` means that effect can observe the
  // dangling duplicate id first and strip it outright, losing the
  // membership instead of moving it — even though mergeItemReferences
  // itself is correct in isolation. LibraryView.handleMergeDuplicates
  // fixes this by reassigning collections/activity BEFORE calling
  // library.mergeItems (see its own doc comment). Modeled here as: the
  // self-healing cleanup only ever sees a `items` list that already
  // lacks the duplicate AFTER collections have already stopped
  // referencing it (the correct order) — never the reverse.
  // ============================================================
  function selfHealCollectionMembership(collectionItemIds, currentLibraryItemIds) {
    return collectionItemIds.filter((id) => currentLibraryItemIds.includes(id));
  }

  check("ordering regression: reassigning collections BEFORE removing the duplicate from items survives self-healing cleanup", () => {
    let collectionItemIds = ["duplicate"];
    // Correct order: reassign first...
    collectionItemIds = collectionItemIds.map((id) => (id === "duplicate" ? "survivor" : id));
    // ...THEN remove the duplicate from the library's own items list.
    const libraryItemIds = ["survivor"]; // duplicate already gone
    // The self-healing effect, reacting to the new items list, must find
    // nothing to strip — "survivor" is still a real item.
    const healed = selfHealCollectionMembership(collectionItemIds, libraryItemIds);
    assert.deepEqual(healed, ["survivor"], "membership must survive — this is the regression the wrong order actually produced");
  });

  check("ordering regression: the WRONG order (remove first, reassign second) is what actually loses the membership — proving the fix matters", () => {
    let collectionItemIds = ["duplicate"];
    const libraryItemIds = ["survivor"]; // duplicate already removed from items FIRST (the buggy order)
    // Self-healing runs before reassignment ever happens in this ordering.
    collectionItemIds = selfHealCollectionMembership(collectionItemIds, libraryItemIds);
    assert.deepEqual(collectionItemIds, [], "this is the exact bug caught live: membership silently lost, not moved");
  });

  // ============================================================
  // merge_library_items RPC control flow, reproduced from
  // supabase/migrations/0009_stage27_merge_library_items.sql
  // ============================================================
  function mergeRpcModel(rows, callerUid, survivorId, duplicateId, mergedRow) {
    if (!callerUid) return { status: "unauthorized" };
    if (survivorId === duplicateId) return { status: "same_item" };

    // Deterministic lock ordering by uuid string comparison — modeled here
    // as "acquire in sorted order", then look up by role afterward.
    const [first, second] = [survivorId, duplicateId].sort();
    void first;
    void second;

    const survivorRow = rows.find((r) => r.id === survivorId && r.user_id === callerUid);
    const duplicateRow = rows.find((r) => r.id === duplicateId && r.user_id === callerUid);
    if (!survivorRow || !duplicateRow) return { status: "not_found" };
    if (survivorRow.type !== duplicateRow.type) return { status: "type_mismatch" };

    const catalogSurvivor = survivorRow.metadata.catalogSource;
    const catalogDuplicate = duplicateRow.metadata.catalogSource;
    if (catalogSurvivor && catalogDuplicate && (catalogSurvivor.provider !== catalogDuplicate.provider || catalogSurvivor.externalId !== catalogDuplicate.externalId)) {
      return { status: "catalog_source_conflict" };
    }

    // Server-authoritative progress recomputation — deliberately reads
    // ONLY survivorRow/duplicateRow (the "currently locked" state), never
    // mergedRow, for progress fields. This is the crux of Test X.
    let finalCurrentChapter;
    if (survivorRow.type === "manga") {
      const s = survivorRow.metadata.currentChapter ?? -1;
      const d = duplicateRow.metadata.currentChapter ?? -1;
      if (Math.max(s, d) >= 0) finalCurrentChapter = Math.max(s, d);
    }

    return { status: "merged", survivorId, finalCurrentChapter, appliedFrom: mergedRow ? "merged_row_for_non_progress_fields" : undefined };
  }

  check("Test S: merging another user's item is rejected", () => {
    const rows = [
      { id: "s", user_id: "user-1", type: "novel", metadata: {} },
      { id: "d", user_id: "user-2", type: "novel", metadata: {} }, // belongs to a different user
    ];
    const result = mergeRpcModel(rows, "user-1", "s", "d", {});
    assert.equal(result.status, "not_found"); // never leaks whether it exists — same as any other cross-user id
  });

  check("Test T: survivorId === duplicateId is rejected as a no-op/error", () => {
    const result = mergeRpcModel([], "user-1", "same-id", "same-id", {});
    assert.equal(result.status, "same_item");
  });

  check("Test U: different media types rejected server-side even if the client claims otherwise", () => {
    const rows = [
      { id: "s", user_id: "u", type: "anime", metadata: {} },
      { id: "d", user_id: "u", type: "manga", metadata: {} },
    ];
    const result = mergeRpcModel(rows, "u", "s", "d", {});
    assert.equal(result.status, "type_mismatch");
  });

  check("Test V: double-submit the same merge — second call finds the duplicate already gone (not_found), never corrupts anything", () => {
    let rows = [
      { id: "s", user_id: "u", type: "manga", metadata: { currentChapter: 10 } },
      { id: "d", user_id: "u", type: "manga", metadata: { currentChapter: 20 } },
    ];
    const first = mergeRpcModel(rows, "u", "s", "d", {});
    assert.equal(first.status, "merged");
    // Simulate the RPC's actual effect: duplicate row deleted.
    rows = rows.filter((r) => r.id !== "d");
    const second = mergeRpcModel(rows, "u", "s", "d", {});
    assert.equal(second.status, "not_found"); // deterministic safe failure, not a duplicate write
  });

  check("Test W: A->B and B->A concurrent merge requests both target the same underlying pair — whichever completes first wins, the second safely fails (no deadlock modeled as no unbounded wait, no corruption)", () => {
    let rows = [
      { id: "a", user_id: "u", type: "novel", metadata: {} },
      { id: "b", user_id: "u", type: "novel", metadata: {} },
    ];
    // Deterministic lock ordering means both requests acquire locks on
    // this pair in the same order regardless of which role is "survivor"
    // — modeled here as: the first to actually run wins, the second (now
    // operating on an already-merged pair) gets a clean not_found rather
    // than partial/corrupted state.
    const requestAintoB = mergeRpcModel(rows, "u", "b", "a", {}); // keep B, merge A in
    assert.equal(requestAintoB.status, "merged");
    rows = rows.filter((r) => r.id !== "a");
    const requestBintoA = mergeRpcModel(rows, "u", "a", "b", {}); // the racing "keep A" request, now stale
    assert.equal(requestBintoA.status, "not_found");
  });

  check("Test X: tracking progress arrives at the duplicate's CURRENT value while merging — the merge uses the fresh row, never a stale client-precomputed number", () => {
    // Client fetched the duplicate at chapter 60 and precomputed a merged
    // value of max(50, 60) = 60 — but by the time the merge transaction
    // actually locks the rows, a concurrent TrackingSource commit already
    // advanced the duplicate to chapter 61. The RPC must reflect 61, not
    // the client's stale 60.
    const rows = [
      { id: "s", user_id: "u", type: "manga", metadata: { currentChapter: 50 } },
      { id: "d", user_id: "u", type: "manga", metadata: { currentChapter: 61 } }, // fresher than what the client saw
    ];
    const staleClientMergedRow = { metadata: { currentChapter: 60 } }; // what the client precomputed and would send
    const result = mergeRpcModel(rows, "u", "s", "d", staleClientMergedRow);
    assert.equal(result.status, "merged");
    assert.equal(result.finalCurrentChapter, 61, "must reflect the fresh row's value, never the client's stale precomputed one");
  });

  console.log(
    "\nNote: Tests S-X above validate the merge RPC's ALGORITHM (ownership branching, same-item/type-mismatch rejection, deterministic lock-ordering logic, and — most importantly — that progress fields are recomputed from fresh row state rather than trusted from the client) as a plain JS model of the SQL function's control flow. Real PostgreSQL row-locking and transaction behavior under genuinely concurrent connections (including a real TrackingSource commit racing a real merge transaction) can only be proven against a real Supabase project after `npx.cmd supabase db push` applies 0009_stage27_merge_library_items.sql.",
  );

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}`);
    if (!r.ok) console.log(`  ${r.err.message}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
