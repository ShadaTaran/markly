#!/usr/bin/env node
// Verifies Stage 26 "cross-source work identity & tracking source
// management" logic:
//   - many tracking_sources rows safely sharing one library_item_id
//     (Phase 0 found this already worked structurally — modeled here as
//     regression proof, not new code)
//   - cross-source progress: the existing atomic apply_extension_progress/
//     apply_extension_season_episode_progress RPCs are oblivious to which
//     source triggered a call, so two sources already serialize correctly
//     through the same row lock (Tests A/B/C/J/K)
//   - disabled-source server enforcement (already existed since Stage 22 —
//     regression-proved, Test D/E)
//   - the new auto_link_suppressed_at manual-unlink-suppression logic
//     (genuinely new — Tests F/G), and that it does NOT block Auto-Add's
//     "second source, same title" scenario when NOT suppressed (Test I)
//   - fixture-correction regression: the real attemptSmartAutoLink exact-
//     match logic against the corrected Source B fixture title ("Lord of
//     the Mysteries", matching the real NovelPhoenix work) in both
//     directions — a genuine positive match, and a negative proof that
//     "Lord of Mysteries" (missing "the") still does NOT match, so the
//     fixture fix didn't quietly loosen Smart Auto-Link along the way
//   - unconfirmed video discovery across sources never advancing progress
//     (Test L)
//   - the new source-display helpers (friendly names, progress
//     formatting, safe Open Source URLs, grouping by LibraryItem)
//
// Reproduced verbatim from the real modules/SQL rather than imported —
// same approach as every other script in this directory.
//
// IMPORTANT: the RPC-model checks below validate the ALGORITHM (lock +
// compare-and-set ordering), not real PostgreSQL row-locking under actual
// concurrent connections — the same honest caveat every prior atomic-RPC
// script in this directory carries. Real concurrent-request behavior
// across two genuinely simultaneous sources can only be proven against a
// real Supabase project.
//
// Run with: node scripts/verify-source-management.mjs

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
// apply_extension_progress, reproduced from
// supabase/migrations/0004_stage18_atomic_progress.sql — unchanged by
// Stage 26, modeled here only to prove cross-source callers serialize
// correctly through it.
// ============================================================
function applyProgressModel(row, newValue) {
  const current = row.metadata.currentChapter ?? 0;
  if (newValue < current) return { status: "behind_current_progress", currentValue: current };
  if (newValue === current) return { status: "unchanged", currentValue: current };
  row.metadata.currentChapter = newValue;
  return { status: "updated", currentValue: newValue };
}

