-- Stage 28: destructive action recovery & undo.
--
-- Run this against your Supabase project after 0001-0009 (all already
-- applied — 0009 in particular is DEPLOYED and IMMUTABLE; this migration
-- never edits it, only layers a `create or replace` of the same function
-- name/signature on top, exactly the same precedent 0006 already set for
-- 0005). Safe to re-run.
--
-- ============================================================
-- Why this exists
-- ============================================================
-- Delete and Merge are Markly's two genuinely destructive LibraryItem
-- actions. Stage 28 gives both a short-lived, transactional Undo: the
-- recovery snapshot is captured in the SAME transaction as the
-- destructive write (never "delete, then separately try to remember what
-- was deleted" — a crash or network failure between those two steps
-- would make recovery impossible), and every Undo re-validates the
-- current, live database state before touching anything, so it can never
-- silently erase progress that arrived after the original action (see
-- README "Destructive Action Recovery & Undo" for the exact scenarios
-- this protects: a TrackingSource reclaimed by another item, or a
-- browser progress commit that landed on the survivor after a merge).
--
-- ============================================================
-- library_recovery_actions
-- ============================================================
-- Deliberately narrow — only two action_types, only what Delete/Merge
-- actually need to reverse themselves. Not a generic command log, not
-- event sourcing, not a permanent trash: `expires_at` bounds every row's
-- useful life to 15 minutes, and a successful Undo deletes its own row
-- (so "does this row still exist" is the entire double-undo guard — no
-- separate consumed flag needed). No cron/background worker: expired rows
-- are opportunistically deleted by the next real request that touches
-- this user's recovery rows (creating a new one, or attempting an undo);
-- until then they simply can't be restored (expires_at is checked before
-- ever acting on one), and the client's own list query filters them out
-- by not asking for anything past expires_at.
create table if not exists public.library_recovery_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  action_type text not null check (action_type in ('delete_item', 'merge_items')),
  -- Never contains tokens/secrets/credentials — payload is built entirely
  -- from library_items/collection_items/activity_events/tracking_sources
  -- rows already owned by this user (and tracking_sources itself has no
  -- credential columns to begin with — verified against 0003: adapter_id,
  -- source_key, source_title, source_url, media_type, auto_track_enabled,
  -- last_detected_progress, last_seen_at, auto_link_suppressed_at — all
  -- already user-visible data, nothing extension-auth-related).
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists library_recovery_actions_user_expiry_idx on public.library_recovery_actions (user_id, expires_at);

alter table public.library_recovery_actions enable row level security;

drop policy if exists "library_recovery_actions_select_own" on public.library_recovery_actions;
create policy "library_recovery_actions_select_own" on public.library_recovery_actions
  for select using (auth.uid() = user_id);

-- Needed so the security-invoker RPCs below (running as the calling user,
-- not a superuser) can actually write this table themselves — a direct
-- client insert of a well-formed-but-fabricated row is harmless: Undo
-- re-validates everything against live state regardless of what the
-- payload claims, so a fabricated recovery row can only ever "restore"
-- something that's already independently re-verified as safe, never
-- forge access to another user's data (every check below is itself
-- auth.uid()-scoped).
drop policy if exists "library_recovery_actions_insert_own" on public.library_recovery_actions;
create policy "library_recovery_actions_insert_own" on public.library_recovery_actions
  for insert with check (auth.uid() = user_id);

drop policy if exists "library_recovery_actions_delete_own" on public.library_recovery_actions;
create policy "library_recovery_actions_delete_own" on public.library_recovery_actions
  for delete using (auth.uid() = user_id);

-- No update policy — a recovery row is either fully present (usable) or
-- fully gone (consumed/expired); nothing ever partially edits one.

revoke all on table public.library_recovery_actions from public;

