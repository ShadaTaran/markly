#!/usr/bin/env node
// Verifies Stage 43 "Account Lifecycle & Data Ownership":
//   - Phase 0's data-ownership finding: every one of the 14 user-owned
//     tables across migrations 0001-0019 declares its own `user_id`
//     column `references auth.users (id) on delete cascade` — proven live
//     against a disposable Supabase project (a synthetic user with one row
//     in every table, including a linked-manual AND an unlinked-suppressed
//     -automatic tracking_sources row, was reduced to zero rows everywhere
//     by a single `delete from auth.users where id = ...`). Because a
//     foreign-key cascade fires at the Postgres engine level, it is NOT
//     subject to the referencing table's own RLS policies — so migration
//     0019's tracking_sources restriction, and pairing_codes/
//     extension_devices having no ordinary-authenticated delete policy at
//     all, have zero effect on this cleanup path.
//   - POST /api/account/delete: server-derived identity (never a client-
//     supplied user id), explicit typed-confirmation requirement, a
//     single admin.deleteUser(id, false) call (hard delete, not
//     Supabase's soft-delete option) with no separate per-table cleanup
//     step that could partially fail, no raw DB/admin error exposure.
//   - The Danger Zone UI: an explicit, accessible confirmation dialog
//     (reusing the shared Dialog primitive's already-audited contract),
//     never a one-click button or browser confirm(), with a link to the
//     existing backup/export flow rather than a duplicate of it.
//   - No migration 0020: the cascade guarantee already existing in
//     0001-0019 made one unnecessary — this script also guards against a
//     future change silently weakening any of those 14 cascades.
//   - No coupling into logout, 401 handling, or integration disconnect —
//     account deletion happens ONLY from this one explicit, confirmed
//     action.
//
// Reproduced/audited verbatim from the real modules and migration files
// (same convention as every other script in this directory — plain .mjs,
// no TypeScript loader, no real database call).
//
// Run with: node scripts/verify-account-lifecycle.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}
function src(path) {
  return readFileSync(path, "utf8");
}
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const deleteRoute = src("src/app/api/account/delete/route.ts");
const deleteRouteStripped = stripComments(deleteRoute);
const dialogSource = src("src/components/DeleteAccountDialog.tsx");
const panelSource = src("src/components/AccountSettingsPanel.tsx");
const panelStripped = stripComments(panelSource);
const authProviderSource = stripComments(src("src/components/AuthProvider.tsx"));
const logoutCleanupSource = src("src/lib/push/logout-cleanup.ts");
const anilistDisconnectSource = stripComments(src("src/app/api/integrations/anilist/disconnect/route.ts"));
const adminClientSource = src("src/lib/supabase/admin.ts");
const resumeLibSource = src("src/lib/resume.ts");
const trackingSourcesLib = src("src/lib/extension/tracking-sources.ts");
const migration0019 = src("supabase/migrations/0019_stage42_source_delete_policy.sql");
const settingsShellSource = src("src/components/SettingsShell.tsx");
const accountMenuSource = src("src/components/AccountMenu.tsx");
const localImportSource = src("src/hooks/useLocalImport.ts");
const migrationLibSource = src("src/lib/cloud/migration.ts");
const extStorageSource = src("extension/src/lib/storage.ts");
const tokensLibSource = src("src/lib/extension/tokens.ts");
const extApiSource = src("extension/src/lib/api.ts");
const extServiceWorkerSource = src("extension/src/background/service-worker.ts");
const extensionProgressRoute = stripComments(src("src/app/api/extension/progress/route.ts"));
const devicesLibSource = src("src/lib/extension/devices.ts");

const migrationFiles = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
const migrationTexts = Object.fromEntries(migrationFiles.map((f) => [f, src(`supabase/migrations/${f}`)]));

// ============================================================
// Phase 0 — data-ownership map: every user-owned table's FK to auth.users
// ============================================================
// The 14 tables Phase 0's audit found, and the migration file each was
// created in — this is the authoritative list this whole feature's safety
// rests on. If a future migration adds a 15th user-owned table without
// this same cascade, this list (and the live-cascade guarantee it
// documents) must be revisited — that is the entire point of this section
// existing as a regression check, not just a one-time audit note.
const USER_OWNED_TABLES = [
  ["library_items", "0001_stage16_core_schema.sql"],
  ["collections", "0001_stage16_core_schema.sql"],
  ["collection_items", "0001_stage16_core_schema.sql"],
  ["activity_events", "0001_stage16_core_schema.sql"],
  ["external_connections", "0002_stage17_external_connections.sql"],
  ["extension_devices", "0003_stage18_auto_tracking.sql"],
  ["pairing_codes", "0003_stage18_auto_tracking.sql"],
  ["tracking_sources", "0003_stage18_auto_tracking.sql"],
  ["library_recovery_actions", "0010_stage28_library_recovery.sql"],
  ["backup_import_requests", "0013_stage29_backup_import.sql"],
  ["saved_library_views", "0015_stage31_saved_library_views.sql"],
  ["reminders", "0016_stage34_reminders.sql"],
  ["push_subscriptions", "0017_stage37_web_push.sql"],
  ["reminder_deliveries", "0017_stage37_web_push.sql"],
];

