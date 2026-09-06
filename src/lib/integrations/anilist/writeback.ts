import type { SupabaseClient } from "@supabase/supabase-js";
import { isMediaItem } from "@/lib/item-detail";
import { diffMediaTrackingEvents } from "@/lib/activity-events";
import { fromLibraryItemRow, toLibraryItemRow } from "@/lib/cloud/library-items";
import { insertActivityEvent } from "@/lib/cloud/activity";
import { generateId } from "@/lib/utils";
import type { LibraryItemRow } from "@/lib/supabase/database.types";
import type { MediaItem } from "@/types/library-item";
import type { ActivityEventInput } from "@/types/activity";
import { anilistGraphQL, anilistGraphQLTolerant, AniListAuthError, AniListRateLimitError } from "@/lib/integrations/anilist/client";
import {
  VIEWER_QUERY,
  MEDIA_LISTS_QUERY,
  MEDIA_LIST_ENTRY_QUERY,
  SAVE_MEDIA_LIST_ENTRY_MUTATION,
  flattenEntries,
  type AniListViewerResponse,
  type AniListMediaListsResponse,
  type AniListMediaListEntryResponse,
  type AniListSaveMediaListEntryResponse,
} from "@/lib/integrations/anilist/queries";
import {
  buildSyncBaseline,
  readSyncBaseline,
  applyInboundPersonalTracking,
  mapAniListStatus,
  mapAniListScore,
  mapMarklyStatusToAniList,
  type AniListEntryFields,
} from "@/lib/integrations/anilist/mapping";
import { marklyRatingToScoreRaw, marklyRatingToAniListScore, type AniListScoreFormat } from "@/lib/integrations/anilist/score";
import { buildItemReconciliation, type ItemReconciliation, type RemoteSnapshot, type SyncDirection } from "@/lib/integrations/anilist/reconciliation";

const LIBRARY_TABLE = "library_items";
const DEFAULT_SCORE_FORMAT: AniListScoreFormat = "POINT_10_DECIMAL";
const KNOWN_SCORE_FORMATS: readonly AniListScoreFormat[] = ["POINT_100", "POINT_10_DECIMAL", "POINT_10", "POINT_5", "POINT_3"];

function normalizeScoreFormat(raw: string | undefined): AniListScoreFormat {
  return raw && (KNOWN_SCORE_FORMATS as readonly string[]).includes(raw) ? (raw as AniListScoreFormat) : DEFAULT_SCORE_FORMAT;
}

function readExternalId(row: LibraryItemRow): string | undefined {
  const source = row.metadata.catalogSource;
  if (!source || typeof source !== "object") return undefined;
  const candidate = source as Record<string, unknown>;
  return candidate.provider === "anilist" && typeof candidate.externalId === "string" ? candidate.externalId : undefined;
}

// ============================================================
// Preview (read-only — §55: zero mutation, even with writes enabled)
// ============================================================

export interface WritebackPreviewItem {
  reconciliation: ItemReconciliation;
  /** Snapshot fingerprints captured AT PREVIEW TIME — the Apply endpoint re-verifies both against fresh reads before ever mutating anything (§24/§25). Never trust these at apply time. */
  expectedLocalUpdatedAt: string;
  expectedRemote: { exists: boolean; status?: string; progress?: number; score?: number | null };
}

export interface WritebackPreview {
  writesAllowed: boolean;
  scoreFormat: AniListScoreFormat;
  username: string;
  items: WritebackPreviewItem[];
}

/**
 * Builds the full reconciliation snapshot for every write-eligible item
 * (anime/manga, catalogSource.provider === "anilist" — §5/§6). ONE bulk
 * AniList request for the whole list (MEDIA_LISTS_QUERY, same query
 * Stage 17 already uses) plus one Viewer request — never N+1 (§38).
 * Read-only: does not write to library_items, does not touch
 * anilistSync, does not call SaveMediaListEntry.
 */
