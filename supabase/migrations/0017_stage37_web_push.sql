-- Stage 37: background web push & notification delivery.
--
-- Run this against your Supabase project after 0001-0016 (all already
-- applied and immutable). NOT YET DEPLOYED as of this writing — see the
-- Stage 37 report(s). This migration may be freely edited in place until
-- it is actually deployed; once deployed it becomes immutable like every
-- migration before it. This version incorporates two rounds of static
-- pre-deployment review AND a full pass of real, disposable-PostgreSQL-
-- backed validation (see the "Migration 0017 Reliability & Security
-- Review," "Final 0017 Pre-Database-Test Pass," and "Real Disposable
-- Supabase Database Validation" reports) that found and fixed four real
-- defects before any of this ever shipped:
--   1. A crashed processor could leave a claim permanently stuck at
--      status='claimed' with no way to ever recover it — fixed with an
--      explicit lease (claimed_at/lease_expires_at) below.
--   2. Occurrence identity was `coalesce(updated_at, created_at)`, which
--      the merge/undo-merge RPCs (0016) bump merely to reassign
--      `library_item_id` — completely unrelated to a reminder's schedule.
--      A merged reminder would have appeared to be a "new occurrence,"
--      re-notifying for something already delivered. Fixed by deriving
--      occurrence identity from `reminder_effective_due_at()` — a pure
--      function of ONLY the columns that actually define when a reminder
--      is due — below.
--   3. A due reminder with NO active push subscription at all (the common
--      case for most reminders, most of the time) would still be claimed
--      and re-examined once per scheduler tick for the entire 24h catch-up
--      window, since a 'skipped' delivery row was unconditionally, always
--      immediately reclaimable. Fixed two ways: (a)
--      list_due_reminder_candidates now excludes a reminder from
--      candidacy entirely when its owner has zero active subscriptions
--      (the common case never reaches the claim function at all), and (b)
--      the narrower race where a subscription still existed at candidate-
--      read time but is gone by actual send time now defers the 'skipped'
--      row's next reclaim by SKIPPED_RETRY_DEFER_MINUTES (15) rather than
--      leaving it immediately reclaimable — see
--      list_due_reminder_candidates' and claim_reminder_delivery's own
--      doc comments below for the full cooperation between these two
--      functions and lib/push/deliver.ts.
--   4. Found via real PostgreSQL testing against a disposable project (not
--      by static review): the 'failed'+retryable branch's own attempt-cap
--      check returned 'exhausted' without ever updating the row, unlike
--      the 'claimed' branch's identical cap check just above it (which DID
--      self-heal to retryable=false). Harmless in practice (attempt_count
--      itself already prevented further reclaims either way) but
--      inconsistent — a row exhausted through this path stayed at
--      retryable=true forever, which would misreport as "will still
--      retry" to anything inspecting the row directly. Fixed by making
--      this branch self-heal identically to the other one.
--
-- ============================================================
-- Why this exists
-- ============================================================
-- Stage 34 gave Markly reminders that only ever surface while the app is
-- open (lib/reminders.ts resolves "due" purely in memory, on every
-- render). This migration adds the two tables a server-side delivery
-- engine needs to reach a user while Markly is closed: one browser/device
-- Web Push subscription per row (push_subscriptions), and an atomic
-- claim/outcome ledger per reminder occurrence (reminder_deliveries) so a
-- scheduler that retries, overlaps, crashes, or reruns can never send the
-- same occurrence twice under normal operation — see
-- claim_reminder_delivery()'s own doc comment for the exact delivery
-- guarantee this provides (at-least-once, not exactly-once — Web Push is
-- an external network call that cannot be part of a database
-- transaction, so a crash between "push sent" and "outcome recorded" is a
-- real, irreducible ambiguity, mitigated but not eliminated by the
-- occurrence-specific Notification.tag deduplicating at the OS/browser
-- level on the rare occasions it actually recurs).
--
-- No recurrence exists in this schema (Stage 34 never introduced it) — a
-- reminder row IS one occurrence, identified by
-- (reminder_id, reminder_effective_due_at(...)) — see that function's own
-- doc comment for why this, and not a raw timestamp column, is the safe
-- choice.
--
-- ============================================================
-- reminder_effective_due_at — the single canonical "when is this reminder
-- due" computation, and (as of the reliability review) the basis for
-- occurrence identity itself.
-- ============================================================
-- Pure function of exactly the columns that define a reminder's schedule
-- — nothing else. Release: the stored scheduled_for snapshot minus the
-- lead time (never a live AniList refetch — see list_due_reminder_
-- candidates' own doc comment for why that's a deliberate, separate
-- concern from lib/reminders.ts's client-side display reconciliation).
-- Continue: remind_at directly.
--
-- Audited (reliability review §3) against EVERY reminder write path:
--   - createReminder (hooks/useReminders.ts): sets scheduled_for/
--     remind_before_minutes/remind_at once at insert — not an "edit."
--   - updateReleaseLeadTime: changes remind_before_minutes — a genuine
--     reschedule; this function's result legitimately changes. CORRECT
--     to produce a new occurrence.
--   - updateContinueTime: changes remind_at — a genuine reschedule; this
--     function's result legitimately changes. CORRECT to produce a new
--     occurrence.
--   - dismissReminder: sets dismissed_at only — never touches any input
--     to this function. Moot anyway: a dismissed reminder is excluded
--     from list_due_reminder_candidates entirely (dismissed_at is null),
--     so it can never become a delivery candidate again regardless.
--   - merge_library_items / undo_library_recovery (0016): reassign a
--     moved reminder's library_item_id (and bump updated_at) during a
--     duplicate-merge — NEVER touch kind/scheduled_for/
--     remind_before_minutes/remind_at. THIS is exactly the case the
--     reliability review flagged: the OLD identity
--     (coalesce(updated_at, created_at)) would have changed here even
--     though nothing schedule-related did, spuriously creating a second,
--     independently-claimable "occurrence" for an item that may have
--     already been notified. reminder_effective_due_at()'s inputs are
--     completely unaffected by this reassignment, so identity correctly
--     stays the same.
-- No other write path touches these columns. Conclusion: deriving
-- identity from this function is safe — editing non-scheduling state
-- (item association, dismissal, or any hypothetical future metadata
-- field) can never fabricate a duplicate occurrence, and only a genuine
-- reschedule (remind_at or remind_before_minutes) ever does.
--
-- IMMUTABLE (a pure function of its scalar inputs, touches no table, and
-- SECURITY INVOKER needs no elevated privilege at all) and callable only
-- by service_role — its two callers (list_due_reminder_candidates,
-- claim_reminder_delivery) are themselves service_role-only, so there is
-- no legitimate reason for any other role to ever invoke it, even though
-- it exposes nothing sensitive on its own.
create or replace function public.reminder_effective_due_at(
  p_kind text,
  p_scheduled_for timestamptz,
  p_remind_before_minutes integer,
  p_remind_at timestamptz
)
returns timestamptz
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_kind = 'continue' then p_remind_at
    else p_scheduled_for - (p_remind_before_minutes || ' minutes')::interval
  end;
$$;

revoke all on function public.reminder_effective_due_at(text, timestamptz, integer, timestamptz) from public;
revoke all on function public.reminder_effective_due_at(text, timestamptz, integer, timestamptz) from anon, authenticated;
grant execute on function public.reminder_effective_due_at(text, timestamptz, integer, timestamptz) to service_role;

-- ============================================================
-- push_subscriptions
-- ============================================================
-- One row per browser/device Web Push subscription. A user may have many
-- (Chrome desktop, Firefox laptop, Android browser, ...) — modeled as
-- independent rows, never collapsed to one-per-user.
--
-- Endpoint ownership rule (Stage 37 §14/§16, and re-examined in the
-- reliability review §10 — the exact rule and threat model both reports
-- must state): `endpoint` is GLOBALLY unique. Subscribing always goes
-- through upsert_push_subscription() below, which upserts keyed on
-- endpoint and unconditionally overwrites `user_id` to whoever is
-- currently authenticated. This means an endpoint belongs to exactly
-- whichever Markly account most recently, explicitly subscribed it — if
-- browser B was subscribed for User A and is later (re-)subscribed for
-- User B, ownership flips atomically to B, and A's reminders can never
-- reach that browser again from that moment on.
--
-- Threat model (reliability review §10): a Web Push endpoint URL is a
-- high-entropy, unguessable bearer identifier issued by the push service
-- directly to one specific browser installation — this IS the actual
-- trust boundary the Web Push standard itself relies on (there is no
-- stronger cryptographic "prove you are the same browser" mechanism
-- available in the protocol; every real-world Web Push implementation
-- trusts endpoint possession the same way). Markly's own code never
-- returns an endpoint to anyone but its current owner (never logged,
-- never rendered, never included in any API response beyond the
-- subscribing browser's own round trip) — the only channel through which
-- another user could ever learn a genuine endpoint value is a compromise
-- OUTSIDE Markly's control entirely (the victim's own browser, a leaked
-- log elsewhere, etc.), which is already a much larger compromise than
-- anything this table could defend against on its own. Should such a
-- compromise occur, the worst case is a denial-of-service against the
-- rightful owner (their subscription row gets overwritten with an
-- attacker-controlled key, so pushes intended for them fail to decrypt in
-- their browser) — NEVER disclosure of the victim's reminder content to
-- the attacker, since the attacker does not thereby gain the ability to
-- receive pushes sent to the victim's real endpoint (that routing is
-- controlled by the push service, not this database). Conclusion:
-- unconditional ownership transfer keyed on exact endpoint match remains
-- the correct, standard, and proportionate design — no additional
-- verification layer was added, since one would need to invent a
-- mechanism the Web Push protocol itself doesn't provide, for a residual
-- risk that already requires a larger out-of-band compromise.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null,
  -- Web Push key material (Stage 37 §11/§12) — never logged, never
  -- returned to any client beyond the owner's own subscribe call, never
  -- rendered in any UI. Bounded well above any real Web Push provider's
  -- observed key sizes, purely to reject pathological input.
  p256dh text not null,
  auth_key text not null,
  -- Optional, user-facing, client-generated coarse label (e.g. "Chrome on
  -- Windows") — never a fingerprinting payload; see
  -- src/hooks/usePushNotifications.ts for exactly what it derives from
  -- (a short browser/OS token, nothing else).
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  -- Set when Web Push reports this endpoint gone (404/410) — a dead
  -- subscription is excluded from delivery but the row is kept (not
  -- deleted) so re-enabling the same browser later reuses/repairs it
  -- rather than accumulating duplicate history. Never set for a
  -- transient/retryable or auth/config failure (Stage 37 §29/§30).
  disabled_at timestamptz,
  constraint push_subscriptions_endpoint_key unique (endpoint),
  constraint push_subscriptions_endpoint_check check (length(endpoint) > 0 and length(endpoint) <= 2000),
  constraint push_subscriptions_p256dh_check check (length(p256dh) > 0 and length(p256dh) <= 512),
  constraint push_subscriptions_auth_key_check check (length(auth_key) > 0 and length(auth_key) <= 256),
  constraint push_subscriptions_label_check check (label is null or length(label) <= 120)
);

