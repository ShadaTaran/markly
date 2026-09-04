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
