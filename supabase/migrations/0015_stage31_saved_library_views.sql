-- Stage 31: Advanced Library Discovery & Smart Views
--
-- Run this against your Supabase project (SQL Editor, or `supabase db push`
-- if you use the Supabase CLI locally) AFTER 0001-0014. Safe to re-run:
-- every statement is guarded with IF NOT EXISTS / OR REPLACE / DROP POLICY
-- IF EXISTS, matching every prior migration's convention.
--
-- Two independent, narrow additions, both required by Phase 0 inspection:
--
-- 1. saved_library_views — a Smart View is a saved QUERY (a JSONB
--    definition), never a saved list of item ids. Membership is always
--    recomputed from the definition against current library/activity
--    state (see src/lib/smart-views.ts) — this table stores nothing that
--    could go stale the way a cached item-id list would.
--
-- 2. get_library_activity_summary() — the existing activity_events table
--    already supports everything Smart Views need (progress_updated/
--    rating_updated/status_updated, scoped by user_id), but the app's
--    existing activity fetch (lib/cloud/activity.ts's fetchActivityEvents)
--    caps at 500 rows for the Recent Activity display — exactly the same
--    gap Stage 29 already found and had to work around for backup export.
--    Reusing that capped fetch (or the backup exporter's own 50,000-row
--    fetch, which downloads full event bodies just to derive one
--    timestamp) would make "Recently Active"/"Stalled" silently wrong for
--    any account with more historical activity than the fetch covers.
--    This function returns ONLY item_id + the latest qualifying
--    timestamp — never the full event history — computed server-side.

-- ============================================================
-- saved_library_views
-- ============================================================
-- The name CHECK constraints exist so the database's own uniqueness
-- guarantee actually means what the app promises: "Anime Backlog" and
-- " Anime Backlog " are the same saved view, not two. Requiring
-- `name = btrim(name)` at write time (rather than trying to make the
-- unique index itself trim-aware) means the client's own trim -- which
-- setSmartViewName already performs before ever calling upsertSavedViewRow
-- -- is enforced, not just assumed: a raw PostgREST write bypassing the
-- app is rejected outright with a normal, expected constraint violation
-- rather than silently creating a second row an app-level trim can't see.
-- The length bound mirrors lib/smart-views.ts's own
-- MAX_SMART_VIEW_NAME_LENGTH client-side validator, so a row this schema
-- accepts is always one Markly's own UI could have produced.
create table if not exists public.saved_library_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (name = btrim(name) and char_length(name) > 0 and char_length(name) <= 200),
  definition_version integer not null,
  definition jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index if not exists saved_library_views_user_id_idx on public.saved_library_views (user_id);

-- Case-insensitive per-user uniqueness, enforced in the database (not just
-- client-side) so two concurrent "Save as Smart View" calls with the same
-- name from two tabs/devices can never both succeed (Stage 31 §28/§70) —
-- the second insert/update fails with a unique_violation instead of
-- silently creating a duplicate. The CHECK constraint above guarantees
-- `name` is already trimmed, so `lower(name)` alone (no separate btrim
-- needed here) is exactly `lower(btrim(name))` for every row this table
-- can ever contain — "Anime Backlog" and " Anime Backlog " can't coexist
-- because the second write is rejected by the CHECK before uniqueness is
-- even considered.
create unique index if not exists saved_library_views_user_name_idx
  on public.saved_library_views (user_id, lower(name));

alter table public.saved_library_views enable row level security;

drop policy if exists "saved_library_views_select_own" on public.saved_library_views;
create policy "saved_library_views_select_own" on public.saved_library_views
  for select using (auth.uid() = user_id);

drop policy if exists "saved_library_views_insert_own" on public.saved_library_views;
create policy "saved_library_views_insert_own" on public.saved_library_views
  for insert with check (auth.uid() = user_id);

drop policy if exists "saved_library_views_update_own" on public.saved_library_views;
create policy "saved_library_views_update_own" on public.saved_library_views
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "saved_library_views_delete_own" on public.saved_library_views;
create policy "saved_library_views_delete_own" on public.saved_library_views
  for delete using (auth.uid() = user_id);

-- ============================================================
-- Activity summary support
-- ============================================================
-- Speeds up the (user_id, group by item_id, max(created_at)) aggregate
-- below for accounts with a large activity history. activity_events
-- already has (user_id, created_at desc) and (item_id) individually
-- (0001_stage16_core_schema.sql); this composite index is the one this
-- specific query pattern actually wants.
create index if not exists activity_events_user_item_created_idx
  on public.activity_events (user_id, item_id, created_at desc);

-- SECURITY INVOKER (the default — stated explicitly): runs as the calling
-- user, so activity_events' own existing "select own" RLS policy already
-- guarantees a caller can never see another user's rows even without the
-- redundant `where user_id = auth.uid()` below. That filter is kept
-- anyway as defense in depth and to let the planner use the new index
-- directly rather than relying solely on the RLS policy's own predicate.
-- No user_id parameter is accepted from the caller — auth.uid() is the
-- only source of identity, so a caller can never request another user's
-- summary by passing a different id.
create or replace function public.get_library_activity_summary()
returns table (item_id uuid, last_activity_at timestamptz)
language sql
security invoker
stable
set search_path = ''
as $$
  select ae.item_id, max(ae.created_at) as last_activity_at
  from public.activity_events ae
  where ae.user_id = auth.uid()
    and ae.type in ('progress_updated', 'rating_updated', 'status_updated')
  group by ae.item_id;
$$;

-- Matches every other RPC in this codebase's own convention (0004/0005/
-- 0007/0009/0010/0011/0012/0013/0014 all grant execute explicitly rather
-- than relying on Postgres's implicit PUBLIC-executable default). An
-- unauthenticated (anon) caller would see auth.uid() resolve to null,
-- making the where clause's `ae.user_id = null` comparison always false
-- (zero rows, never another user's data) even without this grant — but
-- this is scoped to `authenticated` explicitly anyway, as defense in
-- depth and for consistency with the rest of the schema.
grant execute on function public.get_library_activity_summary() to authenticated;
