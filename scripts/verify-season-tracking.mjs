#!/usr/bin/env node
// Verifies Stage 25 "season-aware episode tracking" logic:
//   - apply_extension_season_episode_progress's lexicographic (season,
//     episode) comparison (supabase/migrations/
//     0007_stage25_season_progress.sql) — the primary Stage 25 acceptance
//     test (a season transition must advance even though the raw episode
//     number goes down), previous-season-high-episode rejection, same-
//     season regression/advance, first-ever-seasonal-write, and
//     numbering_mismatch (never silently reinterpreting an absolute item)
//   - server-side bounds validation on season/episode (route.ts)
//   - buildDetectedMediaInput's season-aware, confirmed-gated construction
//     (src/lib/extension/detected-item.ts) — discovery-without-completion
//     never bakes in unwatched season/episode numbers
//   - Activity diffing/formatting for season_episode progress events
//     (never "Episode 12 -> 1")
//   - AniList sync isolation — never fabricates currentSeason
//
// Reproduced verbatim from the real modules/SQL rather than imported —
// same approach as every other script in this directory. Keep in sync if
// the real implementations change.
//
// IMPORTANT: the RPC logic below is reproduced as a plain JS model of the
// SQL function's control flow — it proves the ALGORITHM (the comparison
// rule, the mismatch guard, the bounds), not real PostgreSQL row-locking
// or transaction semantics. Concurrency safety under real simultaneous
// requests (two detections racing for the same item) can only be proven
// against a real Supabase project after the migration is applied — the
// same honest caveat every prior atomic-RPC script in this directory
// carries (see verify-atomic-progress.mjs, verify-auto-add.mjs).
//
// Run with: node scripts/verify-season-tracking.mjs

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
// apply_extension_season_episode_progress, reproduced from
// supabase/migrations/0007_stage25_season_progress.sql
// ============================================================
const MAX_SEASON = 999;
const MAX_EPISODE = 99999;

/**
 * `row` models one library_items row's relevant metadata:
 * { type, status, metadata: { episodeNumbering?, currentSeason?, currentEpisode? } }
 */
function applySeasonEpisodeProgressModel(row, mediaType, newSeason, newEpisode) {
  if (mediaType !== "anime" && mediaType !== "series") {
    return { status: "incompatible_media_type" };
  }
  if (!Number.isInteger(newSeason) || newSeason < 1 || newSeason > MAX_SEASON) {
    throw new Error(`invalid season ${newSeason}`);
  }
  if (!Number.isInteger(newEpisode) || newEpisode < 1 || newEpisode > MAX_EPISODE) {
    throw new Error(`invalid episode ${newEpisode}`);
  }
  if (!row) return { status: "item_not_found" };
  if (row.type !== mediaType) return { status: "incompatible_media_type" };

  const meta = row.metadata ?? {};
  const numbering = meta.episodeNumbering ?? null;

  if (numbering === "absolute" || (numbering === null && "currentEpisode" in meta)) {
    return { status: "numbering_mismatch" };
  }

  const currentSeason = meta.currentSeason ?? null;
  const currentEpisode = meta.currentEpisode ?? 0;

  if (currentSeason !== null) {
    if (newSeason < currentSeason || (newSeason === currentSeason && newEpisode < currentEpisode)) {
      return { status: "behind_current_progress", currentSeason, currentEpisode };
    }
    if (newSeason === currentSeason && newEpisode === currentEpisode) {
      return { status: "unchanged", currentSeason, currentEpisode };
    }
  }

  const newStatus = row.status === "planned" ? "in_progress" : row.status;
  return {
    status: "updated",
    currentSeason: newSeason,
    currentEpisode: newEpisode,
    statusChanged: newStatus !== row.status,
    newStatus,
  };
}

