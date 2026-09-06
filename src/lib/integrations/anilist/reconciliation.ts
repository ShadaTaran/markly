import type { MediaItem, TrackingStatus } from "@/types/library-item";
import { mapAniListStatus, mapAniListScore, mapMarklyStatusToAniList, type AniListSyncBaseline } from "@/lib/integrations/anilist/mapping";

/**
 * Stage 30 — pure reconciliation model. Everything in this file is a
 * plain function of its inputs (no I/O, no Supabase, no fetch) so the
 * hardest safety rules (never fabricate a seasonal conversion, never
 * silently pick a "winner", never treat a coarser format as free
 * precision) are deterministically unit-testable without a live AniList
 * account — see scripts/verify-anilist-writeback.mjs.
 */

export type SyncDirection = "to_anilist" | "to_markly";

export type FieldState =
  | "same"
  | "local_only"
  | "remote_only"
  | "different"
  | "local_changed"
  | "remote_changed"
  | "both_changed"
  | "unsupported"
  | "not_applicable";

export interface FieldReconciliation<T> {
  state: FieldState;
  local: T | undefined;
  remote: T | undefined;
  allowedDirections: SyncDirection[];
  suggestedDirection: SyncDirection | "none";
  /** Present only for state "unsupported" — the plain-language-mappable reason a direction was excluded. */
  reason?: "seasonal_numbering" | "fractional_progress" | "type_unsupported";
}

/**
 * Three-way field comparison — same shape used for progress, status, and
 * rating. `equal` is injected per field rather than assuming `===` so
 * callers can use whatever equality makes sense for that field's type
 * (numbers compare fine with `===`, but this keeps the function generic
 * without relying on reference equality assumptions leaking in).
 *
 * Deliberately does NOT pick a winner by magnitude, timestamp, or any
 * other heuristic (Stage 30 review, "progress is not always monotonic
 * user intent") — only three inputs ever decide the outcome: does
 * local/remote agree NOW, did local move away from the baseline, did
 * remote move away from the baseline. When both moved, no direction is
 * preselected — the user chooses.
 */
function reconcileField<T>(
  local: T | undefined,
  remote: T | undefined,
  remoteExists: boolean,
  baseline: { local: T | undefined; remote: T | undefined } | undefined,
  equal: (a: T, b: T) => boolean,
): FieldReconciliation<T> {
  const valuesEqual = (a: T | undefined, b: T | undefined) => (a === undefined && b === undefined) || (a !== undefined && b !== undefined && equal(a, b));

  if (!remoteExists) {
    if (local === undefined) return { state: "not_applicable", local, remote: undefined, allowedDirections: [], suggestedDirection: "none" };
    return { state: "local_only", local, remote: undefined, allowedDirections: ["to_anilist"], suggestedDirection: "to_anilist" };
  }

  if (valuesEqual(local, remote)) {
    return { state: "same", local, remote, allowedDirections: [], suggestedDirection: "none" };
  }

  if (!baseline) {
    // No prior sync baseline for this item — Markly has no basis to know
    // which side is "newer". Show the difference, let the user decide.
    return { state: "different", local, remote, allowedDirections: ["to_anilist", "to_markly"], suggestedDirection: "none" };
  }

  const localChanged = !valuesEqual(local, baseline.local);
  const remoteChanged = !valuesEqual(remote, baseline.remote);

  if (remoteChanged && !localChanged) {
    return { state: "remote_changed", local, remote, allowedDirections: ["to_anilist", "to_markly"], suggestedDirection: "to_markly" };
  }
  if (localChanged && !remoteChanged) {
    return { state: "local_changed", local, remote, allowedDirections: ["to_anilist", "to_markly"], suggestedDirection: "to_anilist" };
  }
  // Both changed (differently), or neither changed relative to baseline
  // yet current values still differ (a stale/rebuilt baseline) — either
  // way, Markly cannot safely guess intent. No direction preselected.
  return { state: "both_changed", local, remote, allowedDirections: ["to_anilist", "to_markly"], suggestedDirection: "none" };
}

/** Removes a direction this item structurally cannot support (e.g. outbound seasonal progress) from an already-computed field, downgrading the suggestion if it's no longer available. */
function restrictDirections<T>(field: FieldReconciliation<T>, remove: SyncDirection, reason: FieldReconciliation<T>["reason"]): FieldReconciliation<T> {
  if (!field.allowedDirections.includes(remove)) return field;
  const allowedDirections = field.allowedDirections.filter((direction) => direction !== remove);
  const suggestedDirection = field.suggestedDirection === remove ? "none" : field.suggestedDirection;
  if (allowedDirections.length === 0 && field.state !== "same" && field.state !== "not_applicable") {
    return { ...field, state: "unsupported", allowedDirections, suggestedDirection: "none", reason };
  }
  return { ...field, allowedDirections, suggestedDirection, reason: allowedDirections.length === 0 ? reason : field.reason };
}

export interface RemoteSnapshot {
  exists: boolean;
  entryId?: number;
  status?: string;
  progress?: number;
  rating?: number;
  updatedAt?: number | null;
}

export interface ItemFieldsReconciliation {
  progress: FieldReconciliation<number>;
  status: FieldReconciliation<TrackingStatus>;
  rating: FieldReconciliation<number>;
}

