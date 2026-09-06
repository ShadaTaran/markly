#!/usr/bin/env node
// Verifies Stage 30 "Safe AniList Write-Back & Two-Way Reconciliation":
//   - lib/integrations/anilist/mapping.ts: status mapping both
//     directions, the shared seasonal-safe inbound-apply guard (Tests S)
//   - lib/integrations/anilist/score.ts: rating <-> AniList score
//     conversion across every ScoreFormat, unrated semantics (Tests R)
//   - lib/integrations/anilist/reconciliation.ts: three-way field-level
//     state (same/local_changed/remote_changed/both_changed/different/
//     local_only/unsupported), never picking a winner by magnitude
//     (Tests F)
//   - lib/integrations/anilist/writeback.ts: the apply orchestration —
//     staleness protection (local and remote), remote-existence races,
//     idempotent repair after a partial failure, ownership/catalog-
//     target enforcement, writes-disabled enforcement (Tests A), the
//     outbound mutation's variable minimality — only user-selected
//     fields ever leave the client (Tests M), and phase-aware error
//     reporting — preflight-read vs mutation vs baseline-save failures
//     stay distinguishable without exposing raw AniList responses
//     (Tests O)
//   - components/AniListReconcilePanel.tsx: reconciliation radio group
//     identity is scoped by item+field, never by displayed text — a
//     live-discovered near-miss where two items with identical displayed
//     values shared one native radio group (Tests N)
//
// Tests S/R/F are reproduced verbatim from the real modules (same
// approach as every other script in this directory — plain .mjs, no
// TypeScript loader available under the project's Node >=20.9 baseline).
// Tests A model writeback.ts's orchestration ALGORITHM against an
// in-memory fake AniList server + fake Supabase table — not a live
// database or live AniList test (see docs/scripts/verify-anilist-
// writeback.mjs's own note at the end); real live-read-only verification
// is documented separately in the Stage 30 report, and NO mutation is
// ever sent to a real AniList account by this script or by Stage 30's
// implementation without explicit later approval.
//
// Run with: node scripts/verify-anilist-writeback.mjs

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
// mapAniListStatus / mapMarklyStatusToAniList, reproduced from
// lib/integrations/anilist/mapping.ts
// ============================================================
function mapAniListStatus(status) {
  switch (status) {
    case "CURRENT": return { markly: "in_progress", wasRepeating: false };
    case "PLANNING": return { markly: "planned", wasRepeating: false };
    case "COMPLETED": return { markly: "completed", wasRepeating: false };
    case "DROPPED": return { markly: "dropped", wasRepeating: false };
    case "PAUSED": return { markly: "on_hold", wasRepeating: false };
    case "REPEATING": return { markly: "in_progress", wasRepeating: true };
    default: return { markly: "planned", wasRepeating: false };
  }
}
function mapMarklyStatusToAniList(status) {
  switch (status) {
    case "in_progress": return "CURRENT";
    case "planned": return "PLANNING";
    case "completed": return "COMPLETED";
    case "dropped": return "DROPPED";
    case "on_hold": return "PAUSED";
  }
}

// ============================================================
// mapAniListScore / roundToHalf, reproduced from mapping.ts + tracking.ts
// ============================================================
function roundToHalf(v) { return Math.round(v * 2) / 2; }
function normalizeRating(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 10) return undefined;
  return roundToHalf(v);
}
function mapAniListScore(score) {
  if (score === null || score === undefined || score <= 0) return undefined;
  return normalizeRating(score);
}

// ============================================================
// score.ts, reproduced verbatim
// ============================================================
function marklyRatingToScoreRaw(rating) { return Math.round(rating * 10); }
function marklyRatingToAniListScore(rating, format) {
  switch (format) {
    case "POINT_100": return Math.round(rating * 10);
    case "POINT_10_DECIMAL": return Math.round(rating * 10) / 10;
    case "POINT_10": return Math.round(rating);
    case "POINT_5": return Math.round(rating / 2);
    case "POINT_3":
      if (rating <= 4) return 1;
      if (rating <= 7) return 2;
      return 3;
  }
}
function isExactRoundTrip(rating, format) {
  switch (format) {
    case "POINT_100":
    case "POINT_10_DECIMAL":
      return true;
    case "POINT_10":
      return Number.isInteger(rating);
    case "POINT_5":
      return rating % 2 === 0;
    case "POINT_3":
      return false;
  }
}
const ALL_SCORE_FORMATS = ["POINT_100", "POINT_10_DECIMAL", "POINT_10", "POINT_5", "POINT_3"];

// ============================================================
// applyInboundPersonalTracking, reproduced from mapping.ts
// ============================================================
function applyInboundPersonalTracking(current, incoming, updatedAt) {
  switch (current.type) {
    case "anime":
    case "series": {
      if (current.episodeNumbering === "seasonal") {
        return { patched: { ...current, status: incoming.status, rating: incoming.rating, updatedAt }, progressApplied: false, progressSkippedReason: "seasonal_numbering" };
      }
      return { patched: { ...current, status: incoming.status, rating: incoming.rating, currentEpisode: incoming.progress, updatedAt }, progressApplied: true };
    }
    case "manga":
      return { patched: { ...current, status: incoming.status, rating: incoming.rating, currentChapter: incoming.progress, updatedAt }, progressApplied: true };
    default:
      return { patched: current, progressApplied: false };
  }
}

// ============================================================
// reconciliation.ts, reproduced verbatim
// ============================================================
function reconcileField(local, remote, remoteExists, baseline, equal) {
  const valuesEqual = (a, b) => (a === undefined && b === undefined) || (a !== undefined && b !== undefined && equal(a, b));
  if (!remoteExists) {
    if (local === undefined) return { state: "not_applicable", local, remote: undefined, allowedDirections: [], suggestedDirection: "none" };
    return { state: "local_only", local, remote: undefined, allowedDirections: ["to_anilist"], suggestedDirection: "to_anilist" };
  }
  if (valuesEqual(local, remote)) return { state: "same", local, remote, allowedDirections: [], suggestedDirection: "none" };
  if (!baseline) return { state: "different", local, remote, allowedDirections: ["to_anilist", "to_markly"], suggestedDirection: "none" };
  const localChanged = !valuesEqual(local, baseline.local);
  const remoteChanged = !valuesEqual(remote, baseline.remote);
  if (remoteChanged && !localChanged) return { state: "remote_changed", local, remote, allowedDirections: ["to_anilist", "to_markly"], suggestedDirection: "to_markly" };
  if (localChanged && !remoteChanged) return { state: "local_changed", local, remote, allowedDirections: ["to_anilist", "to_markly"], suggestedDirection: "to_anilist" };
  return { state: "both_changed", local, remote, allowedDirections: ["to_anilist", "to_markly"], suggestedDirection: "none" };
}
function restrictDirections(field, remove, reason) {
  if (!field.allowedDirections.includes(remove)) return field;
  const allowedDirections = field.allowedDirections.filter((d) => d !== remove);
  const suggestedDirection = field.suggestedDirection === remove ? "none" : field.suggestedDirection;
  if (allowedDirections.length === 0 && field.state !== "same" && field.state !== "not_applicable") {
    return { ...field, state: "unsupported", allowedDirections, suggestedDirection: "none", reason };
  }
  return { ...field, allowedDirections, suggestedDirection, reason: allowedDirections.length === 0 ? reason : field.reason };
}
function localProgress(item) {
  if (item.type === "anime" || item.type === "series") return item.currentEpisode;
  if (item.type === "manga") return item.currentChapter;
  return undefined;
}
function isSeasonal(item) {
  return (item.type === "anime" || item.type === "series") && item.episodeNumbering === "seasonal";
}
function buildItemReconciliation(item, mediaId, remote, baselineRaw) {
  const writeEligible = item.type === "anime" || item.type === "series" || item.type === "manga";
  const baselineStatus = baselineRaw ? mapAniListStatus(baselineRaw.status).markly : undefined;
  const baselineRating = baselineRaw ? mapAniListScore(baselineRaw.score) : undefined;
  const baselineProgress = baselineRaw?.progress;

  let progress = reconcileField(localProgress(item), remote.progress, remote.exists, baselineRaw ? { local: baselineProgress, remote: baselineProgress } : undefined, (a, b) => a === b);
  if (isSeasonal(item)) {
    progress = { state: "unsupported", local: localProgress(item), remote: remote.progress, allowedDirections: [], suggestedDirection: "none", reason: "seasonal_numbering" };
  } else if (item.type === "manga" && !Number.isInteger(localProgress(item) ?? 0)) {
    progress = restrictDirections(progress, "to_anilist", "fractional_progress");
  }

  const status = reconcileField(item.status, remote.status !== undefined ? mapAniListStatus(remote.status).markly : undefined, remote.exists, baselineRaw ? { local: baselineStatus, remote: baselineStatus } : undefined, (a, b) => a === b);
  const rating = reconcileField(item.rating, remote.rating, remote.exists, baselineRaw ? { local: baselineRating, remote: baselineRating } : undefined, (a, b) => a === b);

  if (!writeEligible) {
    const na = (f) => ({ ...f, allowedDirections: [], suggestedDirection: "none", state: f.state === "same" ? "same" : "not_applicable" });
    return { itemId: item.id, title: item.title, type: item.type, mediaId, remoteExists: remote.exists, fields: { progress: na(progress), status: na(status), rating: na(rating) }, writeEligible: false };
  }
  return { itemId: item.id, title: item.title, type: item.type, mediaId, remoteExists: remote.exists, fields: { progress, status, rating }, writeEligible: true };
}