function main() {
  // --- The primary Stage 25 acceptance test: a season transition must
  // advance even though the raw episode number drops. ---
  check("season transition: S1E12 -> S2E1 is an advance, not a regression", () => {
    const row = { type: "anime", status: "in_progress", metadata: { episodeNumbering: "seasonal", currentSeason: 1, currentEpisode: 12 } };
    const result = applySeasonEpisodeProgressModel(row, "anime", 2, 1);
    assert.equal(result.status, "updated");
    assert.equal(result.currentSeason, 2);
    assert.equal(result.currentEpisode, 1);
  });

  check("previous season, high episode: S1E20 does not beat S2E1", () => {
    const row = { type: "anime", status: "in_progress", metadata: { episodeNumbering: "seasonal", currentSeason: 2, currentEpisode: 1 } };
    const result = applySeasonEpisodeProgressModel(row, "anime", 1, 20);
    assert.equal(result.status, "behind_current_progress");
    assert.equal(result.currentSeason, 2);
    assert.equal(result.currentEpisode, 1);
  });

  check("same season, regression: S2E5 -> S2E3 is rejected", () => {
    const row = { type: "anime", status: "in_progress", metadata: { episodeNumbering: "seasonal", currentSeason: 2, currentEpisode: 5 } };
    const result = applySeasonEpisodeProgressModel(row, "anime", 2, 3);
    assert.equal(result.status, "behind_current_progress");
  });

  check("same season, advance: S2E3 -> S2E5 updates", () => {
    const row = { type: "anime", status: "in_progress", metadata: { episodeNumbering: "seasonal", currentSeason: 2, currentEpisode: 3 } };
    const result = applySeasonEpisodeProgressModel(row, "anime", 2, 5);
    assert.equal(result.status, "updated");
    assert.equal(result.currentEpisode, 5);
  });

  check("identical (season, episode) is a genuine no-op", () => {
    const row = { type: "anime", status: "in_progress", metadata: { episodeNumbering: "seasonal", currentSeason: 2, currentEpisode: 5 } };
    const result = applySeasonEpisodeProgressModel(row, "anime", 2, 5);
    assert.equal(result.status, "unchanged");
  });

  check("future season, low episode number DOES win (the general case of the primary bug)", () => {
    const row = { type: "anime", status: "in_progress", metadata: { episodeNumbering: "seasonal", currentSeason: 1, currentEpisode: 24 } };
    const result = applySeasonEpisodeProgressModel(row, "anime", 3, 1);
    assert.equal(result.status, "updated");
  });

  // --- Unknown-season / first-write establishment ---
  check("first-ever seasonal position (no currentSeason/currentEpisode yet) is accepted, not compared against anything", () => {
    const row = { type: "anime", status: "planned", metadata: { episodeNumbering: "seasonal" } };
    const result = applySeasonEpisodeProgressModel(row, "anime", 1, 1);
    assert.equal(result.status, "updated");
    assert.equal(result.currentSeason, 1);
    // planned -> in_progress, same rule as autoAdvanceStatus for a real 0 -> positive transition.
    assert.equal(result.newStatus, "in_progress");
  });

  // --- numbering_mismatch: never silently reinterpret an absolute item ---
  check("numbering_mismatch: a legacy item with a real currentEpisode and no numbering marker refuses a seasonal write", () => {
    const row = { type: "anime", status: "in_progress", metadata: { currentEpisode: 17 } };
    const result = applySeasonEpisodeProgressModel(row, "anime", 1, 1);
    assert.equal(result.status, "numbering_mismatch");
  });

  check("numbering_mismatch: an item explicitly marked absolute refuses a seasonal write even with no currentEpisode yet", () => {
    const row = { type: "anime", status: "planned", metadata: { episodeNumbering: "absolute" } };
    const result = applySeasonEpisodeProgressModel(row, "anime", 1, 1);
    assert.equal(result.status, "numbering_mismatch");
  });

  check("a brand-new item with no numbering marker and no progress at all yet is open to a first seasonal write", () => {
    const row = { type: "anime", status: "planned", metadata: {} };
    const result = applySeasonEpisodeProgressModel(row, "anime", 1, 1);
    assert.equal(result.status, "updated");
  });

  // --- Cross-media / not-found ---
  check("incompatible_media_type: manga/novel/etc. never accept season_episode progress", () => {
    const row = { type: "manga", status: "in_progress", metadata: {} };
    const result = applySeasonEpisodeProgressModel(row, "manga", 1, 1);
    assert.equal(result.status, "incompatible_media_type");
  });

  check("item_not_found: no row at all", () => {
    const result = applySeasonEpisodeProgressModel(null, "anime", 1, 1);
    assert.equal(result.status, "item_not_found");
  });

  check("series behaves identically to anime (shared tracking model)", () => {
    const row = { type: "series", status: "in_progress", metadata: { episodeNumbering: "seasonal", currentSeason: 1, currentEpisode: 12 } };
    const result = applySeasonEpisodeProgressModel(row, "series", 2, 1);
    assert.equal(result.status, "updated");
  });

  // --- Bounds validation (mirrors route.ts's re-validation, never trusts the caller) ---
  for (const [label, season, episode] of [
    ["season 0", 0, 1],
    ["negative season", -1, 1],
    ["season above max", MAX_SEASON + 1, 1],
    ["non-integer season", 1.5, 1],
    ["episode 0", 1, 0],
    ["episode above max", 1, MAX_EPISODE + 1],
    ["NaN episode", 1, NaN],
    ["Infinity episode", 1, Infinity],
  ]) {
    check(`bounds: ${label} is rejected, never silently coerced or committed`, () => {
      const row = { type: "anime", status: "planned", metadata: {} };
      assert.throws(() => applySeasonEpisodeProgressModel(row, "anime", season, episode));
    });
  }

  // ============================================================
  // buildDetectedMediaInput's season-aware construction, reproduced from
  // src/lib/extension/detected-item.ts
  // ============================================================
  function buildAnimeInputModel(progress) {
    const isSeasonal = progress?.kind === "season_episode";
    const confirmedEpisode = (progress?.kind === "episode" || isSeasonal) && progress.confirmed !== false ? progress.value : undefined;
    const confirmedSeason = isSeasonal && progress.confirmed !== false ? progress.season : undefined;
    const episodeNumbering = isSeasonal ? "seasonal" : undefined;
    return { currentEpisode: confirmedEpisode, currentSeason: confirmedSeason, episodeNumbering };
  }

  check("Auto-Add: a confirmed season_episode detection bakes in both season and episode", () => {
    const input = buildAnimeInputModel({ kind: "season_episode", value: 3, season: 2, confirmed: true });
    assert.deepEqual(input, { currentEpisode: 3, currentSeason: 2, episodeNumbering: "seasonal" });
  });

  check("discovery-without-completion: an unconfirmed season_episode detection marks the item seasonal but leaves season/episode uncommitted", () => {
    const input = buildAnimeInputModel({ kind: "season_episode", value: 3, season: 2, confirmed: false });
    assert.equal(input.episodeNumbering, "seasonal");
    assert.equal(input.currentEpisode, undefined);
    assert.equal(input.currentSeason, undefined);
  });

  check("absolute detection (kind: episode) never sets episodeNumbering at all — stays the plain legacy shape", () => {
    const input = buildAnimeInputModel({ kind: "episode", value: 7, confirmed: true });
    assert.deepEqual(input, { currentEpisode: 7, currentSeason: undefined, episodeNumbering: undefined });
  });

  check("no detection at all -> everything undefined, unchanged from every stage before 25", () => {
    const input = buildAnimeInputModel(undefined);
    assert.deepEqual(input, { currentEpisode: undefined, currentSeason: undefined, episodeNumbering: undefined });
  });

  // ============================================================
  // Activity diffing/formatting, reproduced from
  // src/lib/activity-events.ts / src/lib/activity-format.ts
  // ============================================================
  function getProgressSnapshotModel(item) {
    if (item.currentEpisode === undefined) return undefined;
    return item.episodeNumbering === "seasonal"
      ? { kind: "season_episode", value: item.currentEpisode, season: item.currentSeason }
      : { kind: "episode", value: item.currentEpisode };
  }

  function diffSeasonEventModel(before, after) {
    const b = getProgressSnapshotModel(before);
    const a = getProgressSnapshotModel(after);
    const changed = a && (!b || b.kind !== a.kind || b.value !== a.value || b.season !== a.season);
    if (!changed) return null;
    return {
      progressKind: a.kind,
      previousValue: b?.value,
      newValue: a.value,
      ...(a.kind === "season_episode" && { previousSeason: b?.season, newSeason: a.season }),
    };
  }

  function formatSeasonEpisodeModel(season, episode) {
    return season !== undefined ? `S${season}E${episode}` : `E${episode}`;
  }

  check("season transition produces a progress_updated event carrying both seasons, never a bare '12 -> 1'", () => {
    const before = { type: "anime", currentEpisode: 12, currentSeason: 1, episodeNumbering: "seasonal" };
    const after = { type: "anime", currentEpisode: 1, currentSeason: 2, episodeNumbering: "seasonal" };
    const event = diffSeasonEventModel(before, after);
    assert.equal(event.progressKind, "season_episode");
    assert.equal(event.previousSeason, 1);
    assert.equal(event.previousValue, 12);
    assert.equal(event.newSeason, 2);
    assert.equal(event.newValue, 1);
    const text = `${formatSeasonEpisodeModel(event.previousSeason, event.previousValue)} → ${formatSeasonEpisodeModel(event.newSeason, event.newValue)}`;
    assert.equal(text, "S1E12 → S2E1");
  });

  check("no change (identical season+episode) never produces an event", () => {
    const item = { type: "anime", currentEpisode: 3, currentSeason: 2, episodeNumbering: "seasonal" };
    assert.equal(diffSeasonEventModel(item, item), null);
  });

  check("absolute items keep producing plain 'episode' events, unaffected by Stage 25", () => {
    const before = { type: "anime", currentEpisode: 4 };
    const after = { type: "anime", currentEpisode: 5 };
    const event = diffSeasonEventModel(before, after);
    assert.equal(event.progressKind, "episode");
    assert.equal(event.previousSeason, undefined);
  });

  // ============================================================
  // getQuickIncrementInfo / quickIncrementProgress, reproduced from
  // src/lib/tracking.ts / src/hooks/useLibraryItems.ts
  // ============================================================
  function quickIncrementModel(item) {
    const previous = item.currentEpisode;
    const next = (previous ?? 0) + 1;
    const isSeasonal = item.episodeNumbering === "seasonal";
    const currentEpisode = !isSeasonal && item.totalEpisodes !== undefined ? Math.min(next, item.totalEpisodes) : next;
    return { currentEpisode, currentSeason: item.currentSeason };
  }

  check("quick +1 on a seasonal item advances the episode only — never touches or infers a season rollover", () => {
    const item = { currentEpisode: 12, currentSeason: 1, episodeNumbering: "seasonal", totalEpisodes: 24 };
    const result = quickIncrementModel(item);
    assert.equal(result.currentEpisode, 13);
    assert.equal(result.currentSeason, 1); // still season 1 — never auto-rolled to season 2
  });

  check("quick +1 on a seasonal item is never capped by the whole-series totalEpisodes", () => {
    const item = { currentEpisode: 24, currentSeason: 1, episodeNumbering: "seasonal", totalEpisodes: 24 };
    const result = quickIncrementModel(item);
    assert.equal(result.currentEpisode, 25); // would have been capped at 24 for an absolute item
  });

  check("quick +1 on an absolute item still clamps to totalEpisodes exactly as before Stage 25", () => {
    const item = { currentEpisode: 24, totalEpisodes: 24 };
    const result = quickIncrementModel(item);
    assert.equal(result.currentEpisode, 24);
  });

  // ============================================================
  // AniList sync isolation, reproduced from
  // src/lib/integrations/anilist/sync.ts
  // ============================================================
  check("AniList sync writes plain absolute currentEpisode and never fabricates episodeNumbering/currentSeason", () => {
    // Mirrors handleExistingItem's applyUpdate patch for the anime/series
    // branch: `{ ...current, status, rating, currentEpisode: incoming.progress, updatedAt }`
    // — no episodeNumbering or currentSeason key anywhere in that object
    // literal, so an item that was absolute (or had no numbering opinion
    // at all) before an AniList sync stays absolute after it.
    const current = { type: "anime", currentEpisode: 10, status: "in_progress", rating: 8 };
    const incoming = { status: "in_progress", rating: 8, progress: 11 };
    const patched = { ...current, status: incoming.status, rating: incoming.rating, currentEpisode: incoming.progress, updatedAt: "now" };
    assert.equal(patched.currentEpisode, 11);
    assert.equal("episodeNumbering" in patched, false);
    assert.equal("currentSeason" in patched, false);
  });

  check("AniList sync never overwrites an existing seasonal item's currentSeason (field simply isn't touched by the patch)", () => {
    const current = { type: "anime", currentEpisode: 3, currentSeason: 2, episodeNumbering: "seasonal", status: "in_progress" };
    const incoming = { status: "in_progress", rating: undefined, progress: 4 };
    const patched = { ...current, status: incoming.status, rating: incoming.rating, currentEpisode: incoming.progress, updatedAt: "now" };
    // currentSeason/episodeNumbering survive via the base spread — AniList
    // only ever explicitly sets status/rating/currentEpisode.
    assert.equal(patched.currentSeason, 2);
    assert.equal(patched.episodeNumbering, "seasonal");
  });

  // ============================================================
  // Regression test for a real, self-caught bug: localStorage/cloud
  // activity persistence had a hardcoded PROGRESS_KINDS whitelist
  // (src/lib/activity-storage.ts) that didn't include "season_episode".
  // Proven live: adding a seasonal anime item, clicking +1, and checking
  // localStorage showed the progress_updated event WAS written — but the
  // very next hydration (a fresh page load) called loadActivity(), whose
  // validator silently filtered the event out for having an "unknown"
  // progressKind, and the persistence effect immediately re-saved the
  // now-filtered (event-losing) list back over the original. Reproduced
  // here as a plain filter, matching isValidActivityEvent's actual logic.
  // ============================================================
  const PROGRESS_KINDS = ["episode", "chapter", "page", "percent", "playtime", "season_episode"];
  function isValidActivityEventModel(candidate) {
    if (candidate.type !== "progress_updated") return true;
    return (
      typeof candidate.progressKind === "string" &&
      PROGRESS_KINDS.includes(candidate.progressKind) &&
      Number.isFinite(candidate.newValue) &&
      (candidate.previousSeason === undefined || Number.isFinite(candidate.previousSeason)) &&
      (candidate.newSeason === undefined || Number.isFinite(candidate.newSeason))
    );
  }

  check("bugfix: a season_episode progress event survives the localStorage validity filter (previously silently dropped)", () => {
    const event = { type: "progress_updated", progressKind: "season_episode", previousValue: 12, newValue: 1, previousSeason: 1, newSeason: 2 };
    assert.equal(isValidActivityEventModel(event), true);
  });

  check("bugfix: a season_episode event with no previousSeason (first-ever seasonal position) still survives the filter", () => {
    const event = { type: "progress_updated", progressKind: "season_episode", newValue: 1, newSeason: 1 };
    assert.equal(isValidActivityEventModel(event), true);
  });

  check("the validity filter still rejects a genuinely unknown progressKind (the check has teeth, not just a rubber stamp)", () => {
    const event = { type: "progress_updated", progressKind: "not_a_real_kind", newValue: 1 };
    assert.equal(isValidActivityEventModel(event), false);
  });

  console.log(
    "\nNote: apply_extension_season_episode_progress's checks above validate the ALGORITHM (the lexicographic comparison, the mismatch guard, the bounds) as a plain JS model of the SQL function's control flow — the same caveat every prior atomic-RPC script in this directory carries. Real concurrent-request locking behavior can only be proven against a real Supabase project after `npx.cmd supabase db push` applies 0007_stage25_season_progress.sql.",
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
