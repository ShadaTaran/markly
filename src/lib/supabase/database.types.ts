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

type InsertOf<Row, Required extends keyof Row> = Partial<Row> & Pick<Row, Required>;

export type LibraryItemInsert = InsertOf<LibraryItemRow, "id" | "user_id" | "type" | "title">;
export type CollectionInsert = InsertOf<CollectionRow, "id" | "user_id" | "name">;
export type CollectionItemInsert = InsertOf<CollectionItemRow, "collection_id" | "item_id" | "user_id">;
export type ActivityEventInsert = InsertOf<ActivityEventRow, "id" | "user_id" | "item_id" | "type">;
