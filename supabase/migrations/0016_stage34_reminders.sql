-- Stage 34: reminders & notification center.
--
-- Run this against your Supabase project after 0001-0015 (all already
-- applied — 0012 in particular is DEPLOYED and IMMUTABLE; this migration
-- never edits it, only layers a `create or replace` of the same function
-- names/signatures on top, the same precedent 0010/0011/0012 already set
-- for 0009). NOT YET DEPLOYED as of this writing — see the Stage 34
-- report: schema/RLS/CRUD/cross-user-isolation/duplicate-create-race/
-- delete-undo/merge-undo/identical-release-reminder-merge/conflicted-undo
-- validation against a real database is a SEPARATE, later round. This
-- migration may be freely edited in place until it is actually deployed;
-- once deployed it becomes immutable like every migration before it.
--
-- ============================================================
-- Why this exists
-- ============================================================
-- Two reminder kinds (RELEASE, tied to a Stage 33 ReleaseEvent target, and
-- CONTINUE, a manual "come back to this" alarm), persisted per-device
-- locally when signed out and cross-device here when signed in. A release
-- reminder is identified by a STABLE provider/media/episode target, never
-- by its stored `scheduled_for` snapshot — see lib/reminders.ts's own doc
-- comment for the full reasoning (a schedule can change; the identity
-- cannot). No new delivery mechanism is introduced here (no cron, no Edge
-- Function scheduling, no push) — this migration is persistence only.
--
-- Two more responsibilities layer on top of the already-deployed Stage
-- 27/28 recovery RPCs, exactly the way 0010/0012 layered onto 0009:
--   1. delete_library_item_with_recovery must snapshot an item's reminders
--      before they CASCADE away with it, so Undo can restore them.
--   2. merge_library_items must decide, per duplicate reminder, whether it
--      moves to the survivor untouched or is an exact logical duplicate of
--      one the survivor already has (same release target, or same
--      continue instant) — in which case it's deleted rather than moved,
--      with its full row snapshotted so Undo can still split it back out.
-- undo_library_recovery reverses both of the above from the stored
-- payload, inside the same transactional safety net (row-lock +
-- re-validation) it already provides for library_items/collections/
-- activity_events.
--
-- ============================================================
-- reminders
-- ============================================================
-- Composite uniqueness backing reminders' composite FK below (Issue A of
-- the pre-deployment correctness review). `id` alone is already the
-- primary key (globally unique) — this adds no new uniqueness guarantee,
-- it only gives Postgres a NAMED (id, user_id) pair a composite foreign
-- key can target. This is an ADDITIVE alter to the already-deployed 0001
-- table, made here in 0016 (0001 itself is never edited), the same way
-- every later migration in this project extends earlier tables.
alter table public.library_items
  add constraint library_items_id_user_id_key unique (id, user_id);

