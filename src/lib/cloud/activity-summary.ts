import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActivitySummaryRow } from "@/lib/supabase/database.types";
import type { ActivitySummary } from "@/lib/smart-views";

/** Safely parses the RPC's untyped result — matching the codebase's existing .rpc() convention (e.g. lib/cloud/recovery.ts's parseDeleteResult) rather than casting via .returns(), which doesn't reliably resolve for this project's Supabase client (see database.types.ts's own doc comment). */
function parseActivitySummaryRows(data: unknown): ActivitySummaryRow[] {
  if (!Array.isArray(data)) return [];
  const rows: ActivitySummaryRow[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.item_id === "string" && typeof candidate.last_activity_at === "string") {
      rows.push({ item_id: candidate.item_id, last_activity_at: candidate.last_activity_at });
    }
  }
  return rows;
}

/**
 * Stage 31 — calls get_library_activity_summary() (0015 migration): a
 * server-side aggregate covering the account's ENTIRE activity history,
 * not the 500-row UI-display cap fetchActivityEvents uses. Returns only
 * item_id + last_activity_at — never the full event bodies — so this is
 * cheap even for a heavy account (see that migration's own doc comment
 * for why the existing capped fetch and the backup exporter's own
 * 50,000-row fetch are both wrong tools for this).
 */
export async function fetchActivitySummary(supabase: SupabaseClient): Promise<ActivitySummary> {
  const { data, error } = await supabase.rpc("get_library_activity_summary");
  if (error) throw error;

  const summary = new Map<string, string>();
  parseActivitySummaryRows(data).forEach((row) => summary.set(row.item_id, row.last_activity_at));
  return summary;
}
