-- Stage 18: Browser Extension + Auto-Tracking Foundation
--
-- Run this against your Supabase project after 0001 and 0002. Safe to
-- re-run. Do not apply to the remote database until reviewed.
--
-- Three tables:
--   extension_devices  — a paired browser extension install, identified
--                        only by a hash of its device token (never the
--                        raw token — see src/lib/extension/tokens.ts).
--   pairing_codes      — short-lived, one-time codes used to hand a new
--                        device its token; also stored hashed.
--   tracking_sources   — the persistent mapping from one adapter+site
--                        identity (e.g. novelphoenix/lord-of-mysteries)
--                        to at most one of the user's LibraryItems.
--                        Detected-but-unlinked sources are also rows
--                        here (library_item_id null) so the Auto
--                        Tracking settings page can show "needs linking"
--                        without a separate table.

-- ============================================================
-- extension_devices
-- ============================================================
create table if not exists public.extension_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'Browser Extension',
  token_hash text not null unique,
  browser text,
  extension_version text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create index if not exists extension_devices_user_id_idx on public.extension_devices (user_id);

alter table public.extension_devices enable row level security;

drop policy if exists "extension_devices_select_own" on public.extension_devices;
create policy "extension_devices_select_own" on public.extension_devices
  for select using (auth.uid() = user_id);

-- No insert policy for normal (session-authenticated) callers: a device
-- row is only ever created by /api/extension/pair, which runs under the
-- server-only admin client after independently verifying a pairing code
-- — RLS is irrelevant to that path (the admin client bypasses it by
-- design; see src/lib/supabase/admin.ts), and no legitimate signed-in
-- request should be creating device rows directly.

drop policy if exists "extension_devices_update_own" on public.extension_devices;
create policy "extension_devices_update_own" on public.extension_devices
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "extension_devices_delete_own" on public.extension_devices;
create policy "extension_devices_delete_own" on public.extension_devices
  for delete using (auth.uid() = user_id);

-- ============================================================
-- pairing_codes
-- ============================================================
create table if not exists public.pairing_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists pairing_codes_user_id_idx on public.pairing_codes (user_id);

alter table public.pairing_codes enable row level security;

drop policy if exists "pairing_codes_select_own" on public.pairing_codes;
create policy "pairing_codes_select_own" on public.pairing_codes
  for select using (auth.uid() = user_id);

drop policy if exists "pairing_codes_insert_own" on public.pairing_codes;
create policy "pairing_codes_insert_own" on public.pairing_codes
  for insert with check (auth.uid() = user_id);

-- No update/delete policy: only /api/extension/pair ever consumes
-- (marks used_at on) a code, via the server-only admin client — a
-- pairing code is never meant to be editable by ordinary authenticated
-- requests, only creatable (to generate one) and readable (to show it
-- was created).

-- ============================================================
-- tracking_sources
-- ============================================================
create table if not exists public.tracking_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  library_item_id uuid references public.library_items (id) on delete set null,
  adapter_id text not null,
  source_key text not null,
  source_title text not null,
  source_url text,
  -- The media type this source was detected as (e.g. 'novel'). Persisted
  -- so the "Link Item" picker in Settings can offer only compatible
  -- LibraryItem types even before a link exists — see requirement that a
  -- Novel source must never be linkable to an Anime item.
  media_type text not null check (media_type in ('anime', 'manga', 'novel', 'game', 'movie', 'series')),
  auto_track_enabled boolean not null default true,
  last_detected_progress jsonb,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, adapter_id, source_key)
);

create index if not exists tracking_sources_user_id_idx on public.tracking_sources (user_id);
create index if not exists tracking_sources_library_item_id_idx on public.tracking_sources (library_item_id);

alter table public.tracking_sources enable row level security;

drop policy if exists "tracking_sources_select_own" on public.tracking_sources;
create policy "tracking_sources_select_own" on public.tracking_sources
  for select using (auth.uid() = user_id);

-- Mirrors collection_items' WITH CHECK pattern from 0001: a link to
-- library_item_id is only accepted if that item is *also* owned by the
-- same authenticated user — closing the same class of IDOR a plain
-- ownership-of-this-row check would miss.
drop policy if exists "tracking_sources_insert_own" on public.tracking_sources;
create policy "tracking_sources_insert_own" on public.tracking_sources
  for insert with check (
    auth.uid() = user_id
    and (
      library_item_id is null
      or exists (select 1 from public.library_items li where li.id = library_item_id and li.user_id = auth.uid())
    )
  );

drop policy if exists "tracking_sources_update_own" on public.tracking_sources;
create policy "tracking_sources_update_own" on public.tracking_sources
  for update using (auth.uid() = user_id) with check (
    auth.uid() = user_id
    and (
      library_item_id is null
      or exists (select 1 from public.library_items li where li.id = library_item_id and li.user_id = auth.uid())
    )
  );

drop policy if exists "tracking_sources_delete_own" on public.tracking_sources;
create policy "tracking_sources_delete_own" on public.tracking_sources
  for delete using (auth.uid() = user_id);
