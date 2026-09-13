-- Stage 42: tighten tracking_sources DELETE authorization to match the
-- application's own hard-delete eligibility rule (unlinked + manual only).
--
-- Run this against your Supabase project after 0001-0018 (all already
-- applied — this migration does not touch anything any of them created).
-- Safe to re-run.
--
-- ============================================================
-- Why this exists
-- ============================================================
-- Migration 0003's original tracking_sources_delete_own policy was
-- ownership-only (auth.uid() = user_id). Stage 42's application route
-- (deleteUnlinkedManualSource, src/lib/extension/tracking-sources.ts)
-- already enforces library_item_id IS NULL AND adapter_id = 'manual' in
-- its own atomic DELETE ... WHERE clause, but an authenticated user could
-- bypass the Next.js route entirely and issue a direct PostgREST DELETE
-- against tracking_sources with only ownership enforced — potentially
-- erasing a linked source, a non-manual/extension-detected source, or an
-- explicitly-unlinked automatic source's auto_link_suppressed_at memory
-- (see 0008's own comment: that column is the only thing preventing Smart
-- Auto-Link from silently relinking a source right back after an explicit
-- Unlink — nothing else remembers that choice once the row is gone).
--
-- This migration makes the database itself the authority for exactly the
-- same rule the application already enforces — defense in depth, closing
-- the direct-API bypass without changing any legitimate existing
-- behavior. The Stage 42 Phase 0 audit (repository-wide) found no other
-- code path ever issues a DELETE against tracking_sources at all:
--   - recordDetection / claimSourceLink / clearBrokenLink (extension
--     detection & auto-link, admin-client) only ever upsert/update.
--   - linkSource / unlinkSource / setAutoTrackEnabled / createManualSource /
--     restoreTrackingSource (ordinary authenticated paths) only ever
--     insert/update.
--   - merge_library_items (0009) and undo_library_recovery (0010-0012)
--     move/restore sources via a plain UPDATE ... SET library_item_id,
--     never a DELETE, both running security invoker under the calling
--     user's own permissions.
--   - Deleting a LibraryItem never deletes its TrackingSources at all —
--     library_item_id's own foreign key (0003) is `on delete set null`,
--     a database-engine-level FK action independent of (and not gated
--     by) this table's own DELETE policy.
--   - Backup restore, service-role/admin operations: same conclusion —
--     no DELETE caller found.
-- Tightening this policy therefore cannot break any of the above; the
-- only DELETE it needs to keep permitting is deleteUnlinkedManualSource's
-- own already-narrower request.
--
-- ============================================================
-- The fix
-- ============================================================
-- Replace the ownership-only DELETE policy with one that additionally
-- requires the row to be unlinked (library_item_id is null) and manual
-- (adapter_id = 'manual') — the exact two conditions that make hard-
-- deleting a TrackingSource row safe (see deleteUnlinkedManualSource's
-- own doc comment): nothing automatic can ever recreate a "manual" row,
-- so erasing an unlinked one can never reopen the automatic-relink hole
-- erasing a non-manual row's auto_link_suppressed_at memory could.

drop policy if exists "tracking_sources_delete_own" on public.tracking_sources;
create policy "tracking_sources_delete_unlinked_manual_own" on public.tracking_sources
  for delete using (
    auth.uid() = user_id
    and library_item_id is null
    and adapter_id = 'manual'
  );

-- No other change: SELECT/INSERT/UPDATE policies (0003), grants, table
-- structure, indexes, and every other table are untouched by this
-- migration. The application's own atomic WHERE clause in
-- deleteUnlinkedManualSource is kept as-is (defense in depth) — this
-- migration only makes the database independently enforce the same rule,
-- it does not replace the application-level check.
