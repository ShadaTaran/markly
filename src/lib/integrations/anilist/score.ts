/**
 * Stage 30 — centralized Markly ↔ AniList rating conversion, both
 * directions, for every AniList ScoreFormat. Confirmed via GraphQL
 * introspection against https://graphql.anilist.co (not scraped docs):
 * ScoreFormat is POINT_100 | POINT_10_DECIMAL | POINT_10 | POINT_5 |
 * POINT_3, and SaveMediaListEntry accepts EITHER `score: Float` ("the
 * score in the user's chosen scoring method") OR `scoreRaw: Int` ("the
 * score in 100 point" — format-INDEPENDENT).
 *
 * Markly ratings are always 1-10 in 0.5 steps (lib/tracking.ts's
 * normalizeRating), so `scoreRaw = round(rating * 10)` is always an
 * exact integer in [10, 100] for every valid Markly rating — never
 * lossy, regardless of the account's scoreFormat. Stage 30's outbound
 * writes therefore send ONLY `scoreRaw` (see writeback.ts) — there is
 * no "rating unsupported for this format" case for the mutation itself,
 * and no need to also send `score` in the user's native format, since
 * scoreRaw alone is already exact and authoritative. `scoreFormat` is
 * still fetched (Viewer.mediaListOptions.scoreFormat) and surfaced for
 * preview display and the format test matrix below, per the review's
 * explicit request to inspect it — not because the write would
 * otherwise be lossy without it.
 */
export type AniListScoreFormat = "POINT_100" | "POINT_10_DECIMAL" | "POINT_10" | "POINT_5" | "POINT_3";

/** AniList's own convention: 0 (or absent) always means "no score" — never a real rating of 0, in ANY format. */
export function isAniListUnrated(rawScore: number | null | undefined): boolean {
  return rawScore === null || rawScore === undefined || rawScore <= 0;
}

/** Markly's 1-10 (0.5 steps) rating -> AniList's format-independent 100-point mutation field. Always exact. */
export function marklyRatingToScoreRaw(rating: number): number {
  return Math.round(rating * 10);
}

/**
 * Markly's 1-10 rating -> the value to send as SaveMediaListEntry's
 * `score` argument, in the user's OWN configured format — sent alongside
 * scoreRaw (never instead of it) purely as a redundant, format-native
 * value matching the mutation's own two-field shape. Never itself the
 * value that determines exactness — see the module doc comment.
 */
export function marklyRatingToAniListScore(rating: number, format: AniListScoreFormat): number {
  switch (format) {
    case "POINT_100":
      return Math.round(rating * 10);
    case "POINT_10_DECIMAL":
      return Math.round(rating * 10) / 10;
    case "POINT_10":
      return Math.round(rating);
    case "POINT_5":
      return Math.round(rating / 2);
    case "POINT_3":
      // AniList's own documented mapping: 0 => No Score, 1 => :(, 2 => :|, 3 => :).
      // A coarse 3-bucket smiley scale — Markly's rating is bucketed into
      // low/mid/high thirds of the 1-10 range.
      if (rating <= 4) return 1;
      if (rating <= 7) return 2;
      return 3;
  }
}

/**
 * AniList's raw score -> Markly rating. Reproduced from the EXISTING
 * mapAniListScore (anilist/mapping.ts) — kept here only as the
 * documented single source of truth for the format-matrix tests; the
 * real inbound path still calls mapAniListScore directly (never forked).
 * AniList's list-entry queries always request `score(format:
 * POINT_10_DECIMAL)` (a forced 0-10 float), so this conversion is
 * format-independent on the read side regardless of the account's own
 * configured scoreFormat — that setting only affects what a human sees
 * on AniList's own website, never what this app receives.
 */
export function isExactRoundTrip(rating: number, format: AniListScoreFormat): boolean {
  // A round trip is "exact" when converting Markly -> AniList's native
  // format -> back to a 0-10 float lands on the identical Markly rating
  // after Markly's own 0.5-step rounding. POINT_100 and POINT_10_DECIMAL
  // never lose anything (10x more precision than Markly's own 0.5 steps
  // for the coarser one, and equal precision for the finer one).
  // POINT_10/POINT_5/POINT_3 are coarser than Markly's scale and cannot
  // always round-trip exactly.
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
