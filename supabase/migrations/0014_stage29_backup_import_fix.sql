-- Stage 29 fix: three genuine defects in import_library_backup, all found
-- via live testing against the deployed database, all fixed here.
--
-- NOT DEPLOYED. Created for review only — do not run `supabase db push`
-- for this file without explicit approval. Does not touch 0001-0013 in
-- any way (0013 is immutable — it is already deployed).
--
-- ============================================================
-- DEFECT 1 (severe): temp tables never dropped, breaking the 3rd+ call
-- ============================================================
-- 0013's import_library_backup creates two working-storage temp tables:
--
--   create temporary table pg_temp.import_item_map (...);
--   create temporary table pg_temp.import_collection_map (...);
--
-- Postgres temporary tables are scoped to the SESSION (the underlying
-- backend connection), not to the transaction or to one function call.
-- Neither statement had an `on commit drop` clause, so once one call to
-- this function completes, `import_item_map`/`import_collection_map`
-- keep existing on whatever pooled backend connection handled that call.
-- Supabase's connection pooler reuses backend connections across
-- unrelated requests (including from different users), so the very next
-- call to import_library_backup that happens to land on that same
-- already-used connection hits:
--
--   42P07: relation "import_item_map" already exists
--
-- This was reproduced live and deterministically: five sequential calls
-- from one authenticated test user, each with a fresh p_request_id and a
-- trivially valid one-item plan, produced:
--
--   call 1: OK imported
--   call 2: OK imported
--   call 3: ERROR 42P07 relation "import_item_map" already exists
--   call 4: ERROR 42P07 relation "import_item_map" already exists
--   call 5: ERROR 42P07 relation "import_item_map" already exists
--
-- i.e. the RPC silently stops working for a given pooled connection after
-- its first successful use — not a rare edge case, but the deterministic
-- outcome of ordinary repeated use (a second import, a second user
-- sharing a pooled connection, a retried request, ...). This is a severe,
-- genuine defect, not a theoretical one.
--
-- Fix: add `on commit drop` to both CREATE TEMPORARY TABLE statements.
-- Since one RPC call is one top-level transaction, this correctly scopes
-- each temp table's lifetime to exactly the call that created it: it is
-- dropped the instant that call's transaction commits, so the NEXT call
-- on the same reused connection always starts clean. On a rollback (e.g.
-- the CHECK-constraint-violation path exercised in testing), Postgres
-- already undoes the CREATE TABLE itself as transactional DDL, so
-- `on commit drop` changes nothing about the rollback path — it only
-- fixes the normal-completion path, which is exactly where the bug was.
--
-- ============================================================
-- DEFECT 2 (smaller): plan_too_large permanently consumes the request id
-- ============================================================
-- 0013 ran the record-count bound checks AFTER the double-submit guard's
-- INSERT into backup_import_requests. 'plan_too_large' returns via a
-- normal (non-exceptional) RETURN, which does not roll back that earlier
-- successful insert. Reproduced live: a plan with 5001 items returned
-- plan_too_large, and a retry with the SAME request id and a corrected,
-- validly-sized plan then returned duplicate_request instead of being
-- evaluated — an oversized (and therefore entirely rejected, zero-effect)
-- plan permanently burned that request id.
--
-- Fix: move the bound checks to before the double-submit guard's INSERT
-- (see the reorder below). These checks only read p_plan, never anything
-- the insert writes, so this is a pure reorder with no other behavior
-- change — double-submit protection for validly-sized plans is unaffected
-- (both the original and the reordered version still insert the request
-- row, then proceed, whenever the plan is within bounds).
--
-- ============================================================
-- DEFECT 3 (concurrency): same plan, two request ids, race-created
-- duplicate LibraryItems
-- ============================================================
-- Live testing (Issue A, second live-validation round) proved: one user,
-- the SAME normalized import plan, TWO different (independently
-- generated) p_request_id values, submitted concurrently — both calls
-- succeeded, and TWO copies of the same logical item were created. This
-- is not the double-submit case (0013/0014 already handle identical
-- request ids correctly) — it is two genuinely different, both-valid
-- requests, each computed from a plan snapshot that was accurate at
-- PREVIEW time but stale by the time either transaction actually ran.
-- Request-id idempotency was never designed to catch this (it guards
-- transport/retry duplication of ONE logical request, not two distinct
-- concurrent imports of the same backup), so a second mechanism is
-- needed: the client's classification (new / already_present /
-- possible_duplicate), computed once against a point-in-time snapshot,
-- must be re-validated against the CURRENT database state before this
-- function actually creates anything — otherwise two concurrent callers
-- can both correctly see "doesn't exist yet" and both create it.
--
-- Fix, two parts (see A4 in the review): first, a per-user
-- `pg_advisory_xact_lock` (same idiom already used by
-- `auto_add_and_link_source` in 0005/0006 and by the recovery RPCs in
-- 0011/0012 — `perform pg_advisory_xact_lock(hashtext(v_uid::text))`)
-- serializes every import for one user: a second concurrent call for the
-- same user simply waits until the first transaction commits or rolls
-- back, then proceeds against whatever that first call actually left
-- behind. The lock ALONE is not sufficient — a second call that acquires
-- the lock after the first commits would still blindly create a
-- duplicate using its own (now stale) plan snapshot. So second, after
-- acquiring the lock, every "genuinely new" candidate item (and
-- candidate collection) is re-checked against the database's CURRENT
-- state — not the client's possibly-stale classification — using the
-- exact same conservative identity rules `lib/backup/plan.ts`'s
-- `classifyItem` already uses for the normal (non-racing) case:
--
--   AUTHORITATIVE: same user, same media type, same catalogSource
--   (provider + externalId) as an item that already exists.
--   TITLE-ONLY (only checked when no authoritative match): same user,
--   same media type, exact normalized title match, with neither side
--   carrying a CONFLICTING catalogSource (mirrors classifyItem's own
--   "withhold on conflicting catalog ids" rule exactly).
--
-- Title normalization reuses the EXISTING `public.normalize_title_for_
-- matching` (defined in 0005, already a verified byte-for-byte SQL
-- mirror of src/lib/title-normalization.ts's normalizeTitleForMatching —
-- same NFKC/quote/dash folding, same order) rather than a second,
-- possibly-drifting reimplementation. That function was previously
-- granted to `service_role` only (0005's auto_add_and_link_source is
-- always called via the admin/service-role client); import_library_backup
-- is SECURITY INVOKER and runs as the calling `authenticated` user, so
-- this migration also grants it EXECUTE — a pure, side-effect-free text
-- transformation, safe to expose more broadly.
--
-- Outcome per identity result, mirroring the classifyItem categories
-- exactly (see A5/A6 in the review for the reasoning):
--   - AUTHORITATIVE match found -> do NOT create a second copy; map the
--     candidate's backupItemId to the EXISTING item instead (was_created
--     = false, identical to a normal client-supplied itemMappings entry).
--     Collection membership may safely attach to it, same as any other
--     already-present mapping. This is not a loosening: an authoritative
--     match is already treated as safe-to-auto-attach in the normal
--     (non-race) flow.
--   - TITLE-ONLY match found -> do NOT create a second copy, but also do
--     NOT silently map it as already-present either (title-only matches
--     are never authoritative — silently attaching one here, only
--     because of a timing coincidence, would be a real loosening of
--     Stage 27/29's "possible duplicate, review required" rule). This one
--     candidate is simply skipped: no insert, no map entry. Its
--     Collection membership / Activity references resolve to nothing —
--     exactly the same "unresolvable backup id, silently omitted" path
--     0013 already uses for a skipped possible-duplicate, no new code
--     needed there.
--   - No match -> create it, exactly as before.
--   - `possibleDuplicateOptIn = true` (see below) -> never revalidated;
--     always created. An explicit user choice to import a known possible
--     duplicate as a separate item must never be silently undone by a
--     safety net aimed at a completely different problem (A3).
--
-- Activity is unaffected by any of this: it already only ever attaches
-- to `was_created = true` items (0013's existing rule), so an
-- authoritative race-remap (was_created = false, like any already-present
-- mapping) or a title-only skip (no map entry at all) both correctly
-- exclude Activity automatically — the EXISTING step 6 logic needed no
-- changes.
--
-- Distinguishing "genuinely new, needs revalidation" from "user
-- explicitly opted into this possible duplicate, never revalidate" (A3)
-- requires ONE piece of information the plan payload did not previously
-- carry: `lib/cloud/backup-import.ts` now sends `possibleDuplicateOptIn:
-- true` on any item whose classification was "possible_duplicate" (the
-- ONLY way such an item reaches the `items` array at all is the user
-- explicitly checking "Import possible duplicates too"). This is the one
-- minimal payload extension needed — no general provenance framework,
-- no per-item audit trail, just the one boolean this fix actually needs.
--
-- collectionsToCreate gets the identical treatment for the same reason
-- (two concurrent imports racing to create "the same" new collection by
-- name): re-checked by exact trimmed/case-insensitive name against
-- current state before creating; a race match is counted as reused
-- (`collectionsReused`), not created, using the exact same comparison
-- `lib/backup/plan.ts`'s `classifyCollection` already uses.
--
-- Result counts (A7): `itemsCreated`/`collectionsCreated`/
-- `collectionsReused`/`activityCreated` all already only ever counted
-- actual commits (see 0013), so no change was needed there beyond adding
-- one new counter, `itemsReused`, for a race-remapped item — distinct
-- from `itemsCreated` so the client can report what actually happened
-- rather than assuming the stale plan's original expectation.
--
-- What this fix deliberately does NOT change: same-request-id
-- double-submit still returns `duplicate_request` (now via a strictly
-- serialized path through the same lock, never a functional change);
-- a later, genuinely separate reimport (new request id, run once the
-- first has already committed) is unaffected — it already reclassifies
-- against current state at PLAN time, so revalidation at commit time
-- simply confirms what the client already knew; cross-account behavior
-- is untouched (the lock is keyed per-user, never shared across
-- accounts); `backupId` is still never referenced anywhere in this
-- function (it never was). Website items (matched by exact URL, not
-- catalogSource/title) are NOT covered by this revalidation — a
-- deliberate scope decision: the review's A4 spec names only the
-- authoritative/title-only categories, replicating `normalizeUrlForCompare`
-- in SQL would add real risk of divergence for a narrower case, and a
-- raced duplicate website bookmark is low-stakes (no progress/Activity
-- data at risk, trivially deleted) compared to a duplicate media item.
--
-- ============================================================
-- Scope of this migration
-- ============================================================
-- Same signature, same SECURITY INVOKER, same search_path, same
-- ownership re-verification, same Activity idempotency, same URL
-- protocol guards, same record-count limits as 0013. The three defects
-- above are the only substantive behavior changes. This is a
-- `create or replace function` because Postgres has no way to patch a
-- few lines of a function body in place.
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

  -- FIX (0014), SECOND DEFECT: the record-count bound checks now run
  -- BEFORE the double-submit guard's INSERT, not after. In 0013 they ran
  -- after — live testing confirmed that an oversized plan (plan_too_large)
  -- still left its just-inserted backup_import_requests row in place,
  -- because 'plan_too_large' is a normal (non-exceptional) RETURN, which
  -- does not roll back the insert that already committed earlier in the
  -- same call. A client that retried the SAME request id with a
  -- corrected, appropriately-sized plan would incorrectly get
  -- 'duplicate_request' instead of having the corrected plan evaluated —
  -- reproduced live: a 5001-item plan returned plan_too_large, and a
  -- retry with the same request id and a valid 1-item plan then returned
  -- duplicate_request instead of importing. This reorder is safe: these
  -- checks only read p_plan, never anything the insert below writes, and
  -- an oversized plan now never touches backup_import_requests at all.
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

  -- FIX (0014), THIRD DEFECT: per-user serialization — see this
  -- migration's header comment (DEFECT 3). Held for the rest of the
  -- transaction, released automatically at commit/rollback; a second
  -- concurrent call for the SAME user blocks here until the first
  -- finishes, then proceeds against whatever the first actually
  -- committed — which the revalidation checks below then account for.
  -- Calls for DIFFERENT users never contend (different lock keys).
  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  -- Double-submit guard — see 0013's header comment. Must be the first
  -- WRITE (the read-only size checks above it don't count).
  begin
    insert into public.backup_import_requests (id, user_id) values (p_request_id, v_uid);
  exception when unique_violation then
    return jsonb_build_object('status', 'duplicate_request');
  end;

  -- FIX (0014), FIRST DEFECT: `on commit drop` added to both temp
  -- tables — see this migration's header comment. Together with the
  -- reorder above, these are the only two functional changes from 0013.
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

    -- DEFECT 3 revalidation — see this migration's header comment. Never
    -- run for an item the user explicitly opted to import as a separate
    -- copy despite being a possible duplicate (A3): that intent must
    -- survive regardless of what else exists.
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
          -- flow. Skip this ONE candidate: no insert, no map entry: its
          -- Collection membership / Activity references simply resolve
          -- to nothing, the same path 0013 already uses for any other
          -- unresolvable backup id.
          continue;
        end if;
      end if;
    end if;

    if v_existing_item_id is not null then
      -- Authoritative race match: treat exactly like a normal
      -- client-supplied itemMappings entry (was_created = false) — safe
      -- to attach Collection membership, never Activity (step 6 already
      -- excludes any mapping with was_created = false).
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

  -- 2. Create new Collections. Same DEFECT 3 revalidation as items above,
  -- for the same reason (two concurrent imports racing to create "the
  -- same" new collection by name) — reuses classifyCollection's own
  -- trimmed/case-insensitive name comparison, re-checked against current
  -- state under the per-user lock.
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
  -- re-verified. Used ONLY for Collection membership resolution below,
  -- never for Activity (see 0013's header comment).
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
  -- bypassing that validator could and could not do (carried forward
  -- from 0013, updated for DEFECT 3's revalidation logic):
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
  --     above, the one field class here where a bypass has an actual
  --     code-execution-on-click implication, not just implausible data.
  --   - Concurrency-safe identity: a client cannot force a duplicate
  --     LibraryItem/Collection to be created by racing two request ids —
  --     the per-user advisory lock plus commit-time revalidation (DEFECT
  --     3) re-derives authoritative/title-only identity from the CURRENT
  --     database state, never trusting the client's classification for
  --     whether something is safe to skip creating (only for WHICH
  --     candidates are exempt from revalidation, via
  --     `possibleDuplicateOptIn` — and an item exempted that way still
  --     only ever creates a normal, correctly-owned row; it cannot forge
  --     an existingItemId mapping, which remains ownership-checked above).
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
    'itemsReused', v_items_reused,
    'collectionsCreated', v_collections_created,
    'collectionsReused', v_collections_reused,
    'activityCreated', v_activity_created
  );
end;
$$;

revoke all on function public.import_library_backup(uuid, jsonb) from public;
grant execute on function public.import_library_backup(uuid, jsonb) to authenticated;

-- DEFECT 3 fix: normalize_title_for_matching (defined in 0005) was
-- previously granted to service_role only — its one existing caller,
-- auto_add_and_link_source, is always invoked via the admin/service-role
-- client. import_library_backup is SECURITY INVOKER and runs as the
-- calling `authenticated` user, so it needs its own EXECUTE grant on this
-- function to call it. Pure, side-effect-free text transformation (no
-- table access) — broadening its grant carries no security risk. 0005's
-- own CREATE FUNCTION statement (0001-0013 are immutable) is untouched;
-- this is an additive grant only.
grant execute on function public.normalize_title_for_matching(text) to authenticated;