export async function buildWritebackPreview(
  supabase: SupabaseClient,
  userId: string,
  accessToken: string,
  anilistUserId: number,
  allowWrites: boolean,
): Promise<WritebackPreview> {
  const [viewerData, lists, existingRowsResult] = await Promise.all([
    anilistGraphQL<AniListViewerResponse>(accessToken, VIEWER_QUERY),
    anilistGraphQL<AniListMediaListsResponse>(accessToken, MEDIA_LISTS_QUERY, { userId: anilistUserId }),
    supabase.from(LIBRARY_TABLE).select("*").eq("user_id", userId).in("type", ["anime", "manga", "series"]).returns<LibraryItemRow[]>(),
  ]);

  if (existingRowsResult.error) throw existingRowsResult.error;
  const rows = existingRowsResult.data ?? [];

  const scoreFormat = normalizeScoreFormat(viewerData.Viewer?.mediaListOptions?.scoreFormat);
  const username = viewerData.Viewer?.name ?? "";

  const remoteByMediaId = new Map<string, RemoteSnapshot & { raw: AniListEntryFields }>();
  const registerEntries = (entries: { status: string; score: number | null; progress: number | null; updatedAt: number | null; media: { id: number } }[]) => {
    for (const entry of entries) {
      const mediaId = entry.media.id.toString();
      remoteByMediaId.set(mediaId, {
        exists: true,
        status: entry.status,
        progress: entry.progress ?? undefined,
        rating: entry.score !== null && entry.score !== undefined && entry.score > 0 ? entry.score : undefined,
        updatedAt: entry.updatedAt,
        raw: { status: entry.status, score: entry.score, progress: entry.progress, updatedAt: entry.updatedAt, media: entry.media },
      });
    }
  };
  registerEntries(flattenEntries(lists.anime));
  registerEntries(flattenEntries(lists.manga));

  const items: WritebackPreviewItem[] = [];
  for (const row of rows) {
    const mediaId = readExternalId(row);
    if (!mediaId) continue; // §5 — no authoritative AniList identity, never write-eligible

    let item: MediaItem;
    try {
      const parsed = fromLibraryItemRow(row);
      if (!isMediaItem(parsed)) continue;
      item = parsed;
    } catch {
      continue;
    }

    const remote = remoteByMediaId.get(mediaId);
    const remoteSnapshot: RemoteSnapshot = remote
      ? { exists: true, progress: remote.progress, status: remote.status, rating: remote.rating, updatedAt: remote.updatedAt }
      : { exists: false };

    const baseline = readSyncBaseline(row.metadata);
    const reconciliation = buildItemReconciliation(item, mediaId, remoteSnapshot, baseline);

    items.push({
      reconciliation,
      expectedLocalUpdatedAt: row.updated_at ?? row.created_at,
      expectedRemote: remote ? { exists: true, status: remote.raw.status, progress: remote.raw.progress ?? undefined, score: remote.raw.score } : { exists: false },
    });
  }

  return { writesAllowed: allowWrites, scoreFormat, username, items };
}

// ============================================================
// Apply (§23-§37: normalized plan, per-item, staleness-checked, sequential)
// ============================================================

export interface ApplyPlanItemChanges {
  progress: SyncDirection | "none";
  status: SyncDirection | "none";
  rating: SyncDirection | "none";
}

export interface ApplyPlanItem {
  itemId: string;
  /** Client-claimed AniList media id, for stale-plan detection only — the server ALWAYS derives the real mutation target from the owned LibraryItem's own catalogSource, never trusts this (§37). */
  expectedMediaId: string;
  expectedLocalUpdatedAt: string;
  expectedRemoteExists: boolean;
  expectedRemoteStatus?: string;
  expectedRemoteProgress?: number;
  expectedRemoteScore?: number | null;
  changes: ApplyPlanItemChanges;
}

export type ApplyItemResultStatus =
  | "applied"
  | "no_changes_selected"
  | "local_changed_since_preview"
  | "remote_changed_since_preview"
  | "not_found"
  | "not_write_eligible"
  | "writes_disabled"
  | "unsupported_field"
  | "stale_target"
  /** The pre-mutation staleness re-fetch (MEDIA_LIST_ENTRY_QUERY) failed — SaveMediaListEntry was never attempted. */
  | "remote_read_error"
  /** SaveMediaListEntry itself failed — it was attempted and did not succeed. */
  | "remote_write_error"
  /** SaveMediaListEntry succeeded (or idempotent-repair found it already correct), but persisting the local baseline afterward failed — safe to retry, the idempotent-repair check will recognize AniList already matches and skip a second mutation. */
  | "baseline_save_failed"
  /** Any other unexpected failure (outside applyWritebackItem's own AniList calls) — a true last-resort fallback, kept distinct from the two AniList-specific phases above. */
  | "remote_error"
  | "rate_limited"
  | "reconnect_required";

