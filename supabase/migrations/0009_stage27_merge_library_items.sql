-- Stage 27: safe duplicate detection & manual merge.
--
-- Run this against your Supabase project after 0001-0008 (all already
-- applied — this migration does not touch anything any of them created).
-- Safe to re-run.
--
-- ============================================================
-- Why this exists
-- ============================================================
-- Merging two LibraryItems touches four tables (library_items,
-- tracking_sources, collection_items, activity_events) and must never
-- leave a half-merged state if the browser, network, or a concurrent
-- request interferes partway through (see README "Safe Duplicate
-- Detection & Manual Merge" — "cloud merge must be atomic"). A sequence of
-- independent REST calls from the browser cannot provide that; one
-- Postgres transaction can.
--
-- Two real, non-obvious findings shaped this function (see the Stage 27
-- Phase 0 report):
--   1. collection_items and activity_events have NO UPDATE row-level-
--      security policy (only SELECT/INSERT/DELETE — see 0001). A plain
--      `update ... set item_id = ...` against either table is silently
--      rejected under `security invoker`. This function moves rows in
--      both tables via INSERT + DELETE instead, which the existing
--      policies already permit.
--   2. A TrackingSource can commit real progress to the about-to-be-
--      deleted duplicate item at any moment via apply_extension_progress/
--      apply_extension_season_episode_progress (0004/0007) — including
--      while this very merge is running. Trusting a browser-precomputed
--      "merged progress" value would risk silently losing whichever
--      commit landed last. So this function does NOT trust the caller's
--      merged progress fields at all: after locking both rows, it
--      independently recomputes every progress-bearing metadata field
--      (currentEpisode/currentSeason/episodeNumbering/currentChapter/
--      progressValue/progressUnit/playtimeHours) from whatever is
--      actually, currently in the two locked rows, using the exact same
--      "furthest wins" / lexicographic-seasonal / numbering-mode-conflict
--      rules as the client-side preview (src/lib/library-merge.ts) — the
--      client's own computation is trusted only for the fields nothing
--      else in the system writes concurrently (title, description, tags,
--      genres, cover, catalogSource, ...).
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
begin
  if v_uid is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if p_survivor_id = p_duplicate_id then
    return jsonb_build_object('status', 'same_item');
  end if;

  -- Deterministic lock ordering (always the numerically/lexicographically
  -- smaller uuid first, regardless of which one is "survivor" in THIS
  -- request) — so a concurrent "merge A into B" and "merge B into A" (or
  -- any two overlapping requests touching this pair) always acquire these
  -- two row locks in the same order and can never deadlock against each
  -- other. One blocks briefly until the other's transaction completes,
  -- then safely re-reads whatever state that left behind.
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

  -- catalogSource conflict — re-verified against the freshly-locked rows
  -- (not merely trusted from the client) since a blocking decision this
  -- consequential (refusing an otherwise-valid merge) should be based on
  -- what's actually in the database right now.
  v_catalog_survivor := v_survivor.metadata->'catalogSource';
  v_catalog_duplicate := v_duplicate.metadata->'catalogSource';
  if v_catalog_survivor is not null and v_catalog_duplicate is not null
     and (v_catalog_survivor->>'provider' <> v_catalog_duplicate->>'provider' or v_catalog_survivor->>'externalId' <> v_catalog_duplicate->>'externalId') then
    return jsonb_build_object('status', 'catalog_source_conflict');
  end if;

  -- Base metadata: the caller's (client-precomputed) merged fields for
  -- everything that isn't independently recomputed below — title,
  -- description, tags, genres, authors, studio, cover, catalogSource,
  -- anilistSync, etc. None of these are written by any concurrent
  -- background process, so trusting the caller's already-reviewed
  -- computation here is safe (see the module doc comment above).
  v_final_metadata := coalesce(p_merged_row->'metadata', v_survivor.metadata);

  -- ============================================================
  -- Server-authoritative progress recomputation (Section 33) — every
  -- branch reads ONLY v_survivor/v_duplicate (the freshly locked rows),
  -- never p_merged_row, for these specific keys.
  -- ============================================================
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
        null; -- neither side has real progress — leave whatever the caller sent (should also be absent)
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

  -- Preserve whichever side's AniList sync baseline exists (survivor
  -- first) — this key isn't part of the app's MediaItem type at all (see
  -- src/lib/integrations/anilist/sync.ts), so a client-computed
  -- p_merged_row never carries it; grafting it on here (from the fresh
  -- rows, same non-racy reasoning as catalogSource) is what stops a merge
  -- from silently resetting the survivor's AniList sync state.
  if v_survivor.metadata ? 'anilistSync' then
    v_final_metadata := jsonb_set(v_final_metadata, '{anilistSync}', v_survivor.metadata->'anilistSync');
  elsif v_duplicate.metadata ? 'anilistSync' then
    v_final_metadata := jsonb_set(v_final_metadata, '{anilistSync}', v_duplicate.metadata->'anilistSync');
  end if;

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

  -- Move tracking_sources — a plain UPDATE is fine here (tracking_sources
  -- DOES have an UPDATE policy — see 0003). Uniqueness is on
  -- (user_id, adapter_id, source_key), independent of library_item_id, so
  -- reassignment can never collide. Every per-source field
  -- (auto_track_enabled, auto_link_suppressed_at, last_detected_progress,
  -- last_seen_at, source_url, adapter_id/source_key identity) is
  -- untouched — Section 20/35.
  update public.tracking_sources
  set library_item_id = p_survivor_id, updated_at = v_now
  where library_item_id = p_duplicate_id and user_id = v_uid;

  -- Move collection_items via INSERT + DELETE (no UPDATE policy exists on
  -- this table — see the module doc comment). `on conflict do nothing`
  -- handles the case where the survivor is already a member of the same
  -- collection (composite PK (collection_id, item_id) — Section 22).
  insert into public.collection_items (collection_id, item_id, user_id, added_at)
  select ci.collection_id, p_survivor_id, v_uid, ci.added_at
  from public.collection_items ci
  where ci.item_id = p_duplicate_id and ci.user_id = v_uid
  on conflict (collection_id, item_id) do nothing;

  delete from public.collection_items where item_id = p_duplicate_id and user_id = v_uid;

  -- Move activity_events, also via INSERT + DELETE (no UPDATE policy —
  -- same reason). A single WITH...RETURNING avoids ever having two rows
  -- with the same primary-key id at once (id is the PK; only item_id
  -- changes) — historical values (type/data/created_at) are copied
  -- verbatim, never rewritten (Section 23).
  with moved as (
    delete from public.activity_events
    where item_id = p_duplicate_id and user_id = v_uid
    returning id, user_id, type, data, created_at
  )
  insert into public.activity_events (id, user_id, item_id, type, data, created_at)
  select id, user_id, p_survivor_id, type, data, created_at from moved;

  -- Delete the duplicate LAST, only after every relationship above has
  -- already been moved (Section 27) — if anything before this point
  -- failed, the whole transaction rolls back and the duplicate (and every
  -- one of its relationships) is untouched.
  delete from public.library_items where id = p_duplicate_id and user_id = v_uid;

  return jsonb_build_object('status', 'merged', 'survivorId', p_survivor_id);
end;
$$;

-- Session-authenticated by design (unlike the extension-facing RPCs in
-- 0004-0007, which run under the service_role admin client because
-- device-token auth isn't Supabase session auth) — merging is a pure
-- web-app user action, so this uses auth.uid() directly rather than a
-- passed-in user id, matching the existing linkSource/unlinkSource
-- pattern (src/lib/extension/tracking-sources.ts). security invoker means
-- RLS still applies to every statement inside this function exactly as if
-- the caller ran them directly; the explicit `and user_id = v_uid` filters
-- above are defense in depth on top of that, matching this project's
-- established habit of not relying on RLS alone.
revoke all on function public.merge_library_items(uuid, uuid, jsonb) from public;
grant execute on function public.merge_library_items(uuid, uuid, jsonb) to authenticated;