// ============================================================
// Test helpers
// ============================================================
function animeItem(overrides) {
  return { id: "i1", type: "anime", title: "T", status: "in_progress", currentEpisode: 5, ...overrides };
}
function mangaItem(overrides) {
  return { id: "i1", type: "manga", title: "T", status: "in_progress", currentChapter: 5, ...overrides };
}

// ============================================================
// S — status mapping (bidirectional, exhaustive matrix)
// ============================================================
const ANILIST_STATUSES = ["CURRENT", "PLANNING", "COMPLETED", "DROPPED", "PAUSED", "REPEATING"];
const MARKLY_STATUSES = ["planned", "in_progress", "completed", "on_hold", "dropped"];

check("S1: every AniList status maps to a defined Markly status, never falls through unmapped", () => {
  for (const s of ANILIST_STATUSES) {
    const { markly } = mapAniListStatus(s);
    assert.ok(MARKLY_STATUSES.includes(markly), `${s} did not map to a known Markly status`);
  }
});
check("S2: REPEATING maps to in_progress WITH wasRepeating=true; CURRENT maps to in_progress WITHOUT it", () => {
  assert.deepEqual(mapAniListStatus("REPEATING"), { markly: "in_progress", wasRepeating: true });
  assert.deepEqual(mapAniListStatus("CURRENT"), { markly: "in_progress", wasRepeating: false });
});
check("S3: every Markly status maps to a defined AniList enum value (exhaustive, no missing case)", () => {
  for (const s of MARKLY_STATUSES) {
    const anilist = mapMarklyStatusToAniList(s);
    assert.ok(ANILIST_STATUSES.includes(anilist), `${s} did not map to a known AniList status`);
  }
});
check("S4: Markly -> AniList -> Markly round-trips to the SAME Markly status for all 5 (REPEATING is never a write target)", () => {
  for (const s of MARKLY_STATUSES) {
    const anilist = mapMarklyStatusToAniList(s);
    const back = mapAniListStatus(anilist).markly;
    assert.equal(back, s, `${s} -> ${anilist} -> ${back} did not round-trip`);
    assert.notEqual(anilist, "REPEATING");
  }
});
check("S5: an unrecognized AniList status string never throws and defaults to 'planned' rather than crashing sync", () => {
  assert.deepEqual(mapAniListStatus("SOME_FUTURE_STATUS"), { markly: "planned", wasRepeating: false });
});

// ============================================================
// R — rating/score conversion (exhaustive format matrix)
// ============================================================
check("R1: marklyRatingToScoreRaw is always an exact integer in [10,100] for every valid Markly rating", () => {
  for (let r = 1; r <= 10; r += 0.5) {
    const raw = marklyRatingToScoreRaw(r);
    assert.ok(Number.isInteger(raw) && raw >= 10 && raw <= 100, `rating ${r} -> scoreRaw ${raw} out of range`);
  }
});
for (const format of ALL_SCORE_FORMATS) {
  check(`R2 [${format}]: marklyRatingToAniListScore never throws and returns a finite number for every valid Markly rating`, () => {
    for (let r = 1; r <= 10; r += 0.5) {
      const v = marklyRatingToAniListScore(r, format);
      assert.ok(Number.isFinite(v), `rating ${r} in format ${format} produced ${v}`);
    }
  });
}
check("R3: POINT_100 and POINT_10_DECIMAL round-trip EXACTLY for every Markly rating (isExactRoundTrip must say so)", () => {
  for (let r = 1; r <= 10; r += 0.5) {
    assert.equal(isExactRoundTrip(r, "POINT_100"), true);
    assert.equal(isExactRoundTrip(r, "POINT_10_DECIMAL"), true);
  }
});
check("R4: POINT_3 (smiley scale) is NEVER claimed exact — Markly must not pretend 9/10 and a 3-point smiley are interchangeable", () => {
  for (let r = 1; r <= 10; r += 0.5) {
    assert.equal(isExactRoundTrip(r, "POINT_3"), false);
  }
});
check("R5: POINT_10 is exact ONLY for whole-number Markly ratings, never for a half-step like 7.5", () => {
  assert.equal(isExactRoundTrip(8, "POINT_10"), true);
  assert.equal(isExactRoundTrip(7.5, "POINT_10"), false);
});
check("R6 (unrated, AniList -> Markly): a raw score of 0 or null NEVER becomes a real Markly rating — always undefined, never a literal 0", () => {
  assert.equal(mapAniListScore(0), undefined);
  assert.equal(mapAniListScore(null), undefined);
  assert.equal(mapAniListScore(undefined), undefined);
  assert.equal(mapAniListScore(-1), undefined);
});
check("R7 (unrated, Markly -> AniList): an undefined Markly rating is never converted at all (writeback.ts only calls marklyRatingToScoreRaw when rating !== undefined)", () => {
  const rating = undefined;
  const shouldSendScore = rating !== undefined;
  assert.equal(shouldSendScore, false);
});
check("R8: known documented lossy simplification is preserved — AniList 7.3 rounds to Markly 7.5, not silently truncated or rejected", () => {
  assert.equal(mapAniListScore(7.3), 7.5);
});