export interface ApplyItemResult {
  itemId: string;
  status: ApplyItemResultStatus;
  appliedFields?: { progress: boolean; status: boolean; rating: boolean };
}

function remoteFingerprintsMatch(
  a: { exists: boolean; status?: string; progress?: number; score?: number | null },
  b: { exists: boolean; status?: string; progress?: number; score?: number | null },
): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists) return true;
  return a.status === b.status && (a.progress ?? null) === (b.progress ?? null) && (a.score ?? null) === (b.score ?? null);
}

/**
 * Applies one item's chosen per-field directions. Never trusts anything
 * about the outbound target beyond the plan's itemId — mediaId, current
 * local values, and current remote values are ALL re-derived from fresh
 * server-side reads before anything is sent to AniList (§32-§37).
 *
 * Order: 1) re-read + verify local, 2) re-verify write eligibility and
 * writes-enabled, 3) re-fetch remote, 4) compare against the plan's
 * expected snapshots — UNLESS the remote already exactly equals what
 * this same outbound mutation would produce (idempotent repair — §54/§65:
 * a prior partial failure, mutation-succeeded-but-baseline-save-failed,
 * must not be treated as a fresh conflict nor trigger a second mutation),
 * 5) mutate AniList (only if an outbound field was chosen), 6) apply
 * inbound fields locally (only if chosen, using the FRESH remote values
 * just fetched, never the stale preview ones), 7) persist the new
 * baseline reflecting the ACTUAL final state.
 */
