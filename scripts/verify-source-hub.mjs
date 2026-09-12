#!/usr/bin/env node
// Verifies Stage 40 (Source Hub & Multi-Source Management): the manual
// "Add Source" flow, the empty/one/many-source Item Detail UI, reuse of
// Stage 39's URL validation, the existing Stage 26 auto-relink-suppression
// invariant, and durable structural contracts — most importantly that
// adding a source never server-fetches its URL, never silently moves a
// source between LibraryItems, and never requires (or accidentally gained)
// a database migration.
//
// Run with: node scripts/verify-source-hub.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

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

// ============================================================
// A — URL validation reuse (Stage 40 §4, reusing lib/website.ts verbatim —
// same convention as Stage 39's own verify-share-capture.mjs).
// ============================================================
function normalizeUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const hasProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed);
  return hasProtocol ? trimmed : `https://${trimmed}`;
}
function isValidUrl(value) {
  try {
    const { protocol, hostname, username, password } = new URL(value);
    if (protocol !== "http:" && protocol !== "https:") return false;
    if (username || password) return false;
    return hostname.length > 0 && (hostname.includes(".") || hostname === "localhost");
  } catch {
    return false;
  }
}

check("A1: AddSourceDialog imports isValidUrl/normalizeUrl from lib/website.ts — no second validator", () => {
  const source = src("src/components/AddSourceDialog.tsx");
  assert.ok(/from "@\/lib\/website"/.test(source));
  assert.ok(source.includes("isValidUrl") && source.includes("normalizeUrl"));
});

check("A2 (CRITICAL — scheme allowlist): javascript:/data:/blob:/file:/ftp:/chrome:/about:/intent:/mailto:/tel: are all rejected by the shared validator", () => {
  for (const scheme of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "blob:https://example.com/x", "file:///etc/passwd", "ftp://example.com/x", "chrome://settings", "about:blank", "intent://example.com#Intent;end", "mailto:a@example.com", "tel:+1234567890"]) {
    assert.ok(!isValidUrl(normalizeUrl(scheme)), `expected ${scheme} to be rejected`);
  }
});

check("A3 (CRITICAL — credential URL): userinfo is rejected outright", () => {
  assert.ok(!isValidUrl(normalizeUrl("https://user:password@example.com/foo")));
});

check("A4: a bare hostname is normalized to https://, matching the manual Website form and Stage 39", () => {
  assert.equal(normalizeUrl("example.com/foo"), "https://example.com/foo");
  assert.ok(isValidUrl(normalizeUrl("example.com/foo")));
});

check("A5: long/malformed input never throws", () => {
  assert.doesNotThrow(() => isValidUrl(normalizeUrl("a".repeat(5000))));
  assert.doesNotThrow(() => isValidUrl(normalizeUrl("not a url at all")));
});

// ============================================================
// B — no arbitrary server fetch / SSRF (Stage 40 §35, CRITICAL). Adding a
// source must never fetch the source URL itself.
// ============================================================
const sourceHubFiles = ["src/components/AddSourceDialog.tsx", "src/components/ItemTrackingSourcesSection.tsx", "src/lib/extension/tracking-sources.ts", "src/app/api/tracking-sources/route.ts"];

