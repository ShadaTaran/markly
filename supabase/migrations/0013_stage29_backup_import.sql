-- Stage 29: portable backup export & safe import — cloud import RPC.
--
-- NOT DEPLOYED. Created for review only — do not run `supabase db push`
-- for this file without explicit approval. Does not touch 0001-0012 in
-- any way.
--
-- ============================================================
-- Why this exists
-- ============================================================
-- Importing a backup creates rows across four tables (library_items,
-- collections, collection_items, activity_events) with ids remapped from
-- the backup file's own backup-local ids to freshly-generated ones. A
-- sequence of independent client calls could fail partway through and
-- leave a half-imported graph; one Postgres transaction cannot.
--
-- ============================================================
-- Why SECURITY INVOKER, not DEFINER (unlike Stage 28's recovery RPCs)
-- ============================================================
-- Every table this function writes to already has a working INSERT
-- policy for `authenticated` under normal RLS, because the existing app
-- already writes to all four of them directly from the client
-- (library_items via plain upsert, collections likewise, collection_items
-- via setCollectionMembership, activity_events via insertActivityEvent).
-- There is no privilege gap to bridge the way Stage 28's recovery table
-- deliberately has one — SECURITY INVOKER already works cleanly here, so
-- per the Stage 29 review's own guidance ("prefer INVOKER, do not choose
-- DEFINER unnecessarily") this stays SECURITY INVOKER throughout.
--
-- ============================================================
-- Security boundaries the client cannot influence
-- ============================================================
-- - `user_id` on every inserted row is always `auth.uid()` — the backup
--   payload has no user/owner field to begin with (see types/backup.ts).
-- - Every `existingItemId`/`existingCollectionId` the client claims maps
--   to an "already present" item or a "reuse" collection is independently
--   re-verified to belong to `auth.uid()` before it is used for anything
--   — the client's classification (which backup record matches which
--   current row) is trusted for BUSINESS LOGIC (worst case: a wrong
--   classification just creates a legitimate new item under the caller's
--   own account), but never for OWNERSHIP (a claimed existing-row id is
--   always re-checked).
-- - Record-count limits are re-enforced server-side (defense in depth —
--   "client validation is not security"), independent of whatever the
--   browser-side validator already did.
--
-- ============================================================
-- Double-submit / concurrency
-- ============================================================
-- Two identical import requests (an accidental double-click, a client
-- retry after a network hiccup) must never produce two copies of the
-- same import. `backup_import_requests` is a minimal, narrow table
-- (id + user_id + created_at, nothing else — no raw backup JSON, no
-- secrets) whose ONLY job is making a repeated `p_request_id` fail fast:
-- the RPC's very first write is `insert into backup_import_requests
-- (id, user_id) values (p_request_id, auth.uid())`, and a second call
-- with the same id hits that table's primary key and is caught explicitly,
-- returning a clean `duplicate_request` status instead of creating
-- anything. This is intentionally NOT a general audit/provenance system —
-- see the table's own comment for why a handful of small rows per import
-- is an acceptable, minimal cost for this one guarantee.
--
-- Retention: rows are never deleted. Each one exists only to make its
-- own exact (user_id, id) pair fail a second time — once the RPC call it
-- guarded has committed or aborted, the row has no further semantic use,
-- but at realistic scale (one row per confirmed import action — imports
-- are an occasional, deliberate user action, not a per-request or
-- per-record operation) even a power user performing dozens of imports a
-- year accumulates a negligible number of rows over the lifetime of an
-- account. No cron/background cleanup is introduced for this — the same
-- "do not add scheduled infrastructure for a bounded, small cost"
-- judgment already applied to Stage 28's 15-minute recovery rows (which
-- DO need opportunistic sweeping, being far higher-volume and time-
-- sensitive) simply doesn't tip the same way here, since there is
-- nothing time-sensitive or high-volume about this table at all.
--
-- Item/Collection/Activity idempotency ACROSS separate imports (the same
-- file imported again, possibly much later) needs no such table at all —
-- see lib/backup/plan.ts's own doc comment: reclassifying against
-- current state naturally turns previously-imported items into
-- "already_present" on a later import, and Activity is only ever
-- imported for items with action "create" (never for an already_present
-- mapping), which is what keeps a repeat import from duplicating history.
-- This RPC re-enforces that second guarantee itself (Task/Section 34) —
-- it never imports an Activity record unless the record's `backupItemId`
-- was ALSO an item this very call just created, regardless of what the
-- client's plan claims.
--
-- `p_request_id` identifies ONE CONFIRMED IMPORT ACTION, never the backup
-- file itself: the client (lib/cloud/backup-import.ts) generates a fresh
-- crypto.randomUUID() every time "Import" is confirmed, not the file's
-- own `backupId` and not anything derived from its contents — so
-- reopening/reimporting the exact same file later is always a brand-new
-- id, never blocked by an earlier import's row (see the "why this design
-- already supports intentional reimport" note below).
--
-- Uniqueness is scoped to (user_id, id), NOT id alone — a security review
-- caught this: `p_request_id` is a plain client-supplied RPC argument,
-- so nothing stops an authenticated caller from INSERTing a row under
-- their own user_id for an id of their choosing (the INSERT policy below
-- only constrains WHICH user_id, same as everywhere else in this
-- project). A global `primary key (id)` would let User A's request row
-- (or a row an attacker deliberately inserted for themselves) collide
-- against a completely unrelated User B request that later happens to
-- reuse — or, in an adversarial case, was deliberately pre-inserted to
-- collide with — the same id, rejecting B's legitimate import for a
-- reason that has nothing to do with B's own history. Since the
-- practical id-generation strategy is a 122-bit random UUID this was
-- already astronomically unlikely to occur by accident, but the SCHEMA
-- itself should encode the right invariant regardless of how hard it is
-- to trigger today: one user's request history must never be able to
-- interfere with another's. `primary key (user_id, id)` makes that
-- structural rather than incidental, while leaving the actual
-- double-submit guarantee (two concurrent calls, same user, same id)
-- exactly as effective as before — they still collide against each
-- other, since user_id is identical for both.
create table if not exists public.backup_import_requests (
  id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists backup_import_requests_user_id_idx on public.backup_import_requests (user_id);

alter table public.backup_import_requests enable row level security;

drop policy if exists "backup_import_requests_select_own" on public.backup_import_requests;
create policy "backup_import_requests_select_own" on public.backup_import_requests
  for select using (auth.uid() = user_id);

drop policy if exists "backup_import_requests_insert_own" on public.backup_import_requests;
create policy "backup_import_requests_insert_own" on public.backup_import_requests
  for insert with check (auth.uid() = user_id);

-- No UPDATE, no DELETE policy — a row here only ever needs to exist long
-- enough to make a repeated id fail; it is never modified.
revoke all on table public.backup_import_requests from public, anon, authenticated;
grant select, insert on public.backup_import_requests to authenticated;

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
  v_collections_created int := 0;
  v_collections_reused int := 0;
  v_activity_created int := 0;
  rec record;
  v_new_id uuid;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if p_request_id is null or p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    return jsonb_build_object('status', 'invalid_plan');
  end if;

  -- Double-submit guard — see header comment. Must be the first write.
  begin
    insert into public.backup_import_requests (id, user_id) values (p_request_id, v_uid);
  exception when unique_violation then
    return jsonb_build_object('status', 'duplicate_request');
  end;

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

  create temporary table pg_temp.import_item_map (
    backup_item_id text primary key,
    real_item_id uuid not null,
    was_created boolean not null
  );
  create temporary table pg_temp.import_collection_map (
    backup_collection_id text primary key,
    real_collection_id uuid not null
  );

  -- 1. Create new LibraryItems.
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
      platform text, "playtimeHours" numeric, developer text, publisher text, "catalogPlatforms" jsonb
    )
  loop
    if rec."backupItemId" is null or rec."type" is null or rec."title" is null then
      continue;
    end if;

    v_new_id := gen_random_uuid();

    -- Security audit finding: this RPC is callable directly by any
    -- authenticated client, not only through the browser-side validator
    -- (lib/backup/validate.ts's isValidUrl) — a caller bypassing that
    -- validator could otherwise store a `javascript:`/`data:` URL in
    -- url/image_url/source_url, all three of which the app later renders
    -- as a clickable href or image src. That's a genuine (if
    -- self-targeted) code-execution-on-click risk, unlike the other
    -- unchecked fields below (progress numbers, enum-ish strings,
    -- catalogSource shape) which can only ever produce implausible-but-
    -- inert display values in the caller's own account — see this
    -- function's own closing comment for the full client-only-vs-server-
    -- enforced audit. http(s)-only, matching isValidUrl's own rule;
    -- anything else (including a missing/malformed URL) is dropped to
    -- null rather than rejecting the whole record.
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

  -- 2. Create new Collections.
  for rec in
    select * from jsonb_to_recordset(coalesce(p_plan->'collectionsToCreate', '[]'::jsonb)) as x(
      "backupCollectionId" text, name text, description text, "createdAt" timestamptz
    )
  loop
    if rec."backupCollectionId" is null or rec.name is null then
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
  -- re-verified. Used ONLY for Collection membership resolution below,
  -- never for Activity (see header comment).
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
  -- true), regardless of what the client's plan included. This is the
  -- server-side half of Stage 29's idempotency guarantee: even a
  -- maliciously or buggily constructed plan that includes Activity for an
  -- "already present" mapping can never actually attach it.
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
  -- This RPC is reachable directly by any authenticated client, not only
  -- through lib/backup/validate.ts's browser-side validator — "client
  -- validation is not security." An honest accounting of what a caller
  -- bypassing that validator could and could not do:
  --
  -- SERVER-ENFORCED (cannot be bypassed, by construction or a table
  -- constraint — a violation aborts this entire transaction atomically,
  -- so nothing partial is ever left behind, but as a raw Postgres error
  -- rather than a clean status):
  --   - user_id on every row: always auth.uid(), never client-suppliable
  --     (no field for it exists in the plan format at all).
  --   - Ownership of every "existing" id (itemMappings.existingItemId,
  --     collectionsToReuse.existingCollectionId): independently
  --     re-verified against auth.uid(), never trusted from the plan.
  --   - Record-count limits: re-checked above, independent of whatever
  --     the browser-side limits already enforced.
  --   - Activity idempotency: only ever imported for a backupItemId this
  --     SAME call just created (was_created = true in the temp map),
  --     regardless of what the plan's own `activity` array contains.
  --   - `type` (library_items.type) and `rating` (1-10) — enforced by
  --     0001's own CHECK constraints; `activity_events.type` (the 4 known
  --     kinds) likewise.
  --   - `url`/`imageUrl`/`sourceUrl` protocol — http(s)-only, enforced
  --     just above (added after a security review specifically flagged
  --     these as renderable hrefs/image srcs, the one field class here
  --     where a bypass has an actual code-execution-on-click
  --     implication, not just implausible data).
  --
  -- CLIENT-ONLY (a direct RPC call bypassing lib/backup/validate.ts could
  -- store an out-of-range or nonsensical value here, but ONLY ever in
  -- the CALLER'S OWN account — no cross-user exposure, since RLS already
  -- scopes every SELECT to auth.uid() = user_id regardless): title/
  -- description/category length, tag/genre/author array sizes and
  -- string lengths, progress/episode/chapter/season numeric bounds
  -- (including negative or absurd values), playtimeHours/pageCount/
  -- releaseYear bounds, progressKind/progressUnit/episodeNumbering/
  -- readingFormat enum shape (stored as free text inside `metadata`,
  -- with no CHECK constraint), and catalogSource's own shape (provider/
  -- externalId are not re-validated against the known provider list).
  -- This matches the EXISTING trust model the rest of the app already
  -- has for these exact same metadata fields (no other write path — the
  -- normal add/edit forms included — range-checks them at the database
  -- layer either); Stage 29 does not weaken anything that was already
  -- true, and does not introduce a new engine to re-validate business-
  -- level field semantics the rest of the schema has never enforced.
  return jsonb_build_object(
    'status', 'imported',
    'itemsCreated', v_items_created,
    'collectionsCreated', v_collections_created,
    'collectionsReused', v_collections_reused,
    'activityCreated', v_activity_created
  );
end;
$$;

revoke all on function public.import_library_backup(uuid, jsonb) from public;
grant execute on function public.import_library_backup(uuid, jsonb) to authenticated;
