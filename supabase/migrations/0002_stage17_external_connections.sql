-- Stage 17: Connected Accounts + AniList Import/Sync
--
-- Run this against your Supabase project (SQL Editor, or `supabase db push`)
-- after 0001_stage16_core_schema.sql. Safe to re-run.
--
-- Provider-neutral table: only "anilist" is used today, but the shape
-- (provider text + provider_user_id/username + encrypted token + status)
-- is deliberately generic so a future Trakt/Steam connection reuses the
-- same table rather than getting one of its own.
--
-- No provider token is ever stored in plaintext. `token_ciphertext` holds a
-- self-describing AES-256-GCM envelope ("v1.<iv>.<authTag>.<ciphertext>",
-- all base64) produced by src/lib/integrations/crypto.ts — decryption only
-- ever happens inside a server-side route using
-- MARKLY_INTEGRATION_ENCRYPTION_KEY, which this database never has access
-- to. RLS on this table protects *row* access (one user can't see another
-- user's row); it does not and cannot make the ciphertext itself meaningful
-- to a browser — that property comes from the encryption key never leaving
-- the server.
create table if not exists public.external_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('anilist')),
  provider_user_id text not null,
  provider_username text not null,
  token_ciphertext text not null,
  -- AniList tokens are long-lived (~1 year) but do expire, with no refresh
  -- token — this is set from the token response's actual expires_in, not a
  -- hardcoded assumption, and reconnection is required once it lapses.
  token_expires_at timestamptz,
  connection_status text not null default 'connected' check (connection_status in ('connected', 'reconnect_required')),
  last_synced_at timestamptz,
  -- Small, provider-specific extras that don't warrant their own columns
  -- (e.g. AniList's numeric mediaListOptions aren't needed since scores are
  -- requested in a forced format — reserved for future provider metadata).
  provider_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create index if not exists external_connections_user_id_idx on public.external_connections (user_id);

alter table public.external_connections enable row level security;

drop policy if exists "external_connections_select_own" on public.external_connections;
create policy "external_connections_select_own" on public.external_connections
  for select using (auth.uid() = user_id);

drop policy if exists "external_connections_insert_own" on public.external_connections;
create policy "external_connections_insert_own" on public.external_connections
  for insert with check (auth.uid() = user_id);

drop policy if exists "external_connections_update_own" on public.external_connections;
create policy "external_connections_update_own" on public.external_connections
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "external_connections_delete_own" on public.external_connections;
create policy "external_connections_delete_own" on public.external_connections
  for delete using (auth.uid() = user_id);