check("A0 (CRITICAL): every one of the 14 known user-owned tables' own migration file declares user_id references auth.users(id) on delete cascade", () => {
  for (const [table, file] of USER_OWNED_TABLES) {
    const text = migrationTexts[file];
    assert.ok(text, `expected migration file ${file} to exist for table ${table}`);
    const tableBlock = text.slice(text.indexOf(`create table if not exists public.${table} (`));
    assert.ok(
      /user_id uuid not null references auth\.users \(id\) on delete cascade/.test(tableBlock.slice(0, 2000)),
      `${table} (in ${file}) must declare user_id ... references auth.users (id) on delete cascade`,
    );
  }
});

check("A1: no user-owned table beyond the 14 known ones exists without the same auth.users cascade — every 'create table' in every migration is accounted for", () => {
  const allCreatedTables = [];
  for (const text of Object.values(migrationTexts)) {
    const matches = text.matchAll(/create table if not exists public\.(\w+) \(/g);
    for (const m of matches) allCreatedTables.push(m[1]);
  }
  const known = new Set(USER_OWNED_TABLES.map(([t]) => t));
  const unknown = allCreatedTables.filter((t) => !known.has(t));
  assert.equal(unknown.length, 0, `found table(s) not in this script's ownership map: ${unknown.join(", ")} — update USER_OWNED_TABLES and re-audit`);
});

check("A2: reminders' library_item_id participates in a composite (library_item_id, user_id) FK to library_items, itself on delete cascade — an indirect ownership path that is ALSO covered by reminders' own direct user_id cascade", () => {
  const remindersFile = migrationTexts["0016_stage34_reminders.sql"];
  assert.ok(/foreign key \(library_item_id, user_id\) references public\.library_items \(id, user_id\) on delete cascade/.test(remindersFile));
});

check("A3: collection_items and activity_events are each doubly-owned (their own direct user_id cascade AND a cascade from their library_items/collections parent) — either alone already guarantees cleanup", () => {
  const core = migrationTexts["0001_stage16_core_schema.sql"];
  assert.ok(/collection_id uuid not null references public\.collections \(id\) on delete cascade/.test(core));
  assert.ok(/item_id uuid not null references public\.library_items \(id\) on delete cascade/.test(core));
  assert.match(core, /create table if not exists public\.activity_events[\s\S]{0,300}item_id uuid not null references public\.library_items \(id\) on delete cascade/);
});

check("A4: tracking_sources.library_item_id is ON DELETE SET NULL (never cascade) — deleting a LibraryItem must not delete its TrackingSources, but deleting the OWNING USER still does via tracking_sources' own direct user_id cascade", () => {
  const file = migrationTexts["0003_stage18_auto_tracking.sql"];
  assert.ok(/library_item_id uuid references public\.library_items \(id\) on delete set null/.test(file));
});

check("A5: no user-owned table relies SOLELY on an indirect/SET NULL path with no direct auth.users cascade of its own — every table in USER_OWNED_TABLES has been independently confirmed by A0", () => {
  assert.equal(USER_OWNED_TABLES.length, 14);
});

// ============================================================
// B — Stage 42's tracking_sources DELETE RLS restriction does not affect
// (and was not weakened for) whole-account cascade cleanup
// ============================================================
check("B1 (CRITICAL): migration 0019's actual SQL statements (not its prose comments, which discuss the FK mechanism for context) contain no CASCADE or FOREIGN KEY DDL — it only narrows the ordinary-authenticated DELETE policy, never touches the FK/cascade mechanism this feature depends on", () => {
  const sqlOnly = migration0019
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.ok(!/cascade|foreign key/i.test(sqlOnly));
});

check("B2: migration 0019's policy predicate (the three ANDed conditions) is present unchanged — this feature does not loosen or touch it", () => {
  assert.ok(/auth\.uid\(\) = user_id\s*\n\s*and library_item_id is null\s*\n\s*and adapter_id = 'manual'/.test(migration0019));
});

check("B3: deleteUnlinkedManualSource (the Stage 42 ordinary-user delete path) is untouched by Stage 43 — still the same atomic id+user+unlinked+manual WHERE clause, no new account-deletion-specific branch added to it", () => {
  assert.ok(/library_item_id.*is.*null/i.test(trackingSourcesLib) || /\.is\("library_item_id", null\)/.test(trackingSourcesLib));
  assert.ok(!/account.*delet|delet.*account/i.test(trackingSourcesLib), "tracking-sources.ts must have no account-deletion-specific logic — whole-account cleanup happens via the auth.users cascade, never through this file");
});

// ============================================================
// C — POST /api/account/delete: identity, confirmation, and cleanup design
// ============================================================
check("C1 (CRITICAL): the route derives the target user EXCLUSIVELY from the authenticated session (auth.getUser()), never from the request body", () => {
  assert.ok(/supabase\.auth\.getUser\(\)/.test(deleteRouteStripped));
  assert.ok(!/body\.(userId|user_id|targetUserId|accountId|email)/.test(deleteRouteStripped), "must never read a target-user identifier from the client body");
});

check("C2: the request body type accepts only `confirmation` — no field for a client-chosen user id, email-as-authority, or target account", () => {
  const bodyTypeMatch = deleteRouteStripped.match(/let body: \{([^}]*)\}/);
  assert.ok(bodyTypeMatch, "expected a typed request body declaration");
  assert.ok(/confirmation\??:\s*string/.test(bodyTypeMatch[1]));
  assert.ok(!/user_?id|email|account/i.test(bodyTypeMatch[1]), "the body type must carry nothing beyond the confirmation phrase");
});

