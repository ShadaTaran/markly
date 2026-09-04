-- Stage 26: cross-source work identity & tracking source management.
--
-- Run this against your Supabase project after 0001-0007 (all already
-- applied — this migration does not touch anything any of them created).
-- Safe to re-run.
--
-- ============================================================
-- Why this exists
-- ============================================================
-- Phase 0 investigation (see the Stage 26 final report) found that
-- tracking_sources already supports many sources linking to one
-- LibraryItem (the only uniqueness constraint is on source identity —
-- user_id + adapter_id + source_key — never on library_item_id), and that
-- the existing atomic progress RPCs (0004, 0007) are already safe under
-- concurrent updates from multiple sources, since they lock and compare by
-- library_item_id alone, oblivious to which source triggered the call.
-- Almost none of Stage 26 needed new schema.
--
-- The one genuine gap: an explicit, user-initiated Unlink only ever
-- cleared library_item_id, with nothing recording that this was a
-- deliberate choice — so the very next detection would run Smart
-- Auto-Link again, see the same exact-title match, and silently link the
-- source right back. That makes "Unlink" practically useless. This column
-- is the minimal durable state needed to preserve that intent.
--
-- ============================================================
-- The fix
-- ============================================================
-- auto_link_suppressed_at: null (the default) means "eligible for normal
-- Smart Auto-Link / Auto-Add", exactly today's behavior for every existing
-- row — no existing source becomes disabled/unlinked/suppressed by this
-- migration. Set (to the unlink time) only by an explicit, user-initiated
-- Unlink action (src/lib/extension/tracking-sources.ts's unlinkSource,
-- called from POST /api/tracking-sources/unlink) — never by
-- clearBrokenLink, which runs when a *linked item was deleted*, not a
-- user "stop tracking this" decision, and must remain free to
-- auto-relink or Auto-Add normally afterward. Cleared back to null by an
-- explicit manual Link (linkSource / POST /api/tracking-sources/link) —
-- any deliberate "yes, link this" action restores normal automatic
-- behavior, matching the product requirement that the user always has an
-- explicit way back in.
alter table public.tracking_sources
  add column if not exists auto_link_suppressed_at timestamptz;

comment on column public.tracking_sources.auto_link_suppressed_at is
  'Set when a user explicitly unlinks this source (never by automatic unlinking, e.g. a deleted item) — while set, server-side auto-tracking (route.ts) skips Smart Auto-Link and Auto-Add for this source entirely, so an explicit Unlink is never immediately undone by the next detection. Cleared by an explicit manual Link.';

-- No RLS change needed: the existing tracking_sources_update_own policy
-- already covers every column on the row generically (see 0003).