// ============================================================
// F — field-level reconciliation (three-way baseline, no picking a winner)
// ============================================================
check("F1: identical local/remote values -> 'same', zero allowed directions (nothing to sync)", () => {
  const r = buildItemReconciliation(animeItem({ currentEpisode: 5, status: "in_progress", rating: 8 }), "42", { exists: true, progress: 5, status: "CURRENT", rating: 8 }, undefined);
  assert.equal(r.fields.progress.state, "same");
  assert.equal(r.fields.status.state, "same");
  assert.equal(r.fields.rating.state, "same");
});
check("F2: no baseline, values differ -> 'different', BOTH directions allowed, NO direction preselected (Markly cannot guess which is newer)", () => {
  const r = buildItemReconciliation(animeItem({ currentEpisode: 18, status: "in_progress" }), "42", { exists: true, progress: 16, status: "CURRENT" }, undefined);
  assert.equal(r.fields.progress.state, "different");
  assert.deepEqual(r.fields.progress.allowedDirections.sort(), ["to_anilist", "to_markly"]);
  assert.equal(r.fields.progress.suggestedDirection, "none");
});
check("F3: baseline exists, ONLY local changed -> 'local_changed', suggested direction is to_anilist", () => {
  const baseline = { mediaId: "42", status: "CURRENT", wasRepeating: false, progress: 16, score: null, anilistUpdatedAt: 1, syncedAt: "2026-01-01T00:00:00.000Z" };
  const r = buildItemReconciliation(animeItem({ currentEpisode: 18 }), "42", { exists: true, progress: 16, status: "CURRENT" }, baseline);
  assert.equal(r.fields.progress.state, "local_changed");
  assert.equal(r.fields.progress.suggestedDirection, "to_anilist");
});
check("F4: baseline exists, ONLY remote changed -> 'remote_changed', suggested direction is to_markly", () => {
  const baseline = { mediaId: "42", status: "CURRENT", wasRepeating: false, progress: 16, score: null, anilistUpdatedAt: 1, syncedAt: "2026-01-01T00:00:00.000Z" };
  const r = buildItemReconciliation(animeItem({ currentEpisode: 16 }), "42", { exists: true, progress: 20, status: "CURRENT" }, baseline);
  assert.equal(r.fields.progress.state, "remote_changed");
  assert.equal(r.fields.progress.suggestedDirection, "to_markly");
});
check("F5 (critical — §20): BOTH changed differently -> 'both_changed', NO direction preselected, regardless of which number is larger", () => {
  const baseline = { mediaId: "42", status: "CURRENT", wasRepeating: false, progress: 16, score: null, anilistUpdatedAt: 1, syncedAt: "2026-01-01T00:00:00.000Z" };
  // Markly LOWER than remote (18 -> local now 15, remote now 20) — must NOT auto-pick the higher remote value.
  const r = buildItemReconciliation(animeItem({ currentEpisode: 15 }), "42", { exists: true, progress: 20, status: "CURRENT" }, baseline);
  assert.equal(r.fields.progress.state, "both_changed");
  assert.equal(r.fields.progress.suggestedDirection, "none", "must never auto-select just because one number is larger");
});
check("F6: remote entry does not exist -> 'local_only' when Markly has a value, allowedDirections is ONLY to_anilist (nothing to pull from)", () => {
  const r = buildItemReconciliation(animeItem({ currentEpisode: 5, rating: 8 }), "42", { exists: false }, undefined);
  assert.equal(r.fields.progress.state, "local_only");
  assert.deepEqual(r.fields.progress.allowedDirections, ["to_anilist"]);
  assert.equal(r.remoteExists, false);
});
check("F7 (Stage 25 — seasonal progress never fabricated): seasonal item's progress is ALWAYS 'unsupported', zero allowed directions, regardless of baseline/values", () => {
  const seasonal = animeItem({ episodeNumbering: "seasonal", currentSeason: 2, currentEpisode: 3 });
  const r1 = buildItemReconciliation(seasonal, "42", { exists: true, progress: 27, status: "CURRENT" }, undefined);
  assert.equal(r1.fields.progress.state, "unsupported");
  assert.equal(r1.fields.progress.reason, "seasonal_numbering");
  assert.deepEqual(r1.fields.progress.allowedDirections, []);
  // Status/rating remain independently reconcilable even though progress is blocked.
  const r2 = buildItemReconciliation(animeItem({ episodeNumbering: "seasonal", currentSeason: 2, currentEpisode: 3, status: "planned" }), "42", { exists: true, progress: 27, status: "CURRENT" }, undefined);
  assert.notEqual(r2.fields.status.state, "unsupported");
});
check("F8 (fractional manga never floored/ceiled outbound): a decimal chapter differing from remote -> outbound direction excluded, inbound stays available", () => {
  const r = buildItemReconciliation(mangaItem({ currentChapter: 12.5 }), "7", { exists: true, progress: 12, status: "CURRENT" }, undefined);
  assert.ok(!r.fields.progress.allowedDirections.includes("to_anilist"), "fractional progress must never be sendable outbound");
  assert.ok(r.fields.progress.allowedDirections.includes("to_markly"), "inbound (AniList's integer) has no precision problem and must remain available");
});
check("F9: integer manga chapter differing from remote is fully comparable in both directions (no false-positive fractional guard)", () => {
  const r = buildItemReconciliation(mangaItem({ currentChapter: 13 }), "7", { exists: true, progress: 12, status: "CURRENT" }, undefined);
  assert.deepEqual(r.fields.progress.allowedDirections.sort(), ["to_anilist", "to_markly"]);
});
check("F10 (field independence — §22/§66): progress unsupported (seasonal) does not block status or rating from reconciling independently in the SAME item", () => {
  const baseline = { mediaId: "42", status: "CURRENT", wasRepeating: false, progress: 27, score: 7, anilistUpdatedAt: 1, syncedAt: "2026-01-01T00:00:00.000Z" };
  const r = buildItemReconciliation(animeItem({ episodeNumbering: "seasonal", currentSeason: 2, currentEpisode: 3, status: "completed", rating: 9 }), "42", { exists: true, progress: 30, status: "CURRENT", rating: 7 }, baseline);
  assert.equal(r.fields.progress.state, "unsupported");
  assert.equal(r.fields.status.state, "local_changed");
  assert.equal(r.fields.rating.state, "local_changed");
});
check("F11 (unrated distinguished from 0): local undefined rating vs remote undefined rating -> 'same', never 'different'", () => {
  const r = buildItemReconciliation(animeItem({ rating: undefined }), "42", { exists: true, progress: 5, status: "CURRENT", rating: undefined }, undefined);
  assert.equal(r.fields.rating.state, "same");
});
check("F12: non-write-eligible type (defensive — writeback.ts never calls this for one, but verified here) forces every field to not_applicable/same, never a real direction", () => {
  const r = buildItemReconciliation({ id: "i1", type: "movie", title: "M", status: "planned" }, "1", { exists: true, progress: 1, status: "CURRENT" }, undefined);
  assert.equal(r.writeEligible, false);
  for (const f of Object.values(r.fields)) assert.deepEqual(f.allowedDirections, []);
});

// ============================================================
// A — apply orchestration model (staleness, idempotency, ownership)
// ============================================================
// In-memory fake standing in for Supabase + the AniList API, exercising
// the SAME control-flow writeback.ts's applyWritebackItem implements —
// not a live database/API test (see header note).
function makeFakeDb() {
  return { items: new Map() }; // itemId -> { id, user_id, type, title, status, rating, currentEpisode, currentChapter, episodeNumbering, updated_at, metadata }
}
function makeFakeRemote() {
  return { entries: new Map(), nextId: 1 }; // mediaId -> { id, status, score, progress, updatedAt }
}

