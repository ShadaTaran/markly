import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MediaItem } from "@/types/library-item";
import type { DetectedMetadata } from "@/lib/extension/detected-metadata";

const TABLE = "tracking_sources";

/**
 * `last_detected_progress` predates Stage 21 and its DB column keeps that
 * name (no migration needed for this — see README "Metadata Enrichment"),
 * but its JSON value now optionally also carries the last confidently
 * detected enrichment metadata alongside the progress it was always
 * storing. Application code (TrackingSourceSummary, mapped in
 * app/settings/tracking/page.tsx and app/api/tracking-sources/route.ts)
 * presents these as two separate, cleanly-named fields regardless of how
 * they're stored together here.
 */
export interface StoredDetectionProgress {
  kind: string;
  value: number;
  /** Stage 25 — present only when kind === "season_episode"; see EpisodeTrackedItem.currentSeason and README "Season-Aware Episode Tracking". */
  season?: number;
  metadata?: DetectedMetadata;
  /**
   * Stage 24 — false only for a video "episode detected, not yet watched
   * enough" discovery ping (see /api/extension/progress's `commitProgress`
   * handling and README "Episode/Video Tracking"). Absent (the default for
   * every reading-media detection, unchanged since Stage 18) or true means
   * this value represents genuinely committed/immediate progress — reading
   * a chapter *is* progress, but merely opening a video episode's page is
   * not. buildDetectedMediaInput (src/lib/extension/detected-item.ts)
   * checks this before baking a detected episode number into a newly
   * created LibraryItem.
   */
  confirmed?: boolean;
}

export interface TrackingSourceRow {
  id: string;
  user_id: string;
  library_item_id: string | null;
  adapter_id: string;
  source_key: string;
  source_title: string;
  source_url: string | null;
  media_type: MediaItem["type"];
  auto_track_enabled: boolean;
  last_detected_progress: StoredDetectionProgress | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  /** Stage 26 — see migrations/0008's own comment. Non-null means an explicit user Unlink is still in effect for this source. */
  auto_link_suppressed_at: string | null;
}

export interface DetectionInput {
  adapterId: string;
  sourceKey: string;
  sourceTitle: string;
  sourceUrl: string | null;
  mediaType: MediaItem["type"];
  progress: { kind: string; value: number; season?: number };
  detectedMetadata?: DetectedMetadata;
  /** Stage 24 — see StoredDetectionProgress.confirmed. Only ever passed as `false` by the video discovery path; every other caller omits it (defaults to confirmed). */
  confirmed?: boolean;
}

/**
 * Admin-client only. Upserts by (user_id, adapter_id, source_key) —
 * deliberately omits library_item_id/auto_track_enabled from the payload
 * so an existing link and its auto-track preference are never reset by a
 * routine detection; only a real /link or /unlink action (or a successful
 * smart auto-link — see claimSourceLink below) changes those. New
 * (never-seen) sources fall back to the table defaults (unlinked,
 * auto-tracking on for whenever they do get linked). Returns the row's id
 * so the caller can attempt a smart auto-link against it without a
 * separate read.
 */
