-- Stage 28 fix (revised a second time after a second security review — see
-- the Stage 28 real-database validation report for the FOR UPDATE/RLS
-- diagnosis this migration also still fixes, and the first security
-- review for why the original "just add an UPDATE policy" draft was
-- rejected before deployment).
--
-- ============================================================
-- The new issue this revision fixes
-- ============================================================
-- The first revision of this migration removed the need for an UPDATE
-- policy on library_recovery_actions, but left the table's INSERT policy
-- (`library_recovery_actions_insert_own`, from 0010) exactly as it was:
-- `with check (auth.uid() = user_id)`. That check only constrains WHICH
-- ROW a client may insert (one they own) — never which COLUMNS or VALUES.
-- Combined with this project's evident default table grants (every other
-- public table already works for `authenticated` via plain PostgREST
-- calls with no explicit GRANT statement anywhere in 0001-0010, which is
-- only possible if `authenticated` already holds full table-level
-- privileges by project default — the same evidence base as the prior
-- UPDATE-policy review), an ordinary signed-in client could very likely
-- have called
--   supabase.from('library_recovery_actions').insert({
--     user_id: ownUserId, action_type: 'delete_item',
--     payload: <anything>, expires_at: <anything>,
--   })
-- directly — forging an arbitrary recovery snapshot for their own
-- account, which undo_library_recovery would then trust completely.
-- Concretely, for a forged row an attacker could have chosen: an
-- arbitrary LibraryItem UUID and fields to (re)create, arbitrary
-- collection/Activity/TrackingSource ids to attach, `delete_item` vs
-- `merge_items` framing, fabricated survivor/duplicate snapshots, and an
-- expires_at far in the future. This is confined to the attacker's own
-- account (the WITH CHECK genuinely does stop `user_id` forgery — this
-- was never a cross-user vulnerability), but it breaks the intended
-- invariant that a row in this table can ONLY ever be the byte-for-byte
-- product of a real, transactional Delete or Merge.
--
-- ============================================================
-- The fix: recovery rows become genuinely client-write-proof
-- ============================================================
-- The INSERT policy is dropped outright — no policy replaces it, and the
-- underlying table-level INSERT/UPDATE grants are explicitly revoked from
-- `authenticated`/`anon` too (belt and suspenders: the security boundary
-- must not depend solely on which of "missing grant" or "missing policy"
-- actually turns out to be true — GRANT answers "may this role write at
-- all", RLS answers "which rows"; this migration makes the answer to the
-- first question an explicit, auditable "no" regardless of what the
-- project's original defaults were). SELECT stays exactly as it was (a
-- user still needs to list their own active recovery actions — Settings
-- "Recently Changed" depends on it) and so does DELETE (see below for why
-- that one is a deliberate, documented exception, not an oversight).
--
-- With INSERT now blocked for every real client, the two functions that
-- legitimately NEED to create a recovery row —
-- delete_library_item_with_recovery and merge_library_items — are
-- redefined as SECURITY DEFINER instead of SECURITY INVOKER. This is the
-- minimum privilege elevation that satisfies both halves of the
-- requirement (a user cannot directly forge a row, but the approved
-- Delete/Merge paths still can): every statement in both functions
-- ALREADY carried an explicit `and user_id = v_uid` (or
-- `and ci.user_id = v_uid`, etc.) predicate before this revision — that
-- was already this project's established defense-in-depth habit (see
-- 0009's own comment: "the explicit `and user_id = v_uid` filters above
-- are defense in depth on top of [RLS]"), so removing RLS's automatic
-- enforcement for these two functions removes no actual protection: the
-- same ownership boundary is still checked, explicitly, on every single
-- row these functions touch. `set search_path = public` (already
-- present) prevents search_path hijacking; `auth.uid()` is still derived
-- fresh inside the function and rejected if null; no statement anywhere
-- in either function trusts a client-supplied user id for anything.
--
-- undo_library_recovery is UNCHANGED from the prior revision of this
-- migration: it never needs to INSERT into library_recovery_actions at
-- all (only SELECT, which the existing SELECT policy already permits,
-- and DELETE to consume a row, which the existing DELETE policy already
-- permits), so it has no reason to become SECURITY DEFINER — it stays
-- SECURITY INVOKER, still using the advisory-transaction-lock fix from
-- the prior revision (pg_advisory_xact_lock instead of `for update` on
-- library_recovery_actions — see that function's own comment).
--
-- ============================================================
-- Why DELETE remains available to normal clients (a deliberate decision,
-- not an oversight — see Task 8 of the security review)
-- ============================================================
-- A client deleting their own recovery row directly can only ever make
-- their own future Undo opportunity disappear early — it can never forge
-- a restore, fabricate data, or affect any other row. The integrity
-- invariant this migration exists to protect ("every row's payload is
-- the genuine product of a real Delete/Merge") only concerns rows that
-- EXIST; a client discarding their own row early is indistinguishable in
-- effect from simply waiting the 15 minutes out, so restricting DELETE
-- too would add complexity (another SECURITY DEFINER surface, or forcing
-- "discard my own Undo" through the Undo RPC itself) for no integrity
-- benefit. The existing library_recovery_actions_delete_own policy
-- (`auth.uid() = user_id`, from 0010) is left exactly as it is.
--
-- One concurrency nuance was checked explicitly: undo_library_recovery
-- serializes Undo-vs-Undo via an advisory lock, but a direct client
-- DELETE never acquires that lock (it isn't aware of it — advisory locks
-- only serialize against other callers of the SAME pg_advisory_xact_lock
-- key, never against arbitrary statements from other sessions). So a
-- direct "discard" DELETE can race an in-flight Undo call on the exact
-- same row. Traced through: Undo takes the advisory lock, then a PLAIN
-- (non-locking) SELECT captures the row's payload into a local variable —
-- from that point on, Undo's restoration logic depends only on that
-- already-captured snapshot, never on the row continuing to exist. If a
-- concurrent direct DELETE removes the row at any point after Undo's
-- SELECT, Undo's own final `delete ... where id = p_recovery_id` simply
-- affects zero rows instead of one — not an error, and the restoration
-- it already performed (recreating/updating LibraryItems, collections,
-- Activity, TrackingSources) is entirely unaffected, since none of that
-- logic re-reads the recovery row. The reverse ordering (direct DELETE
-- completes before Undo's SELECT even runs) is just the ordinary
-- not_found path. Neither ordering produces duplicate restoration,
-- corrupted restoration, or a reusable/replayable recovery row — the row
-- ends up deleted in every case, and a second Undo attempt on the same id
-- always correctly gets not_found regardless of which delete "won". This
-- is a benign race (a "discard" losing to an already-in-flight Undo is
-- arguably the semantically correct outcome anyway), so DELETE stays
-- enabled — no discard-specific RPC was built for this.
--
-- ============================================================
-- SECURITY DEFINER search_path hardening (third security review)
-- ============================================================
-- Whether PUBLIC/anon/authenticated currently hold CREATE on the public
-- schema could not be confirmed by live catalog inspection (same
-- limitation as the grant-inference elsewhere in this migration's
-- history — no direct database access available). Rather than depend on
-- resolving that uncertainty, delete_library_item_with_recovery and
-- merge_library_items (the two SECURITY DEFINER functions) both exclude
-- `public` from search_path entirely (`pg_catalog, pg_temp` instead) —
-- every application table/type reference in both was audited and is
-- already fully schema-qualified (`public.library_items`, etc.), and
-- auth.uid() is schema-qualified too, so this changes no behavior today
-- and closes the object-name-shadowing attack class unconditionally,
-- regardless of what the answer to the CREATE-privilege question turns
-- out to be — including the pg_temp-shadowing variant (a caller creating
-- a same-named temp table in their own session before calling the
-- function), since a schema-qualified reference never consults pg_temp
-- or search_path at all. undo_library_recovery stays SECURITY INVOKER
-- and keeps `search_path = public` — it carries no privilege elevation
-- for a shadowed reference to exploit, and (like the other two) already
-- fully qualifies every reference regardless.

-- ------------------------------------------------------------
-- 1. Table privilege model: SELECT + system-only write.
-- ------------------------------------------------------------
drop policy if exists "library_recovery_actions_insert_own" on public.library_recovery_actions;

-- Explicit, in addition to (never a substitute for) the RLS policy state
-- above — see the header comment for why both layers matter here.
-- Includes PUBLIC (not just anon/authenticated): revoking from PUBLIC
-- means the denial holds for every current AND future role that inherits
-- from it, rather than depending on an exhaustive, easy-to-forget list of
-- named roles — the safer default given the underlying table-level grants
-- were never confirmed by live catalog inspection (see the security
-- review reports).
revoke insert, update on public.library_recovery_actions from public, authenticated, anon;

-- ------------------------------------------------------------
-- 2. delete_library_item_with_recovery — same body as 0010, now
--    SECURITY DEFINER so it can still write the recovery row it
--    captures, now that no client-facing INSERT path exists.
-- ------------------------------------------------------------
create or replace function public.delete_library_item_with_recovery(
  p_item_id uuid
)
returns jsonb
language plpgsql
security definer
-- `public` is deliberately EXCLUDED from search_path for this DEFINER
-- function (unlike the SECURITY INVOKER functions elsewhere in this
-- schema, which safely use `public` since they carry no privilege
-- elevation to exploit). Every application table/type reference in this
-- function body is already fully schema-qualified (public.library_items,
-- etc.) and auth.uid() is schema-qualified too, so nothing here actually
-- depends on search_path at all — this is deliberate belt-and-suspenders
-- hardening, not a functional requirement: if a future edit ever
-- introduces an unqualified reference by mistake, excluding `public`
-- means it fails loudly (object not found) instead of silently resolving
-- to a same-named object an attacker created in `public` (or in their own
-- session's pg_temp, which is included explicitly here rather than
-- relying on its usual implicit-first search position, precisely so a
-- caller-created temp table/view can never shadow an application object
-- this function was written to reference unqualified — it never does,
-- but the setting holds even if that ever changes). pg_catalog remains
-- searchable for built-ins (jsonb_build_object, gen_random_uuid, now,
-- coalesce, ...); it would be implicitly searched regardless, but is
-- listed explicitly here for clarity.
set search_path = pg_catalog, pg_temp
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

-- ------------------------------------------------------------
-- 3. merge_library_items — same body/logic as the prior revision of this
--    migration (advisory-lock-free; it never touched
--    library_recovery_actions with anything but a single INSERT), now
--    SECURITY DEFINER for the same reason as above.
-- ------------------------------------------------------------
create or replace function public.merge_library_items(
  p_survivor_id uuid,
  p_duplicate_id uuid,
  p_merged_row jsonb
)
returns jsonb
language plpgsql
security definer
-- `public` excluded from search_path — same DEFINER hardening rationale
-- as delete_library_item_with_recovery's identical comment above: every
-- reference here is already fully schema-qualified, so this changes no
-- behavior today and closes the shadowing class of attack against any
-- future unqualified reference by mistake.
set search_path = pg_catalog, pg_temp
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

  select coalesce(jsonb_agg(collection_id), '[]'::jsonb) into v_survivor_collection_ids
  from public.collection_items where item_id = p_survivor_id and user_id = v_uid;
  select coalesce(jsonb_agg(collection_id), '[]'::jsonb) into v_duplicate_collection_ids
  from public.collection_items where item_id = p_duplicate_id and user_id = v_uid;
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_moved_source_ids
  from public.tracking_sources where library_item_id = p_duplicate_id and user_id = v_uid;
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_moved_activity_ids
  from public.activity_events where item_id = p_duplicate_id and user_id = v_uid;

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

  select * into v_survivor_after from public.library_items where id = p_survivor_id and user_id = v_uid;

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
      'survivorPostMergeExpected', to_jsonb(v_survivor_after),
      'survivorPreMergeCollectionIds', v_survivor_collection_ids,
      'duplicatePreMergeCollectionIds', v_duplicate_collection_ids,
      'movedSourceIds', v_moved_source_ids,
      'movedActivityIds', v_moved_activity_ids
    ),
    v_now,
    v_now + interval '15 minutes'
  );

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

revoke all on function public.merge_library_items(uuid, uuid, jsonb) from public;
grant execute on function public.merge_library_items(uuid, uuid, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 4. undo_library_recovery — UNCHANGED from the prior revision of this
--    migration. Still SECURITY INVOKER (it never needs to insert into
--    library_recovery_actions), still uses the advisory-lock fix instead
--    of `for update` on that table.
-- ------------------------------------------------------------
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
  v_item jsonb;
  v_collection_ids jsonb;
  v_activity_events jsonb;
  v_source_ids jsonb;
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

  -- Serialize concurrent Undo attempts on the SAME recovery id via an
  -- advisory transaction lock instead of `for update` on
  -- library_recovery_actions — that table has no UPDATE policy (by
  -- design, see this migration's header) and PostgreSQL RLS gates a
  -- locking SELECT by the UPDATE policy too, so `for update` there would
  -- silently return zero rows for every real user regardless of whether
  -- the row exists. An advisory lock needs no table grant or RLS policy
  -- at all, is scoped to this transaction (auto-released at
  -- COMMIT/ROLLBACK — pg_advisory_XACT_lock, never the session variant),
  -- and provides the exact same serialization guarantee: a second
  -- concurrent call blocks here until the first transaction finishes,
  -- then its own plain SELECT below sees whatever was actually
  -- committed. hashtext() is a standard built-in (int4, implicitly
  -- widened to the bigint pg_advisory_xact_lock(bigint) expects).
  perform pg_advisory_xact_lock(hashtext(p_recovery_id::text));

  select * into v_recovery from public.library_recovery_actions where id = p_recovery_id and user_id = v_uid;
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

    if to_jsonb(v_current_survivor) is distinct from v_survivor_post_expected then
      return jsonb_build_object('status', 'recovery_conflict', 'reason', 'survivor_changed');
    end if;

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