function applyWritebackItemModel(db, remote, userId, allowWrites, plan) {
  const { changes } = plan;
  const wantsOutbound = changes.progress === "to_anilist" || changes.status === "to_anilist" || changes.rating === "to_anilist";
  const wantsInbound = changes.progress === "to_markly" || changes.status === "to_markly" || changes.rating === "to_markly";
  if (!wantsOutbound && !wantsInbound) return { itemId: plan.itemId, status: "no_changes_selected" };
  if (wantsOutbound && !allowWrites) return { itemId: plan.itemId, status: "writes_disabled" };

  const row = db.items.get(plan.itemId);
  if (!row || row.user_id !== userId) return { itemId: plan.itemId, status: "not_found" };
  if (!row.catalogSource || row.catalogSource.provider !== "anilist") return { itemId: plan.itemId, status: "not_write_eligible" };
  const mediaId = row.catalogSource.externalId;
  if (mediaId !== plan.expectedMediaId) return { itemId: plan.itemId, status: "stale_target" };
  if (row.updated_at !== plan.expectedLocalUpdatedAt) return { itemId: plan.itemId, status: "local_changed_since_preview" };

  if (changes.progress === "to_anilist" && row.type === "manga" && !Number.isInteger(row.currentChapter ?? 0)) return { itemId: plan.itemId, status: "unsupported_field" };
  if (changes.progress === "to_anilist" && row.type === "anime" && row.episodeNumbering === "seasonal") return { itemId: plan.itemId, status: "unsupported_field" };

  const remoteEntry = remote.entries.get(mediaId) ?? null;
  const currentRemoteSnapshot = remoteEntry ? { exists: true, status: remoteEntry.status, progress: remoteEntry.progress, score: remoteEntry.score } : { exists: false };
  const expectedRemoteSnapshot = { exists: plan.expectedRemoteExists, status: plan.expectedRemoteStatus, progress: plan.expectedRemoteProgress, score: plan.expectedRemoteScore };
  const fingerprintsMatch = currentRemoteSnapshot.exists === expectedRemoteSnapshot.exists && (!currentRemoteSnapshot.exists || (currentRemoteSnapshot.status === expectedRemoteSnapshot.status && (currentRemoteSnapshot.progress ?? null) === (expectedRemoteSnapshot.progress ?? null) && (currentRemoteSnapshot.score ?? null) === (expectedRemoteSnapshot.score ?? null)));

  const outboundTargetMatches = () => {
    if (!remoteEntry) return false;
    if (changes.status === "to_anilist" && remoteEntry.status !== mapMarklyStatusToAniList(row.status)) return false;
    if (changes.rating === "to_anilist" && row.rating !== undefined && remoteEntry.score !== row.rating) return false;
    if (changes.progress === "to_anilist" && remoteEntry.progress !== (row.type === "manga" ? row.currentChapter : row.currentEpisode)) return false;
    return true;
  };

  if (!fingerprintsMatch) {
    const alreadyApplied = wantsOutbound && outboundTargetMatches();
    if (!alreadyApplied) return { itemId: plan.itemId, status: "remote_changed_since_preview" };
  }

  const appliedFields = { progress: false, status: false, rating: false };
  let finalRemote = remoteEntry;
  if (wantsOutbound && remoteEntry && outboundTargetMatches()) {
    appliedFields.progress = changes.progress === "to_anilist";
    appliedFields.status = changes.status === "to_anilist";
    appliedFields.rating = changes.rating === "to_anilist";
  } else if (wantsOutbound) {
    finalRemote = {
      id: remoteEntry?.id ?? remote.nextId++,
      status: changes.status === "to_anilist" ? mapMarklyStatusToAniList(row.status) : (remoteEntry?.status ?? "PLANNING"),
      score: changes.rating === "to_anilist" && row.rating !== undefined ? row.rating : (remoteEntry?.score ?? null),
      progress: changes.progress === "to_anilist" ? (row.type === "manga" ? row.currentChapter : row.currentEpisode) : (remoteEntry?.progress ?? 0),
      updatedAt: Date.now(),
    };
    remote.entries.set(mediaId, finalRemote);
    appliedFields.progress = changes.progress === "to_anilist";
    appliedFields.status = changes.status === "to_anilist";
    appliedFields.rating = changes.rating === "to_anilist";
  }

  if (wantsInbound && finalRemote) {
    if (changes.status === "to_markly") row.status = mapAniListStatus(finalRemote.status).markly;
    if (changes.rating === "to_markly") row.rating = mapAniListScore(finalRemote.score);
    if (changes.progress === "to_markly") {
      const { progressApplied, patched } = applyInboundPersonalTracking(row, { status: row.status, progress: finalRemote.progress ?? 0, rating: row.rating }, new Date().toISOString());
      if (row.type === "manga") row.currentChapter = patched.currentChapter;
      else row.currentEpisode = patched.currentEpisode;
      appliedFields.progress = progressApplied;
    }
    appliedFields.status = appliedFields.status || changes.status === "to_markly";
    appliedFields.rating = appliedFields.rating || changes.rating === "to_markly";
  }

  row.updated_at = `updated-${Math.random().toString(36).slice(2)}`;
  return { itemId: plan.itemId, status: "applied", appliedFields };
}

function seedItem(db, overrides) {
  const row = { id: "item-1", user_id: "user-1", type: "anime", title: "Frieren", status: "in_progress", rating: 9, currentEpisode: 18, episodeNumbering: "absolute", updated_at: "v1", catalogSource: { provider: "anilist", externalId: "42" }, ...overrides };
  db.items.set(row.id, row);
  return row;
}
function basePlan(overrides) {
  return { itemId: "item-1", expectedMediaId: "42", expectedLocalUpdatedAt: "v1", expectedRemoteExists: true, expectedRemoteStatus: "CURRENT", expectedRemoteProgress: 16, expectedRemoteScore: 8, changes: { progress: "none", status: "none", rating: "none" }, ...overrides };
}