export async function recordDetection(admin: SupabaseClient, userId: string, input: DetectionInput): Promise<{ id: string }> {
  const { data, error } = await admin
    .from(TABLE)
    .upsert(
      {
        user_id: userId,
        adapter_id: input.adapterId,
        source_key: input.sourceKey,
        source_title: input.sourceTitle,
        source_url: input.sourceUrl,
        media_type: input.mediaType,
        last_detected_progress: {
          ...input.progress,
          ...(input.confirmed === false && { confirmed: false }),
          ...(input.detectedMetadata && { metadata: input.detectedMetadata }),
        },
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,adapter_id,source_key" },
    )
    .select("id")
    .returns<{ id: string }[]>();
  if (error) throw error;

  const row = data?.[0];
  if (!row) throw new Error("recordDetection: upsert returned no row");
  return { id: row.id };
}

/**
 * Admin-client only. Atomically claims the first link for a source row —
 * only takes effect if the row is still unlinked at the moment this
 * UPDATE runs, mirroring consumePairingCode's `UPDATE ... WHERE used_at
 * IS NULL` pattern (src/lib/extension/pairing.ts). If two concurrent
 * first detections for the same source both compute the same smart
 * auto-link candidate, only one UPDATE actually matches the WHERE clause
 * — the other affects zero rows and must re-read the row to find out
 * which link actually won, rather than assuming its own candidate is
 * authoritative. Scoped to userId as well as sourceId, even though both
 * are already derived from user-scoped reads, as defense in depth around
 * the one write path that creates a tracking_sources -> library_items
 * link without an explicit user action.
 */
export async function claimSourceLink(admin: SupabaseClient, userId: string, sourceId: string, libraryItemId: string): Promise<string> {
  const { data, error } = await admin
    .from(TABLE)
    .update({ library_item_id: libraryItemId, updated_at: new Date().toISOString() })
    .eq("id", sourceId)
    .eq("user_id", userId)
    .is("library_item_id", null)
    .select("library_item_id")
    .returns<{ library_item_id: string | null }[]>();
  if (error) throw error;

  const won = data?.[0]?.library_item_id;
  if (won) return won;

  const { data: current, error: readError } = await admin
    .from(TABLE)
    .select("library_item_id")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .returns<{ library_item_id: string | null }[]>();
  if (readError) throw readError;

  const winningId = current?.[0]?.library_item_id;
  if (!winningId) throw new Error("claimSourceLink: source is still unlinked after a failed claim");
  return winningId;
}

/** Admin-client only — used by /api/extension/progress to find an existing mapping for a detection. */
export async function getSourceByKey(admin: SupabaseClient, userId: string, adapterId: string, sourceKey: string): Promise<TrackingSourceRow | null> {
  const { data, error } = await admin
    .from(TABLE)
    .select("*")
    .eq("user_id", userId)
    .eq("adapter_id", adapterId)
    .eq("source_key", sourceKey)
    .returns<TrackingSourceRow[]>();
  if (error) throw error;
  return data?.[0] ?? null;
}

/** Admin-client only — clears a stale link (its LibraryItem was deleted) without losing the detected-source row itself. */
export async function clearBrokenLink(admin: SupabaseClient, sourceId: string): Promise<void> {
  const { error } = await admin.from(TABLE).update({ library_item_id: null, updated_at: new Date().toISOString() }).eq("id", sourceId);
  if (error) throw error;
}

/** Session-authenticated (RLS-scoped) — for the Auto Tracking settings page. */
export async function listSources(supabase: SupabaseClient, userId: string): Promise<TrackingSourceRow[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("user_id", userId)
    .order("last_seen_at", { ascending: false })
    .returns<TrackingSourceRow[]>();
  if (error) throw error;
  return data ?? [];
}

/**
 * Session-authenticated (RLS-scoped) — the targeted query the item detail
 * page's Tracking Sources section uses instead of fetching every one of
 * the user's sources and filtering client-side (see README "Cross-Source
 * Work Identity" — avoiding N+1/over-fetching was an explicit Stage 26
 * requirement).
 */
export async function listSourcesForItem(supabase: SupabaseClient, userId: string, libraryItemId: string): Promise<TrackingSourceRow[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("user_id", userId)
    .eq("library_item_id", libraryItemId)
    .order("last_seen_at", { ascending: false })
    .returns<TrackingSourceRow[]>();
  if (error) throw error;
  return data ?? [];
}

/**
 * Session-authenticated (RLS-scoped) — the RLS policy's WITH CHECK
 * independently re-verifies libraryItemId belongs to this user, so this
 * is defense in depth, not the only enforcement.
 *
 * Stage 26 — always clears auto_link_suppressed_at: any deliberate,
 * explicit "link this" action (the inline picker, or re-choosing the same
 * item via Add or Link) is exactly the user-intent signal that should
 * restore normal automatic behavior for this source, regardless of
 * whether it was previously suppressed.
 */
export async function linkSource(supabase: SupabaseClient, userId: string, sourceId: string, libraryItemId: string): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({ library_item_id: libraryItemId, auto_link_suppressed_at: null, updated_at: new Date().toISOString() })
    .eq("id", sourceId)
    .eq("user_id", userId);
  if (error) throw error;
}

/**
 * Stage 26 — also records that this was an explicit, user-initiated
 * unlink (auto_link_suppressed_at), so the next detection through
 * /api/extension/progress doesn't immediately run Smart Auto-Link/Auto-Add
 * and silently relink (or duplicate) it right back — see route.ts and
 * migrations/0008's own comment. clearBrokenLink (a *deleted item*
 * unlinking its sources automatically) deliberately does not set this —
 * only a real user action does.
 */