check("C3 (CRITICAL): an exact confirmation phrase is required and checked before any deletion is attempted", () => {
  const confirmIndex = deleteRouteStripped.indexOf('body.confirmation !== "DELETE"');
  const deleteUserIndex = deleteRouteStripped.indexOf("admin.deleteUser");
  assert.ok(confirmIndex !== -1, "must reject anything other than the exact confirmation phrase");
  assert.ok(confirmIndex < deleteUserIndex, "the confirmation check must happen BEFORE the actual deletion call");
});

check("C4: an invalid confirmation returns a dedicated, non-2xx error code — never proceeds to deletion", () => {
  assert.ok(/invalid_confirmation/.test(deleteRouteStripped));
  assert.match(deleteRouteStripped, /invalid_confirmation[\s\S]{0,40}status: 400/);
});

check("C5 (CRITICAL): an unauthenticated request is rejected (401) before any confirmation/deletion logic runs", () => {
  const unauthIndex = deleteRouteStripped.indexOf('status: 401');
  const confirmIndex = deleteRouteStripped.indexOf("body.confirmation");
  assert.ok(unauthIndex !== -1 && unauthIndex < confirmIndex);
});

check("C6 (CRITICAL): the actual account deletion is exactly ONE call — admin.deleteUser — with no sequence of per-table deletes preceding it in this route; whole-account cleanup relies on the database's own cascade, not an ordered application-level sequence", () => {
  assert.ok(/admin\.deleteUser\(userData\.user\.id, false\)/.test(deleteRouteStripped), "must hard-delete (shouldSoftDelete=false), explicitly, not rely on the client default");
  assert.ok(!/\.from\([^)]*\)\.delete\(\)/.test(deleteRouteStripped), "must not contain any direct per-table .from(...).delete() call — cleanup is the cascade, not a manual sequence");
});

check("C7: the admin client is used for exactly the one call that needs elevated privilege (auth.admin.deleteUser) — reuses the existing server-only admin client rather than inventing a new privileged path", () => {
  assert.ok(/import \{ getSupabaseAdminClient \} from "@\/lib\/supabase\/admin"/.test(deleteRoute));
  const adminUsages = deleteRouteStripped.match(/adminClient\./g) ?? [];
  assert.equal(adminUsages.length, 1, "the admin client must be used exactly once — for the deleteUser call itself, nothing else");
});

check("C8: no raw database/admin error is ever exposed to the client — every failure path returns a fixed, generic error code", () => {
  assert.ok(!/error\.message|err\.message|String\(error\)|JSON\.stringify\(error\)/.test(deleteRouteStripped));
  assert.ok(/auth_delete_failed/.test(deleteRouteStripped));
});

check("C9: a 503 not_configured response exists for a deployment where cloud sync or the admin client isn't configured — fails closed, never silently proceeds", () => {
  const matches = deleteRouteStripped.match(/not_configured[\s\S]{0,30}status: 503/g) ?? [];
  assert.ok(matches.length >= 2, "expected not_configured for both the missing session-client and missing admin-client cases");
});

