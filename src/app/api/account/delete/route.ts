import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Stage 43 — permanently deletes the authenticated user's Markly account.
 *
 * Request body carries only `confirmation`; the target user is never
 * client-supplied — it's always `userData.user.id` from this request's own
 * session (see createClient()/auth.getUser() below), so a malicious client
 * cannot choose a different account to delete.
 *
 * Cleanup design (Stage 43 Phase 0 audit): every user-owned table in this
 * schema (library_items, collections, collection_items, activity_events,
 * tracking_sources, external_connections, extension_devices,
 * pairing_codes, saved_library_views, reminders, reminder_deliveries,
 * push_subscriptions, library_recovery_actions, backup_import_requests —
 * confirmed exhaustively against every migration 0001-0019) declares its
 * `user_id` column `references auth.users (id) on delete cascade`. A
 * foreign-key-triggered cascade fires at the Postgres engine level and is
 * NOT subject to the referencing table's own RLS policies — unlike an
 * ordinary authenticated DELETE statement, it is not narrowed by, and
 * cannot be blocked by, migration 0019's tracking_sources restriction (or
 * pairing_codes/extension_devices having no ordinary-authenticated delete
 * policy at all). This was proven live against a disposable Supabase
 * project: a synthetic user with one row in every one of the 14 tables
 * above (including both a linked-manual and an unlinked-suppressed-
 * automatic tracking_sources row) was reduced to zero rows everywhere by a
 * single `delete from auth.users where id = ...`.
 *
 * This means a single admin.deleteUser(id, false) call (false = hard
 * delete, not Supabase's soft-delete option) both removes the Auth
 * identity AND atomically cascades every table above in one Postgres
 * statement — there is no separate "cleanup" step that can succeed while
 * auth deletion fails, or vice versa, so no migration 0020 and no explicit
 * cleanup RPC were needed for this guarantee.
 *
 * Uses the existing server-only admin client (src/lib/supabase/admin.ts,
 * already used by the extension pairing/progress routes) for exactly this
 * one call — never for anything an ordinary authenticated/RLS-scoped
 * operation could do instead.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: { confirmation?: string };
  try {
    body = (await request.json()) as { confirmation?: string };
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (body.confirmation !== "DELETE") {
    return NextResponse.json({ error: "invalid_confirmation" }, { status: 400 });
  }

  const adminClient = getSupabaseAdminClient();
  if (!adminClient) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  try {
    const { error } = await adminClient.auth.admin.deleteUser(userData.user.id, false);
    if (error) return NextResponse.json({ error: "auth_delete_failed" }, { status: 502 });
    return NextResponse.json({ status: "deleted" });
  } catch {
    return NextResponse.json({ error: "auth_delete_failed" }, { status: 502 });
  }
}