export interface ItemReconciliation {
  itemId: string;
  title: string;
  type: "anime" | "series" | "manga";
  mediaId: string;
  remoteExists: boolean;
  remoteEntryId: number | undefined;
  fields: ItemFieldsReconciliation;
  /** True only when this item's type/media combination is eligible for outbound writes at all (Stage 30 §5/§6) — independent of whether any individual field is currently supported. */
  writeEligible: boolean;
}

function localProgress(item: MediaItem): number | undefined {
  if (item.type === "anime" || item.type === "series") return item.currentEpisode;
  if (item.type === "manga") return item.currentChapter;
  return undefined;
}

function isSeasonal(item: MediaItem): boolean {
  return (item.type === "anime" || item.type === "series") && item.episodeNumbering === "seasonal";
}

/**
 * Builds the full per-item reconciliation snapshot. `item` must already
 * be known write-eligible (authoritative catalogSource.provider ===
 * "anilist" — see writeback.ts's own eligibility filter, never fuzzy
 * title matching) before this is called; `writeEligible` on the result
 * additionally reflects the item TYPE (anime/manga only — Stage 30 v1
 * scope, see §6/§12) since novel/website/game/movie never reach here
 * with a meaningful media id relationship even if cataloged.
 */
export function buildItemReconciliation(
  item: MediaItem,
  mediaId: string,
  remote: RemoteSnapshot,
  baselineRaw: AniListSyncBaseline | undefined,
): ItemReconciliation {
  const writeEligible = item.type === "anime" || item.type === "series" || item.type === "manga";

  // The baseline records ONE synced state (what both sides looked like
  // right after the last successful sync/apply) — not two independent
  // "local baseline" / "remote baseline" values, so the same mapped
  // figure is the comparison point for BOTH "did local drift away from
  // it" and "did remote drift away from it".
  const baselineStatus = baselineRaw ? mapAniListStatus(baselineRaw.status).markly : undefined;
  const baselineRating = baselineRaw ? mapAniListScore(baselineRaw.score) : undefined;
  const baselineProgress = baselineRaw?.progress;

  let progress = reconcileField<number>(localProgress(item), remote.progress, remote.exists, baselineRaw ? { local: baselineProgress, remote: baselineProgress } : undefined, (a, b) => a === b);

  if (isSeasonal(item)) {
    // AniList has no seasonal concept — its progress is always one
    // absolute count. Never fabricate an S×E<->absolute conversion (Stage
    // 25 rule) — progress is simply not comparable at all for a seasonal
    // item, in EITHER direction, regardless of what baseline/remote say.
    progress = { state: "unsupported", local: localProgress(item), remote: remote.progress, allowedDirections: [], suggestedDirection: "none", reason: "seasonal_numbering" };
  } else if (item.type === "manga" && !Number.isInteger(localProgress(item) ?? 0)) {
    // AniList's progress is integer-only; a Markly split-release decimal
    // (e.g. 12.5) is never floored/ceiled/rounded to fake an integer —
    // outbound is unsupported for this field. Inbound (AniList's integer
    // -> Markly) has no such problem, so it stays available.
    progress = restrictDirections(progress, "to_anilist", "fractional_progress");
  }

  const status = reconcileField<TrackingStatus>(
    item.status,
    remote.status !== undefined ? mapAniListStatus(remote.status).markly : undefined,
    remote.exists,
    baselineRaw ? { local: baselineStatus, remote: baselineStatus } : undefined,
    (a, b) => a === b,
  );

  const rating = reconcileField<number>(
    item.rating,
    remote.rating,
    remote.exists,
    baselineRaw ? { local: baselineRating, remote: baselineRating } : undefined,
    (a, b) => a === b,
  );

  if (!writeEligible) {
    // Defensive — writeback.ts never calls this for a non-anime/manga
    // item, but every field is forced to not_applicable if it ever does.
    const na = <T,>(f: FieldReconciliation<T>): FieldReconciliation<T> => ({ ...f, allowedDirections: [], suggestedDirection: "none", state: f.state === "same" ? "same" : "not_applicable" });
    return {
      itemId: item.id,
      title: item.title,
      type: item.type as "anime" | "series" | "manga",
      mediaId,
      remoteExists: remote.exists,
      remoteEntryId: remote.entryId,
      fields: { progress: na(progress), status: na(status), rating: na(rating) },
      writeEligible: false,
    };
  }

  return {
    itemId: item.id,
    title: item.title,
    type: item.type as "anime" | "series" | "manga",
    mediaId,
    remoteExists: remote.exists,
    remoteEntryId: remote.entryId,
    fields: { progress, status, rating },
    writeEligible: true,
  };
}

/** The per-field direction a user has actually chosen for one item — "none" is always valid (no change for that field). Built by the client from ItemReconciliation.fields.*.suggestedDirection, but never trusted as-is server-side (see writeback.ts). */
export interface FieldChoice {
  progress: SyncDirection | "none";
  status: SyncDirection | "none";
  rating: SyncDirection | "none";
}

/** The AniList status enum value to write for a chosen outbound status change. */
export function outboundStatusValue(status: TrackingStatus): ReturnType<typeof mapMarklyStatusToAniList> {
  return mapMarklyStatusToAniList(status);
}