export async function unlinkSource(supabase: SupabaseClient, userId: string, sourceId: string): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({ library_item_id: null, auto_link_suppressed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", sourceId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function setAutoTrackEnabled(supabase: SupabaseClient, userId: string, sourceId: string, enabled: boolean): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({ auto_track_enabled: enabled, updated_at: new Date().toISOString() })
    .eq("id", sourceId)
    .eq("user_id", userId);
  if (error) throw error;
}

export type CreateManualSourceResult =
  | { status: "created"; sourceId: string }
  | { status: "linked"; sourceId: string }
  | { status: "already-linked"; sourceId: string }
  | { status: "conflict"; sourceId: string; conflictingLibraryItemId: string }
  | { status: "item-not-found" }
  | { status: "unsupported-item-type" };

const POSTGRES_UNIQUE_VIOLATION = "23505";

/** Mirrors tracking_sources' own media_type CHECK constraint (0003) — the only LibraryItem types a TrackingSource can ever describe. Website (and the unused article/video/other placeholders) are deliberately excluded — see createManualSource's own item-type check below. */
const TRACKABLE_MEDIA_TYPES: readonly MediaItem["type"][] = ["anime", "manga", "novel", "game", "movie", "series"];

/**
 * Session-authenticated (RLS-scoped) — Stage 40's "Add Source" manual entry
 * path. Deliberately never upserts a payload that could silently move an
 * EXISTING source's library_item_id out from under whatever item it is
 * currently linked to (Stage 40 §10, §8): a pre-existing row for the same
 * (user, "manual", normalizedUrl) identity is only ever linked (if
 * currently unlinked) or reported back as already-linked/in-conflict —
 * never blindly overwritten by a second Add Source attempt.
 *
 * The request's `libraryItemId` is untrusted input: neither its ownership
 * nor its real media type is taken on faith. This function loads the
 * target LibraryItem itself via the RLS-scoped `supabase` client — the
 * SAME "final data-integrity & ownership gate" pass also confirmed that
 * `tracking_sources_insert_own`/`_update_own` (migration 0003) already
 * enforce library_item_id ownership at the database level (mirroring
 * collection_items' own WITH CHECK pattern from 0001), so a forged
 * libraryItemId belonging to another account — or naming a row that
 * doesn't exist at all — can never actually get a row written under it;
 * this SELECT exists so the FAILURE is a clean, generic `item-not-found`
 * result instead of a raw RLS/Postgres error surfacing from the eventual
 * insert. Because `library_items_select_own` (0001) scopes the SELECT the
 * exact same way, "belongs to someone else" and "doesn't exist" are
 * indistinguishable here too — never a signal an attacker could use to
 * enumerate other accounts' item ids.
 *
 * The item's OWN stored `type` — never the caller-supplied `mediaType`
 * this function used to accept — is what decides both whether source
 * linking is allowed at all (website items, and the unused generic
 * article/video/other placeholders, have no TrackingSource concept — see
 * TRACKABLE_MEDIA_TYPES) and what value the created row's `media_type`
 * column gets. This closes the "website LibraryItem id + a fabricated
 * mediaType" gap a purely client-trusting version of this function had.
 *
 * `adapter_id: "manual"` is a reserved sentinel — never a real extension
 * adapter id (see extension/src/adapters/*, none of which use it) —
 * identifying a user-entered source. Its `source_key` is the same
 * normalized URL lib/website.ts's normalizeUrl already produces (computed
 * by the caller — see the API route — never accepted as a separate,
 * independently-trusted field from the request body), so a manual source
 * gets the exact same (user_id, adapter_id, source_key) uniqueness
 * guarantee (0003's own unique constraint) every extension-detected source
 * already has — no new constraint needed, and concurrent double-submits
 * are resolved by catching the resulting unique-violation and re-resolving
 * once (Stage 40 §36/§37) rather than trusting a client-side disabled-
 * button guard alone.
 *
 * Before falling through to that manual-adapter identity, this also
 * audits every OTHER adapter for the exact same normalized `source_url`
 * (Stage 40 correction §19/§20): DB uniqueness is scoped to
 * (user_id, adapter_id, source_key), so a real extension adapter's
 * source_key is frequently an opaque, adapter-defined id rather than a
 * URL — meaning the exact same page could otherwise end up linked twice,
 * once under its real adapter and once again under "manual". A match
 * already linked to THIS item is reported as already-linked (never a
 * second row); a match already linked to a DIFFERENT item is reported as
 * a conflict — in both cases the existing row (whatever adapter created
 * it) is left completely untouched: never relabeled, relinked, or
 * deleted, and its richer adapter-specific metadata is never suppressed.
 * An UNLINKED cross-adapter row sharing the same URL is deliberately left
 * alone rather than silently claimed — that would be exactly the kind of
 * automatic cross-adapter merge Stage 40 explicitly rules out; it simply
 * never appears in this item's Source Hub list (which only ever shows
 * sources actually linked to it), so no visible duplicate results.
 */
export async function createManualSource(
  supabase: SupabaseClient,
  userId: string,
  libraryItemId: string,
  normalizedUrl: string,
  label: string,
): Promise<CreateManualSourceResult> {
  const { data: itemRows, error: itemError } = await supabase
    .from("library_items")
    .select("id, type")
    .eq("id", libraryItemId)
    .eq("user_id", userId)
    .returns<{ id: string; type: string }[]>();
  if (itemError) throw itemError;

  const item = itemRows?.[0];
  if (!item) return { status: "item-not-found" };
  if (!(TRACKABLE_MEDIA_TYPES as readonly string[]).includes(item.type)) return { status: "unsupported-item-type" };
  const mediaType = item.type as MediaItem["type"];

  const { data: sameUrlRows, error: sameUrlError } = await supabase
    .from(TABLE)
    .select("id, library_item_id")
    .eq("user_id", userId)
    .eq("source_url", normalizedUrl)
    .returns<{ id: string; library_item_id: string | null }[]>();
  if (sameUrlError) throw sameUrlError;

  const sameItemCrossAdapterMatch = (sameUrlRows ?? []).find((row) => row.library_item_id === libraryItemId);
  if (sameItemCrossAdapterMatch) return { status: "already-linked", sourceId: sameItemCrossAdapterMatch.id };
  const otherItemCrossAdapterMatch = (sameUrlRows ?? []).find((row) => row.library_item_id !== null && row.library_item_id !== libraryItemId);
  if (otherItemCrossAdapterMatch) {
    return { status: "conflict", sourceId: otherItemCrossAdapterMatch.id, conflictingLibraryItemId: otherItemCrossAdapterMatch.library_item_id! };
  }

  const { data: existingRows, error: readError } = await supabase
    .from(TABLE)
    .select("id, library_item_id")
    .eq("user_id", userId)
    .eq("adapter_id", "manual")
    .eq("source_key", normalizedUrl)
    .returns<{ id: string; library_item_id: string | null }[]>();
  if (readError) throw readError;

  const existing = existingRows?.[0];
  if (existing) {
    if (existing.library_item_id === libraryItemId) return { status: "already-linked", sourceId: existing.id };
    if (existing.library_item_id) return { status: "conflict", sourceId: existing.id, conflictingLibraryItemId: existing.library_item_id };
    await linkSource(supabase, userId, existing.id, libraryItemId);
    return { status: "linked", sourceId: existing.id };
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      user_id: userId,
      library_item_id: libraryItemId,
      adapter_id: "manual",
      source_key: normalizedUrl,
      source_title: label,
      source_url: normalizedUrl,
      media_type: mediaType,
      auto_track_enabled: false,
      last_seen_at: new Date().toISOString(),
    })
    .select("id")
    .returns<{ id: string }[]>();

  if (error) {
    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      // Lost a concurrent create race — the row now exists; resolve it
      // exactly as the pre-check branch above would (one retry only, the
      // second attempt cannot lose the same race again).
      return createManualSource(supabase, userId, libraryItemId, normalizedUrl, label);
    }
    throw error;
  }

  const row = data?.[0];
  if (!row) throw new Error("createManualSource: insert returned no row");
  return { status: "created", sourceId: row.id };
}

