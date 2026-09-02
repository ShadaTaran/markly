-- Stage 18 fix: concurrency-safe auto-tracking progress application.
--
-- Run this against your Supabase project after 0001, 0002, and 0003 (0003
-- has already been applied to the real project — this migration does not
-- touch anything it created). Safe to re-run: the function is `create or
-- replace`, and the grant/revoke statements are idempotent.
--
-- ============================================================
-- Why this exists
-- ============================================================
-- /api/extension/progress previously read a LibraryItem, compared its
-- progress value in application code, and (if it advanced) wrote the new
-- value and inserted Activity events as separate, unlocked steps. Under
-- concurrency (the extension retrying, a duplicate detection racing a
-- fresh one, or simply two requests landing close together) two requests
-- could both read the same pre-update row, both independently conclude
-- "this advances progress", and both write — converging on the same
-- correct final LibraryItem value, but each inserting its own
-- progress_updated (and, on a first detection, status_updated) Activity
-- row. The LibraryItem looked right; Activity history did not.
--
-- Extension-side dedup (the service worker's lastSentValue map) only
-- reduces how often this is *triggered* — it cannot make two already-
-- in-flight server requests safe, and says nothing about two separate
-- server instances. Correctness has to live in the database.
--
-- ============================================================
-- The fix
-- ============================================================
-- apply_extension_progress() does the read, the compare, the LibraryItem
-- write, and the Activity insert(s) as one function call — i.e. one
-- Postgres transaction — locking the target row with `select ... for
-- update` before reading it. A second concurrent call for the same
-- LibraryItem blocks at that select until the first call's transaction
-- commits; when it then runs, it observes the *already-updated* row, so
-- an identical duplicate correctly resolves to "unchanged" and inserts
-- nothing. Only the request that actually observes and wins the
-- compare-and-set ever inserts Activity rows. This is what makes 2, 5, or
-- 20 concurrent identical requests collapse into exactly one write and
-- one Activity event, regardless of how many application server
-- instances are running.
create or replace function public.apply_extension_progress(
  p_user_id uuid,
  p_item_id uuid,
  p_media_type text,
  p_progress_field text,
  p_progress_kind text,
  p_new_value numeric
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.library_items%rowtype;
  v_current_value numeric;
  v_progress_unit text;
  v_previous_status text;
  v_new_status text;
  v_new_metadata jsonb;
  v_now timestamptz := now();
  v_status_changed boolean := false;
begin
  if p_progress_field not in ('currentEpisode', 'currentChapter', 'progressValue', 'playtimeHours') then
    raise exception 'apply_extension_progress: invalid progress field %', p_progress_field;
  end if;

  -- Row lock: a second concurrent call for the same item blocks here
  -- until this transaction commits or rolls back, then observes whatever
  -- this call left behind rather than the pre-update state.
  select * into v_row
  from public.library_items
  where id = p_item_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('status', 'item_not_found');
  end if;

  if v_row.type <> p_media_type then
    return jsonb_build_object('status', 'incompatible_media_type');
  end if;

  -- A novel's progress unit, once set, is fixed — mirrors the original
  -- application-level rule that auto-tracking must not silently switch
  -- e.g. an item tracked by page count into chapters.
  if p_progress_field = 'progressValue' then
    v_progress_unit := v_row.metadata->>'progressUnit';
    if v_progress_unit is not null and v_progress_unit <> p_progress_kind then
      return jsonb_build_object('status', 'incompatible_media_type');
    end if;
  end if;

  v_current_value := coalesce((v_row.metadata->>p_progress_field)::numeric, 0);

  if p_new_value < v_current_value then
    return jsonb_build_object('status', 'behind_current_progress', 'currentValue', v_current_value);
  end if;

  if p_new_value = v_current_value then
    return jsonb_build_object('status', 'unchanged', 'currentValue', v_current_value);
  end if;

  -- This call wins the compare-and-set: build the new metadata/status and
  -- write. Everything from here to the end of the function is part of the
  -- same transaction that holds the row lock above.
  v_new_metadata := jsonb_set(v_row.metadata, array[p_progress_field], to_jsonb(p_new_value), true);
  if p_progress_field = 'progressValue' and v_progress_unit is null then
    v_new_metadata := jsonb_set(v_new_metadata, array['progressUnit'], to_jsonb(p_progress_kind), true);
  end if;

  v_previous_status := v_row.status;
  v_new_status := v_previous_status;
  -- Mirrors autoAdvanceStatus() in src/lib/tracking.ts: only a real
  -- 0 -> positive transition on a 'planned' item auto-advances.
  if v_previous_status = 'planned' and v_current_value = 0 and p_new_value > 0 then
    v_new_status := 'in_progress';
  end if;

  update public.library_items
  set metadata = v_new_metadata,
      status = v_new_status,
      updated_at = v_now
  where id = p_item_id and user_id = p_user_id;

  insert into public.activity_events (user_id, item_id, type, data, created_at)
  values (
    p_user_id,
    p_item_id,
    'progress_updated',
    jsonb_build_object(
      'progressKind', p_progress_kind,
      'previousValue', v_current_value,
      'newValue', p_new_value,
      'source', 'browser_extension'
    ),
    v_now
  );

  if v_new_status <> v_previous_status then
    insert into public.activity_events (user_id, item_id, type, data, created_at)
    values (
      p_user_id,
      p_item_id,
      'status_updated',
      jsonb_build_object(
        'previousValue', v_previous_status,
        'newValue', v_new_status,
        'source', 'browser_extension'
      ),
      v_now
    );
    v_status_changed := true;
  end if;

  return jsonb_build_object('status', 'updated', 'currentValue', p_new_value, 'statusChanged', v_status_changed);
end;
$$;

-- SECURITY INVOKER (the default, stated explicitly) — this function does
-- not bypass Row Level Security on its own. /api/extension/progress calls
-- it only through the server-only admin client (src/lib/supabase/admin.ts,
-- SUPABASE_SECRET_KEY), whose underlying role already bypasses RLS the
-- same way it does for every other admin-client query; a hypothetical
-- authenticated caller invoking this RPC directly would still be bound by
-- the existing library_items/activity_events RLS policies, not granted
-- any new capability by this function. Locked down further below anyway,
-- matching this project's habit of not relying on convention alone for an
-- access boundary (see chrome.storage.local's explicit TRUSTED_CONTEXTS
-- restriction for the same philosophy).
revoke all on function public.apply_extension_progress(uuid, uuid, text, text, text, numeric) from public;
revoke all on function public.apply_extension_progress(uuid, uuid, text, text, text, numeric) from anon, authenticated;
grant execute on function public.apply_extension_progress(uuid, uuid, text, text, text, numeric) to service_role;