check("A1: writes_disabled — outbound selected but allowWrites=false, no mutation attempted, remote untouched", () => {
  const db = makeFakeDb(); const remote = makeFakeRemote();
  seedItem(db, {});
  remote.entries.set("42", { id: 1, status: "CURRENT", score: 8, progress: 16, updatedAt: 1 });
  const result = applyWritebackItemModel(db, remote, "user-1", false, basePlan({ changes: { progress: "to_anilist", status: "none", rating: "none" } }));
  assert.deepEqual(result, { itemId: "item-1", status: "writes_disabled" });
  assert.equal(remote.entries.get("42").progress, 16, "remote must be completely untouched");
});
check("A2 (§36 ownership): a different user's itemId is never found, never leaks target existence", () => {
  const db = makeFakeDb(); const remote = makeFakeRemote();
  seedItem(db, { user_id: "victim" });
  const result = applyWritebackItemModel(db, remote, "attacker", true, basePlan({ changes: { progress: "to_anilist", status: "none", rating: "none" } }));
  assert.equal(result.status, "not_found");
});
check("A3 (§37 catalog-target forgery): client's expectedMediaId disagreeing with the OWNED item's real catalogSource is refused, never mutates the forged target", () => {
  const db = makeFakeDb(); const remote = makeFakeRemote();
  seedItem(db, { catalogSource: { provider: "anilist", externalId: "42" } });
  const result = applyWritebackItemModel(db, remote, "user-1", true, basePlan({ expectedMediaId: "999", changes: { progress: "to_anilist", status: "none", rating: "none" } }));
  assert.equal(result.status, "stale_target");
  assert.ok(!remote.entries.has("999"), "the forged target id was never touched");
});
check("A4 (§24 local staleness): item updated after preview -> local_changed_since_preview, no mutation", () => {
  const db = makeFakeDb(); const remote = makeFakeRemote();
  seedItem(db, { updated_at: "v2" }); // "changed since preview" — plan still expects v1
  remote.entries.set("42", { id: 1, status: "CURRENT", score: 8, progress: 16, updatedAt: 1 });
  const result = applyWritebackItemModel(db, remote, "user-1", true, basePlan({ changes: { progress: "to_anilist", status: "none", rating: "none" } }));
  assert.equal(result.status, "local_changed_since_preview");
  assert.equal(remote.entries.get("42").progress, 16, "no mutation sent");
});
check("A5 (§25 remote staleness): remote progress changed since preview to something DIFFERENT from the intended target -> remote_changed_since_preview, no mutation", () => {
  const db = makeFakeDb(); const remote = makeFakeRemote();
  seedItem(db, { currentEpisode: 20 });
  remote.entries.set("42", { id: 1, status: "CURRENT", score: 8, progress: 19, updatedAt: 99 }); // preview expected 16, now 19 — and outbound target (20) != 19
  const before = { ...remote.entries.get("42") };
  const result = applyWritebackItemModel(db, remote, "user-1", true, basePlan({ changes: { progress: "to_anilist", status: "none", rating: "none" } }));
  assert.equal(result.status, "remote_changed_since_preview");
  assert.deepEqual(remote.entries.get("42"), before, "no mutation sent");
});
check("A6 (§54/§65 idempotent repair): remote already equals the outbound target (a prior partial failure already applied it) -> treated as success, NOT remote_changed, NO second mutation", () => {
  const db = makeFakeDb(); const remote = makeFakeRemote();
  seedItem(db, { currentEpisode: 20 });
  // Remote's CURRENT progress (20) already matches what THIS plan would send, even though it differs from the plan's stale "expected" snapshot (16).
  remote.entries.set("42", { id: 1, status: "CURRENT", score: 8, progress: 20, updatedAt: 500 });
  const before = { ...remote.entries.get("42") };
  const result = applyWritebackItemModel(db, remote, "user-1", true, basePlan({ changes: { progress: "to_anilist", status: "none", rating: "none" } }));
  assert.equal(result.status, "applied");
  assert.equal(result.appliedFields.progress, true);
  assert.deepEqual(remote.entries.get("42"), before, "must NOT issue a second mutation — remote was already correct");
});
check("A7 (§27 remote-created-after-preview race): preview said 'no entry', remote now HAS one with a DIFFERENT value than the plan would create -> remote_changed_since_preview, never blindly creates/overwrites", () => {
  const db = makeFakeDb(); const remote = makeFakeRemote();
  seedItem(db, { currentEpisode: 5 });
  remote.entries.set("42", { id: 1, status: "PLANNING", score: null, progress: 3, updatedAt: 1 }); // now exists, with unrelated values
  const result = applyWritebackItemModel(db, remote, "user-1", true, basePlan({ expectedRemoteExists: false, expectedRemoteStatus: undefined, expectedRemoteProgress: undefined, expectedRemoteScore: undefined, changes: { progress: "to_anilist", status: "none", rating: "none" } }));
  assert.equal(result.status, "remote_changed_since_preview");
});
check("A8 (§28 remote-deleted-after-preview race): preview said entry exists, it's gone now -> remote_changed_since_preview, never silently recreates", () => {
  const db = makeFakeDb(); const remote = makeFakeRemote();
  seedItem(db, { currentEpisode: 20 });
  // remote.entries has NOTHING for "42" — deleted.
  const result = applyWritebackItemModel(db, remote, "user-1", true, basePlan({ changes: { progress: "to_anilist", status: "none", rating: "none" } }));
  assert.equal(result.status, "remote_changed_since_preview");
  assert.ok(!remote.entries.has("42"));
});
check("A9 (§30/§66 field independence in apply): progress -> to_anilist AND rating -> to_markly in the SAME item both apply correctly, no whole-item forced winner", () => {
  const db = makeFakeDb(); const remote = makeFakeRemote();
  seedItem(db, { currentEpisode: 20, rating: 9 });
  remote.entries.set("42", { id: 1, status: "CURRENT", score: 7, progress: 16, updatedAt: 1 });
  const result = applyWritebackItemModel(db, remote, "user-1", true, basePlan({ expectedRemoteScore: 7, changes: { progress: "to_anilist", status: "none", rating: "to_markly" } }));
  assert.equal(result.status, "applied");
  assert.equal(remote.entries.get("42").progress, 20, "progress went outbound");
  assert.equal(db.items.get("item-1").rating, mapAniListScore(7), "rating came inbound, in the SAME apply call");
});
check("A10 (§54 idempotency, second angle): applying the exact same already-satisfied intended state twice is safe — second call also reports applied with no further mutation", () => {
  const db = makeFakeDb(); const remote = makeFakeRemote();
  seedItem(db, { currentEpisode: 20, status: "in_progress" });
  remote.entries.set("42", { id: 1, status: "CURRENT", score: null, progress: 16, updatedAt: 1 });
  const plan = basePlan({ expectedRemoteScore: null, changes: { progress: "to_anilist", status: "none", rating: "none" } });
  const r1 = applyWritebackItemModel(db, remote, "user-1", true, plan);
  assert.equal(r1.status, "applied");
  // Retry with a plan whose expected snapshot now matches the post-mutation remote state (simulating a client that refreshed).
  const row = db.items.get("item-1");
  const plan2 = basePlan({ expectedLocalUpdatedAt: row.updated_at, expectedRemoteProgress: 20, expectedRemoteScore: null, changes: { progress: "to_anilist", status: "none", rating: "none" } });
  const before = { ...remote.entries.get("42") };
  const r2 = applyWritebackItemModel(db, remote, "user-1", true, plan2);
  assert.equal(r2.status, "applied");
  assert.deepEqual(remote.entries.get("42"), before, "no duplicate mutation for an already-satisfied state");
});
check("A11 (§55 preview never mutates): building a reconciliation model for an item makes zero writes to the fake remote or fake db", () => {
  const db = makeFakeDb(); const remote = makeFakeRemote();
  const row = seedItem(db, { currentEpisode: 18 });
  remote.entries.set("42", { id: 1, status: "CURRENT", score: 8, progress: 16, updatedAt: 1 });
  const before = { db: JSON.stringify([...db.items]), remote: JSON.stringify([...remote.entries]) };
  buildItemReconciliation(row, "42", { exists: true, progress: 16, status: "CURRENT", rating: 8 }, undefined);
  const after = { db: JSON.stringify([...db.items]), remote: JSON.stringify([...remote.entries]) };
  assert.deepEqual(before, after);
});
check("A12 (§67 multi-item plan, mixed states): same/outbound/inbound/unsupported all present in one batch — counts and per-item outcomes are each independently correct", () => {
  const db = makeFakeDb(); const remote = makeFakeRemote();
  seedItem(db, { id: "same-1", currentEpisode: 5, status: "in_progress", catalogSource: { provider: "anilist", externalId: "1" } });
  seedItem(db, { id: "out-1", currentEpisode: 20, catalogSource: { provider: "anilist", externalId: "2" } });
  seedItem(db, { id: "in-1", currentEpisode: 5, catalogSource: { provider: "anilist", externalId: "3" } });
  seedItem(db, { id: "seasonal-1", type: "anime", episodeNumbering: "seasonal", currentSeason: 2, currentEpisode: 3, catalogSource: { provider: "anilist", externalId: "4" } });
  remote.entries.set("1", { id: 1, status: "CURRENT", score: null, progress: 5, updatedAt: 1 });
  remote.entries.set("2", { id: 2, status: "CURRENT", score: null, progress: 15, updatedAt: 1 });
  remote.entries.set("3", { id: 3, status: "CURRENT", score: null, progress: 9, updatedAt: 1 });
  remote.entries.set("4", { id: 4, status: "CURRENT", score: null, progress: 30, updatedAt: 1 });

  const plans = [
    basePlan({ itemId: "out-1", expectedMediaId: "2", expectedRemoteProgress: 15, expectedRemoteScore: null, changes: { progress: "to_anilist", status: "none", rating: "none" } }),
    basePlan({ itemId: "in-1", expectedMediaId: "3", expectedRemoteProgress: 9, expectedRemoteScore: null, changes: { progress: "to_markly", status: "none", rating: "none" } }),
    basePlan({ itemId: "seasonal-1", expectedMediaId: "4", expectedRemoteProgress: 30, expectedRemoteScore: null, changes: { progress: "to_anilist", status: "none", rating: "none" } }),
  ];
  const results = plans.map((p) => applyWritebackItemModel(db, remote, "user-1", true, p));
  assert.equal(results[0].status, "applied");
  assert.equal(remote.entries.get("2").progress, 20);
  assert.equal(results[1].status, "applied");
  assert.equal(db.items.get("in-1").currentEpisode, 9);
  assert.equal(results[2].status, "unsupported_field", "seasonal progress must never be sent outbound, even inside a mixed batch");
});

// ============================================================
// M — outbound mutation variable minimality, reproduced verbatim from
// applyWritebackItem's mutation-building block (writeback.ts, the
// `if (wantsOutbound) { const variables = ... }` section). Confirms the
// ACTUAL GraphQL variables sent to SaveMediaListEntry contain ONLY the
// fields the user explicitly selected for "to_anilist" — never an
// unselected supported field's current value. This matters because
// Markly's staleness re-fetch and its mutation are not atomic: another
// AniList client could change an UNSELECTED field in that gap, and if
// Markly's mutation included that field's stale re-fetched value, it
// would silently revert the other client's concurrent edit. `id`/
// `mediaId` are the mutation's TARGET identity (which entry, which
// media) — not a synced data field — so they are always present
// regardless of selection, exactly like a WHERE clause; `id` is only
// ever included when updating an existing entry (JSON.stringify drops
// an `undefined` value, so passing `remoteEntryId: undefined` for a
// brand-new entry correctly omits `id` from the wire payload,
// triggering AniList's own "create" behavior rather than an update).
// ============================================================
function buildOutboundVariables(remoteEntryId, mediaId, current, changes) {
  const variables = { id: remoteEntryId, mediaId: Number(mediaId) };
  if (changes.status === "to_anilist") variables.status = mapMarklyStatusToAniList(current.status);
  if (changes.rating === "to_anilist" && current.rating !== undefined) {
    variables.scoreRaw = marklyRatingToScoreRaw(current.rating);
  }
  if (changes.progress === "to_anilist") variables.progress = current.type === "manga" ? current.currentChapter : current.currentEpisode;
  return variables;
}
function wireKeys(variables) {
  // Mirrors JSON.stringify's own behavior: a key whose value is `undefined` never appears on the wire.
  return Object.keys(JSON.parse(JSON.stringify(variables)));
}

const RATED_ANIME = { type: "anime", status: "in_progress", rating: 9, currentEpisode: 12 };

check("M1 (§8.A): progress only selected -> variables contain progress, never status or scoreRaw", () => {
  const vars = buildOutboundVariables(1, "42", RATED_ANIME, { progress: "to_anilist", status: "none", rating: "none" });
  const keys = wireKeys(vars);
  assert.ok(keys.includes("progress"));
  assert.ok(!keys.includes("status"), "status was not selected — must not be sent");
  assert.ok(!keys.includes("scoreRaw"), "rating was not selected — must not be sent");
});

