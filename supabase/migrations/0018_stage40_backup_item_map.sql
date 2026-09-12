-- Stage 40 data-integrity correction — Part A completion: expose the
-- authoritative backupItemId -> real LibraryItem id mapping that
-- import_library_backup (0013, fixed by 0014 — both already deployed)
-- already computes and holds in pg_temp.import_item_map for the
-- duration of its own transaction, but never returned to the caller.
--
-- NOT YET APPLIED TO PRODUCTION. Created for review and disposable-
-- database validation only — do not run `supabase db push --linked`
-- against production for this file without explicit separate approval.
-- Does not touch 0001-0017 in any way (all immutable — already deployed).
--
-- ============================================================
-- Why this is needed
-- ============================================================
-- Stage 40's Source Hub correction made TrackingSources first-class
-- backed-up, restorable user data (manually linked URLs, manual labels,
-- explicit source configuration). Restoring a TrackingSource requires
-- knowing the REAL id of its parent LibraryItem in the destination
-- account. For an item classified "already_present" at plan time, the
-- client already has that real id (it's in `library.items`, already
-- loaded). For an item classified "new", the real id is generated INSIDE
-- this function's own transaction (`v_new_id := gen_random_uuid()`) and,
-- until now, was never reported back — only aggregate counts
-- (itemsCreated, itemsReused, ...) were. That left source restoration
-- unable to attach anything to a brand-new item without either guessing
-- (fuzzy title/type matching after the fact — explicitly rejected, see
-- the Stage 40 correction's own "no fuzzy matching" rule) or this fix.
--
-- The mapping is not derived again, not recomputed, not queried by
-- title — it is the EXACT SAME `pg_temp.import_item_map` rows this
-- function already builds and uses internally for Collection membership
-- resolution (step 5) and Activity attachment (step 6). This migration
-- only ADDS one more read of that same temp table into the final return
-- value; it changes no other logic.
--
-- ============================================================
-- Scope of this migration — read this before diffing against 0014
-- ============================================================
-- Same signature (p_request_id uuid, p_plan jsonb), same return type
-- (jsonb), same `language plpgsql`, same `security invoker`, same
-- `set search_path = pg_catalog, pg_temp`, same ownership/grant model
-- (revoke all from public; grant execute to authenticated), same
-- double-submit guard, same per-user advisory lock, same record-count
-- bounds, same temp-table `on commit drop` lifetime, same DEFECT 3
-- revalidation logic, same Activity-idempotency rule, same http(s)-only
-- URL guards. This is a `create or replace function` because Postgres
-- has no way to patch a few lines of a function body in place — the
-- ENTIRE body below is byte-for-byte identical to 0014's, with exactly
-- one addition: the final `return jsonb_build_object(...)` now also
-- includes an `itemMap` key. No other statement, expression, ordering,
-- or behavior differs. See the Stage 40 final report's own "0014-vs-0018
-- semantic diff" section for the full line-by-line audit this claim is
-- based on.
--
-- ============================================================
-- itemMap shape and safety
-- ============================================================
-- One object per row already present in THIS call's own
-- pg_temp.import_item_map (session-scoped, `on commit drop`, populated
-- only by THIS function body, only for backupItemId candidates THIS
-- p_plan named and THIS v_uid's transaction created or authoritatively
-- matched — see steps 1 and 4 below): `{backupItemId, realItemId,
-- wasCreated}`. Nothing else. It cannot contain another user's rows: the
-- table is temporary (backend-connection-scoped, dropped at commit) and
-- every insert into it in this function is already gated by the same
-- `v_uid := auth.uid()` ownership checks steps 1 and 4 always enforced —
-- this migration adds no new write path into that table, only one new
-- READ of it, at the very end, of exactly the rows this same call itself
-- just wrote. No user_id, auth/session detail, source data, or secret
-- ever enters it, matching every other field this function has always
-- returned.
--
-- Ordering is explicit (`jsonb_agg(... order by backup_item_id)`), not
-- left to incidental table/aggregate scan order — deterministic across
-- repeated calls with the same plan. An import with zero mapped items
-- returns `itemMap: []` (via `coalesce(..., '[]'::jsonb)`), never `null`,
-- so a client can always safely iterate it without a null check.
--
-- ============================================================
-- Old-client compatibility
-- ============================================================
-- Every existing response key (`status`, `itemsCreated`, `itemsReused`,
-- `collectionsCreated`, `collectionsReused`, `activityCreated`) keeps its
-- exact name, type, and meaning. `itemMap` is a new key an old client
-- simply never reads — `jsonb_build_object` produces a JSON object, and
-- adding a key to it is never a breaking change for any caller that (like
-- lib/cloud/backup-import.ts's own `parseResult`) reads named keys off the
-- response rather than assuming an exact/closed key set.
create or replace function public.import_library_backup(
  p_request_id uuid,
  p_plan jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_item_count int;
  v_collection_create_count int;
  v_collection_reuse_count int;
  v_mapping_count int;
  v_membership_count int;
  v_activity_count int;
  v_items_created int := 0;
  v_items_reused int := 0;
  v_collections_created int := 0;
  v_collections_reused int := 0;
  v_activity_created int := 0;
  rec record;
  v_new_id uuid;
  v_existing_item_id uuid;
  v_existing_collection_id uuid;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if p_request_id is null or p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    return jsonb_build_object('status', 'invalid_plan');
  end if;

  -- Record-count bound checks run BEFORE the double-submit guard's INSERT
  -- (0014's DEFECT 2 fix — unchanged here).
  v_item_count := coalesce(jsonb_array_length(p_plan->'items'), 0);
  v_collection_create_count := coalesce(jsonb_array_length(p_plan->'collectionsToCreate'), 0);
  v_collection_reuse_count := coalesce(jsonb_array_length(p_plan->'collectionsToReuse'), 0);
  v_mapping_count := coalesce(jsonb_array_length(p_plan->'itemMappings'), 0);
  v_membership_count := coalesce(jsonb_array_length(p_plan->'memberships'), 0);
  v_activity_count := coalesce(jsonb_array_length(p_plan->'activity'), 0);

  -- Defense-in-depth bounds — the browser-side validator (lib/backup/
  -- limits.ts) already enforces these; re-checked here because "client
  -- validation is not security."
  if v_item_count > 5000
     or (v_collection_create_count + v_collection_reuse_count) > 200
     or v_mapping_count > 5000
     or v_membership_count > 250000
     or v_activity_count > 50000
  then
    return jsonb_build_object('status', 'plan_too_large');
  end if;

  -- Per-user serialization (0014's DEFECT 3 fix — unchanged here). Held
  -- for the rest of the transaction, released automatically at
  -- commit/rollback; a second concurrent call for the SAME user blocks
  -- here until the first finishes, then proceeds against whatever the
  -- first actually committed. Calls for DIFFERENT users never contend.
  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  -- Double-submit guard — must be the first WRITE (the read-only size
  -- checks above it don't count).
  begin
    insert into public.backup_import_requests (id, user_id) values (p_request_id, v_uid);
  exception when unique_violation then
    return jsonb_build_object('status', 'duplicate_request');
  end;

  -- `on commit drop` on both temp tables (0014's DEFECT 1 fix —
  -- unchanged here).
  create temporary table pg_temp.import_item_map (
    backup_item_id text primary key,
    real_item_id uuid not null,
    was_created boolean not null
  ) on commit drop;
  create temporary table pg_temp.import_collection_map (
    backup_collection_id text primary key,
    real_collection_id uuid not null
  ) on commit drop;

  -- 1. Create new LibraryItems. Under the per-user advisory lock, so this
  -- sees the fully-committed result of any prior concurrent call for this
  -- same user, not a stale snapshot.
  for rec in
    select * from jsonb_to_recordset(coalesce(p_plan->'items', '[]'::jsonb)) as x(
      "backupItemId" text, "type" text, "title" text, description text, category text,
      tags jsonb, favorite boolean, "createdAt" timestamptz, "updatedAt" timestamptz,
      url text, "imageUrl" text, "sourceUrl" text, "releaseYear" int, "catalogSource" jsonb,
      status text, rating numeric,
      "currentEpisode" numeric, "totalEpisodes" numeric, "episodeNumbering" text, "currentSeason" numeric,
      genres jsonb, studio text,
      "currentChapter" numeric, "totalChapters" numeric, authors jsonb,
      "progressValue" numeric, "progressUnit" text, "pageCount" numeric, "readingFormat" text,
      platform text, "playtimeHours" numeric, developer text, publisher text, "catalogPlatforms" jsonb,
      "possibleDuplicateOptIn" boolean
    )
  loop
    if rec."backupItemId" is null or rec."type" is null or rec."title" is null then
      continue;
    end if;

    v_existing_item_id := null;

    -- DEFECT 3 revalidation — unchanged. Never run for an item the user
    -- explicitly opted to import as a separate copy despite being a
    -- possible duplicate: that intent must survive regardless of what
    -- else exists.
    if not coalesce(rec."possibleDuplicateOptIn", false) then
      if rec."catalogSource" is not null then
        select li.id into v_existing_item_id
        from public.library_items li
        where li.user_id = v_uid
          and li.type = rec."type"
          and li.metadata->'catalogSource'->>'provider' = rec."catalogSource"->>'provider'
          and li.metadata->'catalogSource'->>'externalId' = rec."catalogSource"->>'externalId'
        limit 1;
      end if;

      if v_existing_item_id is null then
        if exists (
          select 1
          from public.library_items li
          where li.user_id = v_uid
            and li.type = rec."type"
            and public.normalize_title_for_matching(li.title) = public.normalize_title_for_matching(rec."title")
            -- Withhold the match on conflicting catalogSource ids, exactly
            -- like classifyItem's own rule — never on a mere title
            -- coincidence when both sides claim a DIFFERENT authoritative
            -- identity.
            and not (
              rec."catalogSource" is not null
              and li.metadata->'catalogSource' is not null
              and (
                li.metadata->'catalogSource'->>'provider' <> rec."catalogSource"->>'provider'
                or li.metadata->'catalogSource'->>'externalId' <> rec."catalogSource"->>'externalId'
              )
            )
        ) then
          -- Title-only match: never authoritative, never silently
          -- attached — same conservative rule as the normal (non-race)
          -- flow. Skip this ONE candidate: no insert, no map entry.
          continue;
        end if;
      end if;
    end if;

    if v_existing_item_id is not null then
      -- Authoritative race match: treat exactly like a normal
      -- client-supplied itemMappings entry (was_created = false) — safe
      -- to attach Collection membership, never Activity (step 6 already
      -- excludes any mapping with was_created = false), and now also
      -- reported in itemMap so source restoration can attach here too.
      insert into pg_temp.import_item_map (backup_item_id, real_item_id, was_created)
      values (rec."backupItemId", v_existing_item_id, false)
      on conflict (backup_item_id) do nothing;
      v_items_reused := v_items_reused + 1;
      continue;
    end if;

    v_new_id := gen_random_uuid();

    insert into public.library_items (
      id, user_id, type, title, description, category, tags, favorite,
      image_url, source_url, url, status, rating, metadata, created_at, updated_at
    )
    values (
      v_new_id, v_uid, rec."type", rec."title",
      coalesce(rec.description, ''), coalesce(rec.category, ''),
      coalesce((select array_agg(t) from jsonb_array_elements_text(coalesce(rec.tags, '[]'::jsonb)) t), '{}'),
      coalesce(rec.favorite, false),
      case when rec."imageUrl" ~* '^https?://' then rec."imageUrl" else null end,
      case when rec."sourceUrl" ~* '^https?://' then rec."sourceUrl" else null end,
      case when rec.url ~* '^https?://' then rec.url else null end,
      rec.status, rec.rating,
      jsonb_strip_nulls(jsonb_build_object(
        'releaseYear', rec."releaseYear", 'catalogSource', rec."catalogSource",
        'currentEpisode', rec."currentEpisode", 'totalEpisodes', rec."totalEpisodes",
        'episodeNumbering', rec."episodeNumbering", 'currentSeason', rec."currentSeason",
        'genres', rec.genres, 'studio', rec.studio,
        'currentChapter', rec."currentChapter", 'totalChapters', rec."totalChapters", 'authors', rec.authors,
        'progressValue', rec."progressValue", 'progressUnit', rec."progressUnit",
        'pageCount', rec."pageCount", 'readingFormat', rec."readingFormat",
        'platform', rec.platform, 'playtimeHours', rec."playtimeHours",
        'developer', rec.developer, 'publisher', rec.publisher, 'catalogPlatforms', rec."catalogPlatforms"
      )),
      coalesce(rec."createdAt", v_now),
      rec."updatedAt"
    );

    insert into pg_temp.import_item_map (backup_item_id, real_item_id, was_created)
    values (rec."backupItemId", v_new_id, true)
    on conflict (backup_item_id) do nothing;

    v_items_created := v_items_created + 1;
  end loop;

  -- 2. Create new Collections. Same DEFECT 3 revalidation as items above.
  for rec in
    select * from jsonb_to_recordset(coalesce(p_plan->'collectionsToCreate', '[]'::jsonb)) as x(
      "backupCollectionId" text, name text, description text, "createdAt" timestamptz
    )
  loop
    if rec."backupCollectionId" is null or rec.name is null then
      continue;
    end if;

    select c.id into v_existing_collection_id
    from public.collections c
    where c.user_id = v_uid
      and trim(lower(c.name)) = trim(lower(rec.name))
    limit 1;

    if v_existing_collection_id is not null then
      insert into pg_temp.import_collection_map (backup_collection_id, real_collection_id)
      values (rec."backupCollectionId", v_existing_collection_id)
      on conflict (backup_collection_id) do nothing;
      v_collections_reused := v_collections_reused + 1;
      continue;
    end if;

    v_new_id := gen_random_uuid();
    insert into public.collections (id, user_id, name, description, created_at)
    values (v_new_id, v_uid, rec.name, rec.description, coalesce(rec."createdAt", v_now));

    insert into pg_temp.import_collection_map (backup_collection_id, real_collection_id)
    values (rec."backupCollectionId", v_new_id)
    on conflict (backup_collection_id) do nothing;

    v_collections_created := v_collections_created + 1;
  end loop;

  -- 3. Reuse existing Collections — ownership independently re-verified.
  for rec in
    select * from jsonb_to_recordset(coalesce(p_plan->'collectionsToReuse', '[]'::jsonb)) as x(
      "backupCollectionId" text, "existingCollectionId" uuid
    )
  loop
    if rec."backupCollectionId" is null or rec."existingCollectionId" is null then
      continue;
    end if;
    if not exists (select 1 from public.collections c where c.id = rec."existingCollectionId" and c.user_id = v_uid) then
      continue;
    end if;

    insert into pg_temp.import_collection_map (backup_collection_id, real_collection_id)
    values (rec."backupCollectionId", rec."existingCollectionId")
    on conflict (backup_collection_id) do nothing;

    v_collections_reused := v_collections_reused + 1;
  end loop;

  -- 4. "Already present" item identity mappings — ownership independently
  -- re-verified. Used for Collection membership resolution below, and
  -- (new in this migration) also surfaced in the returned itemMap so
  -- source restoration can attach to these too.
  for rec in
    select * from jsonb_to_recordset(coalesce(p_plan->'itemMappings', '[]'::jsonb)) as x(
      "backupItemId" text, "existingItemId" uuid
    )
  loop
    if rec."backupItemId" is null or rec."existingItemId" is null then
      continue;
    end if;
    if not exists (select 1 from public.library_items li where li.id = rec."existingItemId" and li.user_id = v_uid) then
      continue;
    end if;

    insert into pg_temp.import_item_map (backup_item_id, real_item_id, was_created)
    values (rec."backupItemId", rec."existingItemId", false)
    on conflict (backup_item_id) do nothing;
  end loop;

  -- 5. Collection memberships — resolved purely via the maps just built.
  -- A pair referencing an unresolvable backup id (a skipped possible-
  -- duplicate, or a stale/malformed reference) simply matches nothing and
  -- is silently skipped — never an error, never a fabricated membership.
  for rec in
    select * from jsonb_to_recordset(coalesce(p_plan->'memberships', '[]'::jsonb)) as x(
      "backupCollectionId" text, "backupItemId" text
    )
  loop
    insert into public.collection_items (collection_id, item_id, user_id, added_at)
    select cm.real_collection_id, im.real_item_id, v_uid, v_now
    from pg_temp.import_collection_map cm
    join pg_temp.import_item_map im on im.backup_item_id = rec."backupItemId"
    where cm.backup_collection_id = rec."backupCollectionId"
    on conflict (collection_id, item_id) do nothing;
  end loop;

  -- 6. Activity — ONLY for items this call just created (was_created =
  -- true), regardless of what the client's plan included.
  for rec in
    select * from jsonb_to_recordset(coalesce(p_plan->'activity', '[]'::jsonb)) as x(
      "backupItemId" text, "type" text, "timestamp" timestamptz,
      "progressKind" text, "previousValue" numeric, "newValue" numeric,
      "previousSeason" numeric, "newSeason" numeric,
      "previousStatus" text, "newStatus" text
    )
  loop
    if rec."backupItemId" is null or rec."type" is null or rec."timestamp" is null then
      continue;
    end if;

    select im.real_item_id into v_new_id
    from pg_temp.import_item_map im
    where im.backup_item_id = rec."backupItemId" and im.was_created = true;

    if v_new_id is null then
      continue;
    end if;

    insert into public.activity_events (id, user_id, item_id, type, data, created_at)
    values (
      gen_random_uuid(), v_uid, v_new_id, rec."type",
      case rec."type"
        when 'progress_updated' then jsonb_strip_nulls(jsonb_build_object(
          'progressKind', rec."progressKind", 'previousValue', rec."previousValue", 'newValue', rec."newValue",
          'previousSeason', rec."previousSeason", 'newSeason', rec."newSeason"
        ))
        when 'rating_updated' then jsonb_strip_nulls(jsonb_build_object('previousValue', rec."previousValue", 'newValue', rec."newValue"))
        when 'status_updated' then jsonb_strip_nulls(jsonb_build_object('previousValue', rec."previousStatus", 'newValue', rec."newStatus"))
        else '{}'::jsonb
      end,
      rec."timestamp"
    );

    v_activity_created := v_activity_created + 1;
  end loop;

  -- ============================================================
  -- Security audit: server-enforced vs client-only validation
  -- ============================================================
  -- Identical to 0014's own audit (nothing about the trust model below
  -- changes in this migration): user_id on every row is always
  -- auth.uid(); ownership of every "existing" id is independently
  -- re-verified; record-count limits are re-checked server-side; Activity
  -- idempotency is enforced server-side regardless of what the plan's own
  -- `activity` array contains; url/imageUrl/sourceUrl protocol is
  -- http(s)-only; concurrent duplicate creation is prevented by the
  -- per-user advisory lock plus commit-time revalidation. This migration
  -- adds NO new server-enforced or client-only-trusted field — `itemMap`
  -- is a pure READ of rows this same call already wrote under those same
  -- guarantees, never a new input or a new trust boundary.
  --
  -- Stage 40 addition: `itemMap` (backupItemId/realItemId/wasCreated for
  -- every item this call created OR authoritatively matched) is now
  -- returned so the client can restore TrackingSources against the real
  -- id of an item that was newly created by THIS SAME import — the one
  -- gap the original Stage 40 correction could not close without this
  -- exact change (see that correction's own final report). Deterministic
  -- order (`order by backup_item_id` inside the aggregate); `[]`, never
  -- `null`, when there is nothing to report.
  return jsonb_build_object(
    'status', 'imported',
    'itemsCreated', v_items_created,
    'itemsReused', v_items_reused,
    'collectionsCreated', v_collections_created,
    'collectionsReused', v_collections_reused,
    'activityCreated', v_activity_created,
    'itemMap', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'backupItemId', im.backup_item_id,
            'realItemId', im.real_item_id,
            'wasCreated', im.was_created
          )
          order by im.backup_item_id
        )
        from pg_temp.import_item_map im
      ),
      '[]'::jsonb
    )
  );
end;
$$;

revoke all on function public.import_library_backup(uuid, jsonb) from public;
grant execute on function public.import_library_backup(uuid, jsonb) to authenticated;
