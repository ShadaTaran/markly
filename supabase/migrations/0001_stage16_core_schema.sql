-- Stage 16: Auth + Database + Cloud Sync Foundation
--
-- Run this against your Supabase project (SQL Editor, or `supabase db push`
-- if you use the Supabase CLI locally). It is safe to re-run: every
-- statement is guarded with IF NOT EXISTS / OR REPLACE / DROP POLICY IF
-- EXISTS.
--
-- There is deliberately no `profiles` table. Markly has no profile
-- customization (avatars, usernames, bios) in this stage, so `auth.users.id`
-- is a sufficient foreign-key target on its own — adding an empty mirror
-- table plus a sync trigger would be schema for its own sake.

-- ============================================================
-- library_items
-- ============================================================
-- Common, frequently-filtered/sorted columns are real columns (status,
-- rating, favorite, category, tags, title, description — exactly what the
-- app already filters, sorts, and aggregates on). Sparse, type-specific and
-- catalog fields (progress numbers, genres, authors, studio, developer,
-- catalogSource, ...) live in `metadata` as JSONB rather than as dozens of
-- mostly-null columns, one set of which only ever applies to a single type.
create table if not exists public.library_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (
    type in ('website', 'anime', 'manga', 'novel', 'game', 'movie', 'series', 'article', 'video', 'other')
  ),
  title text not null,
  description text not null default '',
  category text not null default '',
  tags text[] not null default '{}',
  favorite boolean not null default false,
  image_url text,
  source_url text,
  url text,
  status text check (status in ('planned', 'in_progress', 'completed', 'on_hold', 'dropped')),
  rating numeric check (rating is null or (rating >= 1 and rating <= 10)),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index if not exists library_items_user_id_idx on public.library_items (user_id);
create index if not exists library_items_user_type_idx on public.library_items (user_id, type);

alter table public.library_items enable row level security;

drop policy if exists "library_items_select_own" on public.library_items;
create policy "library_items_select_own" on public.library_items
  for select using (auth.uid() = user_id);

drop policy if exists "library_items_insert_own" on public.library_items;
create policy "library_items_insert_own" on public.library_items
  for insert with check (auth.uid() = user_id);

drop policy if exists "library_items_update_own" on public.library_items;
create policy "library_items_update_own" on public.library_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "library_items_delete_own" on public.library_items;
create policy "library_items_delete_own" on public.library_items
  for delete using (auth.uid() = user_id);

-- ============================================================
-- collections
-- ============================================================
create table if not exists public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index if not exists collections_user_id_idx on public.collections (user_id);

alter table public.collections enable row level security;

drop policy if exists "collections_select_own" on public.collections;
create policy "collections_select_own" on public.collections
  for select using (auth.uid() = user_id);

drop policy if exists "collections_insert_own" on public.collections;
create policy "collections_insert_own" on public.collections
  for insert with check (auth.uid() = user_id);

drop policy if exists "collections_update_own" on public.collections;
create policy "collections_update_own" on public.collections
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "collections_delete_own" on public.collections;
create policy "collections_delete_own" on public.collections
  for delete using (auth.uid() = user_id);

-- ============================================================
-- collection_items (join table — never duplicates LibraryItem data)
-- ============================================================
-- user_id is denormalized onto the join row (rather than derived only via
-- the collections/library_items FKs) specifically so RLS can enforce, at
-- insert time, that the caller owns *both* the collection and the item
-- being linked — not just that they own one of the two. Without that check
-- a caller could link their own item into someone else's collection_id (or
-- vice versa) as long as the collection_id/item_id values were guessable,
-- which plain ownership-of-the-join-row RLS would not catch.
create table if not exists public.collection_items (
  collection_id uuid not null references public.collections (id) on delete cascade,
  item_id uuid not null references public.library_items (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (collection_id, item_id)
);

create index if not exists collection_items_user_id_idx on public.collection_items (user_id);
create index if not exists collection_items_item_id_idx on public.collection_items (item_id);

alter table public.collection_items enable row level security;

drop policy if exists "collection_items_select_own" on public.collection_items;
create policy "collection_items_select_own" on public.collection_items
  for select using (auth.uid() = user_id);

drop policy if exists "collection_items_insert_own" on public.collection_items;
create policy "collection_items_insert_own" on public.collection_items
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.collections c where c.id = collection_id and c.user_id = auth.uid())
    and exists (select 1 from public.library_items li where li.id = item_id and li.user_id = auth.uid())
  );

drop policy if exists "collection_items_delete_own" on public.collection_items;
create policy "collection_items_delete_own" on public.collection_items
  for delete using (auth.uid() = user_id);

-- ============================================================
-- activity_events
-- ============================================================
-- `data` holds the 2-4 fields that vary by event type (progressKind, the
-- previous/new numeric or status value) — a narrow JSONB payload rather
-- than a handful of nullable typed columns, for the same reason as
-- library_items.metadata above. Events never store a copy of the item.
create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id uuid not null references public.library_items (id) on delete cascade,
  type text not null check (type in ('progress_updated', 'rating_updated', 'status_updated', 'item_added')),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activity_events_user_id_idx on public.activity_events (user_id, created_at desc);
create index if not exists activity_events_item_id_idx on public.activity_events (item_id);

alter table public.activity_events enable row level security;

drop policy if exists "activity_events_select_own" on public.activity_events;
create policy "activity_events_select_own" on public.activity_events
  for select using (auth.uid() = user_id);

drop policy if exists "activity_events_insert_own" on public.activity_events;
create policy "activity_events_insert_own" on public.activity_events
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.library_items li where li.id = item_id and li.user_id = auth.uid())
  );

drop policy if exists "activity_events_delete_own" on public.activity_events;
create policy "activity_events_delete_own" on public.activity_events
  for delete using (auth.uid() = user_id);

-- No update policy for activity_events: events are append-only/delete-only
-- in this app (nothing ever edits a past event in place).