export async function applyWritebackItem(
  supabase: SupabaseClient,
  userId: string,
  accessToken: string,
  anilistUserId: number,
  allowWrites: boolean,
  plan: ApplyPlanItem,
): Promise<ApplyItemResult> {
  const { changes } = plan;
  const wantsOutbound = changes.progress === "to_anilist" || changes.status === "to_anilist" || changes.rating === "to_anilist";
  const wantsInbound = changes.progress === "to_markly" || changes.status === "to_markly" || changes.rating === "to_markly";

  if (!wantsOutbound && !wantsInbound) {
    return { itemId: plan.itemId, status: "no_changes_selected" };
  }
  if (wantsOutbound && !allowWrites) {
    // Server-enforced regardless of what the client believes the toggle
    // state is (§34) — never relies on a disabled button alone.
    return { itemId: plan.itemId, status: "writes_disabled" };
  }

  const { data: rows, error: fetchError } = await supabase.from(LIBRARY_TABLE).select("*").eq("id", plan.itemId).eq("user_id", userId).returns<LibraryItemRow[]>();
  if (fetchError) throw fetchError;
  const row = rows?.[0];
  if (!row) return { itemId: plan.itemId, status: "not_found" }; // §36 — ownership re-verified, never trusts a client-supplied id blindly

  const mediaId = readExternalId(row);
  if (!mediaId || (row.type !== "anime" && row.type !== "manga" && row.type !== "series")) {
    return { itemId: plan.itemId, status: "not_write_eligible" };
  }
  if (mediaId !== plan.expectedMediaId) {
    // §37 — the client's claimed mediaId disagrees with what the OWNED
    // item's own catalogSource actually says. The server never trusts
    // the client's mediaId as the mutation target (that's always
    // re-derived from `mediaId` above) — this only means the plan is
    // stale relative to current ownership/catalog state, so refuse and
    // ask for a refresh rather than silently using either value.
    return { itemId: plan.itemId, status: "stale_target" };
  }

  let current: MediaItem;
  try {
    const parsed = fromLibraryItemRow(row);
    if (!isMediaItem(parsed)) return { itemId: plan.itemId, status: "not_write_eligible" };
    current = parsed;
  } catch {
    return { itemId: plan.itemId, status: "not_write_eligible" };
  }

  const currentLocalUpdatedAt = row.updated_at ?? row.created_at;
  if (currentLocalUpdatedAt !== plan.expectedLocalUpdatedAt) {
    return { itemId: plan.itemId, status: "local_changed_since_preview" };
  }

  // Fractional manga progress can never be sent outbound — re-verified
  // here independently of whatever the client's UI already prevented
  // (§11, defense in depth).
  if (changes.progress === "to_anilist" && current.type === "manga" && !Number.isInteger(current.currentChapter ?? 0)) {
    return { itemId: plan.itemId, status: "unsupported_field" };
  }
  if (changes.progress === "to_anilist" && (current.type === "anime" || current.type === "series") && current.episodeNumbering === "seasonal") {
    return { itemId: plan.itemId, status: "unsupported_field" };
  }

  let remoteEntry: AniListEntryFields | null;
  let remoteEntryId: number | undefined;
  try {
    const tolerant = await anilistGraphQLTolerant<AniListMediaListEntryResponse>(accessToken, MEDIA_LIST_ENTRY_QUERY, { userId: anilistUserId, mediaId: Number(mediaId) });
    remoteEntry = tolerant.MediaList;
    remoteEntryId = tolerant.MediaList?.id;
  } catch (error) {
    return classifyAniListError(plan.itemId, error, "preflight_read");
  }

  const currentRemoteSnapshot = remoteEntry
    ? { exists: true, status: remoteEntry.status, progress: remoteEntry.progress ?? undefined, score: remoteEntry.score }
    : { exists: false };
  const expectedRemoteSnapshot = {
    exists: plan.expectedRemoteExists,
    status: plan.expectedRemoteStatus,
    progress: plan.expectedRemoteProgress,
    score: plan.expectedRemoteScore,
  };

  if (!remoteFingerprintsMatch(currentRemoteSnapshot, expectedRemoteSnapshot)) {
    // Idempotent-repair check (§54/§65): if the CURRENT remote state
    // already exactly equals what the selected outbound fields would
    // have produced, this is a safe retry after a prior partial failure
    // — never re-mutate, never report a conflict, just proceed to repair
    // the local baseline (and still apply any selected inbound fields,
    // using the current, already-correct remote values).
    const alreadyApplied = wantsOutbound && remoteEntry !== null && remoteEntryAlreadyMatchesSelection(remoteEntry, current, changes);
    if (!alreadyApplied) {
      return { itemId: plan.itemId, status: "remote_changed_since_preview" };
    }
  }

  const appliedFields = { progress: false, status: false, rating: false };
  const syncedAt = new Date().toISOString();

  if (wantsOutbound && remoteEntry !== null && remoteEntryAlreadyMatchesSelection(remoteEntry, current, changes)) {
    // Idempotent repair path — remote already correct, skip the mutation.
    appliedFields.progress = changes.progress === "to_anilist";
    appliedFields.status = changes.status === "to_anilist";
    appliedFields.rating = changes.rating === "to_anilist";
  } else if (wantsOutbound) {
    try {
      const variables: Record<string, unknown> = { id: remoteEntryId, mediaId: Number(mediaId) };
      if (changes.status === "to_anilist") variables.status = mapMarklyStatusToAniList(current.status);
      if (changes.rating === "to_anilist" && current.rating !== undefined) {
        variables.scoreRaw = marklyRatingToScoreRaw(current.rating);
      }
      if (changes.progress === "to_anilist") variables.progress = outboundProgressValue(current);

      const result = await anilistGraphQL<AniListSaveMediaListEntryResponse>(accessToken, SAVE_MEDIA_LIST_ENTRY_MUTATION, variables);
      if (!result.SaveMediaListEntry) throw new Error("AniList did not return the saved entry.");
      remoteEntry = { status: result.SaveMediaListEntry.status, score: result.SaveMediaListEntry.score, progress: result.SaveMediaListEntry.progress, updatedAt: result.SaveMediaListEntry.updatedAt, media: result.SaveMediaListEntry.media };
      remoteEntryId = result.SaveMediaListEntry.id;
      appliedFields.progress = changes.progress === "to_anilist";
      appliedFields.status = changes.status === "to_anilist";
      appliedFields.rating = changes.rating === "to_anilist";
    } catch (error) {
      return classifyAniListError(plan.itemId, error, "mutation");
    }
  }

  let patched: MediaItem = current;
  if (wantsInbound && remoteEntry) {
    // Feed back the item's OWN current status/rating as "incoming" for
    // whichever of those two fields was NOT selected, so
    // applyInboundPersonalTracking's write is a no-op for that field —
    // this reuses its seasonal-progress guard for the progress field
    // specifically, without needing a second copy of that logic here.
    const incomingStatus = changes.status === "to_markly" ? mapAniListStatus(remoteEntry.status).markly : current.status;
    const incomingRating = changes.rating === "to_markly" ? mapAniListScore(remoteEntry.score) : current.rating;
    const applyResult = applyInboundPersonalTracking(current, { status: incomingStatus, progress: remoteEntry.progress ?? 0, rating: incomingRating }, syncedAt);
    patched = changes.progress === "to_markly" ? applyResult.patched : restoreUnselectedProgress(applyResult.patched, current);
    appliedFields.status = changes.status === "to_markly";
    appliedFields.rating = changes.rating === "to_markly";
    appliedFields.progress = changes.progress === "to_markly" && applyResult.progressApplied;
  }

  const events: ActivityEventInput[] = wantsInbound
    ? diffMediaTrackingEvents(current.id, current, patched).map((event) => ({ ...event, source: "anilist_sync" as const }))
    : [];

  const outRow = toLibraryItemRow(patched, userId);
  outRow.metadata = {
    ...outRow.metadata,
    anilistSync: remoteEntry ? buildSyncBaseline(remoteEntry, syncedAt) : readSyncBaseline(row.metadata),
  };
  const { error: saveError } = await supabase.from(LIBRARY_TABLE).upsert(outRow);
  if (saveError) {
    // The AniList side already succeeded (a fresh mutation just above, or
    // idempotent-repair finding it already correct) — only Markly's own
    // baseline bookkeeping failed to persist. Distinct from
    // remote_write_error so a retry is understood as "safe, AniList
    // already has the right value" rather than "re-attempt the mutation."
    // A retry re-enters this same function, re-fetches the now-matching
    // remote entry, and the idempotent-repair check above lets it through
    // without a second SaveMediaListEntry call.
    return { itemId: plan.itemId, status: "baseline_save_failed" };
  }

  for (const event of events) {
    await insertActivityEvent(supabase, { ...event, id: generateId(), timestamp: syncedAt }, userId).catch(() => undefined);
  }

  return { itemId: plan.itemId, status: "applied", appliedFields };
}

