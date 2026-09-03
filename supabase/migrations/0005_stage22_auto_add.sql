-- Stage 22: Optional zero-touch auto-add.
--
-- Run this against your Supabase project after 0001-0004. Safe to re-run:
-- the column add is IF NOT EXISTS, the function is `create or replace`, and
-- the grant/revoke statements are idempotent. Do not apply this remotely
-- until reviewed.
--
-- ============================================================
-- Why this exists
-- ============================================================
-- Today, a detected work with no existing LibraryItem match always returns
-- "needs_link" — the user must open Settings and click "Add & Track"
-- themselves (Stage 20/21). Stage 22 adds an opt-in, device-level
-- preference that, when a detection confidently matches nothing in the
-- user's library, creates the LibraryItem and links it automatically
-- instead of waiting for that click. Default is OFF; enabling it never
-- affects any source that's already linked.
--
-- ============================================================
-- auto_add_enabled
-- ============================================================
-- Device-level, not account-level: extension_devices already exists 1:1
-- per paired browser install, and every request is already authenticated
-- to a specific device (see authenticateDevice in
-- src/lib/extension/devices.ts) — no new trust surface is needed to read
-- this column. Device-level also matches the stated use case directly
-- ("enabled on one browser, not another"), and avoids introducing a
-- generic account-preferences table for a single boolean.
alter table public.extension_devices
  add column if not exists auto_add_enabled boolean not null default false;