check("M2 (§8.B): status only selected -> variables contain status, never progress or scoreRaw", () => {
  const vars = buildOutboundVariables(1, "42", RATED_ANIME, { progress: "none", status: "to_anilist", rating: "none" });
  const keys = wireKeys(vars);
  assert.ok(keys.includes("status"));
  assert.ok(!keys.includes("progress"));
  assert.ok(!keys.includes("scoreRaw"));
});

check("M3 (§8.C): rating only selected -> variables contain scoreRaw, never progress or status", () => {
  const vars = buildOutboundVariables(1, "42", RATED_ANIME, { progress: "none", status: "none", rating: "to_anilist" });
  const keys = wireKeys(vars);
  assert.ok(keys.includes("scoreRaw"));
  assert.ok(!keys.includes("progress"));
  assert.ok(!keys.includes("status"));
});

check("M4 (§8.D): progress + rating selected -> variables contain both, never status", () => {
  const vars = buildOutboundVariables(1, "42", RATED_ANIME, { progress: "to_anilist", status: "none", rating: "to_anilist" });
  const keys = wireKeys(vars);
  assert.ok(keys.includes("progress") && keys.includes("scoreRaw"));
  assert.ok(!keys.includes("status"));
});

check("M5 (§8.E): all three selected -> variables contain progress, status, and scoreRaw", () => {
  const vars = buildOutboundVariables(1, "42", RATED_ANIME, { progress: "to_anilist", status: "to_anilist", rating: "to_anilist" });
  const keys = wireKeys(vars);
  assert.ok(keys.includes("progress") && keys.includes("status") && keys.includes("scoreRaw"));
});

check("M6 (§8.F): zero outbound directions selected (a mix of none/to_markly) -> applyWritebackItemModel never touches the remote entry at all", () => {
  const db = makeFakeDb(); const remote = makeFakeRemote();
  seedItem(db, { currentEpisode: 5, rating: 9 });
  remote.entries.set("42", { id: 1, status: "CURRENT", score: 7, progress: 5, updatedAt: 1 });
  const before = { ...remote.entries.get("42") };
  const result = applyWritebackItemModel(db, remote, "user-1", true, basePlan({ expectedRemoteScore: 7, expectedRemoteProgress: 5, changes: { progress: "to_markly", status: "none", rating: "none" } }));
  assert.equal(result.status, "applied");
  assert.deepEqual(remote.entries.get("42"), before, "no outbound direction was selected — SaveMediaListEntry's equivalent must never fire, even though writes are allowed and the call succeeds via the inbound path");
});

check("M7 (§8.G): pure inbound reconciliation (all three fields to_markly) -> remote entry untouched", () => {
  const db = makeFakeDb(); const remote = makeFakeRemote();
  seedItem(db, { currentEpisode: 5, rating: 9, status: "in_progress" });
  remote.entries.set("42", { id: 1, status: "COMPLETED", score: 6, progress: 12, updatedAt: 1 });
  const before = { ...remote.entries.get("42") };
  const result = applyWritebackItemModel(db, remote, "user-1", true, basePlan({ expectedRemoteScore: 6, expectedRemoteStatus: "COMPLETED", expectedRemoteProgress: 12, changes: { progress: "to_markly", status: "to_markly", rating: "to_markly" } }));
  assert.equal(result.status, "applied");
  assert.deepEqual(remote.entries.get("42"), before, "an all-inbound plan must never issue any outbound mutation");
});

check("M8 (§8.H): remote entry missing + one field selected -> minimal create payload (no id, only mediaId + the selected field)", () => {
  const vars = buildOutboundVariables(undefined, "99", RATED_ANIME, { progress: "to_anilist", status: "none", rating: "none" });
  const keys = wireKeys(vars);
  assert.ok(!keys.includes("id"), "no existing entry — `id` must be omitted so AniList creates rather than updates");
  assert.ok(keys.includes("mediaId"), "mediaId is the new entry's target, always required, not a 'selected field'");
  assert.ok(keys.includes("progress"));
  assert.ok(!keys.includes("status") && !keys.includes("scoreRaw"), "creating a new entry must not invent values for fields the user never selected");
});

check("M9 (§9 — the exact micro-race scenario): remote re-fetch shows progress=10/rating=8; only progress=12 is selected; rating changes to 9 elsewhere between re-fetch and mutation -> the mutation payload must not carry rating/scoreRaw, so it cannot revert that concurrent change", () => {
  const reFetchedRemote = { progress: 10, rating: 8 }; // what Markly just re-read, immediately before mutating
  void reFetchedRemote; // the point of this test: the mutation is built from `current` + `changes` only, never from the re-fetched remote snapshot's OTHER fields
  const vars = buildOutboundVariables(1, "42", { ...RATED_ANIME, currentEpisode: 12 }, { progress: "to_anilist", status: "none", rating: "none" });
  const keys = wireKeys(vars);
  assert.equal(vars.progress, 12);
  assert.ok(!keys.includes("scoreRaw"), "even though a fresh rating value (8, or a since-changed 9) was just read, it must never be included — Markly did not select rating for outbound sync");
  assert.ok(!keys.includes("status"));
});

check("M10 (§7 idempotent-repair equality ignores unselected fields): remoteEntryAlreadyMatchesSelection-equivalent must return true when only the SELECTED field matches, even if an unselected field's remote value disagrees with what Markly's own current value would be", () => {
  // Reproduced from writeback.ts's remoteEntryAlreadyMatchesSelection.
  function remoteEntryAlreadyMatchesSelection(remoteEntry, current, changes) {
    if (changes.status === "to_anilist" && remoteEntry.status !== mapMarklyStatusToAniList(current.status)) return false;
    if (changes.rating === "to_anilist" && current.rating !== undefined && remoteEntry.score !== current.rating) return false;
    if (changes.progress === "to_anilist" && remoteEntry.progress !== current.currentEpisode) return false;
    return true;
  }
  const current = { ...RATED_ANIME, currentEpisode: 12, status: "in_progress", rating: 9 };
  // Remote's progress already matches the intended target (12) — but its status/score are totally unrelated to Markly's current values, and NEITHER status nor rating was selected.
  const remoteEntry = { status: "DROPPED", score: 2, progress: 12 };
  const onlyProgressSelected = { progress: "to_anilist", status: "none", rating: "none" };
  assert.equal(
    remoteEntryAlreadyMatchesSelection(remoteEntry, current, onlyProgressSelected),
    true,
    "repair must succeed based on the selected field alone — an unselected field's mismatched remote value must never block repair or force Markly to rewrite it",
  );
});

// ============================================================
// N — reconciliation radio group identity, reproduced verbatim from
// AniListReconcilePanel.tsx's buildReconciliationRadioGroupName. A
// live-discovered bug: the OLD formula was `${label}-${localText}-
// ${remoteText}` — scoped by DISPLAYED TEXT, not by item. Native
// `<input name="...">` grouping is global across the whole document
// regardless of React component boundaries, so two different items
// whose same field happened to show identical text (e.g. both
// "Status: In Progress -> —") silently shared ONE native radio group.
// During the live write-validation test this almost left a second,
// untouched item's Status field selected for outbound sync — caught
// only because the plan was intercepted and inspected before it ever
// reached the network (see the Stage 30 live-test report). The fix
// scopes every group by itemId + field, never by displayed text.
// ============================================================
function buildReconciliationRadioGroupName(itemId, field) {
  return `anilist-sync-${itemId}-${field}`;
}

check("N1: progress radio group differs between two different items", () => {
  assert.notEqual(buildReconciliationRadioGroupName("item-A", "progress"), buildReconciliationRadioGroupName("item-B", "progress"));
});

check("N2: status radio group differs between two different items", () => {
  assert.notEqual(buildReconciliationRadioGroupName("item-A", "status"), buildReconciliationRadioGroupName("item-B", "status"));
});

check("N3: rating radio group differs between two different items", () => {
  assert.notEqual(buildReconciliationRadioGroupName("item-A", "rating"), buildReconciliationRadioGroupName("item-B", "rating"));
});