create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Same lifecycle choice as collection_items/activity_events (see 0009's
  -- own doc comment): CASCADE, with the delete-with-recovery RPC below
  -- capturing an explicit snapshot BEFORE the cascade runs, so Undo is
  -- exact — never SET NULL (unlike tracking_sources), since a reminder
  -- with no owning item is never meaningful to keep dangling.
  --
  -- Issue A of the pre-deployment correctness review: a single-column FK
  -- to library_items(id) only proves the referenced item EXISTS, never
  -- that it belongs to THIS row's own user_id — traced concretely, an
  -- authenticated User A who merely knows another user B's LibraryItem
  -- UUID could otherwise INSERT a self-owned reminder (user_id = A)
  -- pointing at library_item_id = B's item, since the old single-column
  -- FK and the plain `auth.uid() = user_id` RLS check never cross-
  -- reference each other. library_item_id is therefore NOT its own
  -- column-level FK — it participates ONLY in the composite FK below,
  -- which requires the EXACT (library_item_id, user_id) pair to exist as
  -- a row in library_items, making a cross-user reference impossible to
  -- create in the first place (Issue A4) — a structural guarantee that
  -- reaches every code path, including the three SECURITY DEFINER
  -- functions below, which RLS itself never applies to at all.
  library_item_id uuid not null,
  kind text not null check (kind in ('release', 'continue')),
  -- Release-only fields (null for kind = 'continue'). `provider` is
  -- constrained to 'anilist' today (the only Stage 33 provider) but kept
  -- as a text column, not a hardcoded literal, matching
  -- types/release-event.ts's own ReleaseEventProvider being an extensible
  -- union rather than a boolean flag.
  provider text,
  external_media_id text,
  episode integer,
  scheduled_for timestamptz,
  remind_before_minutes integer,
  -- Continue-only field (null for kind = 'release').
  remind_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  -- Explicit, application-set on every write — never a DB trigger. Matches
  -- library_items/collections/tracking_sources' own convention (Phase 0
  -- confirmed no table in this schema uses a trigger for this).
  updated_at timestamptz,
  constraint reminders_kind_fields_check check (
    (
      kind = 'release'
      and provider is not null
      and external_media_id is not null
      and episode is not null
      and scheduled_for is not null
      and remind_before_minutes is not null
      and remind_at is null
    )
    or
    (
      kind = 'continue'
      and remind_at is not null
      and provider is null
      and external_media_id is null
      and episode is null
      and scheduled_for is null
      and remind_before_minutes is null
    )
  ),
  constraint reminders_provider_check check (provider is null or provider = 'anilist'),
  -- Sensible bounds (Issue E of the correctness review) — 0 is a valid
  -- lead time ("at release time"); 43200 (30 days) comfortably covers the
  -- six presets (max 1440) plus room for a future custom/longer lead
  -- option without allowing a pathological value. Deliberately NOT
  -- capped at exactly the app's current six presets — the app enforcing a
  -- narrower UI choice than the DB allows is fine and future-friendly.
  constraint reminders_remind_before_minutes_check check (remind_before_minutes is null or (remind_before_minutes >= 0 and remind_before_minutes <= 43200)),
  -- AniList (and every provider this app has ever integrated) numbers
  -- episodes starting at 1 — matches lib/release-calendar.ts's own
  -- normalizer, which already treats episode 0 as invalid
  -- (`entry.episode > 0`, not `>= 0`). Deliberately NOT `remind_at >
  -- now()` for continue reminders anywhere in this file — a valid
  -- reminder is EXPECTED to become historical/due as time passes; that is
  -- its whole purpose, never a constraint violation.
  constraint reminders_episode_check check (episode is null or episode > 0),
  -- A positive integer, as text (matching CatalogSourceReference.externalId
  -- and ReleaseEvent.externalMediaId's own string representation) — never
  -- zero, negative, or non-numeric. Mirrors buildAniListMediaAssociation's
  -- own `Number.isInteger(mediaId) && mediaId > 0` validation.
  constraint reminders_external_media_id_check check (external_media_id is null or external_media_id ~ '^[1-9][0-9]*$'),
  -- THE fix for Issue A: requires the EXACT (library_item_id, user_id)
  -- pair to exist as a row in library_items — not just library_item_id
  -- alone. A row with library_item_id pointing at another user's item can
  -- never be inserted OR updated into existence, regardless of which code
  -- path attempts it (a plain RLS-checked client write, or a SECURITY
  -- DEFINER function's internal write), because Postgres enforces FK
  -- constraints unconditionally — they are not RLS policies and are never
  -- bypassed by SECURITY DEFINER. ON DELETE CASCADE fires exactly when
  -- the referenced library_items row (id, user_id) is deleted, which is
  -- the same trigger condition the old single-column FK had (a
  -- library_items row's user_id never changes after insert).
  constraint reminders_library_item_owner_fkey
    foreign key (library_item_id, user_id) references public.library_items (id, user_id) on delete cascade
);

create index if not exists reminders_user_item_idx on public.reminders (user_id, library_item_id);

-- Backs duplicate-create/edit collapsing to one logical reminder — see
-- lib/reminders.ts's findActiveReminderCollision, which enforces the
-- IDENTICAL rule in memory first (fast, no round trip); these indexes are
-- the real authority for a genuine race between two tabs/devices. A
-- dismissed row is excluded from both (`dismissed_at is null`) so
-- historical/dismissed reminders never block creating a fresh one.
create unique index if not exists reminders_release_identity_idx
  on public.reminders (user_id, library_item_id, provider, external_media_id, episode)
  where kind = 'release' and dismissed_at is null;

create unique index if not exists reminders_continue_identity_idx
  on public.reminders (user_id, library_item_id, remind_at)
  where kind = 'continue' and dismissed_at is null;

alter table public.reminders enable row level security;

-- Plain owner-scoped CRUD, like collections/library_items/tracking_sources
-- — unlike library_recovery_actions, reminders has no reason to lock down
-- client INSERT/UPDATE: dismiss/edit/delete are ordinary user actions with
-- no server-recomputed trust boundary to protect (contrast merge's
-- progress fields, which DO need that — see 0009's doc comment). No
-- explicit GRANT/REVOKE statements — matches every other ordinary table in
-- this schema (0001-0010), which rely on the project's default privileges
-- for `authenticated` and never state a table-level grant explicitly.
drop policy if exists "reminders_select_own" on public.reminders;
create policy "reminders_select_own" on public.reminders for select using (auth.uid() = user_id);

-- INSERT/UPDATE both re-check ownership of the REFERENCED library_item, in
-- addition to auth.uid() = user_id — belt and suspenders on top of the
-- reminders_library_item_owner_fkey composite FK above (Issue A), the same
-- "the security boundary must not depend solely on which single mechanism
-- turns out to be right" philosophy 0011 already established for this
-- project. This EXISTS also gives a client-facing PostgREST rejection
-- (42501, "violates row-level security policy") for the common case,
-- rather than surfacing a raw FK-violation error — though the FK alone is
-- what makes the forgery structurally impossible even if this check were
-- ever removed by mistake. The subquery only ever sees rows library_items'
-- OWN RLS already permits the caller to see (its own rows), so this reads
-- correctly under authenticated PostgREST regardless.
drop policy if exists "reminders_insert_own" on public.reminders;
create policy "reminders_insert_own" on public.reminders for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.library_items li
      where li.id = library_item_id and li.user_id = auth.uid()
    )
  );

drop policy if exists "reminders_update_own" on public.reminders;
create policy "reminders_update_own" on public.reminders for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.library_items li
      where li.id = library_item_id and li.user_id = auth.uid()
    )
  );