-- ============================================================
-- normalize_title_for_matching
-- ============================================================
-- SQL mirror of normalizeTitleForMatching (src/lib/extension/auto-link.ts)
-- — same fold order: NFKC normalize, curly single/double quotes and dash
-- variants to their plain ASCII equivalents, lowercase, trim, collapse
-- internal whitespace. Unicode punctuation is referenced via chr() code
-- points rather than literal characters so this function's behavior does
-- not depend on the migration file's own encoding being preserved
-- end-to-end by every tool that might touch it. Keep both implementations
-- in sync if either changes — this one is used only by
-- auto_add_and_link_source below, as a second, lock-protected check; it is
-- never a replacement for attemptSmartAutoLink's own (unlocked, first)
-- check in application code.
create or replace function public.normalize_title_for_matching(p_title text)
returns text
language sql
immutable
as $func$
  select regexp_replace(
    trim(
      lower(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              normalize(p_title, nfkc),
              '[' || chr(8216) || chr(8217) || chr(8219) || ']', '''', 'g'
            ),
            '[' || chr(8220) || chr(8221) || chr(8223) || ']', '"', 'g'
          ),
          '[' || chr(8210) || chr(8211) || chr(8212) || chr(8213) || ']', '-', 'g'
        )
      )
    ),
    '\s+', ' ', 'g'
  )
$func$;

revoke all on function public.normalize_title_for_matching(text) from public;
revoke all on function public.normalize_title_for_matching(text) from anon, authenticated;
grant execute on function public.normalize_title_for_matching(text) to service_role;

-- ============================================================
-- auto_add_and_link_source
-- ============================================================
-- Atomically creates exactly one LibraryItem for a brand-new detected
-- source and links it, or discovers that it doesn't need to (another
-- concurrent request already did, or an exact match now exists) — never
-- both. Two locks, for two different races:
--
--   1. `select ... for update` on the tracking_sources row — serializes
--      concurrent requests for the SAME source (retries, multiple tabs on
--      the same chapter, a reload storm). Mirrors apply_extension_progress
--      (0004) exactly: the second concurrent caller blocks here, then
--      observes library_item_id already set and returns "already_linked"
--      instead of creating a second item.
--
--   2. pg_advisory_xact_lock, keyed on (user, media type, normalized
--      title) — serializes concurrent requests for DIFFERENT sources that
--      happen to name the exact same work (e.g. two tabs open on two
--      different first-ever chapters of the same novel on two different
--      sites, at the same instant). Without this, both could pass their
--      own tracking_sources row-lock (different rows), both see "no
--      existing match", and both create a duplicate item. Held for the
--      rest of the transaction; released automatically at commit/rollback.
--      After acquiring it, library_items is re-checked for an exact
--      normalized-title match one more time — a concurrent auto-add for
--      the same title may have committed between this call starting and
--      the lock being acquired.
--
-- p_row carries every LibraryItem column this needs to set beyond
-- user_id/type/id/created_at (which this function supplies itself) as one
-- jsonb blob shaped like LibraryItemInsert (src/lib/supabase/
-- database.types.ts) — built by the caller via the existing
-- createMediaItem + toLibraryItemRow (src/lib/extension/auto-add.ts),
-- reusing 100% of Stage 20/21's field-building logic (readingFormat
-- suggestion, detected-metadata fill, initial status/progress) rather than
-- duplicating any of it here.
create or replace function public.auto_add_and_link_source(
  p_user_id uuid,
  p_source_id uuid,
  p_media_type text,
  p_row jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_source public.tracking_sources%rowtype;
  v_title text;
  v_normalized text;
  v_match_count int;
  v_existing_id uuid;
  v_item_id uuid;
  v_now timestamptz := now();
begin
  v_title := p_row->>'title';
  if v_title is null or btrim(v_title) = '' then
    return jsonb_build_object('status', 'invalid_title');
  end if;

  select * into v_source
  from public.tracking_sources
  where id = p_source_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('status', 'source_not_found');
  end if;

  if v_source.library_item_id is not null then
    return jsonb_build_object('status', 'already_linked', 'libraryItemId', v_source.library_item_id);
  end if;

  v_normalized := public.normalize_title_for_matching(v_title);

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || '|' || p_media_type || '|' || v_normalized, 0));

  select count(*), max(id) into v_match_count, v_existing_id
  from public.library_items
  where user_id = p_user_id
    and type = p_media_type
    and public.normalize_title_for_matching(title) = v_normalized;

  if v_match_count = 1 then
    update public.tracking_sources
    set library_item_id = v_existing_id, updated_at = v_now
    where id = p_source_id and user_id = p_user_id;
    return jsonb_build_object('status', 'linked_existing', 'libraryItemId', v_existing_id);
  elsif v_match_count > 1 then
    -- Ambiguous: never guess, never create a third item. The caller falls
    -- back to needs_link, exactly as if auto-add were off.
    return jsonb_build_object('status', 'ambiguous');
  end if;

  insert into public.library_items (
    user_id, type, title, description, category, tags, favorite,
    image_url, source_url, status, rating, metadata, created_at
  )
  values (
    p_user_id,
    p_media_type,
    v_title,
    coalesce(p_row->>'description', ''),
    coalesce(p_row->>'category', ''),
    coalesce(
      (select array_agg(value) from jsonb_array_elements_text(coalesce(p_row->'tags', '[]'::jsonb))),
      '{}'::text[]
    ),
    coalesce((p_row->>'favorite')::boolean, false),
    p_row->>'image_url',
    p_row->>'source_url',
    p_row->>'status',
    (p_row->>'rating')::numeric,
    coalesce(p_row->'metadata', '{}'::jsonb),
    v_now
  )
  returning id into v_item_id;

  update public.tracking_sources
  set library_item_id = v_item_id, updated_at = v_now
  where id = p_source_id and user_id = p_user_id;

  -- Same shape as every other creation path's item_added event (see
  -- toActivityEventRow in src/lib/cloud/activity.ts) — item_added has no
  -- `source`/provenance field for any creation path today (catalog search,
  -- manual entry, AniList import, or Stage 20's detected-work fallback all
  -- look identical in Activity), so this doesn't invent one just for
  -- auto-add. The one-time "Added to Markly" popup moment is served by the
  -- API response's autoAdded flag instead (see route.ts), not by anything
  -- persisted here.
  insert into public.activity_events (user_id, item_id, type, data, created_at)
  values (p_user_id, v_item_id, 'item_added', '{}'::jsonb, v_now);

  return jsonb_build_object('status', 'created', 'libraryItemId', v_item_id);
end;
$$;

-- SECURITY INVOKER, same reasoning as 0004's apply_extension_progress:
-- this function does not itself bypass RLS. It's only ever called through
-- the server-only admin client (SUPABASE_SECRET_KEY), whose underlying
-- service_role already bypasses RLS the same way it does for every other
-- admin-client query — this function grants no new capability on its own,
-- and is locked down below anyway for defense in depth.
revoke all on function public.auto_add_and_link_source(uuid, uuid, text, jsonb) from public;
revoke all on function public.auto_add_and_link_source(uuid, uuid, text, jsonb) from anon, authenticated;
grant execute on function public.auto_add_and_link_source(uuid, uuid, text, jsonb) to service_role;