export type RestoreTrackingSourceResult =
  | { status: "created" }
  | { status: "linked" }
  | { status: "already-linked" }
  | { status: "conflict"; conflictingLibraryItemId: string }
  /** Stage 40 backup correction — the destination account already has this exact source, unlinked, with ITS OWN live suppression already set (independent of this backup). Restoring never overrides that — see this function's own doc comment. */
  | { status: "suppressed-elsewhere" }
  | { status: "item-not-found" }
  | { status: "unsupported-item-type" };

/**
 * Stage 40 data-integrity correction — Part A (backup restore). Session-
 * authenticated, structurally a close sibling of createManualSource above:
 * same RLS-backed ownership proof via loading the target LibraryItem
 * itself, same "item's own real type decides media_type, never a
 * caller-declared value" rule (a restored backup never carries a
 * mediaType field at all — see BackupTrackingSource in types/backup.ts),
 * and the same cross-adapter same-URL audit (§19/§20) before falling back
 * to an exact (adapterId, sourceKey) identity lookup.
 *
 * Differs from createManualSource in two ways, both specific to restoring
 * an arbitrary previously-exported identity rather than creating a fresh
 * user-typed one:
 *   1. `adapterId`/`sourceKey` are the backup's OWN preserved values
 *      (could be "manual", or a real extension adapter id) — never
 *      hardcoded to "manual" — so a restored extension-detected source
 *      keeps being recognized correctly by a later live detection from
 *      that same adapter.
 *   2. If the destination account already has this exact identity,
 *      UNLINKED, with `auto_link_suppressed_at` already set by some
 *      unrelated LIVE action on this account (not by this restore), that
 *      live suppression is left alone rather than silently overridden by
 *      linking it — the account's own more-recent explicit unlink wins.
 *      `suppressed` from the backup itself is only ever (re)applied when
 *      CREATING a brand-new row (nothing live to conflict with yet) —
 *      never layered onto an existing row this call is simultaneously
 *      relinking, which would leave a self-contradictory
 *      linked-and-suppressed row for no concrete benefit.
 */