drop policy if exists "reminders_delete_own" on public.reminders;
create policy "reminders_delete_own" on public.reminders for delete using (auth.uid() = user_id);

-- ============================================================
-- delete_library_item_with_recovery — re-defined (same signature/contract
-- as 0012) to additionally snapshot the item's reminders before they
-- CASCADE away, so Undo can restore them. Every 0012 behavior is preserved
-- verbatim otherwise.
-- ============================================================
create or replace function public.delete_library_item_with_recovery(
  p_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_item public.library_items%rowtype;
  v_collection_ids jsonb;
  v_activity jsonb;
  v_source_ids jsonb;
  v_reminders jsonb;
  v_recovery_id uuid;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

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

  -- Stage 34 — snapshot every reminder for this item BEFORE it CASCADEs
  -- away with the library_items row below (raw row shape, restored
  -- verbatim by undo_library_recovery's delete_item branch).
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_reminders
  from public.reminders r where r.library_item_id = p_item_id and r.user_id = v_uid;

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
      'sourceIds', v_source_ids,
      'reminders', v_reminders
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
-- merge_library_items — re-defined (same signature/contract as 0012) to
-- additionally reassign or dedupe-and-delete the duplicate's reminders.
-- Every 0012 behavior is preserved verbatim otherwise: field-merge trust
-- boundary, progress recomputation, conflict blocking, tracking_sources/
-- collection_items/activity_events transfer mechanics, deterministic lock
-- ordering, SECURITY DEFINER + search_path hardening.
-- ============================================================
create or replace function public.merge_library_items(
  p_survivor_id uuid,
  p_duplicate_id uuid,
  p_merged_row jsonb
)
returns jsonb
language plpgsql
security definer
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
  v_survivor_activity_ids jsonb;
  v_survivor_after public.library_items%rowtype;
  -- Stage 34
  v_deduped_reminders jsonb;
  v_moved_reminder_ids jsonb;
  v_survivor_post_merge_reminders jsonb;
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
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_survivor_activity_ids
  from public.activity_events where item_id = p_survivor_id and user_id = v_uid;

  -- Stage 34 — decide, per duplicate reminder, whether it moves to the
  -- survivor untouched or is an exact logical duplicate of one the
  -- survivor already has (same release target, or same continue instant —
  -- mirrors lib/reminders.ts's findActiveReminderCollision exactly). A
  -- dismissed duplicate reminder is never a candidate for dedup (matches
  -- the partial unique indexes' own `dismissed_at is null` scope) and
  -- always moves. `x.is_dup` is stripped from the snapshotted jsonb (it's
  -- a derived column, not a real reminders column).
  select
    coalesce(jsonb_agg(to_jsonb(x) - 'is_dup') filter (where x.is_dup), '[]'::jsonb),
    coalesce(jsonb_agg(x.id) filter (where not x.is_dup), '[]'::jsonb)
  into v_deduped_reminders, v_moved_reminder_ids
  from (
    select
      r.*,
      (
        r.dismissed_at is null
        and exists (
          select 1 from public.reminders sr
          where sr.library_item_id = p_survivor_id
            and sr.user_id = v_uid
            and sr.dismissed_at is null
            and sr.kind = r.kind
            and (
              (r.kind = 'release' and sr.provider = r.provider and sr.external_media_id = r.external_media_id and sr.episode = r.episode)
              or (r.kind = 'continue' and sr.remind_at = r.remind_at)
            )
        )
      ) as is_dup
    from public.reminders r
    where r.library_item_id = p_duplicate_id and r.user_id = v_uid
  ) x;

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

  update public.tracking_sources
  set library_item_id = p_survivor_id, updated_at = v_now
  where library_item_id = p_duplicate_id and user_id = v_uid;

  -- Stage 34 — reassign moved reminders via a plain UPDATE (reminders has
  -- a real UPDATE policy, unlike collection_items/activity_events — see
  -- this migration's own header), then delete the deduplicated ones
  -- outright now that their full data is safely snapshotted above. Moved
  -- BEFORE the recovery-payload insert (unlike earlier tables' mutations,
  -- which historically ran after) specifically so the reminder snapshot
  -- captured just below reflects the true POST-merge state — the same
  -- "re-read what Postgres actually stored" reasoning v_survivor_after
  -- already uses for the survivor's own row.
  update public.reminders
  set library_item_id = p_survivor_id, updated_at = v_now
  where library_item_id = p_duplicate_id and user_id = v_uid
    and id in (select jsonb_array_elements_text(v_moved_reminder_ids)::uuid);

  delete from public.reminders
  where library_item_id = p_duplicate_id and user_id = v_uid
    and id in (select (r->>'id')::uuid from jsonb_array_elements(v_deduped_reminders) r);

  -- Correctness-review fix (Issue B) — the survivor's ENTIRE post-merge
  -- reminder set (its own untouched reminders plus whatever just moved
  -- in), captured as an ordered array of full rows. undo_library_recovery
  -- compares this exact array against the survivor's CURRENT reminder set
  -- before restoring anything: any reminder deleted, edited, or dismissed
  -- since the merge (B1-B4), OR a brand new one created on the survivor
  -- since (B5), makes the current set differ from this one, which blocks
  -- Undo — the same "compare full row content to what was captured right
  -- after the write" technique v_survivor_after already uses, generalized
  -- to a set. `order by id` makes the two sides comparable with a plain
  -- `is distinct from` at Undo time, with no need for a multiset-aware
  -- comparison.
  select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]'::jsonb) into v_survivor_post_merge_reminders
  from public.reminders r where r.library_item_id = p_survivor_id and r.user_id = v_uid;

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
      'movedActivityIds', v_moved_activity_ids,
      'survivorPreMergeActivityIds', v_survivor_activity_ids,
      'movedReminderIds', v_moved_reminder_ids,
      'deduplicatedReminderSnapshots', v_deduped_reminders,
      'survivorPostMergeRemindersExpected', v_survivor_post_merge_reminders
    ),
    v_now,
    v_now + interval '15 minutes'
  );

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

-- ============================================================
-- undo_library_recovery — re-defined (same signature/contract as 0012) to
-- additionally restore reminders for both action types. Every 0012
-- behavior is preserved verbatim otherwise, including the advisory-lock
-- serialization and the clock-independent activity-topology check.
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
  v_item jsonb;
  v_collection_ids jsonb;
  v_activity_events jsonb;
  v_source_ids jsonb;
  v_delete_reminders jsonb;
  v_survivor_id uuid;
  v_duplicate_id uuid;
  v_survivor_pre jsonb;
  v_duplicate_pre jsonb;
  v_survivor_post_expected jsonb;
  v_survivor_collection_ids jsonb;
  v_duplicate_collection_ids jsonb;
  v_moved_source_ids jsonb;
  v_moved_activity_ids jsonb;
  v_survivor_activity_ids jsonb;
  v_moved_reminder_ids jsonb;
  v_deduped_reminder_snapshots jsonb;
  v_survivor_post_merge_reminders_expected jsonb;
  v_current_survivor_reminders jsonb;
  v_current_survivor public.library_items%rowtype;
  v_topology_mismatch boolean;
  v_activity_topology_mismatch boolean;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

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
    -- Stage 34 — absent on a pre-Stage-34 recovery record; coalesced to
    -- '[]' means "nothing to restore," which is also literally true for
    -- any such record (reminders didn't exist yet).
    v_delete_reminders := coalesce(v_recovery.payload->'reminders', '[]'::jsonb);

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

    -- Stage 34 — reinsert every reminder verbatim (same id/every field),
    -- once the item itself exists again to satisfy the FK.
    insert into public.reminders (id, user_id, library_item_id, kind, provider, external_media_id, episode, scheduled_for, remind_before_minutes, remind_at, dismissed_at, created_at, updated_at)
    select
      (r->>'id')::uuid,
      v_uid,
      (v_item->>'id')::uuid,
      r->>'kind',
      r->>'provider',
      r->>'external_media_id',
      (r->>'episode')::integer,
      case when r->>'scheduled_for' is null then null else (r->>'scheduled_for')::timestamptz end,
      (r->>'remind_before_minutes')::integer,
      case when r->>'remind_at' is null then null else (r->>'remind_at')::timestamptz end,
      case when r->>'dismissed_at' is null then null else (r->>'dismissed_at')::timestamptz end,
      (r->>'created_at')::timestamptz,
      case when r->>'updated_at' is null then null else (r->>'updated_at')::timestamptz end
    from jsonb_array_elements(v_delete_reminders) r;

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
    v_survivor_activity_ids := coalesce(v_recovery.payload->'survivorPreMergeActivityIds', '[]'::jsonb);
    -- Stage 34 — absent on a pre-Stage-34 recovery record; '[]' means
    -- "nothing to restore," which is also literally true for any such
    -- record.
    v_moved_reminder_ids := coalesce(v_recovery.payload->'movedReminderIds', '[]'::jsonb);
    v_deduped_reminder_snapshots := coalesce(v_recovery.payload->'deduplicatedReminderSnapshots', '[]'::jsonb);
    -- Correctness-review fix (Issue B) — deliberately NOT coalesced to
    -- '[]': absence (a genuinely pre-Stage-34 record) means "skip this
    -- check, there is nothing to compare" (see the `is not null` guard
    -- below), which is a different meaning from "expected exactly zero
    -- reminders on the survivor" (a real, assertable Stage 34 result).
    v_survivor_post_merge_reminders_expected := v_recovery.payload->'survivorPostMergeRemindersExpected';

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
      select 1 from (
        (
          select id from public.activity_events
          where item_id = v_survivor_id and user_id = v_uid
          except
          select cid::uuid from jsonb_array_elements_text(v_survivor_activity_ids || v_moved_activity_ids) cid
        )
        union all
        (
          select cid::uuid from jsonb_array_elements_text(v_survivor_activity_ids || v_moved_activity_ids) cid
          except
          select id from public.activity_events
          where item_id = v_survivor_id and user_id = v_uid
        )
      ) as diff
    ) into v_activity_topology_mismatch;
    if v_activity_topology_mismatch then
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

    -- Correctness-review fix (Issue B) — the survivor's reminder set must
    -- be BYTE-IDENTICAL to what the merge itself produced. This single
    -- full-row-content comparison (not just an id-set diff, since unlike
    -- activity_events/collection_items a reminder row IS mutable) blocks
    -- Undo whenever ANY of the following happened since the merge: a
    -- moved reminder was deleted (B1), edited (B2), or dismissed (B3); the
    -- survivor's own untouched reminder was edited/dismissed/deleted
    -- (B4); or a brand-new reminder was created on the survivor (B5) —
    -- exactly the same "any real change blocks Undo" rule already applied
    -- to activity_events above, chosen for consistency rather than
    -- inventing separate reminder-specific semantics. Runs BEFORE any
    -- mutation in this function (Issue B7), so a conflict here leaves
    -- every table — including reminders — completely untouched, the same
    -- guarantee every other conflict check in this function already
    -- provides. Skipped entirely (never a false conflict) only for a
    -- genuinely pre-Stage-34 record, where the key is absent.
    if v_survivor_post_merge_reminders_expected is not null then
      select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]'::jsonb) into v_current_survivor_reminders
      from public.reminders r where r.library_item_id = v_survivor_id and r.user_id = v_uid;

      if v_current_survivor_reminders is distinct from v_survivor_post_merge_reminders_expected then
        return jsonb_build_object('status', 'recovery_conflict', 'reason', 'reminders_changed');
      end if;
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

    -- Stage 34 — move reminders back to the (just-recreated) duplicate,
    -- then recreate the deduplicated ones verbatim, restoring the exact
    -- pre-merge two-reminder topology.
    update public.reminders
    set library_item_id = v_duplicate_id, updated_at = v_now
    where user_id = v_uid
      and library_item_id = v_survivor_id
      and id in (select jsonb_array_elements_text(v_moved_reminder_ids)::uuid);

    insert into public.reminders (id, user_id, library_item_id, kind, provider, external_media_id, episode, scheduled_for, remind_before_minutes, remind_at, dismissed_at, created_at, updated_at)
    select
      (r->>'id')::uuid,
      v_uid,
      v_duplicate_id,
      r->>'kind',
      r->>'provider',
      r->>'external_media_id',
      (r->>'episode')::integer,
      case when r->>'scheduled_for' is null then null else (r->>'scheduled_for')::timestamptz end,
      (r->>'remind_before_minutes')::integer,
      case when r->>'remind_at' is null then null else (r->>'remind_at')::timestamptz end,
      case when r->>'dismissed_at' is null then null else (r->>'dismissed_at')::timestamptz end,
      (r->>'created_at')::timestamptz,
      case when r->>'updated_at' is null then null else (r->>'updated_at')::timestamptz end
    from jsonb_array_elements(v_deduped_reminder_snapshots) r;

    delete from public.library_recovery_actions where id = p_recovery_id;

    return jsonb_build_object('status', 'recovered', 'actionType', 'merge_items', 'survivorId', v_survivor_id, 'duplicateId', v_duplicate_id);
  end if;

  return jsonb_build_object('status', 'invalid_action');
end;
$$;

revoke all on function public.undo_library_recovery(uuid) from public;
grant execute on function public.undo_library_recovery(uuid) to authenticated;