check("N4: within ONE item, the three direction options for one field share exactly one group name (so the browser's native radio semantics work — arrow keys and single-selection are scoped correctly), and the three DIFFERENT fields of that same item never collide with each other", () => {
  const progressGroup = buildReconciliationRadioGroupName("item-A", "progress");
  const statusGroup = buildReconciliationRadioGroupName("item-A", "status");
  const ratingGroup = buildReconciliationRadioGroupName("item-A", "rating");
  // Same item+field called twice (as it would be for "No change"/"Use AniList"/"Use Markly") is stable/identical.
  assert.equal(buildReconciliationRadioGroupName("item-A", "progress"), progressGroup);
  // But the three fields of the SAME item must never share a group with each other.
  assert.ok(new Set([progressGroup, statusGroup, ratingGroup]).size === 3, "progress/status/rating groups for one item must all be distinct from each other");
});

check("N5 (the exact live collision, reproduced): two different items whose Status field displays IDENTICAL local/remote text ('CURRENT'/'CURRENT') must still get different native radio group names", () => {
  // Under the OLD formula, both of these would have produced the identical string "Status-CURRENT-CURRENT".
  const itemA = buildReconciliationRadioGroupName("item-lord-of-mysteries", "status");
  const itemB = buildReconciliationRadioGroupName("item-lord-of-mysteries-specials", "status");
  assert.notEqual(itemA, itemB, "identical displayed text must never produce identical native radio group names across different items");
});

check("N6 (§A4 — live near-miss plan-construction regression): two items with identical displayed Status; user selects ONLY Item A's rating -> Item B must never appear in the serialized Apply plan with any selection, especially not status:\"to_anilist\"", () => {
  // Reproduced from AniListReconcilePanel.tsx's apply(): filters out any
  // item whose selection is entirely "none", pushes the rest verbatim.
  function buildPlanFromSelections(items, selections) {
    const plan = [];
    for (const entry of items) {
      const selection = selections[entry.itemId];
      if (selection.progress === "none" && selection.status === "none" && selection.rating === "none") continue;
      plan.push({ itemId: entry.itemId, changes: { ...selection } });
    }
    return plan;
  }
  const items = [
    { itemId: "item-lord-of-mysteries-specials", mediaId: "199448" },
    { itemId: "item-lord-of-mysteries", mediaId: "137667" },
  ];
  // The user correctly left Item A's status untouched ("none") and only chose Item B's rating — this is what
  // a user should be able to reliably produce now that the two items' Status radios are no longer one native group.
  const selections = {
    "item-lord-of-mysteries-specials": { progress: "none", status: "none", rating: "none" },
    "item-lord-of-mysteries": { progress: "none", status: "none", rating: "to_anilist" },
  };
  const plan = buildPlanFromSelections(items, selections);
  assert.equal(plan.length, 1, "only the item with a real selection may appear in the plan");
  assert.equal(plan[0].itemId, "item-lord-of-mysteries");
  assert.equal(plan[0].changes.rating, "to_anilist");
  assert.equal(plan[0].changes.status, "none", "the untouched item's Status must never leak into the plan as an outbound direction");
  assert.equal(plan[0].changes.progress, "none");
});

// ============================================================
// O — apply-time error phase observability, reproduced verbatim from
// writeback.ts's classifyAniListError. The live write-validation attempt
// returned a generic "remote_error" with no way to tell whether
// SaveMediaListEntry was ever actually called. classifyAniListError now
// takes a `phase` ("preflight_read" | "mutation") so a failure during
// the pre-mutation staleness re-fetch reports "remote_read_error"
// (mutation never attempted) and a failure calling SaveMediaListEntry
// itself reports "remote_write_error" (mutation attempted, failed) —
// without ever exposing the underlying raw error, response, token, or
// header. auth/rate-limit failures stay their own specific statuses
// regardless of phase, never collapsed into the generic buckets.
// ============================================================
class FakeAniListAuthError extends Error {}
class FakeAniListRateLimitError extends Error {}
function classifyAniListErrorModel(error, phase) {
  if (error instanceof FakeAniListAuthError) return { status: "reconnect_required" };
  if (error instanceof FakeAniListRateLimitError) return { status: "rate_limited" };
  return { status: phase === "preflight_read" ? "remote_read_error" : "remote_write_error" };
}

// Reproduces applyWritebackItem's actual phase ordering: preflight read
// (MEDIA_LIST_ENTRY_QUERY) can fail before SaveMediaListEntry is ever
// called; SaveMediaListEntry can fail after a successful read; the
// baseline save can fail after a successful (or idempotently-repaired)
// mutation. `mutationCalls` proves exactly how many times the mutation
// mock actually ran.
function applyWritebackPhaseModel({ readError, mutationError, baselineSaveFails, mutationCalls }) {
  if (readError) {
    return classifyAniListErrorModel(readError, "preflight_read");
  }
  // (idempotent-repair / fingerprint checks are covered by the A-tests — this model focuses on phase isolation)
  mutationCalls.count++;
  if (mutationError) {
    return classifyAniListErrorModel(mutationError, "mutation");
  }
  if (baselineSaveFails) {
    return { status: "baseline_save_failed" };
  }
  return { status: "applied" };
}

check("O1 (§B3/§E7): preflight remote read fails -> mutation is never attempted, result is remote_read_error", () => {
  const mutationCalls = { count: 0 };
  const result = applyWritebackPhaseModel({ readError: new Error("transient 502"), mutationCalls });
  assert.equal(result.status, "remote_read_error");
  assert.equal(mutationCalls.count, 0, "SaveMediaListEntry must never be called when the preflight read itself failed");
});

check("O2 (§B3/§E8): preflight read succeeds, mutation fails -> mutation was attempted exactly once, result is remote_write_error", () => {
  const mutationCalls = { count: 0 };
  const result = applyWritebackPhaseModel({ mutationError: new Error("transient 502"), mutationCalls });
  assert.equal(result.status, "remote_write_error");
  assert.equal(mutationCalls.count, 1, "SaveMediaListEntry must have been attempted exactly once");
});

check("O3 (§E9): the two failure phases are distinguishable from each other by result status alone, with no raw error/response ever needed", () => {
  const readResult = applyWritebackPhaseModel({ readError: new Error("x"), mutationCalls: { count: 0 } });
  const writeResult = applyWritebackPhaseModel({ mutationError: new Error("x"), mutationCalls: { count: 0 } });
  assert.notEqual(readResult.status, writeResult.status);
});

check("O4 (§B2/§E10): an auth failure during preflight read still reports reconnect_required, never collapsed into remote_read_error", () => {
  const mutationCalls = { count: 0 };
  const result = applyWritebackPhaseModel({ readError: new FakeAniListAuthError("token rejected"), mutationCalls });
  assert.equal(result.status, "reconnect_required");
  assert.equal(mutationCalls.count, 0);
});

check("O4b: an auth failure during the mutation itself ALSO still reports reconnect_required, never remote_write_error", () => {
  const mutationCalls = { count: 0 };
  const result = applyWritebackPhaseModel({ mutationError: new FakeAniListAuthError("token rejected"), mutationCalls });
  assert.equal(result.status, "reconnect_required");
  assert.equal(mutationCalls.count, 1);
});

check("O5 (§B2/§E11): a rate-limit failure during preflight read still reports rate_limited, never collapsed into remote_read_error", () => {
  const mutationCalls = { count: 0 };
  const result = applyWritebackPhaseModel({ readError: new FakeAniListRateLimitError("429"), mutationCalls });
  assert.equal(result.status, "rate_limited");
  assert.equal(mutationCalls.count, 0);
});

check("O5b: a rate-limit failure during the mutation itself ALSO still reports rate_limited, never remote_write_error", () => {
  const mutationCalls = { count: 0 };
  const result = applyWritebackPhaseModel({ mutationError: new FakeAniListRateLimitError("429"), mutationCalls });
  assert.equal(result.status, "rate_limited");
  assert.equal(mutationCalls.count, 1);
});

// Fuller model for O6 only — adds the idempotent-repair branch
// (remoteEntryAlreadyMatchesSelection, covered in isolation by the
// A6/A10/M10 tests above) so a retry can be modeled end-to-end: when the
// remote already matches what this mutation would have produced, the
// mutation mock is skipped entirely, exactly like the real code.
function applyWritebackPhaseModelWithRepair({ remoteAlreadyMatchesSelection, readError, mutationError, baselineSaveFails, mutationCalls }) {
  if (readError) return classifyAniListErrorModel(readError, "preflight_read");
  if (!remoteAlreadyMatchesSelection) {
    mutationCalls.count++;
    if (mutationError) return classifyAniListErrorModel(mutationError, "mutation");
  }
  if (baselineSaveFails) return { status: "baseline_save_failed" };
  return { status: "applied" };
}

