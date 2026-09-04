-- Stage 25: season-aware episode progress.
--
-- Run this against your Supabase project after 0001-0006 (all already
-- applied to the real project — this migration does not touch anything any
-- of them created, including apply_extension_progress from 0004, which
-- keeps handling every absolute-numbering episode/chapter/page/percent/
-- playtime update exactly as before). Safe to re-run: the function is
-- `create or replace`, and the grant/revoke statements are idempotent.
--
-- ============================================================
-- Why this exists
-- ============================================================
-- Markly's existing auto-tracking progress RPC (apply_extension_progress,
-- 0004) is a single-numeric compare-and-set: "is the new value greater
-- than the current one?". That correctly handles absolute episode
-- numbering (1, 2, 3, ...) but cannot express season-aware numbering,
-- where a *lower* episode number can still be real forward progress (S2E1
-- genuinely comes after S1E12) and a *higher* one can still be behind
-- (S1E20 must never overwrite S2E1). Comparing (season, episode) as a
-- lexicographic pair has to happen inside the same locked transaction as
-- the read — deciding it in application code first (read season, compare
-- in TypeScript, then write) would reopen exactly the read-compare-write
-- race apply_extension_progress was written in 0004 to close.
--
-- ============================================================
-- The fix
-- ============================================================
-- apply_extension_season_episode_progress() mirrors 0004's own structure
-- (row lock via `select ... for update`, one function call = one
-- transaction, Activity insert(s) only on the request that actually wins
-- the compare-and-set) with two differences specific to seasons:
--
--   1. The comparison is lexicographic on (season, episode), not a single
--      number: a higher season always wins regardless of episode; within
--      the same season, only a higher episode wins; a lower season never
--      wins even with a much higher episode.
--
--   2. A "numbering_mismatch" status protects every item that isn't
--      already explicitly seasonal: an item with no episodeNumbering
--      marker but a real currentEpisode already recorded (every legacy
--      item, and every AniList-synced item — AniList always writes plain
--      absolute progress, see src/lib/integrations/anilist/sync.ts) is
--      never silently reinterpreted as seasonal just because a seasonal
--      detection happened to arrive for it. Only an item that is already
--      marked seasonal, or one with no progress recorded at all yet (a
--      freshly Auto-Added item, or a manually added item nobody has
--      tracked progress on), may accept a seasonal write.
create or replace function public.apply_extension_season_episode_progress(
  p_user_id uuid,
  p_item_id uuid,
  p_media_type text,
  p_new_season integer,
  p_new_episode integer
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.library_items%rowtype;
  v_numbering text;
  v_current_season integer;
  v_current_episode numeric;
  v_previous_status text;
  v_new_status text;
  v_new_metadata jsonb;
  v_now timestamptz := now();
  v_status_changed boolean := false;
begin
  if p_media_type not in ('anime', 'series') then
    return jsonb_build_object('status', 'incompatible_media_type');
  end if;

  -- Bounds mirror the server-side validation in
  -- src/app/api/extension/progress/route.ts — never trust the caller's
  -- own bounds, re-checked here regardless of what already ran upstream.
  if p_new_season is null or p_new_season < 1 or p_new_season > 999 then
    raise exception 'apply_extension_season_episode_progress: invalid season %', p_new_season;
  end if;
  if p_new_episode is null or p_new_episode < 1 or p_new_episode > 99999 then
    raise exception 'apply_extension_season_episode_progress: invalid episode %', p_new_episode;
  end if;

  -- Row lock: a second concurrent call for the same item blocks here
  -- until this transaction commits or rolls back, then observes whatever
  -- this call left behind rather than the pre-update state — same
  -- mechanism as apply_extension_progress (0004).
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

  v_numbering := v_row.metadata->>'episodeNumbering';

  -- Never reinterpret an item that is explicitly absolute, or implicitly
  -- absolute because it already has real progress with no seasonal marker
  -- at all (every legacy item, every AniList-synced item).
  if v_numbering = 'absolute' or (v_numbering is null and (v_row.metadata ? 'currentEpisode')) then
    return jsonb_build_object('status', 'numbering_mismatch');
  end if;

  v_current_season := (v_row.metadata->>'currentSeason')::integer;
  v_current_episode := coalesce((v_row.metadata->>'currentEpisode')::numeric, 0);

  if v_current_season is not null then
    -- Lexicographic (season, episode) comparison: a lower season is
    -- always behind, even with a much higher episode number (the "S1E20
    -- must not beat S2E1" case); within the same season, only a strictly
    -- higher episode advances.
    if p_new_season < v_current_season or (p_new_season = v_current_season and p_new_episode < v_current_episode) then
      return jsonb_build_object('status', 'behind_current_progress', 'currentSeason', v_current_season, 'currentEpisode', v_current_episode);
    end if;
    if p_new_season = v_current_season and p_new_episode = v_current_episode then
      return jsonb_build_object('status', 'unchanged', 'currentSeason', v_current_season, 'currentEpisode', v_current_episode);
    end if;
  end if;
  -- Otherwise: a strictly higher season (regardless of episode), a higher
  -- episode within the same season, or this item's very first seasonal
  -- position (v_current_season is null) — all advance.

  v_new_metadata := jsonb_set(v_row.metadata, array['currentSeason'], to_jsonb(p_new_season), true);
  v_new_metadata := jsonb_set(v_new_metadata, array['currentEpisode'], to_jsonb(p_new_episode), true);
  v_new_metadata := jsonb_set(v_new_metadata, array['episodeNumbering'], to_jsonb('seasonal'::text), true);

  v_previous_status := v_row.status;
  v_new_status := v_previous_status;
  -- Mirrors autoAdvanceStatus() in src/lib/tracking.ts: a 'planned' item
  -- becomes 'in_progress' the moment it has any real seasonal position at
  -- all (there is no meaningful "0" to compare against the way a numeric
  -- progress value has one).
  if v_previous_status = 'planned' then
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
      'progressKind', 'season_episode',
      'previousSeason', v_current_season,
      'previousValue', v_current_episode,
      'newSeason', p_new_season,
      'newValue', p_new_episode,
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

  return jsonb_build_object('status', 'updated', 'currentSeason', p_new_season, 'currentEpisode', p_new_episode, 'statusChanged', v_status_changed);
end;
$$;

-- SECURITY INVOKER (the default, stated explicitly) — same reasoning as
-- apply_extension_progress (0004): this function does not bypass Row
-- Level Security on its own, and is called only through the server-only
-- admin client. Locked down further below anyway, matching this
-- codebase's habit of not relying on convention alone for an access
-- boundary.
revoke all on function public.apply_extension_season_episode_progress(uuid, uuid, text, integer, integer) from public;
revoke all on function public.apply_extension_season_episode_progress(uuid, uuid, text, integer, integer) from anon, authenticated;
grant execute on function public.apply_extension_season_episode_progress(uuid, uuid, text, integer, integer) to service_role;