check("B1 (CRITICAL): createManualSource and the /api/tracking-sources POST route never fetch the submitted URL — only Supabase table operations touch it", () => {
  const trackingSourcesLib = stripComments(src("src/lib/extension/tracking-sources.ts"));
  const fn = trackingSourcesLib.slice(trackingSourcesLib.indexOf("export async function createManualSource"));
  assert.ok(!/\bfetch\(/.test(fn), "createManualSource must never call fetch()");
  const routeSource = stripComments(src("src/app/api/tracking-sources/route.ts"));
  assert.ok(!/\bfetch\(/.test(routeSource), "the tracking-sources route must never call fetch() itself");
});

check("B2: any fetch() call in the client-side Source Hub files targets only a fixed, same-origin /api/ path — never the user-submitted URL variable", () => {
  for (const file of ["src/components/AddSourceDialog.tsx", "src/components/ItemTrackingSourcesSection.tsx"]) {
    const source = src(file);
    const calls = [...source.matchAll(/\bfetch\(\s*([^,)]+)/g)].map((m) => m[1].trim());
    for (const arg of calls) {
      assert.ok(/^["'`]\/api\//.test(arg), `${file} calls fetch(${arg}) — must be a literal same-origin "/api/..." path`);
    }
  }
});

// ============================================================
// C — no fuzzy matching / exact identity only (Stage 40 §5/§8).
// ============================================================
check("C1: no fuzzy/loose title-matching heuristic was introduced for source identity — exact normalized URL only", () => {
  for (const file of sourceHubFiles) {
    const source = stripComments(src(file));
    assert.ok(!/normalizeTitleForMatching|fuzzy|levenshtein/i.test(source), `${file} must not add a second, looser source-matching heuristic`);
  }
});

check("C2 (CRITICAL): createManualSource never blindly upserts a payload that could move an existing source's library_item_id — it always checks the existing row first and only inserts when genuinely absent", () => {
  const source = stripComments(src("src/lib/extension/tracking-sources.ts"));
  const fn = source.slice(source.indexOf("export async function createManualSource"), source.indexOf("export async function createManualSource") + 3000);
  assert.ok(fn.includes(".select("), "must read the existing row before deciding what to do");
  assert.ok(!/\.upsert\(/.test(fn), "must never upsert (which could silently overwrite an existing link) — insert only, after an explicit existing-row check");
});

check("C3: duplicate-source identity reuses the existing (user_id, adapter_id, source_key) uniqueness the extension's own detected sources already rely on — no new constraint was invented", () => {
  const source = src("src/lib/extension/tracking-sources.ts");
  assert.ok(source.includes('"manual"'), "manual sources must use the reserved adapter_id sentinel, not a new identity scheme");
});

check("C4: concurrent double-create is resolved via the database's own unique-constraint violation (23505), not merely a client-side disabled-button guard", () => {
  const source = src("src/lib/extension/tracking-sources.ts");
  assert.ok(/23505/.test(source), "must handle the Postgres unique-violation code as the authoritative concurrency guard");
});

check("C5: a cross-item conflict (source already linked to a DIFFERENT item) is reported, never silently resolved by moving the source", () => {
  const source = src("src/lib/extension/tracking-sources.ts");
  assert.ok(/status:\s*"conflict"/.test(source));
});

// ============================================================
// D — explicit-only actions, no auto-add/auto-open (Stage 40 §6/§15/§30).
// ============================================================
check("D1: AddSourceDialog never submits automatically — no useEffect calls the create/submit path, only the form's own onSubmit", () => {
  const source = src("src/components/AddSourceDialog.tsx");
  assert.ok(!/useEffect/.test(source), "Add Source must need no effects — everything is derived state + an explicit submit handler");
});

check("D2: no clipboard read exists anywhere in the Source Hub — a plain input field only", () => {
  for (const file of sourceHubFiles) {
    assert.ok(!/navigator\.clipboard/.test(src(file)), `${file} must not read the clipboard automatically`);
  }
});

check("D3: Open Source is a plain same-tab-safe external link (target=_blank + rel=noopener noreferrer), never an automatic navigation and never proxied through Markly", () => {
  const source = src("src/components/ItemTrackingSourcesSection.tsx");
  assert.ok(/target="_blank"/.test(source) && /rel="noopener noreferrer"/.test(source));
  assert.ok(!/window\.location\s*=.*openUrl|window\.open\(\s*openUrl/.test(source), "opening a source must be a real <a> the user clicks, never scripted");
});

check("D4: no source is auto-opened after linking — Add Source's success path only refreshes the list, it never navigates to the source URL", () => {
  const dialogSource = src("src/components/AddSourceDialog.tsx");
  assert.ok(!/window\.open|window\.location/.test(dialogSource));
});

// ============================================================
// E — Item Detail UI: zero/one/many-source states use one shared
// component (Stage 40 §2/§30/§31/§32).
// ============================================================
const sectionSource = src("src/components/ItemTrackingSourcesSection.tsx");

check("E1: a zero-source empty state exists with truthful, non-alarming copy and an Add Source action — the old Stage 26 behavior of rendering nothing is gone", () => {
  assert.ok(/No sources linked yet/.test(sectionSource));
  assert.ok((sectionSource.match(/Add source/g) ?? []).length >= 2, "expected an Add source affordance in both the empty state and the populated-list header");
});

check("E2: one component renders the list regardless of count — no separate 'single source' branch exists", () => {
  assert.ok(!/sources\.length === 1/.test(sectionSource), "must not special-case exactly one source with different markup");
});

check("E3: the section still renders nothing at all when signed out — tracking_sources remains a cloud-only concept, unchanged from Stage 26. Stage 41.3 narrowed this guard from `!userId || !sources` to `!userId` alone, on purpose: a null source state can now also mean 'genuinely unknown after a failed post-mutation refresh' (not only 'still loading'), and that case must still render its own error/loading UI rather than vanishing — but signed-out must still render nothing at all, unconditionally.", () => {
  assert.ok(/if \(!userId\) return null/.test(sectionSource), "the guard must still return null for a signed-out user");
  assert.ok(!/if \(!userId \|\| !sources\) return null/.test(sectionSource), "the OLD combined guard must be gone — sources === null must no longer mean 'render nothing'");
});

check("E4: hostnames are truncated/wrapped safely, never allowed to overflow — reuses the existing truncate class convention", () => {
  assert.ok(/truncate/.test(sectionSource));
});

// ============================================================
// F — ownership / RLS (Stage 40 §9/§43).
// ============================================================
check("F1 (CRITICAL): createManualSource is session-authenticated (takes the normal RLS-scoped SupabaseClient), never the admin/service-role client", () => {
  const source = src("src/lib/extension/tracking-sources.ts");
  const fn = source.slice(source.indexOf("export async function createManualSource"), source.indexOf("export async function createManualSource") + 400);
  assert.ok(/supabase: SupabaseClient/.test(fn));
});

check("F2: the create-source API route derives user_id only from the authenticated session, never from the request body", () => {
  const route = stripComments(src("src/app/api/tracking-sources/route.ts"));
  const postFn = route.slice(route.indexOf("export async function POST"));
  assert.ok(postFn.includes("userData.user.id"));
  assert.ok(!/user_id\s*:\s*body\./.test(postFn), "user_id must never be read from the client-supplied body");
});

check("F3: the route re-validates the URL server-side with the same policy — never trusts client-side validation alone", () => {
  const route = src("src/app/api/tracking-sources/route.ts");
  assert.ok(route.includes("isValidUrl") && route.includes("normalizeUrl"));
});

// ============================================================
// G — auto-relink suppression preserved (Stage 40 §11/§12, CRITICAL
// pre-existing invariant from Stage 26).
// ============================================================
check("G1 (CRITICAL): unlinkSource still sets auto_link_suppressed_at — Source Hub's Unlink button calls this exact existing function, unchanged", () => {
  const source = src("src/lib/extension/tracking-sources.ts");
  const fn = source.slice(source.indexOf("export async function unlinkSource"), source.indexOf("export async function unlinkSource") + 500);
  assert.ok(fn.includes("auto_link_suppressed_at: new Date().toISOString()"));
});

check("G2: linkSource still clears auto_link_suppressed_at on any explicit link — createManualSource's own linking branch reuses this function rather than a second implementation", () => {
  const source = src("src/lib/extension/tracking-sources.ts");
  const linkFn = source.slice(source.indexOf("export async function linkSource"), source.indexOf("export async function linkSource") + 400);
  assert.ok(linkFn.includes("auto_link_suppressed_at: null"));
  const createFn = source.slice(source.indexOf("export async function createManualSource"));
  assert.ok(createFn.includes("linkSource(supabase"), "createManualSource must call the existing linkSource() for its 'link an existing unlinked source' branch, not duplicate the update itself");
});

check("G3: Source Hub's Unlink action in the UI calls the existing /api/tracking-sources/unlink endpoint — no second unlink code path", () => {
  assert.ok(sectionSource.includes('"/api/tracking-sources/unlink"'));
});

// ============================================================
// H — deterministic ordering (Stage 40 §29, reusing the existing
// most-recently-seen rule Dashboard's own resume logic already uses).
// ============================================================
check("H1: listSourcesForItem orders by last_seen_at descending — the same signal Dashboard's resolveResumeTarget already uses, not a new rule", () => {
  const source = src("src/lib/extension/tracking-sources.ts");
  const fn = source.slice(source.indexOf("export async function listSourcesForItem"), source.indexOf("export async function listSourcesForItem") + 500);
  assert.ok(/order\(\s*"last_seen_at"\s*,\s*\{\s*ascending:\s*false\s*\}\s*\)/.test(fn));
});

check("H2: Dashboard's own best-source selection (existing, unchanged) remains the single source of truth for 'preferred' — Stage 40 did not invent a second preferred-source concept or schema field", () => {
  const dashboardSource = src("src/lib/dashboard.ts");
  assert.ok(dashboardSource.includes("selectBestTrackingSource"));
  const migrationsDir = "supabase/migrations";
  const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  for (const file of migrations) {
    assert.ok(!/preferred_source|is_preferred|default_source/i.test(src(`${migrationsDir}/${file}`)), `${file} must not introduce a new preferred-source column`);
  }
});

// ============================================================
// I — no database migration for the ORIGINAL Source Hub feature or the
// Part B ownership/type gate (Stage 40 §59/§60 decision gate). Migration
// 0018 is a SEPARATE, later, explicitly-approved addition scoped only to
// backup restore's item-mapping gap — see Section N below — never
// conflated with this section's own claim.
// ============================================================
check("I1: Source Hub itself and the Part B ownership/type correction required no schema change — the only migration added anywhere in this stage is 0018 (backup item-map, Section N below), never a second one for Source Hub/Part B", () => {
  const migrations = readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort();
  assert.ok(migrations.includes("0017_stage37_web_push.sql"));
  const beyond0017 = migrations.filter((f) => !migrations.slice(0, migrations.indexOf("0017_stage37_web_push.sql") + 1).includes(f));
  assert.deepEqual(beyond0017, ["0018_stage40_backup_item_map.sql"], "exactly one migration beyond 0017 is expected — 0018, and nothing else");
});

check("I2: migration 0017 itself still exists (immutable, per every prior stage's own rule) — untouched by either the Source Hub feature or migration 0018", () => {
  assert.ok(existsSync("supabase/migrations/0017_stage37_web_push.sql"));
});

// ============================================================
// J — display-name correction is additive, not a regression to existing
// extension-detected sources (Stage 40's getSourceDisplayName change).
// ============================================================
check("J1: getSourceDisplayName only prefers sourceTitle for the reserved 'manual' adapter — every existing extension adapter's display logic (adapter label / hostname fallback) is unchanged", () => {
  const source = src("src/lib/extension/source-display.ts");
  assert.ok(/adapterId === MANUAL_SOURCE_ADAPTER_ID && sourceTitle/.test(source));
  assert.ok(source.includes("ADAPTER_LABELS[adapterId]"), "the pre-existing adapter-label lookup must remain the next fallback for every non-manual source");
});

check("J2: every existing call site of getSourceDisplayName was updated to pass sourceTitle, except the one documented case where sourceTitle is already shown as the primary label right above it (which would otherwise just repeat itself)", () => {
  for (const file of ["src/components/ItemTrackingSourcesSection.tsx", "src/components/TrackingSettingsPanel.tsx", "src/lib/dashboard.ts"]) {
    const source = src(file);
    const lines = source.split("\n");
    lines.forEach((line, i) => {
      const match = line.match(/getSourceDisplayName\(([^)]*)\)/);
      if (!match) return;
      const argCount = match[1].split(",").length;
      if (argCount === 3) return;
      const precedingComment = lines[i - 1] ?? "";
      assert.ok(
        /sourceTitle is already the primary text above/.test(precedingComment),
        `${file}:${i + 1} has an undocumented 2-argument getSourceDisplayName(${match[1]}) call — either pass sourceTitle or add the documenting comment for a deliberate exception`,
      );
    });
  }
});

// ============================================================
// K — Stage 39 Link Source integration is covered in
// verify-share-capture.mjs's own Section K — not duplicated here, only
// cross-checked that the API contract both sides agree on actually matches.
// ============================================================
check("K1: ShareCaptureView's Link Source calls and AddSourceDialog's Add Source call use the identical /api/tracking-sources request shape (libraryItemId, url[, label]) — neither sends a client-declared mediaType", () => {
  const shareSource = src("src/components/ShareCaptureView.tsx");
  const dialogSource = src("src/components/AddSourceDialog.tsx");
  for (const source of [shareSource, dialogSource]) {
    assert.ok(source.includes("libraryItemId"));
    const postCalls = [...source.matchAll(/fetch\(\s*"\/api\/tracking-sources"[\s\S]*?body:\s*JSON\.stringify\(([\s\S]*?)\}\)/g)].map((m) => m[1]);
    for (const body of postCalls) {
      assert.ok(!/mediaType/.test(body), `${source === shareSource ? "ShareCaptureView" : "AddSourceDialog"} still sends mediaType in its POST body — the server must be the sole source of truth for item type`);
    }
  }
});

// ============================================================
// M — Data-Integrity & Ownership Gate correction: parent LibraryItem
// ownership and media type are proven server-side, never trusted from the
// request body (Stage 40 follow-up, Part B).
// ============================================================
check("M1 (CRITICAL): the /api/tracking-sources POST handler no longer parses, validates, or forwards a client-supplied mediaType (GET's own unrelated `mediaType: row.media_type` response mapping of an already-authoritative stored value is untouched)", () => {
  const route = stripComments(src("src/app/api/tracking-sources/route.ts"));
  const postFn = route.slice(route.indexOf("export async function POST"));
  assert.ok(!/mediaType/.test(postFn), "the POST handler must not mention mediaType at all — it must be fully removed from the request contract, not merely unused");
});

check("M2 (CRITICAL): createManualSource's signature no longer accepts a mediaType parameter — the function itself is the one authority for the created row's media_type", () => {
  const source = src("src/lib/extension/tracking-sources.ts");
  const sigStart = source.indexOf("export async function createManualSource");
  const sigEnd = source.indexOf(")", source.indexOf("(", sigStart));
  const signature = source.slice(sigStart, sigEnd);
  assert.ok(!/mediaType/.test(signature), `createManualSource's signature still mentions mediaType: ${signature}`);
});

check("M3 (CRITICAL): createManualSource loads the target LibraryItem itself (id + type) via the RLS-scoped client before ever writing a tracking_sources row — proving both ownership and real type", () => {
  const source = stripComments(src("src/lib/extension/tracking-sources.ts"));
  const fn = source.slice(source.indexOf("export async function createManualSource"), source.indexOf("export async function createManualSource") + 1600);
  assert.ok(/\.from\(\s*"library_items"\s*\)/.test(fn), "must SELECT from library_items before creating a source");
  assert.ok(/\.select\(\s*"id,\s*type"\s*\)/.test(fn), "must load the item's real stored type, not trust a request field");
});

check("M4 (CRITICAL): an item that isn't found (or belongs to someone else) is reported as the exact same generic outcome either way — never a distinguishable signal an attacker could use to enumerate other accounts' item ids", () => {
  const source = src("src/lib/extension/tracking-sources.ts");
  assert.ok(/status:\s*"item-not-found"/.test(source), "must have a single not-found outcome, not separate not-found/forbidden branches");
});

check("M5 (CRITICAL): website items (and any other non-trackable type) are rejected using the item's ACTUAL stored type, mirroring tracking_sources' own media_type CHECK constraint (anime/manga/novel/game/movie/series only)", () => {
  const source = src("src/lib/extension/tracking-sources.ts");
  assert.ok(/TRACKABLE_MEDIA_TYPES.*=.*\[.*"anime".*"manga".*"novel".*"game".*"movie".*"series".*\]/.test(source.replace(/\s+/g, " ")));
  assert.ok(/status:\s*"unsupported-item-type"/.test(source));
});

check("M6: the API route never leaks a raw Supabase/Postgres error for either failure — item-not-found and unsupported-item-type both get clean, generic JSON responses", () => {
  const route = stripComments(src("src/app/api/tracking-sources/route.ts"));
  assert.ok(/item_not_found/.test(route) && /unsupported_item_type/.test(route));
  assert.ok(!/error\.message|error\.details|error\.hint/.test(route), "must never forward a raw Postgres error object's fields to the client");
});

check("M7: the ownership check queries library_items scoped to BOTH the target id and this session's own user_id — defense-in-depth alongside RLS, matching this file's existing convention (unlinkSource/setAutoTrackEnabled)", () => {
  const source = stripComments(src("src/lib/extension/tracking-sources.ts"));
  const fn = source.slice(source.indexOf("export async function createManualSource"), source.indexOf("export async function createManualSource") + 1000);
  assert.ok(/\.eq\(\s*"id",\s*libraryItemId\s*\)[\s\S]*?\.eq\(\s*"user_id",\s*userId\s*\)/.test(fn) || /\.eq\(\s*"user_id",\s*userId\s*\)[\s\S]*?\.eq\(\s*"id",\s*libraryItemId\s*\)/.test(fn));
});

check("M8: the pre-existing tracking_sources RLS insert/update policies (migration 0003) already enforce library_item_id ownership independently of application code — confirmed present, not newly added by this correction", () => {
  const migration = src("supabase/migrations/0003_stage18_auto_tracking.sql");
  assert.ok(/tracking_sources_insert_own/.test(migration) && /li\.user_id = auth\.uid\(\)/.test(migration), "0003's own WITH CHECK must already tie library_item_id to the authenticated user");
});

check("M9: no migration (including 0018, added later for an unrelated reason — see Section N) adds a trigger/constraint tying tracking_sources.media_type to its parent library_items.type — the ownership/type fix is entirely application code, not a new SQL enforcement mechanism", () => {
  const migrations = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
  for (const file of migrations) {
    const content = src(`supabase/migrations/${file}`);
    assert.ok(!/create (or replace )?trigger.*tracking_sources.*media_type/is.test(content), `${file} must not introduce a trigger enforcing media_type consistency`);
  }
});

check("M10: AddSourceDialog and ItemTrackingSourcesSection no longer thread a mediaType prop through the UI — the server is the sole authority now, so the client has nothing to (mis)supply", () => {
  assert.ok(!/mediaType/.test(stripComments(src("src/components/AddSourceDialog.tsx"))));
  assert.ok(!/mediaType/.test(stripComments(src("src/components/ItemTrackingSourcesSection.tsx"))));
});

// ============================================================
// L — backup/local-mode: the Stage 40 data-integrity follow-up correction
// made TrackingSources first-class backed-up data (Part A) — see
// verify-backup-import.mjs's own Tests T for the full round-trip/safety
// suite. These checks only cross-verify the pieces specific to Source
// Hub's own files, and that local mode's existing cloud-only boundary
// (predating this correction) was preserved rather than papered over.
// ============================================================
check("L1: tracking_sources ARE now part of cloud-mode backup/export (Stage 40 data-integrity correction, Part A) — BackupSettingsPanel fetches and includes them", () => {
  const panel = src("src/components/BackupSettingsPanel.tsx");
  assert.ok(/fetchTrackingSourcesForExport/.test(panel), "cloud export must fetch tracking sources, not silently omit Stage 40's own first-class user data");
});

check("L1b: the local-mode export call site passes no tracking-source rows — tracking_sources still has no local/signed-out representation to export FROM", () => {
  const panel = src("src/components/BackupSettingsPanel.tsx");
  const localExportCall = panel.slice(panel.lastIndexOf("buildAndValidateBackup(library.items"));
  assert.ok(/buildAndValidateBackup\(library\.items,\s*collectionsStore\.collections,\s*activity\.events\)/.test(localExportCall.slice(0, 120)));
});

check("L2: the Source Hub section is documented as cloud-only, matching tracking_sources' existing local-mode gap — no second, inconsistent local source model was invented", () => {
  assert.ok(/cloud-only concept/i.test(sectionSource));
});

check("L3: restoreTrackingSource (the backup-restore write path) never introduces a second, incompatible manual-adapter identity scheme — it accepts an arbitrary preserved (adapterId, sourceKey), the same table and RLS policies createManualSource already uses", () => {
  const source = src("src/lib/extension/tracking-sources.ts");
  assert.ok(/export async function restoreTrackingSource/.test(source));
  const fn = source.slice(source.indexOf("export async function restoreTrackingSource"));
  assert.ok(fn.includes(`.from(TABLE)`), "must write to the same tracking_sources table, not a new one");
});

// ============================================================
// N — Migration 0018 (backup item-map). Full byte-level function-body
// diffing and behavioral itemMap modeling live in verify-backup-import.mjs
// (Tests U); these checks only cross-verify from Source Hub's own
// perspective — that the approved migration exists, is exactly one file,
// and that the client-side source-restore path this script already
// audits (Section L) is what actually consumes it.
// ============================================================
check("N1 (CRITICAL): migration 0018 exists and is the ONLY migration beyond 0017", () => {
  assert.ok(existsSync("supabase/migrations/0018_stage40_backup_item_map.sql"));
  const migrations = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
  assert.equal(migrations[migrations.length - 1], "0018_stage40_backup_item_map.sql");
  assert.ok(!migrations.some((f) => f.startsWith("0019")), "no migration 0019 or beyond exists");
});

check("N2: 0018 is additive only — it does not touch (edit, drop, or replace anything in) migrations 0001-0017's own filenames", () => {
  for (let i = 1; i <= 17; i++) {
    const n = String(i).padStart(4, "0");
    const migrations = readdirSync("supabase/migrations");
    assert.ok(migrations.some((f) => f.startsWith(n)), `migration ${n} must still exist unchanged`);
  }
});

check("N3: 0018 grants EXECUTE only to 'authenticated', never to 'public' or 'anon' — the same access model 0013/0014 already established for this function", () => {
  const migration = src("supabase/migrations/0018_stage40_backup_item_map.sql");
  assert.ok(/revoke all on function public\.import_library_backup\(uuid, jsonb\) from public/.test(migration));
  assert.ok(/grant execute on function public\.import_library_backup\(uuid, jsonb\) to authenticated/.test(migration));
  assert.ok(!/grant execute on function public\.import_library_backup.*to (public|anon)/i.test(migration));
});

check("N4: itemMap's returned fields are exactly backupItemId/realItemId/wasCreated — no user_id, no auth/session detail, no source data, no secret is ever selected into it", () => {
  const migration = src("supabase/migrations/0018_stage40_backup_item_map.sql");
  const itemMapExpr = migration.slice(migration.indexOf("'itemMap',"), migration.indexOf("'itemMap',") + 400);
  assert.ok(itemMapExpr.includes("backup_item_id") && itemMapExpr.includes("real_item_id") && itemMapExpr.includes("was_created"));
  assert.ok(!/user_id|auth\.|password|secret|token/i.test(itemMapExpr));
});

check("N5: the backup-import client resolves TrackingSource restoration through the RPC's returned itemMap, not through the plan's own pre-import estimate — the same file this script's Section L already audits for restoreTrackingSource usage", () => {
  const source = src("src/lib/cloud/backup-import.ts");
  assert.ok(/restoreTrackingSourcesFromBackup\(\s*backupTrackingSources: BackupTrackingSource\[\],\s*itemMap: ImportItemMapEntry\[\]/s.test(source.replace(/\s+/g, " ")));
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