check("C10: idempotence — nothing is inserted/updated before the deleteUser call, so a retried request (after e.g. a network drop) has no prior partial side effect of its own to collide with; if the account is already gone, the caller's own session is already invalid and the ordinary unauthenticated (401) path handles that case", () => {
  assert.ok(!/\.insert\(|\.update\(|\.upsert\(/.test(deleteRouteStripped), "the account-delete route itself must never write any row — only read the session and call admin.deleteUser");
});

// ============================================================
// D — client-side success/failure flow
// ============================================================
check("D1 (CRITICAL): on success, the client reuses the EXISTING sign-out mechanism (useAuth().signOut) rather than reimplementing session-clearing or push-unsubscribe itself", () => {
  assert.ok(/const \{[^}]*\bsignOut\b[^}]*\} = useAuth\(\)/.test(panelStripped));
  assert.ok(/await signOut\(\)/.test(panelStripped));
  assert.ok(!/bestEffortDisablePushOnLogout/.test(panelStripped), "must not duplicate the push-cleanup call — signOut() already does this");
});

check("D2: on success, the client redirects to a clean signed-out destination and refreshes router state — no stale account UI left showing", () => {
  assert.ok(/router\.push\("\/"\)/.test(panelStripped));
  assert.ok(/router\.refresh\(\)/.test(panelStripped));
});

check("D3 (CRITICAL): failure is never treated as success — the dialog stays open, an error is shown, and signOut/redirect are only reached on an explicit deleted status", () => {
  const fnBody = panelStripped.slice(panelStripped.indexOf("async function handleConfirmDelete"), panelStripped.indexOf("async function handleConfirmDelete") + 1400);
  assert.ok(/data\.status !== "deleted"/.test(fnBody), "must gate success on an explicit status, never assume ok-status alone means deleted");
  const successGateIndex = fnBody.indexOf('data.status !== "deleted"');
  const signOutIndex = fnBody.indexOf("await signOut()");
  assert.ok(successGateIndex !== -1 && signOutIndex !== -1 && successGateIndex < signOutIndex);
});

check("D4: a network/unexpected failure (fetch throwing) is caught and surfaced, never left as an unhandled rejection or a false success", () => {
  const fnBody = panelStripped.slice(panelStripped.indexOf("async function handleConfirmDelete"));
  assert.ok(/catch \{/.test(fnBody));
});

// ============================================================
// E — Danger Zone UI: deliberate confirmation, no shortcuts
// ============================================================
check("E1 (CRITICAL): no browser confirm() is actually called anywhere in the account-deletion UI code (comments discussing the prohibition don't count)", () => {
  const code = stripComments(panelSource) + stripComments(dialogSource);
  assert.ok(!/window\.confirm\(|[^.\w]confirm\(/.test(code));
});

check("E2 (CRITICAL): the confirmation dialog requires the user to type an exact phrase before the destructive action is enabled", () => {
  assert.ok(/CONFIRMATION_PHRASE = "DELETE"/.test(dialogSource));
  assert.ok(/typed === CONFIRMATION_PHRASE/.test(dialogSource));
  assert.ok(/disabled=\{!canConfirm\}/.test(dialogSource));
});

check("E3: the destructive button is disabled while a request is in flight (busy-protected) — no double-submit", () => {
  assert.ok(/!busy/.test(dialogSource) || /&&\s*!busy/.test(dialogSource));
});

check("E4 (CRITICAL): the dialog reuses the shared Dialog primitive — inheriting its already-audited role=dialog/aria-modal/focus-trap/Escape/focus-restore contract, rather than a bespoke implementation", () => {
  assert.ok(/import \{ Dialog \} from "@\/components\/Dialog"/.test(dialogSource));
});

check("E5: the typed-confirmation input has a proper associated label via the shared Field primitive, not a bare unlabeled input", () => {
  assert.ok(/import \{ Field, inputClass \} from "@\/components\/FormField"/.test(dialogSource));
  assert.ok(/<Field label=/.test(dialogSource));
});

check("E6: an error message, when present, is rendered with role=\"alert\" so assistive technology announces it", () => {
  assert.ok(/role="alert"/.test(dialogSource));
});

check("E7: destructive intent is conveyed by more than color alone — the button carries explicit destructive label text (\"Delete account\"), not just a red variant", () => {
  assert.ok(/Delete account/.test(dialogSource));
});

check("E8: the dialog copy explicitly states permanence, cloud-data deletion, account-access loss, and that this cannot be undone", () => {
  assert.ok(/permanently deletes your Markly account/i.test(dialogSource));
  assert.ok(/no longer be able to sign in/i.test(dialogSource));
  assert.ok(/can(?:'|’|&rsquo;)t be undone/i.test(dialogSource));
});

check("E9: the dialog copy does not overclaim — it explicitly says Markly does not delete/disconnect the account on external services like AniList, only Markly's own stored credential", () => {
  assert.ok(/does not delete or disconnect your account on any external service/i.test(dialogSource));
  assert.ok(/AniList/.test(dialogSource));
});

check("E10: the dialog copy explicitly and truthfully addresses local/signed-out browser data as separate from the cloud account", () => {
  assert.ok(/separate\s+from your cloud account/i.test(dialogSource));
});

check("E11: mobile-safe width — uses the same max-w-sm class already used by the other already-audited confirmation dialogs (DeleteSourceDialog/DeleteLibraryItemDialog)", () => {
  assert.ok(/widthClassName="max-w-sm"/.test(panelSource + dialogSource) || /widthClassName="max-w-sm"/.test(dialogSource));
});

check("E12: no hardcoded color literal (hex, rgb, bg-white, bg-black) is used — only semantic design tokens, so light/dark both resolve correctly", () => {
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgb\(|bg-white\b|bg-black\b/.test(dialogSource + panelSource));
});

// ============================================================
// F — export-before-delete guidance, without duplicating backup logic
// ============================================================
check("F1 (CRITICAL): the Danger Zone links to the EXISTING Data & Backup settings page rather than re-implementing export", () => {
  assert.ok(/href="\/settings\/backup"/.test(panelSource));
  assert.ok(!/fetchTrackingSourcesForExport|fetchActivityEventsForExport|downloadBackupFile/.test(panelSource), "must not duplicate the backup export implementation here");
});

check("F2: export is offered as guidance, never forced — deletion does not depend on any export having happened", () => {
  assert.ok(!/exportedRequired|mustExportFirst|exportComplete/i.test(panelSource + dialogSource));
});

// ============================================================
// G — no accidental auto-delete from unrelated flows
// ============================================================
check("G1 (CRITICAL): signOut() (AuthProvider.tsx) never calls the account-delete endpoint or admin.deleteUser", () => {
  assert.ok(!/account\/delete|admin\.deleteUser/.test(authProviderSource));
});

check("G2: the AniList disconnect route never calls admin.deleteUser or the account-delete endpoint — disconnecting an integration is unrelated to account deletion", () => {
  assert.ok(!/admin\.deleteUser|account\/delete/.test(anilistDisconnectSource));
});

check("G3: the push logout-cleanup helper (reused by both ordinary sign-out and post-deletion cleanup) never itself deletes the account or calls the admin client", () => {
  assert.ok(!/admin\.deleteUser|getSupabaseAdminClient/.test(logoutCleanupSource));
});

check("G4: nothing in the account-delete route is reachable from a 401/token-refresh-failure handler — the route only ever runs from an explicit POST with an explicit confirmation body, never from middleware/proxy", () => {
  assert.ok(!existsSync("src/proxy.ts") || !src("src/proxy.ts").includes("account/delete"));
});

// ============================================================
// H — service-role isolation, no secret exposure
// ============================================================
check("H1 (CRITICAL): the admin client (service-role/secret-key-backed) is never imported by any client (\"use client\") component in this feature", () => {
  assert.ok(!/from "@\/lib\/supabase\/admin"/.test(dialogSource + panelSource), "the browser must never import the admin client module");
});

check("H2: the admin client module itself is still server-only (unchanged guard) — Stage 43 did not weaken this", () => {
  assert.ok(/import "server-only"/.test(adminClientSource));
});

check("H3: no secret value (key, token, password) is printed, logged, or embedded as a literal anywhere in the new files", () => {
  const combined = deleteRoute + dialogSource + panelSource;
  assert.ok(!/SUPABASE_SECRET_KEY\s*=\s*["']|SUPABASE_SERVICE_ROLE_KEY\s*=\s*["']|sk-ant|eyJhbGciOi/.test(combined));
});

// ============================================================
// I — Resume engine / source lifecycle untouched
// ============================================================
check("I1 (CRITICAL): src/lib/resume.ts has no coupling to account deletion — this stage never touches selection/resume logic", () => {
  assert.ok(!/account|delete.*user|admin\.deleteUser/i.test(resumeLibSource));
});

check("I2: Stage 42's tracking-sources.ts module has no new account-deletion-specific export or branch (already covered by B3, restated here as its own named check per the task's own item list)", () => {
  assert.ok(/export async function deleteUnlinkedManualSource/.test(trackingSourcesLib));
});

// ============================================================
// J — migration immutability
// ============================================================
check("J1 (CRITICAL): no migration 0020 (or beyond) exists — Phase 0 found the existing 0001-0019 cascade guarantee already sufficient, so none was created", () => {
  assert.ok(!migrationFiles.some((f) => /^0020/.test(f) || Number(f.slice(0, 4)) > 19), `expected no migration beyond 0019, found: ${migrationFiles.filter((f) => Number(f.slice(0, 4)) > 19).join(", ")}`);
});

check("J2: migration 0018 still exists, unmodified in shape (same table name it created)", () => {
  assert.ok(existsSync("supabase/migrations/0018_stage40_backup_item_map.sql"));
});

check("J3: migration 0019 still exists with its known unique closing comment, confirming it was not edited by this stage", () => {
  assert.ok(migration0019.includes("migration only makes the database independently enforce the same rule"));
});

check("J4: exactly 19 migration files exist", () => {
  assert.equal(migrationFiles.length, 19, `expected exactly 19 migration files, found ${migrationFiles.length}: ${migrationFiles.join(", ")}`);
});

// ============================================================
// K — Settings navigation / discoverability
// ============================================================
check("K1: the new Account settings tab is added to the shared SettingsShell nav — not a separate, disconnected page", () => {
  assert.ok(/\{ id: "account", label: "Account", href: "\/settings\/account" \}/.test(settingsShellSource));
});

check("K2: the account settings page is reachable from the header's Account menu (discoverability), alongside the other existing settings links", () => {
  assert.ok(/href="\/settings\/account"/.test(accountMenuSource));
});

check("K3: this stage did not remove or rename any existing settings tab", () => {
  for (const label of ["Connections", "Auto Tracking", "Notifications", "Recently Changed", "Data & Backup", "App"]) {
    assert.ok(settingsShellSource.includes(`label: "${label}"`), `expected existing tab "${label}" to still be present`);
  }
});

// ============================================================
// L — Part A: account-specific localStorage cleanup after confirmed deletion
// ============================================================
// In-memory reproduction of the two new helpers' exact logic — same
// convention as every other script in this directory (a faithful model,
// never the real browser API), cross-checked against the real source
// below by static assertions on the exact key-prefix constants and
// function shapes.
const DISMISS_FLAG_PREFIX = "markly.import-banner-dismissed.";
const MIGRATION_FLAG_PREFIX = "markly.migrated.";

function makeFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    has: (k) => map.has(k),
    snapshot: () => Object.fromEntries(map),
  };
}

function modelClearImportBannerDismissedForUser(storage, userId) {
  try {
    storage.removeItem(DISMISS_FLAG_PREFIX + userId);
  } catch {
    // Best-effort only.
  }
}

function modelClearMigrationMarkerForUser(storage, userId) {
  try {
    storage.removeItem(MIGRATION_FLAG_PREFIX + userId);
  } catch {
    // Best-effort only.
  }
}

check("L1 (CRITICAL): the real useLocalImport.ts exports clearImportBannerDismissedForUser, keyed by the same DISMISS_FLAG_PREFIX its own persistDismissed/isDismissed already use", () => {
  assert.ok(/export function clearImportBannerDismissedForUser\(userId: string\): void/.test(localImportSource));
  assert.ok(/const DISMISS_FLAG_PREFIX = "markly\.import-banner-dismissed\."/.test(localImportSource));
  const fnBody = localImportSource.slice(localImportSource.indexOf("export function clearImportBannerDismissedForUser"));
  assert.ok(/removeItem\(DISMISS_FLAG_PREFIX \+ userId\)/.test(fnBody));
});

check("L2 (CRITICAL): the real cloud/migration.ts exports clearMigrationMarkerForUser, keyed by the same migrationFlagKey() its own markMigrationComplete/hasCompletedMigration already use", () => {
  assert.ok(/export function clearMigrationMarkerForUser\(userId: string\): void/.test(migrationLibSource));
  const fnBody = migrationLibSource.slice(migrationLibSource.indexOf("export function clearMigrationMarkerForUser"));
  assert.ok(/removeItem\(migrationFlagKey\(userId\)\)/.test(fnBody));
});

check("L3: both new exported helpers wrap their storage access in try/catch — non-throwing, matching every other localStorage helper in this codebase", () => {
  const importFn = localImportSource.slice(localImportSource.indexOf("export function clearImportBannerDismissedForUser"));
  const migrationFn = migrationLibSource.slice(migrationLibSource.indexOf("export function clearMigrationMarkerForUser"));
  assert.ok(/try \{[\s\S]*?catch/.test(importFn));
  assert.ok(/try \{[\s\S]*?catch/.test(migrationFn));
});

check("L4 (A/B — model): clearing deleted user A's flags removes exactly A's two keys and leaves user B's same-prefix keys untouched", () => {
  const storage = makeFakeStorage({
    [DISMISS_FLAG_PREFIX + "userA"]: "1",
    [MIGRATION_FLAG_PREFIX + "userA"]: "true",
    [DISMISS_FLAG_PREFIX + "userB"]: "1",
    [MIGRATION_FLAG_PREFIX + "userB"]: "true",
  });
  modelClearImportBannerDismissedForUser(storage, "userA");
  modelClearMigrationMarkerForUser(storage, "userA");
  assert.equal(storage.has(DISMISS_FLAG_PREFIX + "userA"), false, "A's import-banner flag must be gone");
  assert.equal(storage.has(MIGRATION_FLAG_PREFIX + "userA"), false, "A's migration marker must be gone");
  assert.equal(storage.has(DISMISS_FLAG_PREFIX + "userB"), true, "B's import-banner flag must survive untouched (C)");
  assert.equal(storage.has(MIGRATION_FLAG_PREFIX + "userB"), true, "B's migration marker must survive untouched (C)");
});

check("L5 (D/E/F — model): unrelated local-mode global keys (library, theme, activity, activitySummary, commandPalette, local recovery/reminders/smart-views) are never touched by either helper", () => {
  const localModeKeys = {
    "markly.library": "[]",
    "markly.theme": "dark",
    "markly.activity": "[]",
    "markly.activitySummary": "{}",
    "markly.commandPalette": "{}",
    "markly.localRecovery": "[]",
    "markly.reminders": "[]",
    "markly.smartViews": "[]",
  };
  const storage = makeFakeStorage({
    ...localModeKeys,
    [DISMISS_FLAG_PREFIX + "userA"]: "1",
    [MIGRATION_FLAG_PREFIX + "userA"]: "true",
  });
  modelClearImportBannerDismissedForUser(storage, "userA");
  modelClearMigrationMarkerForUser(storage, "userA");
  for (const [key, value] of Object.entries(localModeKeys)) {
    assert.equal(storage.getItem(key), value, `local-mode key ${key} must be untouched`);
  }
});

check("L6 (CRITICAL, H): the real AccountSettingsPanel only calls the two clear-helpers AFTER the confirmed-deleted gate — the failure branch returns before either call is reachable", () => {
  const fnBody = panelStripped.slice(panelStripped.indexOf("async function handleConfirmDelete"));
  const failureReturnIndex = fnBody.indexOf('data.status !== "deleted"');
  const clearCallIndex = fnBody.indexOf("clearImportBannerDismissedForUser(deletedUserId)");
  assert.ok(failureReturnIndex !== -1 && clearCallIndex !== -1);
  assert.ok(failureReturnIndex < clearCallIndex, "the deleted-status check (and its early return on failure) must come before the clear-helper calls");
  // The failure branch's own block must contain a `return` before falling
  // through to where the clear-helper calls live.
  const failureBlock = fnBody.slice(failureReturnIndex, clearCallIndex);
  assert.ok(/return;/.test(failureBlock), "a failed deletion must return before reaching the clear-helper calls");
});

check("L7 (G): a failed account-delete response never calls either clear-helper — reusing L6's own failureBlock slice, confirming no call appears inside it", () => {
  const fnBody = panelStripped.slice(panelStripped.indexOf("async function handleConfirmDelete"));
  const failureReturnIndex = fnBody.indexOf('data.status !== "deleted"');
  const clearCallIndex = fnBody.indexOf("clearImportBannerDismissedForUser(deletedUserId)");
  const failureBlock = fnBody.slice(failureReturnIndex, clearCallIndex);
  assert.ok(!/clearImportBannerDismissedForUser|clearMigrationMarkerForUser/.test(failureBlock));
});

check("L8 (I): the client-side identity used for local cleanup comes from the already-authenticated session's OWN current user (useAuth()), never from the server response body — the local cleanup id and server authorization are kept separate, matching the task's own instruction", () => {
  assert.ok(/const deletedUserId = user\?\.id/.test(panelStripped));
  assert.ok(!/clearImportBannerDismissedForUser\(data\./.test(panelStripped), "must never derive the cleanup id from the server's response body");
});

check("L9 (I): signOut()/redirect are unconditional after the clear-helper calls — a storage-cleanup hiccup (both helpers are internally try/caught and can never throw out) cannot prevent completing sign-out, and the already-successful server deletion is never reinterpreted as a failure because of it", () => {
  const fnBody = panelStripped.slice(panelStripped.indexOf("async function handleConfirmDelete"));
  const clearCallIndex = fnBody.indexOf("clearMigrationMarkerForUser(deletedUserId)");
  const signOutIndex = fnBody.indexOf("await signOut()");
  assert.ok(clearCallIndex !== -1 && signOutIndex !== -1 && clearCallIndex < signOutIndex);
});

// ============================================================
// M — Part B: extension local pairing audit (no extension code changed)
// ============================================================
check("M1: the extension's device credential is a single opaque key stored via chrome.storage.local, explicitly never webpage localStorage", () => {
  assert.ok(/const TOKEN_KEY = "markly_device_token"/.test(extStorageSource));
  assert.ok(/chrome\.storage\.local/.test(extStorageSource));
  assert.ok(/never webpage[\s*]+localStorage/.test(extStorageSource));
});

check("M2: the device token itself is pure high-entropy randomness (crypto.randomBytes) — no userId/email/source-history is ever encoded into it", () => {
  assert.ok(/export function generateDeviceToken\(\): string \{\s*return crypto\.randomBytes\(32\)\.toString\("base64url"\);/.test(tokensLibSource));
});

check("M3 (CRITICAL): extension_devices/pairing_codes are among the 14 tables Phase 0 already confirmed cascade-delete on account deletion (cross-referenced against the USER_OWNED_TABLES map above, not re-derived here)", () => {
  assert.ok(USER_OWNED_TABLES.some(([t]) => t === "extension_devices"));
  assert.ok(USER_OWNED_TABLES.some(([t]) => t === "pairing_codes"));
});

check("M4: /api/extension/progress returns 401 in exactly two cases — a missing bearer token, or authenticateDevice finding no matching (or revoked) device row — never for any other reason", () => {
  const unauthorizedBlocks = extensionProgressRoute.match(/status: 401/g) ?? [];
  assert.equal(unauthorizedBlocks.length, 2, `expected exactly 2 distinct 401 responses in this route, found ${unauthorizedBlocks.length}`);
  assert.ok(/if \(!token\) return NextResponse\.json\(\{ error: "unauthorized" \}, \{ status: 401 \}\);/.test(extensionProgressRoute));
  assert.ok(/if \(!device\) return NextResponse\.json\(\{ error: "unauthorized" \}, \{ status: 401 \}\);/.test(extensionProgressRoute));
});

check("M5: authenticateDevice itself cleanly distinguishes 'no matching/revoked row' (returns null) from a genuine query failure (throws) — the route's own .catch(() => null) collapsing both into the same 401 is a pre-existing (Stage 18) characteristic, unrelated to and unmodified by Stage 43", () => {
  assert.ok(/if \(!row \|\| row\.revoked_at !== null\) return null;/.test(devicesLibSource));
  assert.ok(/if \(error\) throw error;/.test(devicesLibSource));
  assert.ok(/authenticateDevice\(admin, token\)\.catch\(\(\) => null\)/.test(extensionProgressRoute));
});

check("M6 (CRITICAL, J): the extension's service worker ALREADY clears its local device token whenever it receives an 'unauthorized' progress result — pre-existing Stage 18/22 behavior; after an account deletion the device row is gone, so the very next request already receives this same, already-handled 401/unauthorized outcome with ZERO extension code changes needed", () => {
  assert.ok(/if \(result\.status === "unauthorized"\)/.test(extServiceWorkerSource));
  const branch = extServiceWorkerSource.slice(extServiceWorkerSource.indexOf('if (result.status === "unauthorized")'));
  assert.ok(/await clearDeviceToken\(\)/.test(branch.slice(0, 300)));
});

check("M7: submitProgress treats a bare HTTP 401 as 'unauthorized' — this is the ONLY response shape the service worker's clear-on-unauthorized branch reacts to; nothing new was added for account deletion specifically", () => {
  assert.ok(/if \(response\.status === 401\) return \{ status: "unauthorized" \};/.test(extApiSource));
});

check("M8 (CRITICAL, K): no generic/new 401-handling or account-deletion-specific coupling was added anywhere in the extension — none of its source files mention 'account' deletion at all, confirming Stage 43 made zero extension code changes and relies entirely on the pre-existing clear-on-unauthorized behavior above", () => {
  for (const [name, text] of [
    ["storage.ts", extStorageSource],
    ["api.ts", extApiSource],
    ["service-worker.ts", extServiceWorkerSource],
  ]) {
    assert.ok(!/account.*delet|delet.*account/i.test(text), `${name} must contain no account-deletion-specific logic`);
  }
});

check("M9: extension_devices has no ordinary-authenticated INSERT policy — a dead/cleared local token can never cause a new device row to be auto-recreated; pairing only ever happens through the server-only admin client after independently verifying a fresh pairing code", () => {
  const extDevicesMigration = migrationTexts["0003_stage18_auto_tracking.sql"];
  const tableBlock = extDevicesMigration.slice(
    extDevicesMigration.indexOf("create table if not exists public.extension_devices"),
    extDevicesMigration.indexOf("create table if not exists public.pairing_codes"),
  );
  assert.ok(!/extension_devices_insert_own/.test(tableBlock), "extension_devices must still have no ordinary-authenticated insert policy");
});

// ============================================================
// Report
// ============================================================
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}`);
  if (!r.ok) console.log(`  ${r.err?.message ?? r.err}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