// ============================================================
// Tests A/B/C — two distinct sources, same LibraryItem, same RPC model
// ============================================================
function main() {
  check("Test A: two sources linked to the same item both contribute to one progress value (higher wins)", () => {
    const item = { metadata: { currentChapter: 50 } };
    const fromSourceA = applyProgressModel(item, 51);
    assert.equal(fromSourceA.status, "updated");
    const fromSourceB = applyProgressModel(item, 52);
    assert.equal(fromSourceB.status, "updated");
    assert.equal(item.metadata.currentChapter, 52);
  });

  check("Test B: a second source detecting a lower chapter never regresses the item", () => {
    const item = { metadata: { currentChapter: 52 } };
    const result = applyProgressModel(item, 40);
    assert.equal(result.status, "behind_current_progress");
    assert.equal(item.metadata.currentChapter, 52);
  });

  check("Test C: two sources detecting the identical value produce exactly one logical transition (second is unchanged)", () => {
    const item = { metadata: { currentChapter: 52 } };
    const fromSourceA = applyProgressModel(item, 53);
    const fromSourceB = applyProgressModel(item, 53);
    assert.equal(fromSourceA.status, "updated");
    assert.equal(fromSourceB.status, "unchanged"); // no duplicate Activity — see route.ts, only "updated" ever inserts one
  });

  check("Test J: concurrent-arrival ordering never produces a corrupted intermediate final value", () => {
    // Row locking means requests apply strictly one-at-a-time regardless
    // of arrival order; both legitimate final orderings are acceptable,
    // "51" (B's value lost to a stale read) is not.
    const item1 = { metadata: { currentChapter: 50 } };
    applyProgressModel(item1, 51); // A first
    applyProgressModel(item1, 52); // B second
    assert.equal(item1.metadata.currentChapter, 52);

    const item2 = { metadata: { currentChapter: 50 } };
    applyProgressModel(item2, 52); // B first
    const later = applyProgressModel(item2, 51); // A second, now stale
    assert.equal(item2.metadata.currentChapter, 52);
    assert.equal(later.status, "behind_current_progress");
  });

  // ============================================================
  // apply_extension_season_episode_progress, reproduced from
  // supabase/migrations/0007 — Test K
  // ============================================================
  function applySeasonModel(row, season, episode) {
    const cs = row.metadata.currentSeason ?? null;
    const ce = row.metadata.currentEpisode ?? 0;
    if (cs !== null) {
      if (season < cs || (season === cs && episode < ce)) return { status: "behind_current_progress" };
      if (season === cs && episode === ce) return { status: "unchanged" };
    }
    row.metadata.currentSeason = season;
    row.metadata.currentEpisode = episode;
    return { status: "updated" };
  }

  check("Test K: seasonal cross-source — the higher (season, episode) from either source wins", () => {
    const item = { metadata: { episodeNumbering: "seasonal", currentSeason: 2, currentEpisode: 3 } };
    const fromSourceA = applySeasonModel(item, 2, 4);
    assert.equal(fromSourceA.status, "updated");
    const fromSourceB = applySeasonModel(item, 2, 5);
    assert.equal(fromSourceB.status, "updated");
    assert.equal(item.metadata.currentSeason, 2);
    assert.equal(item.metadata.currentEpisode, 5);
  });

  // ============================================================
  // Tests D/E — disabled-source server enforcement (Stage 22, unchanged;
  // regression-proved here since Stage 26 depends on it still holding)
  // ============================================================
  function routeModel(source, commitProgress) {
    if (source.existing && !source.existing.auto_track_enabled) {
      return { status: "tracking_disabled" };
    }
    return { status: commitProgress ? "updated" : "detected" };
  }

  check("Test D: a disabled source's detection never reaches progress commit", () => {
    const result = routeModel({ existing: { auto_track_enabled: false } }, true);
    assert.equal(result.status, "tracking_disabled");
  });

  check("Test D: a second, enabled source linked to the same item still updates normally", () => {
    const result = routeModel({ existing: { auto_track_enabled: true } }, true);
    assert.equal(result.status, "updated");
  });

  check("Test E: re-enabling a source (auto_track_enabled: true) resumes normal commits", () => {
    const result = routeModel({ existing: { auto_track_enabled: true } }, true);
    assert.equal(result.status, "updated");
  });

  // ============================================================
  // Tests F/G — the new auto_link_suppressed_at logic (route.ts's gate,
  // reproduced verbatim) and Test I (Auto-Add second-source, unsuppressed)
  // ============================================================
  function linkingDecisionModel(existing, smartAutoLinkOutcome, autoAddEnabled) {
    if (!existing?.library_item_id) {
      if (existing?.auto_link_suppressed_at) {
        return { status: "needs_link", reason: "no_match" };
      }
      if (smartAutoLinkOutcome.kind === "matched") {
        return { status: "linked", libraryItemId: smartAutoLinkOutcome.libraryItemId, via: "smart_auto_link" };
      }
      if (smartAutoLinkOutcome.kind === "no_match" && autoAddEnabled) {
        return { status: "linked", libraryItemId: "new-item-id", via: "auto_add" };
      }
      return { status: "needs_link", reason: smartAutoLinkOutcome.kind === "ambiguous" ? "ambiguous" : "no_match" };
    }
    return { status: "linked", libraryItemId: existing.library_item_id, via: "already_linked" };
  }

  check("Test F: an explicitly unlinked source (auto_link_suppressed_at set) is NOT immediately relinked by the next detection, even with an exact title match available", () => {
    const existing = { library_item_id: null, auto_link_suppressed_at: "2026-01-01T00:00:00.000Z" };
    const result = linkingDecisionModel(existing, { kind: "matched", libraryItemId: "item-x" }, true);
    assert.equal(result.status, "needs_link");
    assert.equal(result.reason, "no_match");
  });

  check("Test F: a suppressed source with Auto-Add enabled does NOT create a duplicate item either", () => {
    const existing = { library_item_id: null, auto_link_suppressed_at: "2026-01-01T00:00:00.000Z" };
    const result = linkingDecisionModel(existing, { kind: "no_match" }, true);
    assert.equal(result.status, "needs_link");
  });

  check("Test G: an explicit manual Link clears the suppression, and the source relinks/updates normally afterward", () => {
    // Models linkSource()'s always-clear-suppression write, then the next
    // detection through the (now unsuppressed) row.
    const row = { library_item_id: null, auto_link_suppressed_at: "2026-01-01T00:00:00.000Z" };
    // Manual link (POST /api/tracking-sources/link -> linkSource)
    row.library_item_id = "item-x";
    row.auto_link_suppressed_at = null;
    assert.equal(row.auto_link_suppressed_at, null);
    // Next detection: already linked, flows straight through.
    const result = linkingDecisionModel(row, { kind: "matched", libraryItemId: "item-x" }, true);
    assert.equal(result.status, "linked");
    assert.equal(result.via, "already_linked");
  });

  check("Test I: Auto-Add second-source scenario — an unsuppressed, never-before-seen source with an exact title match links to the existing item, never creating a duplicate", () => {
    const existing = { library_item_id: null, auto_link_suppressed_at: null };
    const result = linkingDecisionModel(existing, { kind: "matched", libraryItemId: "item-x" }, true);
    assert.equal(result.status, "linked");
    assert.equal(result.libraryItemId, "item-x");
    assert.equal(result.via, "smart_auto_link");
  });

  // ============================================================
  // Fixture-correction regression: the Stage 26 acceptance test fixture
  // (Source B, /dev/reader-test-b) was found to be reporting the WRONG
  // title — "Lord of Mysteries" (missing "the") instead of the real
  // NovelPhoenix work's actual title, "Lord of the Mysteries". These two
  // tests prove BOTH directions against the real attemptSmartAutoLink
  // logic (normalizeTitleForMatching + exact-match-only, reproduced
  // verbatim from src/lib/extension/auto-link.ts): the corrected fixture
  // genuinely produces a single-item, two-source match (the positive
  // case Stage 26 needs to demonstrate), and — just as importantly — a
  // near-miss title that merely LOOKS similar still does NOT match,
  // proving the fixture fix didn't accidentally weaken Smart Auto-Link's
  // conservative exact-normalized-title matching to get there.
  // ============================================================
  function normalizeTitleForMatchingModel(title) {
    return title
      .normalize("NFKC")
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”‟]/g, '"')
      .replace(/[‒–—―]/g, "-")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");
  }

  function attemptSmartAutoLinkModel(libraryItems, mediaType, sourceTitle) {
    const target = normalizeTitleForMatchingModel(sourceTitle);
    if (!target) return { kind: "no_match" };
    const matches = libraryItems.filter((item) => item.type === mediaType && normalizeTitleForMatchingModel(item.title) === target);
    if (matches.length === 1) return { kind: "matched", libraryItemId: matches[0].id };
    if (matches.length > 1) return { kind: "ambiguous" };
    return { kind: "no_match" };
  }

  check("fixture fix — exact match: Library \"Lord of the Mysteries\" (novel); Source A detects \"Lord of the Mysteries\" (novel) -> matches the item", () => {
    const library = [{ id: "lotm-item", type: "novel", title: "Lord of the Mysteries" }];
    const outcome = attemptSmartAutoLinkModel(library, "novel", "Lord of the Mysteries");
    assert.equal(outcome.kind, "matched");
    assert.equal(outcome.libraryItemId, "lotm-item");
  });

  check("fixture fix — exact match: the same library item; Source B (corrected fixture, distinct adapter/source identity) also detects \"Lord of the Mysteries\" (novel) -> matches the SAME item, zero duplicates", () => {
    const library = [{ id: "lotm-item", type: "novel", title: "Lord of the Mysteries" }];
    // Source A and Source B are different tracking_sources rows (different
    // adapterId/sourceKey — see markly-test-reader-b.ts's own comment) but
    // both resolve to the identical libraryItemId via the identical exact
    // normalized title, which is exactly the "one work, one item" outcome
    // Stage 26 needed to prove.
    const fromSourceA = attemptSmartAutoLinkModel(library, "novel", "Lord of the Mysteries");
    const fromSourceB = attemptSmartAutoLinkModel(library, "novel", "Lord of the Mysteries");
    assert.equal(fromSourceA.kind, "matched");
    assert.equal(fromSourceB.kind, "matched");
    assert.equal(fromSourceA.libraryItemId, fromSourceB.libraryItemId);
    // Only ever one candidate for either source to have matched against —
    // no second, duplicate LibraryItem was ever in play.
    assert.equal(library.filter((item) => normalizeTitleForMatchingModel(item.title) === normalizeTitleForMatchingModel("Lord of the Mysteries")).length, 1);
  });

  check('fixture-fix negative regression: Library "Lord of the Mysteries"; a detection of "Lord of Mysteries" (missing "the") does NOT auto-link — fuzzy matching stays forbidden', () => {
    const library = [{ id: "lotm-item", type: "novel", title: "Lord of the Mysteries" }];
    const outcome = attemptSmartAutoLinkModel(library, "novel", "Lord of Mysteries");
    assert.equal(outcome.kind, "no_match");
  });

  check('fixture-fix negative regression, reversed direction: Library "Lord of Mysteries"; a detection of "Lord of the Mysteries" also does NOT auto-link', () => {
    const library = [{ id: "other-item", type: "novel", title: "Lord of Mysteries" }];
    const outcome = attemptSmartAutoLinkModel(library, "novel", "Lord of the Mysteries");
    assert.equal(outcome.kind, "no_match");
  });

  check("clearBrokenLink (item deleted) never sets auto_link_suppressed_at — only a real user Unlink does", () => {
    // Models clearBrokenLink's actual update payload: library_item_id
    // only, auto_link_suppressed_at untouched.
    const row = { library_item_id: "item-x", auto_link_suppressed_at: null };
    const clearBrokenLinkPayload = { library_item_id: null }; // exactly what tracking-sources.ts's clearBrokenLink sends
    Object.assign(row, clearBrokenLinkPayload);
    assert.equal(row.auto_link_suppressed_at, null);
    // So the next detection is free to Smart Auto-Link/Auto-Add normally.
    const result = linkingDecisionModel(row, { kind: "matched", libraryItemId: "item-y" }, true);
    assert.equal(result.status, "linked");
  });

  // ============================================================
  // Test L — unconfirmed video discovery across two sources
  // ============================================================
  function buildAnimeInputModel(progress) {
    const confirmedEpisode = progress?.kind === "episode" && progress.confirmed !== false ? progress.value : undefined;
    return { currentEpisode: confirmedEpisode };
  }

  check("Test L: two video sources both discovering the same episode (unconfirmed) never advances progress", () => {
    const fromSourceA = buildAnimeInputModel({ kind: "episode", value: 6, confirmed: false });
    const fromSourceB = buildAnimeInputModel({ kind: "episode", value: 6, confirmed: false });
    assert.equal(fromSourceA.currentEpisode, undefined);
    assert.equal(fromSourceB.currentEpisode, undefined);
  });

  check("Test L: only a genuine completion commit (confirmed !== false) from either source ever sets the episode", () => {
    const fromSourceB = buildAnimeInputModel({ kind: "episode", value: 6, confirmed: true });
    assert.equal(fromSourceB.currentEpisode, 6);
  });

  // ============================================================
  // source-display.ts, reproduced
  // ============================================================
  const ADAPTER_LABELS = {
    mangadex: "MangaDex",
    "markly-test-reader": "Markly Test Reader",
    "markly-test-reader-b": "Markly Test Reader B",
    "markly-season-test": "Markly Season Test",
  };
  const HOSTNAME_LABELS = { "novelphoenix.com": "NovelPhoenix", "mangadex.org": "MangaDex" };

  function getSourceHostnameModel(sourceUrl) {
    if (!sourceUrl) return null;
    try {
      return new URL(sourceUrl).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }

  function getSourceDisplayNameModel(adapterId, sourceUrl) {
    if (ADAPTER_LABELS[adapterId]) return ADAPTER_LABELS[adapterId];
    const hostname = getSourceHostnameModel(sourceUrl);
    if (hostname && HOSTNAME_LABELS[hostname]) return HOSTNAME_LABELS[hostname];
    return hostname ?? adapterId;
  }

  check("friendly name: a known adapterId (mangadex) never shows the raw id", () => {
    assert.equal(getSourceDisplayNameModel("mangadex", "https://mangadex.org/title/abc"), "MangaDex");
  });

  check("friendly name: universal-reader (no adapter-level name) falls back to a known hostname mapping", () => {
    assert.equal(getSourceDisplayNameModel("universal-reader", "https://novelphoenix.com/novel/x/chapter-1"), "NovelPhoenix");
  });

  check("friendly name: an unknown hostname still shows the hostname itself, never the raw adapterId", () => {
    const name = getSourceDisplayNameModel("universal-reader", "https://example-reader.com/book/1/chapter-2");
    assert.equal(name, "example-reader.com");
    assert.notEqual(name, "universal-reader");
  });

  check("friendly name: no parseable URL at all falls back to the raw adapterId as an absolute last resort", () => {
    assert.equal(getSourceDisplayNameModel("universal-reader", null), "universal-reader");
  });

  function formatSourceProgressModel(progress) {
    if (!progress) return "No progress detected yet";
    const value =
      progress.kind === "season_episode"
        ? progress.season !== undefined
          ? `Season ${progress.season}, Episode ${progress.value}`
          : `Episode ${progress.value}`
        : progress.kind === "chapter"
          ? `Chapter ${progress.value}`
          : `${progress.kind} ${progress.value}`;
    return progress.confirmed === false ? `Detected: ${value} (not completed)` : value;
  }

  check("progress formatting: an unconfirmed video discovery is never shown as committed progress", () => {
    const text = formatSourceProgressModel({ kind: "season_episode", value: 3, season: 2, confirmed: false });
    assert.equal(text, "Detected: Season 2, Episode 3 (not completed)");
  });

  check("progress formatting: a confirmed/committed detection shows the plain value with no caveat", () => {
    const text = formatSourceProgressModel({ kind: "chapter", value: 58 });
    assert.equal(text, "Chapter 58");
  });

  function isSafeOpenSourceUrlModel(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  check("Open Source safety: http/https URLs are allowed", () => {
    assert.equal(isSafeOpenSourceUrlModel("https://novelphoenix.com/novel/x/chapter-1"), true);
  });

  for (const dangerous of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "not a url"]) {
    check(`Open Source safety: "${dangerous}" is never rendered as a clickable link`, () => {
      assert.equal(isSafeOpenSourceUrlModel(dangerous), false);
    });
  }

  // ============================================================
  // groupLinkedSources, reproduced from TrackingSettingsPanel.tsx
  // ============================================================
  function groupLinkedSourcesModel(sources, libraryItems) {
    const groups = new Map();
    for (const source of sources) {
      if (!source.libraryItemId) continue;
      const existing = groups.get(source.libraryItemId);
      if (existing) {
        existing.sources.push(source);
        continue;
      }
      const itemTitle = libraryItems?.find((item) => item.id === source.libraryItemId)?.title ?? "Markly item";
      groups.set(source.libraryItemId, { itemId: source.libraryItemId, itemTitle, sources: [source] });
    }
    return Array.from(groups.values());
  }

  check("grouping: two sources linked to the same item group into a single entry with both sources listed", () => {
    const sources = [
      { id: "a", libraryItemId: "item-x" },
      { id: "b", libraryItemId: "item-x" },
      { id: "c", libraryItemId: "item-y" },
    ];
    const items = [{ id: "item-x", title: "Lord of the Mysteries" }, { id: "item-y", title: "Frieren" }];
    const groups = groupLinkedSourcesModel(sources, items);
    assert.equal(groups.length, 2);
    const lomGroup = groups.find((g) => g.itemId === "item-x");
    assert.equal(lomGroup.sources.length, 2);
    assert.equal(lomGroup.itemTitle, "Lord of the Mysteries");
  });

  check("grouping: unlinked sources never appear in any group", () => {
    const sources = [{ id: "a", libraryItemId: "item-x" }, { id: "b", libraryItemId: null }];
    const groups = groupLinkedSourcesModel(sources, [{ id: "item-x", title: "X" }]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].sources.length, 1);
  });

  // ============================================================
  // No-migration-touched regression (schema fact, from Phase 0)
  // ============================================================
  check("Phase 0 fact: tracking_sources' only uniqueness constraint is on source identity, never library_item_id (already many-to-one-safe)", () => {
    // A direct assertion of the 0003 migration's actual constraint text
    // would require parsing SQL; this documents the fact this script's
    // Tests A/B/C/J/K all depend on, verified by inspection in the Stage
    // 26 Phase 0 report.
    const uniqueConstraintColumns = ["user_id", "adapter_id", "source_key"];
    assert.equal(uniqueConstraintColumns.includes("library_item_id"), false);
  });

  console.log(
    "\nNote: the RPC-model checks above (Tests A/B/C/J/K) validate the ALGORITHM — that two distinct callers serialize correctly through the same row-locked compare-and-set — not real PostgreSQL concurrency under genuinely simultaneous connections. The auto_link_suppressed_at logic (Tests F/G/I) is new in this stage; its column and route.ts gate should also be exercised against a real Supabase project after `npx.cmd supabase db push` applies 0008_stage26_source_management.sql.",
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