export async function restoreTrackingSource(
  supabase: SupabaseClient,
  userId: string,
  libraryItemId: string,
  adapterId: string,
  sourceKey: string,
  sourceTitle: string,
  sourceUrl: string,
  autoTrackEnabled: boolean,
  suppressed: boolean,
): Promise<RestoreTrackingSourceResult> {
  const { data: itemRows, error: itemError } = await supabase
    .from("library_items")
    .select("id, type")
    .eq("id", libraryItemId)
    .eq("user_id", userId)
    .returns<{ id: string; type: string }[]>();
  if (itemError) throw itemError;

  const item = itemRows?.[0];
  if (!item) return { status: "item-not-found" };
  if (!(TRACKABLE_MEDIA_TYPES as readonly string[]).includes(item.type)) return { status: "unsupported-item-type" };
  const mediaType = item.type as MediaItem["type"];

  const { data: sameUrlRows, error: sameUrlError } = await supabase
    .from(TABLE)
    .select("id, library_item_id")
    .eq("user_id", userId)
    .eq("source_url", sourceUrl)
    .returns<{ id: string; library_item_id: string | null }[]>();
  if (sameUrlError) throw sameUrlError;

  const sameItemCrossAdapterMatch = (sameUrlRows ?? []).find((row) => row.library_item_id === libraryItemId);
  if (sameItemCrossAdapterMatch) return { status: "already-linked" };
  const otherItemCrossAdapterMatch = (sameUrlRows ?? []).find((row) => row.library_item_id !== null && row.library_item_id !== libraryItemId);
  if (otherItemCrossAdapterMatch) return { status: "conflict", conflictingLibraryItemId: otherItemCrossAdapterMatch.library_item_id! };

  const { data: existingRows, error: readError } = await supabase
    .from(TABLE)
    .select("id, library_item_id, auto_link_suppressed_at")
    .eq("user_id", userId)
    .eq("adapter_id", adapterId)
    .eq("source_key", sourceKey)
    .returns<{ id: string; library_item_id: string | null; auto_link_suppressed_at: string | null }[]>();
  if (readError) throw readError;

  const existing = existingRows?.[0];
  if (existing) {
    if (existing.library_item_id === libraryItemId) return { status: "already-linked" };
    if (existing.library_item_id) return { status: "conflict", conflictingLibraryItemId: existing.library_item_id };
    if (existing.auto_link_suppressed_at) return { status: "suppressed-elsewhere" };
    await linkSource(supabase, userId, existing.id, libraryItemId);
    return { status: "linked" };
  }

  const { error } = await supabase.from(TABLE).insert({
    user_id: userId,
    library_item_id: libraryItemId,
    adapter_id: adapterId,
    source_key: sourceKey,
    source_title: sourceTitle,
    source_url: sourceUrl,
    media_type: mediaType,
    auto_track_enabled: autoTrackEnabled,
    last_seen_at: new Date().toISOString(),
    auto_link_suppressed_at: suppressed ? new Date().toISOString() : null,
  });

  if (error) {
    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      // Lost a concurrent create race (e.g. the extension detected the
      // same page while this restore was in flight) — resolve it exactly
      // as the pre-check branch above would; one retry only.
      return restoreTrackingSource(supabase, userId, libraryItemId, adapterId, sourceKey, sourceTitle, sourceUrl, autoTrackEnabled, suppressed);
    }
    throw error;
  }

  return { status: "created" };
}
