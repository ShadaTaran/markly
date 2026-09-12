import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActivityEvent } from "@/types/activity";
import type { ActivityEventRow } from "@/lib/supabase/database.types";
import { fromActivityEventRow } from "@/lib/cloud/activity";
import { MAX_ACTIVITY_EVENTS, MAX_TRACKING_SOURCES } from "@/lib/backup/limits";

/**
 * Stage 29 — cloud-mode export data fetching.
 *
 * LibraryItems and Collections are safe to fetch via the EXISTING
 * `fetchLibraryItems`/`fetchCollections` (cloud/library-items.ts,
 * cloud/collections.ts) — neither has a row cap, so the app's already-
 * loaded state for those two is already complete and authoritative.
 *
 * Activity is different: `fetchActivityEvents` (cloud/activity.ts) caps
 * at `MAX_ACTIVITY_EVENTS` from activity-storage.ts (500) — a UI display
 * limit for the Recent Activity panel, not a backup-completeness
 * guarantee. Reusing the app's already-loaded `activity.events` for
 * export would silently truncate history for any account with more than
 * 500 events, which is exactly the "partially-loaded UI state passed off
 * as a complete backup" failure Stage 29 explicitly warns against. This
 * module runs its own query instead, capped only at Stage 29's own
 * (much larger) `MAX_ACTIVITY_EVENTS` record limit
 * (lib/backup/limits.ts) — a real ceiling on transaction/file size, not a
 * display convenience.
 *
 * Three independent SELECTs (items, collections+memberships, activity),
 * matching the existing hydration pattern — see the module doc comment
 * on export consistency in lib/backup/export.ts for why this is an
 * accepted, documented trade-off rather than a transactional snapshot.
 */
export async function fetchActivityEventsForExport(supabase: SupabaseClient, userId: string): Promise<ActivityEvent[]> {
  const { data, error } = await supabase
    .from("activity_events")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_ACTIVITY_EVENTS)
    .returns<ActivityEventRow[]>();

  if (error) throw error;

  const events: ActivityEvent[] = [];
  (data ?? []).forEach((row) => {
    const event = fromActivityEventRow(row);
    if (event) events.push(event);
  });
  return events;
}

/**
 * Stage 40 data-integrity correction — the minimal, client-safe row shape
 * `lib/backup/export.ts` needs to build a `BackupTrackingSource`. Kept
 * separate from `lib/extension/tracking-sources.ts`'s own `TrackingSourceRow`
 * deliberately: that file has `import "server-only"` at its top (the whole
 * point of that guard is that it must never be reachable from client code),
 * while this fetch — like `fetchActivityEventsForExport` above — is called
 * directly from BackupSettingsPanel, a client component.
 */
export interface ExportableTrackingSource {
  library_item_id: string;
  adapter_id: string;
  source_key: string;
  source_title: string;
  source_url: string | null;
  auto_track_enabled: boolean;
  auto_link_suppressed_at: string | null;
  last_seen_at: string;
}

/**
 * Only rows actually LINKED to a LibraryItem (`library_item_id is not
 * null`) are ever fetched here — see BackupTrackingSource's own doc
 * comment in types/backup.ts for why an unlinked, never-acted-upon
 * detection isn't included. Ownership is enforced the same way as every
 * other export query on this page: RLS (`tracking_sources_select_own`,
 * migration 0003) plus the explicit `user_id` filter as defense-in-depth,
 * matching this file's own `fetchActivityEventsForExport` above.
 */
export async function fetchTrackingSourcesForExport(supabase: SupabaseClient, userId: string): Promise<ExportableTrackingSource[]> {
  const { data, error } = await supabase
    .from("tracking_sources")
    .select("library_item_id, adapter_id, source_key, source_title, source_url, auto_track_enabled, auto_link_suppressed_at, last_seen_at")
    .eq("user_id", userId)
    .not("library_item_id", "is", null)
    .limit(MAX_TRACKING_SOURCES)
    .returns<ExportableTrackingSource[]>();

  if (error) throw error;
  return data ?? [];
}
