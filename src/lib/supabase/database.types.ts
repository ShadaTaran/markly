/**
 * Row shapes for Stage 16's tables, hand-written to match
 * supabase/migrations/0001_stage16_core_schema.sql.
 *
 * These are used directly (via `.returns<T>()` on selects) rather than
 * threaded through `SupabaseClient<Database>`'s generic Database parameter.
 * The installed @supabase/supabase-js / postgrest-js version's generic
 * schema-inference machinery does not reliably resolve a hand-written
 * Database type in this project's TypeScript configuration (verified by
 * isolated repro — it collapses query/upsert argument types to `never`
 * regardless of how closely the shape matches the officially documented
 * `supabase gen types typescript` output). Typing each query's result
 * explicitly here is simpler and equally safe, and sidesteps that
 * machinery entirely. If this is later replaced by real generated types
 * (once the Supabase CLI is wired into the project), `SupabaseClient` can
 * go back to being parameterized directly.
 */

export interface LibraryItemRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  favorite: boolean;
  image_url: string | null;
  source_url: string | null;
  url: string | null;
  status: string | null;
  rating: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string | null;
}

export interface CollectionRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface CollectionItemRow {
  collection_id: string;
  item_id: string;
  user_id: string;
  added_at: string;
}

export interface ActivityEventRow {
  id: string;
  user_id: string;
  item_id: string;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}

/** Stage 31 — one row per saved Smart View (a query definition, never an item-id list — see src/types/smart-view.ts). */
export interface SavedLibraryViewRow {
  id: string;
  user_id: string;
  name: string;
  definition_version: number;
  definition: Record<string, unknown>;
  created_at: string;
  updated_at: string | null;
}

/** Stage 31 — one row per LibraryItem with at least one qualifying activity event; see the get_library_activity_summary() RPC in 0015_stage31_saved_library_views.sql. */
export interface ActivitySummaryRow {
  item_id: string;
  last_activity_at: string;
}

/** Stage 34 — one row per reminder rule (release or continue); see supabase/migrations/0016_stage34_reminders.sql for the CHECK constraint enforcing which columns apply to which `kind`, and the two partial unique indexes that back duplicate-create collapsing. */
export interface ReminderRow {
  id: string;
  user_id: string;
  library_item_id: string;
  kind: string;
  provider: string | null;
  external_media_id: string | null;
  episode: number | null;
  scheduled_for: string | null;
  remind_before_minutes: number | null;
  remind_at: string | null;
  dismissed_at: string | null;
  created_at: string;
  updated_at: string | null;
}

/** Stage 37 — one row per browser/device Web Push subscription; see supabase/migrations/0017_stage37_web_push.sql for the endpoint-uniqueness/ownership-transfer rule. Never select p256dh/auth_key into any client-visible state beyond the owner's own subscribe call — see lib/cloud/push-subscriptions.ts. */
export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
  label: string | null;
  created_at: string;
  last_used_at: string;
  disabled_at: string | null;
}

/** Stage 37 — the delivery/claim ledger; see supabase/migrations/0017_stage37_web_push.sql. Written only by the delivery engine and the test-notification route via the service-role admin client — never inserted/updated by a plain session client. */
export interface ReminderDeliveryRow {
  id: string;
  user_id: string;
  kind: "reminder" | "test";
  reminder_id: string | null;
  occurrence_version: string | null;
  status: "claimed" | "sent" | "failed" | "skipped";
  retryable: boolean;
  attempt_count: number;
  results: unknown;
  attempted_at: string;
  completed_at: string | null;
}

type InsertOf<Row, Required extends keyof Row> = Partial<Row> & Pick<Row, Required>;

export type LibraryItemInsert = InsertOf<LibraryItemRow, "id" | "user_id" | "type" | "title">;
export type CollectionInsert = InsertOf<CollectionRow, "id" | "user_id" | "name">;
export type CollectionItemInsert = InsertOf<CollectionItemRow, "collection_id" | "item_id" | "user_id">;
export type ActivityEventInsert = InsertOf<ActivityEventRow, "id" | "user_id" | "item_id" | "type">;
export type SavedLibraryViewInsert = InsertOf<SavedLibraryViewRow, "id" | "user_id" | "name" | "definition_version" | "definition">;
export type ReminderInsert = InsertOf<ReminderRow, "id" | "user_id" | "library_item_id" | "kind">;
