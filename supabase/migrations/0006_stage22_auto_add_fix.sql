-- Stage 22 fix: auto_add_and_link_source failed at runtime with
--   ERROR 42883: function max(uuid) does not exist
--
-- 0005 already deployed successfully (DDL is valid, the function body is
-- only checked at parse time for gross syntax, not per-statement type
-- resolution against every possible call) — the bug only surfaces when the
-- function actually executes and reaches:
--
--   select count(*), max(id) into v_match_count, v_existing_id
--   from public.library_items
--   where ...
--
-- library_items.id is `uuid`. PostgreSQL has no built-in MAX(uuid)/MIN(uuid)
-- aggregate (uuid supports ordering comparison operators, but no default
-- aggregate wiring for max/min the way numeric/text/timestamp types get) —
-- so this line fails with "function max(uuid) does not exist" on every
-- real call that gets past the two locks and reaches the exact-match
-- recheck, which is every no_match auto-add attempt. This is exactly why
-- it deployed fine but failed on every real invocation.
--
-- Fix: replace max(id) with (array_agg(id))[1] — array_agg works for any
-- type, needs no ordering operator, and since this is only read when
-- v_match_count = 1 (the only branch that uses v_existing_id for a
-- single-match link), which element of the array is irrelevant when there
-- is only one. Nothing else about the function changes: same two locks
-- (tracking_sources row lock, then the advisory lock keyed on
-- (user, media type, normalized title)), same insert, same activity event,
-- same return contract.
--
-- 0001-0005 are untouched. Do not apply this remotely yourself — run
-- `npx.cmd supabase db push` after review.
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

  -- Fixed: (array_agg(id))[1] instead of max(id) — see the migration's own
  -- header comment above for why max(uuid) doesn't exist.
  select count(*), (array_agg(id))[1] into v_match_count, v_existing_id
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

  insert into public.activity_events (user_id, item_id, type, data, created_at)
  values (p_user_id, v_item_id, 'item_added', '{}'::jsonb, v_now);

  return jsonb_build_object('status', 'created', 'libraryItemId', v_item_id);
end;
$$;

-- Same grants as 0005 — CREATE OR REPLACE does not reset these on its own
-- in every Postgres version, so they're restated explicitly rather than
-- assumed to survive.
revoke all on function public.auto_add_and_link_source(uuid, uuid, text, jsonb) from public;
revoke all on function public.auto_add_and_link_source(uuid, uuid, text, jsonb) from anon, authenticated;
grant execute on function public.auto_add_and_link_source(uuid, uuid, text, jsonb) to service_role;