-- ============================================================
-- delete_library_item_with_recovery
-- ============================================================
-- One transaction: lock the item, snapshot everything Delete would
-- otherwise destroy (the item row itself; collection_items and
-- activity_events, which CASCADE away — see 0001; the ids of any
-- tracking_sources currently pointing at it, which instead SET NULL —
-- see 0003), record the recovery action, then perform the actual delete.
-- tracking_sources rows themselves are never touched here — Stage 18's
-- ON DELETE SET NULL already does exactly the right thing on its own.
create or replace function public.delete_library_item_with_recovery(
  p_item_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_item public.library_items%rowtype;
  v_collection_ids jsonb;
  v_activity jsonb;
  v_source_ids jsonb;
  v_recovery_id uuid;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  -- Opportunistic cleanup of this user's own expired recovery rows —
  -- piggybacked on a real request rather than any scheduled job.
  delete from public.library_recovery_actions where user_id = v_uid and expires_at < v_now;

  select * into v_item from public.library_items where id = p_item_id and user_id = v_uid for update;
  if v_item.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  select coalesce(jsonb_agg(collection_id), '[]'::jsonb) into v_collection_ids
  from public.collection_items where item_id = p_item_id and user_id = v_uid;

  select coalesce(jsonb_agg(to_jsonb(ae)), '[]'::jsonb) into v_activity
  from public.activity_events ae where ae.item_id = p_item_id and ae.user_id = v_uid;

  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_source_ids
  from public.tracking_sources where library_item_id = p_item_id and user_id = v_uid;

  v_recovery_id := gen_random_uuid();
  insert into public.library_recovery_actions (id, user_id, action_type, payload, created_at, expires_at)
  values (
    v_recovery_id,
    v_uid,
    'delete_item',
    jsonb_build_object(
      'item', to_jsonb(v_item),
      'collectionIds', v_collection_ids,
      'activityEvents', v_activity,
      'sourceIds', v_source_ids
    ),
    v_now,
    v_now + interval '15 minutes'
  );

  delete from public.library_items where id = p_item_id and user_id = v_uid;

  return jsonb_build_object('status', 'deleted', 'recoveryId', v_recovery_id);
end;
$$;

revoke all on function public.delete_library_item_with_recovery(uuid) from public;
grant execute on function public.delete_library_item_with_recovery(uuid) to authenticated;

-- ============================================================
-- merge_library_items — re-defined (same signature, same call sites,
-- same client contract) to additionally capture a recovery snapshot in
-- the same transaction as the merge. Every 0009 behavior is preserved
-- verbatim: field-merge trust boundary (client-computed non-progress
-- fields, server-recomputed progress fields), lexicographic seasonal
-- comparison, numbering/progress-unit/catalog-source conflict blocking,
-- tracking_sources/collection_items/activity_events transfer mechanics,
-- deterministic uuid lock ordering, ownership via auth.uid(), same-item
-- and type-mismatch rejection. Only genuinely new: the recovery insert,
-- and returning `recoveryId` alongside the existing response shape.
-- ============================================================
create or replace function public.merge_library_items(
  p_survivor_id uuid,
  p_duplicate_id uuid,
  p_merged_row jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_first public.library_items%rowtype;
  v_second public.library_items%rowtype;
  v_survivor public.library_items%rowtype;
  v_duplicate public.library_items%rowtype;
  v_now timestamptz := now();
  v_final_metadata jsonb;
  v_numbering_survivor text;
  v_numbering_duplicate text;
  v_season_survivor numeric;
  v_season_duplicate numeric;
  v_episode_survivor numeric;
  v_episode_duplicate numeric;
  v_unit_survivor text;
  v_unit_duplicate text;
  v_catalog_survivor jsonb;
  v_catalog_duplicate jsonb;
  -- Stage 28 additions
  v_survivor_collection_ids jsonb;
  v_duplicate_collection_ids jsonb;
  v_moved_source_ids jsonb;
  v_moved_activity_ids jsonb;
  v_survivor_after public.library_items%rowtype;
  v_recovery_id uuid;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  delete from public.library_recovery_actions where user_id = v_uid and expires_at < v_now;

  if p_survivor_id = p_duplicate_id then
    return jsonb_build_object('status', 'same_item');
  end if;

  if p_survivor_id < p_duplicate_id then
    select * into v_first from public.library_items where id = p_survivor_id and user_id = v_uid for update;
    select * into v_second from public.library_items where id = p_duplicate_id and user_id = v_uid for update;
    v_survivor := v_first;
    v_duplicate := v_second;
  else
    select * into v_first from public.library_items where id = p_duplicate_id and user_id = v_uid for update;
    select * into v_second from public.library_items where id = p_survivor_id and user_id = v_uid for update;
    v_survivor := v_second;
    v_duplicate := v_first;
  end if;

  if v_survivor.id is null or v_duplicate.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_survivor.type <> v_duplicate.type then
    return jsonb_build_object('status', 'type_mismatch');
  end if;

  v_catalog_survivor := v_survivor.metadata->'catalogSource';
  v_catalog_duplicate := v_duplicate.metadata->'catalogSource';
  if v_catalog_survivor is not null and v_catalog_duplicate is not null
     and (v_catalog_survivor->>'provider' <> v_catalog_duplicate->>'provider' or v_catalog_survivor->>'externalId' <> v_catalog_duplicate->>'externalId') then
    return jsonb_build_object('status', 'catalog_source_conflict');
  end if;

  v_final_metadata := coalesce(p_merged_row->'metadata', v_survivor.metadata);

  if v_survivor.type in ('anime', 'series') then
    v_numbering_survivor := case when v_survivor.metadata->>'episodeNumbering' = 'seasonal' then 'seasonal'
                                  when v_survivor.metadata ? 'currentEpisode' then 'absolute' else null end;
    v_numbering_duplicate := case when v_duplicate.metadata->>'episodeNumbering' = 'seasonal' then 'seasonal'
                                   when v_duplicate.metadata ? 'currentEpisode' then 'absolute' else null end;

    if v_numbering_survivor is not null and v_numbering_duplicate is not null and v_numbering_survivor <> v_numbering_duplicate then
      return jsonb_build_object('status', 'numbering_mode_conflict');
    end if;

    if coalesce(v_numbering_survivor, v_numbering_duplicate) = 'seasonal' then
      v_season_survivor := coalesce((v_survivor.metadata->>'currentSeason')::numeric, -1);
      v_episode_survivor := coalesce((v_survivor.metadata->>'currentEpisode')::numeric, -1);
      v_season_duplicate := coalesce((v_duplicate.metadata->>'currentSeason')::numeric, -1);
      v_episode_duplicate := coalesce((v_duplicate.metadata->>'currentEpisode')::numeric, -1);

      if v_episode_survivor < 0 and v_episode_duplicate < 0 then
        null;
      elsif v_episode_duplicate < 0
         or v_season_survivor > v_season_duplicate
         or (v_season_survivor = v_season_duplicate and v_episode_survivor >= v_episode_duplicate) then
        v_final_metadata := jsonb_set(v_final_metadata, '{currentSeason}', to_jsonb(v_season_survivor));
        v_final_metadata := jsonb_set(v_final_metadata, '{currentEpisode}', to_jsonb(v_episode_survivor));
        v_final_metadata := jsonb_set(v_final_metadata, '{episodeNumbering}', to_jsonb('seasonal'::text));
      else
        v_final_metadata := jsonb_set(v_final_metadata, '{currentSeason}', to_jsonb(v_season_duplicate));
        v_final_metadata := jsonb_set(v_final_metadata, '{currentEpisode}', to_jsonb(v_episode_duplicate));
        v_final_metadata := jsonb_set(v_final_metadata, '{episodeNumbering}', to_jsonb('seasonal'::text));
      end if;
    elsif coalesce(v_numbering_survivor, v_numbering_duplicate) = 'absolute' then
      v_episode_survivor := coalesce((v_survivor.metadata->>'currentEpisode')::numeric, -1);
      v_episode_duplicate := coalesce((v_duplicate.metadata->>'currentEpisode')::numeric, -1);
      if greatest(v_episode_survivor, v_episode_duplicate) >= 0 then
        v_final_metadata := jsonb_set(v_final_metadata, '{currentEpisode}', to_jsonb(greatest(v_episode_survivor, v_episode_duplicate)));
        v_final_metadata := v_final_metadata - 'currentSeason' - 'episodeNumbering';
      end if;
    end if;
  elsif v_survivor.type = 'manga' then
    v_episode_survivor := coalesce((v_survivor.metadata->>'currentChapter')::numeric, -1);
    v_episode_duplicate := coalesce((v_duplicate.metadata->>'currentChapter')::numeric, -1);
    if greatest(v_episode_survivor, v_episode_duplicate) >= 0 then
      v_final_metadata := jsonb_set(v_final_metadata, '{currentChapter}', to_jsonb(greatest(v_episode_survivor, v_episode_duplicate)));
    end if;
  elsif v_survivor.type = 'novel' then
    v_unit_survivor := coalesce(v_survivor.metadata->>'progressUnit', 'chapter');
    v_unit_duplicate := coalesce(v_duplicate.metadata->>'progressUnit', 'chapter');
    v_episode_survivor := coalesce((v_survivor.metadata->>'progressValue')::numeric, -1);
    v_episode_duplicate := coalesce((v_duplicate.metadata->>'progressValue')::numeric, -1);

    if v_episode_survivor >= 0 and v_episode_duplicate >= 0 and v_unit_survivor <> v_unit_duplicate then
      return jsonb_build_object('status', 'progress_unit_conflict');
    end if;

    if greatest(v_episode_survivor, v_episode_duplicate) >= 0 then
      v_final_metadata := jsonb_set(v_final_metadata, '{progressValue}', to_jsonb(greatest(v_episode_survivor, v_episode_duplicate)));
      v_final_metadata := jsonb_set(
        v_final_metadata, '{progressUnit}',
        to_jsonb(case when v_episode_survivor >= 0 then v_unit_survivor else v_unit_duplicate end)
      );
    end if;
  elsif v_survivor.type = 'game' then
    v_episode_survivor := coalesce((v_survivor.metadata->>'playtimeHours')::numeric, -1);
    v_episode_duplicate := coalesce((v_duplicate.metadata->>'playtimeHours')::numeric, -1);
    if greatest(v_episode_survivor, v_episode_duplicate) >= 0 then
      v_final_metadata := jsonb_set(v_final_metadata, '{playtimeHours}', to_jsonb(greatest(v_episode_survivor, v_episode_duplicate)));
    end if;
  end if;

  if v_survivor.metadata ? 'anilistSync' then
    v_final_metadata := jsonb_set(v_final_metadata, '{anilistSync}', v_survivor.metadata->'anilistSync');
  elsif v_duplicate.metadata ? 'anilistSync' then
    v_final_metadata := jsonb_set(v_final_metadata, '{anilistSync}', v_duplicate.metadata->'anilistSync');
  end if;

  -- Stage 28 — capture everything the recovery snapshot needs BEFORE any
  -- write happens: both full pre-merge rows, each side's own pre-merge
  -- collection membership set (not the union — Undo needs to re-split
  -- them, see README), and which sources/activity rows are about to move.
  select coalesce(jsonb_agg(collection_id), '[]'::jsonb) into v_survivor_collection_ids
  from public.collection_items where item_id = p_survivor_id and user_id = v_uid;
  select coalesce(jsonb_agg(collection_id), '[]'::jsonb) into v_duplicate_collection_ids
  from public.collection_items where item_id = p_duplicate_id and user_id = v_uid;
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_moved_source_ids
  from public.tracking_sources where library_item_id = p_duplicate_id and user_id = v_uid;
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_moved_activity_ids
  from public.activity_events where item_id = p_duplicate_id and user_id = v_uid;

  v_recovery_id := gen_random_uuid();
  insert into public.library_recovery_actions (id, user_id, action_type, payload, created_at, expires_at)
  values (
    v_recovery_id,
    v_uid,
    'merge_items',
    jsonb_build_object(
      'survivorId', p_survivor_id,
      'duplicateId', p_duplicate_id,
      'survivorPreMerge', to_jsonb(v_survivor),
      'duplicatePreMerge', to_jsonb(v_duplicate),
      'survivorPreMergeCollectionIds', v_survivor_collection_ids,
      'duplicatePreMergeCollectionIds', v_duplicate_collection_ids,
      'movedSourceIds', v_moved_source_ids,
      'movedActivityIds', v_moved_activity_ids
      -- 'survivorPostMergeExpected' filled in below, once the survivor
      -- row has actually been written and re-read — see the update below.
    ),
    v_now,
    v_now + interval '15 minutes'
  );

  update public.library_items
  set
    title = coalesce(p_merged_row->>'title', v_survivor.title),
    description = coalesce(p_merged_row->>'description', v_survivor.description),
    category = coalesce(p_merged_row->>'category', v_survivor.category),
    tags = coalesce((select array_agg(x) from jsonb_array_elements_text(p_merged_row->'tags') x), v_survivor.tags),
    favorite = coalesce((p_merged_row->>'favorite')::boolean, v_survivor.favorite),
    image_url = p_merged_row->>'image_url',
    source_url = p_merged_row->>'source_url',
    status = coalesce(p_merged_row->>'status', v_survivor.status),
    rating = (p_merged_row->>'rating')::numeric,
    metadata = v_final_metadata,
    updated_at = v_now
  where id = p_survivor_id and user_id = v_uid;

  -- Re-read the survivor exactly as Postgres actually stored it (not the
  -- in-memory variables that built the UPDATE) — this becomes the
  -- reference snapshot Undo compares against later; any drift from real
  -- storage semantics (numeric formatting, jsonb key canonicalization,
  -- array formatting) is captured correctly this way, never assumed.
  select * into v_survivor_after from public.library_items where id = p_survivor_id and user_id = v_uid;
  update public.library_recovery_actions
  set payload = jsonb_set(payload, '{survivorPostMergeExpected}', to_jsonb(v_survivor_after))
  where id = v_recovery_id;

  update public.tracking_sources
  set library_item_id = p_survivor_id, updated_at = v_now
  where library_item_id = p_duplicate_id and user_id = v_uid;

  insert into public.collection_items (collection_id, item_id, user_id, added_at)
  select ci.collection_id, p_survivor_id, v_uid, ci.added_at
  from public.collection_items ci
  where ci.item_id = p_duplicate_id and ci.user_id = v_uid
  on conflict (collection_id, item_id) do nothing;

  delete from public.collection_items where item_id = p_duplicate_id and user_id = v_uid;

  with moved as (
    delete from public.activity_events
    where item_id = p_duplicate_id and user_id = v_uid
    returning id, user_id, type, data, created_at
  )
  insert into public.activity_events (id, user_id, item_id, type, data, created_at)
  select id, user_id, p_survivor_id, type, data, created_at from moved;

  delete from public.library_items where id = p_duplicate_id and user_id = v_uid;

  return jsonb_build_object('status', 'merged', 'survivorId', p_survivor_id, 'recoveryId', v_recovery_id);
end;
$$;

-- Grants unchanged from 0009 (create or replace preserves them, but
-- stated explicitly again for clarity/re-runnability).
revoke all on function public.merge_library_items(uuid, uuid, jsonb) from public;
grant execute on function public.merge_library_items(uuid, uuid, jsonb) to authenticated;

-- ============================================================
-- undo_library_recovery — one function handling both action types,
-- since both share the same outer shape (lock the recovery row, verify
-- it's usable, branch on action_type, verify nothing has changed that
-- would make restoration unsafe, restore, consume).
-- ============================================================
create or replace function public.undo_library_recovery(
  p_recovery_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_recovery public.library_recovery_actions%rowtype;
  v_existing_id uuid;
  v_missing_collection boolean;
  v_conflicted_source boolean;
  -- delete_item locals
  v_item jsonb;
  v_collection_ids jsonb;
  v_activity_events jsonb;
  v_source_ids jsonb;
  -- merge_items locals
  v_survivor_id uuid;
  v_duplicate_id uuid;
  v_survivor_pre jsonb;
  v_duplicate_pre jsonb;
  v_survivor_post_expected jsonb;
  v_survivor_collection_ids jsonb;
  v_duplicate_collection_ids jsonb;
  v_moved_source_ids jsonb;
  v_moved_activity_ids jsonb;
  v_current_survivor public.library_items%rowtype;
  v_new_unrelated_activity boolean;
  v_topology_mismatch boolean;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select * into v_recovery from public.library_recovery_actions where id = p_recovery_id and user_id = v_uid for update;
  if v_recovery.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_recovery.expires_at < v_now then
    delete from public.library_recovery_actions where id = p_recovery_id;
    return jsonb_build_object('status', 'expired');
  end if;

  -- ============================================================
  -- delete_item
  -- ============================================================
  if v_recovery.action_type = 'delete_item' then
    v_item := v_recovery.payload->'item';
    v_collection_ids := coalesce(v_recovery.payload->'collectionIds', '[]'::jsonb);
    v_activity_events := coalesce(v_recovery.payload->'activityEvents', '[]'::jsonb);
    v_source_ids := coalesce(v_recovery.payload->'sourceIds', '[]'::jsonb);

    select id into v_existing_id from public.library_items where id = (v_item->>'id')::uuid;
    if v_existing_id is not null then
      return jsonb_build_object('status', 'recovery_conflict', 'reason', 'id_in_use');
    end if;

    select exists (
      select 1 from jsonb_array_elements_text(v_collection_ids) cid
      where not exists (select 1 from public.collections c where c.id = cid::uuid and c.user_id = v_uid)
    ) into v_missing_collection;
    if v_missing_collection then
      return jsonb_build_object('status', 'recovery_conflict', 'reason', 'collection_missing');
    end if;

    select exists (
      select 1 from jsonb_array_elements_text(v_source_ids) sid
      where not exists (select 1 from public.tracking_sources ts where ts.id = sid::uuid and ts.user_id = v_uid and ts.library_item_id is null)
    ) into v_conflicted_source;
    if v_conflicted_source then
      return jsonb_build_object('status', 'recovery_conflict', 'reason', 'source_claimed_elsewhere');
    end if;

    insert into public.library_items (id, user_id, type, title, description, category, tags, favorite, image_url, source_url, url, status, rating, metadata, created_at, updated_at)
    values (
      (v_item->>'id')::uuid,
      v_uid,
      v_item->>'type',
      v_item->>'title',
      v_item->>'description',
      v_item->>'category',
      coalesce((select array_agg(x) from jsonb_array_elements_text(v_item->'tags') x), '{}'),
      (v_item->>'favorite')::boolean,
      v_item->>'image_url',
      v_item->>'source_url',
      v_item->>'url',
      v_item->>'status',
      (v_item->>'rating')::numeric,
      coalesce(v_item->'metadata', '{}'::jsonb),
      (v_item->>'created_at')::timestamptz,
      case when v_item->>'updated_at' is null then null else (v_item->>'updated_at')::timestamptz end
    );

    insert into public.collection_items (collection_id, item_id, user_id, added_at)
    select cid::uuid, (v_item->>'id')::uuid, v_uid, v_now
    from jsonb_array_elements_text(v_collection_ids) cid;

    insert into public.activity_events (id, user_id, item_id, type, data, created_at)
    select (e->>'id')::uuid, v_uid, (v_item->>'id')::uuid, e->>'type', coalesce(e->'data', '{}'::jsonb), (e->>'created_at')::timestamptz
    from jsonb_array_elements(v_activity_events) e;

    update public.tracking_sources
    set library_item_id = (v_item->>'id')::uuid, updated_at = v_now
    where user_id = v_uid
      and library_item_id is null
      and id in (select sid::uuid from jsonb_array_elements_text(v_source_ids) sid);

    delete from public.library_recovery_actions where id = p_recovery_id;

    return jsonb_build_object('status', 'recovered', 'actionType', 'delete_item', 'itemId', (v_item->>'id')::uuid);
  end if;

  -- ============================================================
  -- merge_items
  -- ============================================================
  if v_recovery.action_type = 'merge_items' then
    v_survivor_id := (v_recovery.payload->>'survivorId')::uuid;
    v_duplicate_id := (v_recovery.payload->>'duplicateId')::uuid;
    v_survivor_pre := v_recovery.payload->'survivorPreMerge';
    v_duplicate_pre := v_recovery.payload->'duplicatePreMerge';
    v_survivor_post_expected := v_recovery.payload->'survivorPostMergeExpected';
    v_survivor_collection_ids := coalesce(v_recovery.payload->'survivorPreMergeCollectionIds', '[]'::jsonb);
    v_duplicate_collection_ids := coalesce(v_recovery.payload->'duplicatePreMergeCollectionIds', '[]'::jsonb);
    v_moved_source_ids := coalesce(v_recovery.payload->'movedSourceIds', '[]'::jsonb);
    v_moved_activity_ids := coalesce(v_recovery.payload->'movedActivityIds', '[]'::jsonb);

    select * into v_current_survivor from public.library_items where id = v_survivor_id and user_id = v_uid for update;
    if v_current_survivor.id is null then
      return jsonb_build_object('status', 'recovery_conflict', 'reason', 'survivor_missing');
    end if;

    select id into v_existing_id from public.library_items where id = v_duplicate_id;
    if v_existing_id is not null then
      return jsonb_build_object('status', 'recovery_conflict', 'reason', 'id_in_use');
    end if;

    -- The core safety check (Section 16/17/19 of the Stage 28 spec):
    -- exact row equality against the recorded post-merge snapshot. Any
    -- real change since — progress, rating, status, metadata, favorite,
    -- another merge — fails this and blocks Undo outright.
    if to_jsonb(v_current_survivor) is distinct from v_survivor_post_expected then
      return jsonb_build_object('status', 'recovery_conflict', 'reason', 'survivor_changed');
    end if;

    -- Defense in depth: any Activity on survivor created after the merge
    -- that isn't one of the events we're about to move back is
    -- independent evidence of a change, even in a hypothetical case the
    -- row-snapshot check above didn't cover.
    select exists (
      select 1 from public.activity_events ae
      where ae.item_id = v_survivor_id
        and ae.user_id = v_uid
        and ae.created_at > v_recovery.created_at
        and ae.id::text not in (select jsonb_array_elements_text(v_moved_activity_ids))
    ) into v_new_unrelated_activity;
    if v_new_unrelated_activity then
      return jsonb_build_object('status', 'recovery_conflict', 'reason', 'survivor_changed');
    end if;

    select exists (
      select 1 from jsonb_array_elements_text(v_moved_source_ids) sid
      where not exists (select 1 from public.tracking_sources ts where ts.id = sid::uuid and ts.user_id = v_uid and ts.library_item_id = v_survivor_id)
    ) into v_conflicted_source;
    if v_conflicted_source then
      return jsonb_build_object('status', 'recovery_conflict', 'reason', 'source_claimed_elsewhere');
    end if;

    select exists (
      select 1 from jsonb_array_elements_text(v_survivor_collection_ids || v_duplicate_collection_ids) cid
      where not exists (select 1 from public.collections c where c.id = cid::uuid and c.user_id = v_uid)
    ) into v_missing_collection;
    if v_missing_collection then
      return jsonb_build_object('status', 'recovery_conflict', 'reason', 'collection_missing');
    end if;

    -- Collection membership lives in collection_items, a separate table —
    -- changing it never touches the library_items row, so the
    -- to_jsonb(v_current_survivor) IS DISTINCT FROM check above cannot see
    -- a membership added or removed after the merge. Compare the
    -- survivor's CURRENT membership set against the expected post-merge
    -- union of both sides' pre-merge sets (never the stored sets in
    -- isolation) — any real difference either way is user intent since
    -- the merge that Undo must never silently discard or resurrect.
    -- Checked before any write below, so a conflict here leaves every
    -- table completely untouched.
    select exists (
      select 1 from (
        (
          select collection_id from public.collection_items
          where item_id = v_survivor_id and user_id = v_uid
          except
          select cid::uuid from jsonb_array_elements_text(v_survivor_collection_ids || v_duplicate_collection_ids) cid
        )
        union all
        (
          select cid::uuid from jsonb_array_elements_text(v_survivor_collection_ids || v_duplicate_collection_ids) cid
          except
          select collection_id from public.collection_items
          where item_id = v_survivor_id and user_id = v_uid
        )
      ) as diff
    ) into v_topology_mismatch;
    if v_topology_mismatch then
      return jsonb_build_object('status', 'recovery_conflict', 'reason', 'collections_changed');
    end if;

    insert into public.library_items (id, user_id, type, title, description, category, tags, favorite, image_url, source_url, url, status, rating, metadata, created_at, updated_at)
    values (
      (v_duplicate_pre->>'id')::uuid,
      v_uid,
      v_duplicate_pre->>'type',
      v_duplicate_pre->>'title',
      v_duplicate_pre->>'description',
      v_duplicate_pre->>'category',
      coalesce((select array_agg(x) from jsonb_array_elements_text(v_duplicate_pre->'tags') x), '{}'),
      (v_duplicate_pre->>'favorite')::boolean,
      v_duplicate_pre->>'image_url',
      v_duplicate_pre->>'source_url',
      v_duplicate_pre->>'url',
      v_duplicate_pre->>'status',
      (v_duplicate_pre->>'rating')::numeric,
      coalesce(v_duplicate_pre->'metadata', '{}'::jsonb),
      (v_duplicate_pre->>'created_at')::timestamptz,
      case when v_duplicate_pre->>'updated_at' is null then null else (v_duplicate_pre->>'updated_at')::timestamptz end
    );

    update public.library_items
    set
      title = v_survivor_pre->>'title',
      description = v_survivor_pre->>'description',
      category = v_survivor_pre->>'category',
      tags = coalesce((select array_agg(x) from jsonb_array_elements_text(v_survivor_pre->'tags') x), '{}'),
      favorite = (v_survivor_pre->>'favorite')::boolean,
      image_url = v_survivor_pre->>'image_url',
      source_url = v_survivor_pre->>'source_url',
      status = v_survivor_pre->>'status',
      rating = (v_survivor_pre->>'rating')::numeric,
      metadata = coalesce(v_survivor_pre->'metadata', '{}'::jsonb),
      updated_at = case when v_survivor_pre->>'updated_at' is null then null else (v_survivor_pre->>'updated_at')::timestamptz end
    where id = v_survivor_id and user_id = v_uid;

    -- Exact pre-merge collection topology: reset survivor to precisely
    -- its own recorded set, and give the recreated duplicate precisely
    -- its own — a collection both belonged to is re-split into two
    -- independent memberships again, never left as a single "move".
    delete from public.collection_items where item_id = v_survivor_id and user_id = v_uid;
    insert into public.collection_items (collection_id, item_id, user_id, added_at)
    select cid::uuid, v_survivor_id, v_uid, v_now from jsonb_array_elements_text(v_survivor_collection_ids) cid;
    insert into public.collection_items (collection_id, item_id, user_id, added_at)
    select cid::uuid, v_duplicate_id, v_uid, v_now from jsonb_array_elements_text(v_duplicate_collection_ids) cid;

    with moved as (
      delete from public.activity_events
      where user_id = v_uid
        and item_id = v_survivor_id
        and id in (select x::uuid from jsonb_array_elements_text(v_moved_activity_ids) x)
      returning id, user_id, type, data, created_at
    )
    insert into public.activity_events (id, user_id, item_id, type, data, created_at)
    select id, user_id, v_duplicate_id, type, data, created_at from moved;

    update public.tracking_sources
    set library_item_id = v_duplicate_id, updated_at = v_now
    where user_id = v_uid
      and library_item_id = v_survivor_id
      and id in (select x::uuid from jsonb_array_elements_text(v_moved_source_ids) x);

    delete from public.library_recovery_actions where id = p_recovery_id;

    return jsonb_build_object('status', 'recovered', 'actionType', 'merge_items', 'survivorId', v_survivor_id, 'duplicateId', v_duplicate_id);
  end if;

  return jsonb_build_object('status', 'invalid_action');
end;
$$;

revoke all on function public.undo_library_recovery(uuid) from public;
grant execute on function public.undo_library_recovery(uuid) to authenticated;