-- Backs the delivery engine's "active subscriptions for this user" lookup
-- (partial: dead subscriptions are never candidates).
create index if not exists push_subscriptions_active_user_idx
  on public.push_subscriptions (user_id)
  where disabled_at is null;

alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions_select_own" on public.push_subscriptions;
create policy "push_subscriptions_select_own" on public.push_subscriptions for select using (auth.uid() = user_id);

drop policy if exists "push_subscriptions_delete_own" on public.push_subscriptions;
create policy "push_subscriptions_delete_own" on public.push_subscriptions for delete using (auth.uid() = user_id);

-- Deliberately NO insert/update policy for `authenticated` — every write
-- goes through upsert_push_subscription() below. See that function's own
-- doc comment for why a plain client-side upsert cannot implement the
-- ownership-transfer rule this feature needs. The delivery engine's own
-- writes (last_used_at bumps, disabling a dead subscription) run through
-- the service-role admin client, which bypasses RLS entirely, same as
-- every other privileged server-side path in this project.

-- ============================================================
-- reminder_deliveries
-- ============================================================
-- The idempotency/claim ledger (Stage 37 §24/§25/§26/§27, hardened by the
-- reliability review's lease model — see claim_reminder_delivery()'s own
-- doc comment for the complete state machine). One row per reminder
-- OCCURRENCE (never per subscription/device — success is defined at the
-- occurrence level: Stage 37 §31/§36, "one of five devices being gone
-- must not fail the other four"). `kind = 'test'` rows are explicit
-- Send-test-notification actions (Stage 37 §22), completely unrelated to
-- any reminder occurrence — kept in the same table only because they
-- share the same status/observability shape, never because they share
-- identity semantics with a real reminder delivery.
create table if not exists public.reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  -- Denormalized owner (equal to the reminder's own user_id at claim
  -- time) — convenient for RLS/observability, never itself a trust
  -- boundary: claim_reminder_delivery() below always re-derives the real
  -- owner from public.reminders, never from a caller-supplied value.
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('reminder', 'test')),
  reminder_id uuid references public.reminders (id) on delete cascade,
  -- reminder_effective_due_at(...) at claim time — the occurrence-
  -- identity version, deliberately NOT coalesce(updated_at, created_at)
  -- (see this migration's header and reminder_effective_due_at's own doc
  -- comment for the reliability-review finding that made this necessary).
  -- A genuine reschedule (remind_at or remind_before_minutes changing)
  -- produces a DIFFERENT value here and therefore a brand new,
  -- independently claimable row; any other edit (item association,
  -- dismissal, ...) never does.
  occurrence_version timestamptz,
  status text not null check (status in ('claimed', 'sent', 'failed', 'skipped')),
  -- True only when every attempted subscription failed with a transient
  -- (or config/auth) classification (Stage 37 §29/§70) — gates whether a
  -- later processor run may retry this exact occurrence.
  retryable boolean not null default false,
  attempt_count integer not null default 1,
  -- Reliability review §1/§6 — the lease. Set on every transition INTO
  -- 'claimed' (fresh claim or reclaim alike); only meaningful while
  -- status = 'claimed'. A row whose lease has expired while still
  -- 'claimed' means the process that owned it never got to record an
  -- outcome (crashed, was killed, timed out) — see
  -- claim_reminder_delivery()'s own doc comment for exactly how that's
  -- recovered.
  claimed_at timestamptz not null default now(),
  lease_expires_at timestamptz not null default now(),
  -- Reliability review §5 — backoff gate. Set whenever a claim resolves
  -- to 'failed' + retryable = true (see lib/push/delivery-policy.ts's
  -- retryBackoffMinutes); null otherwise (including every 'claimed' row,
  -- every 'sent' row, and every non-retryable 'failed' row, where it is
  -- simply not applicable). A 'failed' + retryable row is NOT reclaimable
  -- before this instant, preventing a frequent scheduler from burning
  -- through every retry attempt in a tight loop.
  next_attempt_at timestamptz,
  -- Per-subscription outcome summary: [{subscriptionId, outcome,
  -- statusCode?}] — never subscription endpoint/key material, never
  -- notification title/body (Stage 37 §64). A JSONB summary rather than a
  -- child table, matching this schema's existing precedent
  -- (library_recovery_actions.payload) for a bounded, non-relational
  -- result shape that never needs its own independent RLS/indexing.
  results jsonb not null default '[]'::jsonb,
  -- First-ever attempt time — set once, never updated by a reclaim
  -- (claimed_at is the CURRENT lease's start; this is history).
  attempted_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint reminder_deliveries_kind_fields_check check (
    (kind = 'reminder' and reminder_id is not null and occurrence_version is not null)
    or
    (kind = 'test' and reminder_id is null and occurrence_version is null)
  ),
  -- A hard ceiling well above the application-level MAX_DELIVERY_ATTEMPTS
  -- (5, enforced by claim_reminder_delivery()'s own logic) — this is only
  -- a defense-in-depth backstop against a future bug ever incrementing
  -- this unboundedly, never the real retry cap itself.
  constraint reminder_deliveries_attempt_count_check check (attempt_count >= 1 and attempt_count <= 20),
  constraint reminder_deliveries_lease_check check (lease_expires_at >= claimed_at)
);

-- THE atomic-claim guarantee (Stage 37 §27): at most one row can ever
-- exist per (reminder_id, occurrence_version) — see
-- claim_reminder_delivery()'s INSERT ... ON CONFLICT below, which targets
-- this exact partial unique index.
create unique index if not exists reminder_deliveries_occurrence_idx
  on public.reminder_deliveries (reminder_id, occurrence_version)
  where kind = 'reminder';

create index if not exists reminder_deliveries_user_idx on public.reminder_deliveries (user_id, attempted_at desc);

alter table public.reminder_deliveries enable row level security;

drop policy if exists "reminder_deliveries_select_own" on public.reminder_deliveries;
create policy "reminder_deliveries_select_own" on public.reminder_deliveries for select using (auth.uid() = user_id);

-- No insert/update/delete policy for any client role — every row is
-- written by the delivery engine (claim_reminder_delivery() below, plus a
-- plain admin-client update to finalize) or the test-notification route,
-- both server-side via the service-role admin client, which bypasses RLS
-- entirely. A client can only ever read its own delivery history through
-- the select policy above (not currently surfaced in any UI — reserved
-- for future observability, per the Stage 37 report's retention note).

-- ============================================================
-- upsert_push_subscription — the ONLY way to create or reassign a
-- push_subscriptions row (Stage 37 §20).
-- ============================================================
-- SECURITY DEFINER so it can implement the ownership-transfer rule
-- documented on push_subscriptions above (a plain RLS-checked UPDATE
-- cannot reassign a row it doesn't already own) — but every value it
-- writes is either auth.uid() itself or a bounds-checked client input;
-- it never trusts a client-supplied user_id (Stage 37 §20's "derive
-- ownership from authenticated session," same discipline every other
-- SECURITY DEFINER function in this schema already follows).
create or replace function public.upsert_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth_key text,
  p_label text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_id uuid;
  v_label text;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if p_endpoint is null or length(p_endpoint) = 0 or length(p_endpoint) > 2000 then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_p256dh is null or length(p_p256dh) = 0 or length(p_p256dh) > 512 then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_auth_key is null or length(p_auth_key) = 0 or length(p_auth_key) > 256 then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_label := nullif(left(coalesce(p_label, ''), 120), '');

  insert into public.push_subscriptions (id, user_id, endpoint, p256dh, auth_key, label, created_at, last_used_at, disabled_at)
  values (gen_random_uuid(), v_uid, p_endpoint, p_p256dh, p_auth_key, v_label, v_now, v_now, null)
  on conflict (endpoint) do update set
    user_id = excluded.user_id,
    p256dh = excluded.p256dh,
    auth_key = excluded.auth_key,
    label = excluded.label,
    last_used_at = v_now,
    disabled_at = null
  returning id into v_id;

  return jsonb_build_object('status', 'ok', 'id', v_id);
end;
$$;

revoke all on function public.upsert_push_subscription(text, text, text, text) from public;
revoke all on function public.upsert_push_subscription(text, text, text, text) from anon;
grant execute on function public.upsert_push_subscription(text, text, text, text) to authenticated;

-- ============================================================
-- claim_reminder_delivery — the atomic occurrence claim, with lease-based
-- crash recovery and backoff-gated retry (Stage 37 §24/§25/§27/§28/§59/
-- §60/§61, hardened by the reliability review §1/§3/§5/§6/§7).
-- ============================================================
-- SECURITY INVOKER (the default, stated explicitly) — matching
-- apply_extension_progress/apply_extension_season_episode_progress's own
-- precedent (0004/0007): this function does not need to bypass RLS on its
-- own, since its one and only caller is the delivery engine's service-
-- role admin client, which already bypasses RLS by itself. Locked down
-- further below anyway, matching this codebase's habit of not relying on
-- convention alone for an access boundary.
--
-- Re-validates the reminder against LIVE state before ever claiming it —
-- never trusts the caller's own "this looked due a moment ago" read:
--   - reminder missing (deleted) -> 'not_found', never claimed (§59).
--   - reminder_effective_due_at(...) no longer equals the caller's
--     p_occurrence_version (rescheduled since being read as a candidate)
--     -> 'stale', never claimed — the reminder's NEW occurrence_version
--     is a different, independently claimable key that a later run will
--     see fresh, so a genuine reschedule is never lost, only
--     re-evaluated (§60).
--   - dismissed_at is not null -> 'skipped_dismissed', never claimed
--     (§61). This check re-runs on every reclaim attempt too (it is the
--     very first thing this function does, before even looking at any
--     existing reminder_deliveries row), so a dismiss that happens
--     between a failed attempt and a would-be retry is caught as well.
--
-- THE COMPLETE STATE MACHINE (reliability review §6):
--
--   'claimed'  — non-terminal, ACTIVELY LEASED while lease_expires_at is
--                still in the future: cannot be stolen by a concurrent
--                caller (returns 'already_leased'). Once the lease
--                expires, reclaimable by the very next caller — treated
--                as a fresh attempt (attempt_count += 1) since a crash
--                between claim and outcome-recording means the actual
--                external send outcome is genuinely unknown (§2's
--                documented at-least-once ambiguity). If attempt_count is
--                already at the cap (5) when a lease expires, the row is
--                self-healed to terminal 'failed'/retryable=false right
--                there (no caller ever needs to loop this manually).
--   'sent'     — TERMINAL. Never reclaimable under any condition.
--   'failed', retryable=true  — non-terminal, reclaimable once
--                next_attempt_at has passed AND attempt_count is under
--                the cap (5); before next_attempt_at, returns
--                'retry_pending' (not an error — just "not yet"). At the
--                cap, self-heals retryable to false (disposable-database-
--                test finding — converges with the 'claimed' branch's own
--                identical self-heal just above, so both ways of reaching
--                the cap leave the row in the exact same persisted
--                terminal state) and returns 'exhausted' (reported
--                distinctly from plain 'terminal' since it never got to
--                try this specific occurrence's final attempt).
--   'failed', retryable=false — TERMINAL (every attempted subscription
--                failed permanently, or 401/403 with nothing else to
--                try). Never reclaimable.
--   'skipped'  — non-terminal, NEVER attempt-limited (reclaiming never
--                increments attempt_count — a skip was never a real
--                external Web Push attempt, zero active subscriptions
--                existed at fan-out time), but IS gated by
--                next_attempt_at (final-review-pass fix, §3/§4): not
--                reclaimable until SKIPPED_RETRY_DEFER_MINUTES (15) after
--                it was recorded, returning 'retry_pending' before then —
--                the same "cheap no-op RPC call, no real work" shape
--                'failed'+retryable already has, not a special case. In
--                practice this branch is now reached only for the
--                narrower race where a subscription existed when
--                list_due_reminder_candidates ran but was gone by the
--                time lib/push/deliver.ts actually resolved subscriptions
--                — the far more common "this user has never enabled push"
--                case is excluded from candidacy entirely by that
--                function's own active-subscription EXISTS check, so it
--                never reaches this function at all (see that function's
--                own doc comment for the full reasoning and the two
--                reports this fixes). Still bounded by the catch-up
--                window itself either way, never unbounded — the exact
--                product reasoning (a user who enables push minutes after
--                a reminder went off, while still within the catch-up
--                window, does get notified) is unchanged from before.
--
-- Lease duration is a literal 120 seconds here — see
-- lib/push/delivery-policy.ts's CLAIM_LEASE_SECONDS for the reasoning
-- (kept in sync manually; the database is the real enforcement point).
create or replace function public.claim_reminder_delivery(
  p_reminder_id uuid,
  p_occurrence_version timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_user_id uuid;
  v_dismissed_at timestamptz;
  v_current_version timestamptz;
  v_now timestamptz := now();
  v_lease_until timestamptz;
  v_id uuid;
  v_attempt_count integer;
  v_existing record;
begin
  select r.user_id, r.dismissed_at,
         public.reminder_effective_due_at(r.kind, r.scheduled_for, r.remind_before_minutes, r.remind_at)
    into v_user_id, v_dismissed_at, v_current_version
  from public.reminders r
  where r.id = p_reminder_id;

  if v_user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_current_version is distinct from p_occurrence_version then
    return jsonb_build_object('status', 'stale');
  end if;

  if v_dismissed_at is not null then
    return jsonb_build_object('status', 'skipped_dismissed');
  end if;

  v_lease_until := v_now + make_interval(secs => 120);

  -- Try a fresh claim first. Atomic against concurrent inserts via the
  -- partial unique index — a conflict here means a row already exists
  -- (from some earlier attempt, however that resolved), never a
  -- duplicate insert.
  insert into public.reminder_deliveries
    (id, user_id, kind, reminder_id, occurrence_version, status, retryable, attempt_count, claimed_at, lease_expires_at, next_attempt_at, attempted_at)
  values
    (gen_random_uuid(), v_user_id, 'reminder', p_reminder_id, p_occurrence_version, 'claimed', false, 1, v_now, v_lease_until, null, v_now)
  on conflict (reminder_id, occurrence_version) where kind = 'reminder' do nothing
  returning id, attempt_count into v_id, v_attempt_count;

  if found then
    return jsonb_build_object('status', 'claimed', 'deliveryId', v_id, 'attemptCount', v_attempt_count, 'userId', v_user_id);
  end if;

  -- A row already exists for this occurrence — lock it (serializes
  -- concurrent reclaim attempts against each other; Stage 37 §76) and
  -- branch through the state machine documented above.
  select * into v_existing
  from public.reminder_deliveries
  where reminder_id = p_reminder_id and occurrence_version = p_occurrence_version and kind = 'reminder'
  for update;

  if v_existing.id is null then
    -- Not reachable in practice (the failed insert above already proved
    -- this exact key exists) — guarded rather than assumed.
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_existing.status = 'sent' then
    return jsonb_build_object('status', 'terminal', 'reason', 'sent');
  end if;

  if v_existing.status = 'skipped' then
    -- Final-review-pass fix (§3/§4) — a skip is now deferred, not
    -- immediately reclaimable: next_attempt_at (set by
    -- lib/push/deliver.ts's finalization to SKIPPED_RETRY_DEFER_MINUTES =
    -- 15 minutes after the skip) gates the next reclaim attempt, the same
    -- pattern already used for 'failed'+retryable below. Reclaiming does
    -- NOT increment attempt_count — a skip was never a real external Web
    -- Push attempt, so it must never consume that budget (attempt_count
    -- means "number of actual external delivery attempts," never "number
    -- of times the scheduler examined this occurrence").
    if v_existing.next_attempt_at is not null and v_existing.next_attempt_at > v_now then
      return jsonb_build_object('status', 'retry_pending', 'nextAttemptAt', v_existing.next_attempt_at);
    end if;
    update public.reminder_deliveries
      set status = 'claimed', claimed_at = v_now, lease_expires_at = v_lease_until, next_attempt_at = null, completed_at = null
      where id = v_existing.id
      returning id, attempt_count into v_id, v_attempt_count;
    return jsonb_build_object('status', 'claimed', 'deliveryId', v_id, 'attemptCount', v_attempt_count, 'userId', v_user_id);
  end if;

  if v_existing.status = 'claimed' then
    if v_existing.lease_expires_at > v_now then
      return jsonb_build_object('status', 'already_leased');
    end if;
    if v_existing.attempt_count >= 5 then
      update public.reminder_deliveries
        set status = 'failed', retryable = false, completed_at = v_now
        where id = v_existing.id;
      return jsonb_build_object('status', 'exhausted');
    end if;
    update public.reminder_deliveries
      set status = 'claimed', attempt_count = v_existing.attempt_count + 1, claimed_at = v_now, lease_expires_at = v_lease_until, next_attempt_at = null, completed_at = null
      where id = v_existing.id
      returning id, attempt_count into v_id, v_attempt_count;
    return jsonb_build_object('status', 'claimed', 'deliveryId', v_id, 'attemptCount', v_attempt_count, 'userId', v_user_id);
  end if;

  -- v_existing.status = 'failed' from here on.
  if not v_existing.retryable then
    return jsonb_build_object('status', 'terminal', 'reason', 'permanent_failure');
  end if;
  if v_existing.attempt_count >= 5 then
    -- Disposable-database-test finding — this branch used to return
    -- 'exhausted' without ever mutating the row, unlike the 'claimed'
    -- branch's own cap check just above (which DOES self-heal to
    -- status='failed', retryable=false). Functionally harmless either way
    -- (attempt_count itself already prevents this row from ever being
    -- reclaimed again through any path), but inconsistent: a row exhausted
    -- via this branch stayed at retryable=true forever, which would read
    -- as "will still retry" to anything inspecting the row directly (e.g.
    -- a future delivery-history view). Self-healing here too makes BOTH
    -- ways of reaching the cap converge on the exact same terminal
    -- persisted state.
    update public.reminder_deliveries
      set retryable = false, completed_at = v_now
      where id = v_existing.id;
    return jsonb_build_object('status', 'exhausted');
  end if;
  if v_existing.next_attempt_at is not null and v_existing.next_attempt_at > v_now then
    return jsonb_build_object('status', 'retry_pending', 'nextAttemptAt', v_existing.next_attempt_at);
  end if;

  update public.reminder_deliveries
    set status = 'claimed', attempt_count = v_existing.attempt_count + 1, claimed_at = v_now, lease_expires_at = v_lease_until, next_attempt_at = null, completed_at = null
    where id = v_existing.id
    returning id, attempt_count into v_id, v_attempt_count;
  return jsonb_build_object('status', 'claimed', 'deliveryId', v_id, 'attemptCount', v_attempt_count, 'userId', v_user_id);
end;
$$;

revoke all on function public.claim_reminder_delivery(uuid, timestamptz) from public;
revoke all on function public.claim_reminder_delivery(uuid, timestamptz) from anon, authenticated;
grant execute on function public.claim_reminder_delivery(uuid, timestamptz) to service_role;

-- ============================================================
-- list_due_reminder_candidates — the canonical due-reminder query (Stage
-- 37 §27 of the report).
-- ============================================================
-- A single SQL definition of "due, for push purposes," delegating the
-- actual due-instant formula to reminder_effective_due_at() so it can
-- never drift from what claim_reminder_delivery() uses for occurrence
-- identity. `p_catchup_minutes` bounds how far into the past a reminder
-- may still be considered (Stage 37 §36/§37) — a reminder due further in
-- the past than that is simply excluded from every future call too (its
-- occurrence_version never changes on its own), i.e. it is silently
-- never pushed, which is the intended catch-up policy, not an oversight.
--
-- Final-review-pass fix (no-subscription churn, §1/§2): also requires the
-- reminder's OWNER to currently have at least one active push
-- subscription. Before this, a reminder belonging to a user with zero
-- subscriptions (the common case — most users, most of the time, simply
-- haven't enabled push) would still be claimed and re-examined once per
-- scheduler tick for the entire 24h catch-up window, since a 'skipped'
-- delivery row was previously always immediately reclaimable. Now, the
-- common "nobody to deliver to" case is excluded from candidacy
-- ENTIRELY — it never reaches claim_reminder_delivery, never creates a
-- reminder_deliveries row, and costs nothing beyond this one EXISTS
-- check. This is a pure existence check — no subscription column
-- (endpoint/p256dh/auth_key) is ever selected or returned by this
-- function.
--
-- This existence check composes correctly with every other candidate
-- category without any special-casing:
--   - A reminder with an existing 'failed'+retryable delivery row whose
--     next_attempt_at has arrived still needs an active subscription to
--     be worth reclaiming at all — if the user's only device died since
--     the last failure, this EXISTS check now excludes it from candidacy,
--     and claim_reminder_delivery's own next_attempt_at gating (see its
--     own doc comment) is simply never reached until a subscription
--     reappears.
--   - A reminder whose ONLY reminder_deliveries row is stuck 'claimed'
--     with an expired lease (a crashed processor, see
--     claim_reminder_delivery's own doc comment) likewise stops being
--     re-examined once the owner has zero active subscriptions — it sits
--     inertly rather than churning, and the moment a subscription
--     reappears, this EXISTS check lets it through again and the
--     existing expired-lease-reclaim logic resolves it exactly as
--     before. It is intentionally NOT resolved to any terminal state
--     merely because subscriptions disappeared — the reminder itself
--     remains completely valid and visible in-app regardless.
--   - The narrower race where a subscription existed at THIS query's
--     execution time but is gone by the time lib/push/deliver.ts actually
--     resolves subscriptions for the fan-out (a few milliseconds later)
--     is NOT handled here — it is handled by claim_reminder_delivery's
--     own 'skipped' branch deferring the next reclaim via next_attempt_at
--     (SKIPPED_RETRY_DEFER_MINUTES = 15), never by this query. See that
--     function's own doc comment.
--
-- STABLE (read-only, no writes) and SECURITY INVOKER, matching
-- claim_reminder_delivery()'s own reasoning: its only caller is the
-- service-role admin client, which already bypasses RLS by itself.
create or replace function public.list_due_reminder_candidates(
  p_now timestamptz,
  p_catchup_minutes integer,
  p_limit integer
)
returns table (
  reminder_id uuid,
  user_id uuid,
  library_item_id uuid,
  occurrence_version timestamptz,
  effective_due_at timestamptz
)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select
    r.id as reminder_id,
    r.user_id,
    r.library_item_id,
    public.reminder_effective_due_at(r.kind, r.scheduled_for, r.remind_before_minutes, r.remind_at) as occurrence_version,
    public.reminder_effective_due_at(r.kind, r.scheduled_for, r.remind_before_minutes, r.remind_at) as effective_due_at
  from public.reminders r
  where r.dismissed_at is null
    and public.reminder_effective_due_at(r.kind, r.scheduled_for, r.remind_before_minutes, r.remind_at) <= p_now
    and public.reminder_effective_due_at(r.kind, r.scheduled_for, r.remind_before_minutes, r.remind_at) >= p_now - (p_catchup_minutes || ' minutes')::interval
    and exists (
      select 1 from public.push_subscriptions ps
      where ps.user_id = r.user_id and ps.disabled_at is null
    )
  order by effective_due_at asc, r.id asc
  limit p_limit;
$$;

revoke all on function public.list_due_reminder_candidates(timestamptz, integer, integer) from public;
revoke all on function public.list_due_reminder_candidates(timestamptz, integer, integer) from anon, authenticated;
grant execute on function public.list_due_reminder_candidates(timestamptz, integer, integer) to service_role;