function outboundProgressValue(item: MediaItem): number | undefined {
  if (item.type === "anime" || item.type === "series") return item.currentEpisode;
  if (item.type === "manga") return item.currentChapter;
  return undefined;
}

/**
 * Restores `patched`'s progress-bearing field back to `original`'s value
 * — used when applyInboundPersonalTracking wrote a new progress value
 * (it always does, when eligible) but the user did NOT actually select
 * progress to sync. `patched` and `original` are always the same
 * underlying item type (patched is derived from original), so each
 * branch narrows both sides together.
 */
function restoreUnselectedProgress(patched: MediaItem, original: MediaItem): MediaItem {
  if ((patched.type === "anime" || patched.type === "series") && (original.type === "anime" || original.type === "series")) {
    return { ...patched, currentEpisode: original.currentEpisode };
  }
  if (patched.type === "manga" && original.type === "manga") {
    return { ...patched, currentChapter: original.currentChapter };
  }
  return patched;
}

function remoteEntryAlreadyMatchesSelection(remoteEntry: AniListEntryFields, current: MediaItem, changes: ApplyPlanItemChanges): boolean {
  if (changes.status === "to_anilist" && remoteEntry.status !== mapMarklyStatusToAniList(current.status)) return false;
  if (changes.rating === "to_anilist" && current.rating !== undefined && remoteEntry.score !== marklyRatingToAniListScore(current.rating, "POINT_10_DECIMAL")) return false;
  if (changes.progress === "to_anilist" && remoteEntry.progress !== outboundProgressValue(current)) return false;
  return true;
}

/**
 * `phase` distinguishes which AniList call failed — "preflight_read" (the
 * staleness re-fetch, meaning SaveMediaListEntry was never attempted) vs
 * "mutation" (SaveMediaListEntry itself was attempted and failed) — so a
 * failure can be diagnosed without ever exposing the underlying raw
 * error/response. auth and rate-limit errors stay their own specific
 * statuses regardless of phase — never collapsed into the generic
 * read/write buckets.
 */
function classifyAniListError(itemId: string, error: unknown, phase: "preflight_read" | "mutation"): ApplyItemResult {
  if (error instanceof AniListAuthError) return { itemId, status: "reconnect_required" };
  if (error instanceof AniListRateLimitError) return { itemId, status: "rate_limited" };
  return { itemId, status: phase === "preflight_read" ? "remote_read_error" : "remote_write_error" };
}
