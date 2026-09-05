import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActivityEvent } from "@/types/activity";
import type { ActivityEventRow } from "@/lib/supabase/database.types";
import { fromActivityEventRow } from "@/lib/cloud/activity";
import { MAX_ACTIVITY_EVENTS } from "@/lib/backup/limits";

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