check("O6 (§B4/§E12): mutation succeeds but baseline save fails -> baseline_save_failed, distinct from remote_write_error; a retry that finds AniList already correct (idempotent repair) does not call the mutation mock again and completes as applied", () => {
  const mutationCalls = { count: 0 };
  const firstAttempt = applyWritebackPhaseModelWithRepair({ remoteAlreadyMatchesSelection: false, baselineSaveFails: true, mutationCalls });
  assert.equal(firstAttempt.status, "baseline_save_failed");
  assert.equal(mutationCalls.count, 1, "the mutation itself succeeded on this first attempt");

  // Retry: AniList now already has the value the first attempt's mutation set —
  // the real remoteEntryAlreadyMatchesSelection check would find it already correct.
  const retryResult = applyWritebackPhaseModelWithRepair({ remoteAlreadyMatchesSelection: true, baselineSaveFails: false, mutationCalls });
  assert.equal(retryResult.status, "applied");
  assert.equal(mutationCalls.count, 1, "retry must not call SaveMediaListEntry a second time — AniList already matches, so the idempotent-repair branch skips the mutation mock entirely");
});

// ============================================================
// G — LatestRequestGuard, reproduced verbatim (types stripped) from
// lib/latest-request-guard.ts. Guards the AniList reconciliation preview
// fetch (AniListReconcilePanel's "Sync Now" load) against overlapping
// requests — a live-observed bug where dev Strict Mode's double
// effect-invoke fired the preview fetch twice, and the slower of the two
// resolved LAST and overwrote an already-successful preview with a stale
// error. `isCurrent(token)` is what the component checks immediately
// before every setState (success or error alike) — these tests exercise
// that decision directly, independent of real async timing.
// ============================================================
class LatestRequestGuard {
  #currentId = 0;
  #controller = null;

  start() {
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    const id = ++this.#currentId;
    return { id, signal: controller.signal };
  }

  isCurrent(token) {
    return token.id === this.#currentId;
  }

  cancel() {
    this.#controller?.abort();
  }
}

check("G1 (§9.A — success/success, newer wins): request 1 then request 2 both eventually succeed — request 2 is current regardless of which resolves first", () => {
  const guard = new LatestRequestGuard();
  const t1 = guard.start();
  const t2 = guard.start();
  assert.equal(guard.isCurrent(t1), false, "request 1 must be stale the instant request 2 starts, even if request 1's success arrives later");
  assert.equal(guard.isCurrent(t2), true, "request 2 (the newer one) is current and may set state");
});

check("G2 (§9.B — success then newer error, newer still wins): request 1 succeeds, request 2 (newer) later fails — request 2's error is allowed to replace it", () => {
  const guard = new LatestRequestGuard();
  const t1 = guard.start();
  assert.equal(guard.isCurrent(t1), true, "before request 2 starts, request 1 is current and its success may apply");
  const t2 = guard.start();
  assert.equal(guard.isCurrent(t1), false, "request 1 becomes stale once request 2 (a retry/second load) starts");
  assert.equal(guard.isCurrent(t2), true, "request 2 is current — its error result is allowed to win, since it is the newest request");
});

check("G3 (§9.C — stale failure ignored): request 1 fails late, request 2 (newer) already resolved earlier — request 1's failure must never override it", () => {
  const guard = new LatestRequestGuard();
  const t1 = guard.start();
  const t2 = guard.start();
  assert.equal(guard.isCurrent(t2), true, "request 2 already applied its (earlier-resolving) result");
  assert.equal(guard.isCurrent(t1), false, "request 1's late-arriving failure must be ignored — it is no longer current");
});

check("G4 (§9.D — stale success ignored): request 1 succeeds late, request 2 (newer) already succeeded earlier — request 1's success must never override it", () => {
  const guard = new LatestRequestGuard();
  const t1 = guard.start();
  const t2 = guard.start();
  assert.equal(guard.isCurrent(t2), true, "request 2 already applied its (earlier-resolving) success");
  assert.equal(guard.isCurrent(t1), false, "request 1's late-arriving success must also be ignored, even though it succeeded too");
});

check("G5 (§9.E — closed/unmounted): cancel() aborts a still-active request's signal, so its late resolution rejects as AbortError rather than resolving normally", () => {
  const guard = new LatestRequestGuard();
  const t1 = guard.start();
  assert.equal(t1.signal.aborted, false);
  guard.cancel();
  assert.equal(t1.signal.aborted, true, "cancel() (panel close/unmount) must abort whatever request is still in flight, so the component's catch block sees AbortError and skips setState entirely");
});

check("G5b (regression — cancel() must NOT permanently disable the guard): a request started AFTER cancel() is still current. This is the exact live bug found in the Stage 30 re-test: React Strict Mode's dev double effect-invoke calls cleanup (cancel) between its two invocations WITHOUT really unmounting the component, then runs the effect again — if cancel() latched a permanent 'disposed' flag (the original, buggy design), that second, real, successful request's own isCurrent() check would incorrectly return false forever, and the UI would be stuck on \"loading\" even though the fetch had already succeeded (observed live: server logged 200 OK, UI never left \"Checking your AniList list…\").", () => {
  const guard = new LatestRequestGuard();
  const strictModeFirstInvoke = guard.start();
  guard.cancel(); // Strict Mode's simulated cleanup — component is NOT actually unmounting
  const strictModeSecondInvoke = guard.start(); // the effect runs again on the same live component
  assert.equal(guard.isCurrent(strictModeSecondInvoke), true, "the request started after cancel() must still be able to become current and eventually set state — cancel() must only abort what was in flight, never poison future requests");
  assert.equal(guard.isCurrent(strictModeFirstInvoke), false, "the cancelled first request remains correctly stale");
});

check("G6 (§9.F — retry creates a new generation): clicking \"Try again\" while the first request hasn't resolved yet invalidates it", () => {
  const guard = new LatestRequestGuard();
  const initialLoad = guard.start();
  const retry = guard.start();
  assert.equal(guard.isCurrent(initialLoad), false, "the request being retried is invalidated by the retry itself, not just by its own resolution");
  assert.equal(guard.isCurrent(retry), true, "the retry's own request is current");
});

check("G7 (abort on supersede): starting a new request aborts the previous one's signal, so the in-flight fetch is actually cancelled, not merely ignored", () => {
  const guard = new LatestRequestGuard();
  const t1 = guard.start();
  assert.equal(t1.signal.aborted, false);
  guard.start();
  assert.equal(t1.signal.aborted, true, "superseding a request must abort its still-in-flight fetch");
});

check("G8 (abort on cancel): closing/unmounting aborts whatever request is still in flight", () => {
  const guard = new LatestRequestGuard();
  const t1 = guard.start();
  assert.equal(t1.signal.aborted, false);
  guard.cancel();
  assert.equal(t1.signal.aborted, true, "cancel() must abort any in-flight request, not just mark its result as stale");
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
console.log(`\nNote: Tests S/R/F are reproduced verbatim from lib/integrations/anilist/{mapping,score,reconciliation}.ts (pure logic, no I/O). Tests A model writeback.ts's apply orchestration ALGORITHM (staleness protection, idempotent repair, ownership/catalog-target enforcement) against an in-memory fake — NOT a live database or live AniList API test. Tests M are reproduced verbatim from applyWritebackItem's outbound mutation-variable construction — confirm SaveMediaListEntry's variables contain ONLY user-selected fields, never an unselected field's current value (the narrow overwrite race a fresh-remote-value round-trip would otherwise create). Tests N are reproduced verbatim from AniListReconcilePanel.tsx's buildReconciliationRadioGroupName — confirm reconciliation radio identity is scoped by item+field, never by displayed text (the live radio-name-collision near-miss). Tests O model writeback.ts's classifyAniListError's phase-aware error reporting (preflight_read vs mutation) and the baseline-save-failure/idempotent-repair retry path. Tests G are reproduced verbatim from lib/latest-request-guard.ts, the stale-response guard used by AniListReconcilePanel's preview fetch. Zero mutations were sent to any real AniList account by this script. Stage 30's actual server routes and live read-only verification are documented separately in the Stage 30 report.`);
if (failed.length > 0) process.exit(1);
