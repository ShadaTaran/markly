import type { SupabaseClient } from "@supabase/supabase-js";
import type { SavedLibraryViewRow } from "@/lib/supabase/database.types";
import type { SavedSmartView } from "@/types/smart-view";
import { SMART_VIEW_DEFINITION_VERSION, defaultSmartViewDefinition } from "@/types/smart-view";
import { parseSmartViewDefinition } from "@/lib/smart-views";

/**
 * Rows whose `definition` fails to parse (an unsupported future version, a
 * hand-edited/corrupted JSONB value) are dropped rather than crashing the
 * whole fetch or the caller — matching the local-storage loader's exact
 * per-record fallback (Stage 31 §29/§73). A dropped row's saved view is
 * simply invisible until fixed or deleted; nothing else in the account is
 * affected.
 */
export async function fetchSavedViews(supabase: SupabaseClient, userId: string): Promise<SavedSmartView[]> {
  const { data, error } = await supabase
    .from("saved_library_views")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .returns<SavedLibraryViewRow[]>();

  if (error) throw error;

  const views: SavedSmartView[] = [];
  (data ?? []).forEach((row) => {
    const definition = parseSmartViewDefinition(row.definition);
    if (!definition) return;
    views.push({ id: row.id, name: row.name, definition, createdAt: row.created_at, updatedAt: row.updated_at ?? undefined });
  });
  return views;
}

/** Distinguishes a duplicate-name conflict (the DB's own case-insensitive unique index) from any other failure, so the UI can show a clear validation message instead of a generic error (Stage 31 §23/§28). */
export type SaveSavedViewResult = { status: "ok" } | { status: "duplicate_name" } | { status: "error" };

export async function upsertSavedViewRow(supabase: SupabaseClient, view: SavedSmartView, userId: string): Promise<SaveSavedViewResult> {
  const { error } = await supabase.from("saved_library_views").upsert({
    id: view.id,
    user_id: userId,
    name: view.name,
    definition_version: SMART_VIEW_DEFINITION_VERSION,
    definition: view.definition ?? defaultSmartViewDefinition(),
    created_at: view.createdAt,
    updated_at: view.updatedAt ?? null,
  });

  if (!error) return { status: "ok" };
  // Postgres unique_violation.
  if (error.code === "23505") return { status: "duplicate_name" };
  return { status: "error" };
}

export async function deleteSavedViewRow(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from("saved_library_views").delete().eq("id", id);
  if (error) throw error;
}
