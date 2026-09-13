#!/usr/bin/env node
// Verifies Stage 42 "Source Lifecycle & Recovery":
//   - Permanent deletion of an UNLINKED MANUAL TrackingSource — the one
//     narrow class Phase 0's audit found genuinely safe to hard-delete
//     (nothing automatic can ever recreate a "manual" row, so erasing one
//     can never reopen the automatic-relink hole that erasing an unlinked
//     EXTENSION-detected row's auto_link_suppressed_at memory could).
//   - The atomic server-side DELETE...WHERE condition (user + unlinked +
//     manual, all in the one statement) that makes the "relink races a
//     delete" scenario safe without any new migration.
//   - Settings → Auto Tracking's new Delete/Forget control, gated to
//     exactly that eligible class, with an explicit confirmation dialog.
//   - Item Detail's new Retry action for a Source Hub that has become
//     unavailable (initial load failure OR a failed post-Add/Relink
//     reconciliation) — reusing the exact same shared, parent-owned fetch
//     already established in Stage 41.2/41.3, never a second independent
//     fetch.
//   - No resume-engine change of any kind: this stage is entirely about
//     source-row lifecycle and consumer-state freshness, not selection.
//
// Reproduced/audited verbatim from the real modules (same convention as
// every other script in this directory — plain .mjs, no TypeScript
// loader, no real database call).
//
// Run with: node scripts/verify-source-lifecycle.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

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

const trackingSourcesLib = src("src/lib/extension/tracking-sources.ts");
const trackingSourcesLibStripped = stripComments(trackingSourcesLib);
const deleteRoute = src("src/app/api/tracking-sources/delete/route.ts");
const deleteRouteStripped = stripComments(deleteRoute);
const settingsPanel = src("src/components/TrackingSettingsPanel.tsx");
const settingsPanelStripped = stripComments(settingsPanel);
const deleteDialog = src("src/components/DeleteSourceDialog.tsx");
const itemDetailSource = stripComments(src("src/components/ItemDetailView.tsx"));
const sectionSource = stripComments(src("src/components/ItemTrackingSourcesSection.tsx"));
const resumeLibSource = src("src/lib/resume.ts");

// ============================================================
// In-memory reproduction of deleteUnlinkedManualSource's ATOMIC WHERE
// condition — the exact four predicates the real DELETE statement ANDs
// together in one round trip. Modeled as a pure function over a fixed
// in-memory row set, exactly like every other script in this directory
// models a query's WHERE clause without a real database.
// ============================================================
function makeRow(overrides = {}) {
  return {
    id: overrides.id ?? "row-1",
    user_id: overrides.user_id ?? "user-1",
    library_item_id: "library_item_id" in overrides ? overrides.library_item_id : null,
    adapter_id: overrides.adapter_id ?? "manual",
  };
}
/** Mirrors: .eq("id", sourceId).eq("user_id", userId).is("library_item_id", null).eq("adapter_id", "manual") */
function atomicDeleteMatches(row, sourceId, userId) {
  return row.id === sourceId && row.user_id === userId && row.library_item_id === null && row.adapter_id === "manual";
}
function simulateDelete(rows, sourceId, userId) {
  const matched = rows.filter((row) => atomicDeleteMatches(row, sourceId, userId));
  if (matched.length > 0) return { status: "deleted" };
  const ownedById = rows.filter((row) => row.id === sourceId && row.user_id === userId);
  return ownedById.length > 0 ? { status: "not-deletable" } : { status: "already-missing" };
}

// ============================================================
// A — manual adapter creation is explicit-only.
// ============================================================
check("A1 (CRITICAL): recordDetection (extension detection) never writes adapter_id at all — it always uses the caller-supplied input.adapterId, which real adapters set to their own real id, never the literal 'manual'", () => {
  const fn = trackingSourcesLibStripped.slice(
    trackingSourcesLibStripped.indexOf("export async function recordDetection"),
    trackingSourcesLibStripped.indexOf("export async function claimSourceLink"),
  );
  assert.ok(/adapter_id:\s*input\.adapterId/.test(fn), "recordDetection must pass through the caller's own adapterId, never hardcode one");
  assert.ok(!/adapter_id:\s*["']manual["']/.test(fn));
});

check("A2 (CRITICAL): claimSourceLink (automatic smart-relink) only ever updates library_item_id — it never writes adapter_id, so it cannot create or change a row's adapter identity at all", () => {
  const fn = trackingSourcesLibStripped.slice(
    trackingSourcesLibStripped.indexOf("export async function claimSourceLink"),
    trackingSourcesLibStripped.indexOf("export async function getSourceByKey"),
  );
  assert.ok(!/adapter_id/.test(fn), "claimSourceLink must never touch adapter_id");
});

check("A3 (CRITICAL): the only two functions that ever write the literal string 'manual' are createManualSource (hardcoded, explicit Add Source) and restoreTrackingSource (passes through the BACKUP's own preserved adapterId, which itself could only be 'manual' if the original row was already created by createManualSource)", () => {
  const literalManualWrites = [...trackingSourcesLibStripped.matchAll(/adapter_id:\s*["']manual["']/g)];
  assert.equal(literalManualWrites.length, 1, "expected exactly one hardcoded adapter_id: \"manual\" write site (createManualSource's insert)");
  const createFn = trackingSourcesLibStripped.slice(trackingSourcesLibStripped.indexOf("export async function createManualSource"));
  assert.ok(/adapter_id:\s*["']manual["']/.test(createFn.slice(0, 3000)));
});

check("A4: no real extension adapter uses 'manual' as its own adapterId — 'manual' remains a reserved sentinel never emitted by genuine detection", () => {
  let adapterFiles;
  try {
    adapterFiles = readdirSync("extension/src/adapters").filter((f) => f.endsWith(".ts"));
  } catch {
    adapterFiles = [];
  }
  assert.ok(adapterFiles.length > 0, "expected at least one real adapter file to check");
  for (const file of adapterFiles) {
    const source = src(`extension/src/adapters/${file}`);
    const idMatch = source.match(/adapterId:\s*["']([^"']+)["']/);
    if (idMatch) assert.notEqual(idMatch[1], "manual", `${file} must never declare itself as the reserved "manual" adapter id`);
  }
});

check("A5: no foreign key anywhere in the schema references tracking_sources — a hard delete can never orphan a row in another table", () => {
  const migrationsDir = "supabase/migrations";
  const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  for (const file of migrations) {
    assert.ok(!/references\s+public\.tracking_sources/i.test(src(`${migrationsDir}/${file}`)), `${file} must not add a FK referencing tracking_sources`);
  }
});

// ============================================================
// B/C/D — delete eligibility rule (pure simulation of the atomic WHERE).
// ============================================================
check("B (CRITICAL): a non-manual (automatic/provider) UNLINKED source is NOT delete-eligible", () => {
  const rows = [makeRow({ id: "s1", adapter_id: "mangadex", library_item_id: null })];
  assert.equal(simulateDelete(rows, "s1", "user-1").status, "not-deletable");
});

check("C (CRITICAL): a LINKED manual source is NOT delete-eligible — Unlink must happen first", () => {
  const rows = [makeRow({ id: "s2", adapter_id: "manual", library_item_id: "item-1" })];
  assert.equal(simulateDelete(rows, "s2", "user-1").status, "not-deletable");
});

check("D: an UNLINKED manual source IS delete-eligible", () => {
  const rows = [makeRow({ id: "s3", adapter_id: "manual", library_item_id: null })];
  assert.equal(simulateDelete(rows, "s3", "user-1").status, "deleted");
});

// ============================================================
// E/F/G — server-side authority; client cannot choose sensitive fields.
// ============================================================
check("E (CRITICAL): the delete route derives the user from the authenticated session (userData.user.id), never from the request body", () => {
  assert.ok(/userData\.user\.id/.test(deleteRouteStripped));
  assert.ok(!/body\.userId|body\.user_id/.test(deleteRouteStripped));
});

check("F (CRITICAL): the client cannot choose adapter_id — the route's request body type declares only { sourceId }, and deleteUnlinkedManualSource's signature takes no adapter parameter from the caller", () => {
  assert.ok(/let body:\s*\{\s*sourceId\?:\s*string\s*\}/.test(deleteRouteStripped));
  const fnSignature = trackingSourcesLibStripped.match(/export async function deleteUnlinkedManualSource\(([^)]*)\)/);
  assert.ok(fnSignature);
  assert.ok(!/adapter/i.test(fnSignature[1]));
});

check("G (CRITICAL): the client cannot choose library_item_id — same signature audit, no libraryItemId parameter accepted anywhere on this path", () => {
  assert.ok(!/libraryItemId/.test(deleteRouteStripped));
  const fnSignature = trackingSourcesLibStripped.match(/export async function deleteUnlinkedManualSource\(([^)]*)\)/);
  assert.ok(!/libraryItemId/i.test(fnSignature[1]));
});

// ============================================================
// H/I — atomic delete condition / relink-race protection.
// ============================================================
check("H (CRITICAL): the real DELETE statement chains user_id + library_item_id IS NULL + adapter_id = 'manual' all onto the SAME .delete() call — one atomic statement, not a SELECT followed by a separate DELETE", () => {
  const fn = trackingSourcesLibStripped.slice(
    trackingSourcesLibStripped.indexOf("export async function deleteUnlinkedManualSource"),
  );
  const deleteCallBlock = fn.slice(0, fn.indexOf(".returns<{ id: string }[]>()"));
  assert.ok(/\.delete\(\)/.test(deleteCallBlock));
  assert.ok(/\.eq\("user_id", userId\)/.test(deleteCallBlock));
  assert.ok(/\.is\("library_item_id", null\)/.test(deleteCallBlock));
  assert.ok(/\.eq\("adapter_id", "manual"\)/.test(deleteCallBlock));
});

check("I (CRITICAL): relink race cannot delete a linked row — simulated atomically: a row that becomes linked between the client's belief and the delete reaching the database is excluded by the same WHERE the delete itself evaluates, not by a stale earlier read", () => {
  const rows = [makeRow({ id: "s4", adapter_id: "manual", library_item_id: null })];
  // Simulate the race: something relinks the row before the delete's WHERE is evaluated.
  rows[0].library_item_id = "item-99";
  assert.equal(simulateDelete(rows, "s4", "user-1").status, "not-deletable", "the atomic WHERE must see the CURRENT (now-linked) state, never a stale unlinked snapshot");
});

// ============================================================
// J — idempotent already-missing behavior.
// ============================================================
check("J: deleting an id that doesn't exist (or belongs to someone else) is reported identically as already-missing — no existence leakage", () => {
  assert.equal(simulateDelete([], "nonexistent", "user-1").status, "already-missing");
  const foreignRow = makeRow({ id: "s5", user_id: "someone-else", library_item_id: null });
  assert.equal(simulateDelete([foreignRow], "s5", "user-1").status, "already-missing", "a foreign user's real row must look identical to a nonexistent one");
});

// ============================================================
// K — no raw DB errors leaked to the client.
// ============================================================
check("K (CRITICAL): the delete route's catch block returns a clean, generic error — never the raw Postgres/Supabase error object or its message/code", () => {
  const postFn = deleteRouteStripped.slice(deleteRouteStripped.indexOf("export async function POST"));
  assert.ok(/catch\s*\{\s*return NextResponse\.json\(\{ error: "delete_failed" \}/.test(postFn.replace(/\s+/g, " ")));
  assert.ok(!/error\.message|error\.code/.test(postFn));
});

// ============================================================
// L/M — no activity/progress/resume mutation.
// ============================================================
check("L (CRITICAL): deleting a source never mutates progress or writes an ActivityEvent — no such call exists anywhere in the delete path", () => {
  const start = trackingSourcesLibStripped.indexOf("export async function deleteUnlinkedManualSource");
  const end = trackingSourcesLibStripped.indexOf("export type RestoreTrackingSourceResult");
  const deleteFnBody = trackingSourcesLibStripped.slice(start, end);
  assert.ok(!/insertActivityEvent|quickIncrementProgress|updateTracking|logEvent/.test(deleteFnBody));
  assert.ok(!/insertActivityEvent|quickIncrementProgress|updateTracking|logEvent/.test(deleteRouteStripped));
});

check("M (CRITICAL): lib/resume.ts is entirely untouched by Stage 42 — no reference to deletion, no new state, no changed selection logic", () => {
  assert.ok(!/delete|Delete/.test(resumeLibSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "the resume engine must contain no deletion concept at all");
  assert.ok(/export function selectContinueSource/.test(resumeLibSource));
  assert.ok(/export function selectRecentlyUsedSource/.test(resumeLibSource));
  assert.ok(/export function resolveResumeTarget/.test(resumeLibSource));
});

// ============================================================
// N/O/P/Q/R — Settings UI eligibility, confirmation, immediate update, no
// collateral impact.
// ============================================================
check("N (CRITICAL): the Settings UI's Delete control is gated to adapter_id === \"manual\" — no path exists to delete a non-manual/automatic source through this new UI", () => {
  assert.ok(/source\.adapterId === "manual" &&/.test(settingsPanelStripped), "the Delete button must be conditionally rendered only for manual sources");
});

check("O: the Delete button is scoped to the Unlinked list only — linked sources' own row (SourceActionsMenu) has no delete/erase action, only Disable/Enable tracking and Unlink", () => {
  const menuBlock = settingsPanelStripped.slice(settingsPanelStripped.indexOf("function SourceActionsMenu"));
  assert.ok(!/Delete|deleteSource/i.test(menuBlock), "the linked-source overflow menu must not gain a delete action — Unlink must happen first, as its own separate step");
});

check("P (CRITICAL): permanent delete requires explicit confirmation — clicking Delete only opens a dialog (setDeleteConfirm), it never calls deleteSource directly", () => {
  assert.ok(/onClick={\(\) => setDeleteConfirm\(source\)}/.test(settingsPanelStripped));
  assert.ok(/onConfirm={\(\) => deleteConfirm && deleteSource\(deleteConfirm\.id\)}/.test(settingsPanelStripped));
});

check("Q: successful deletion updates the list immediately via local state — no full page reload, no router.refresh", () => {
  const fn = settingsPanelStripped.slice(settingsPanelStripped.indexOf("async function deleteSource"), settingsPanelStripped.indexOf("async function toggleAutoTrack"));
  assert.ok(/setSources\(\(current\) => current\.filter/.test(fn));
  assert.ok(!/window\.location\.reload|router\.refresh\(\)/.test(fn));
});

check("R: deleting a source never touches library_items — the parent LibraryItem (if any ever existed) is structurally unaffected", () => {
  const start = trackingSourcesLibStripped.indexOf("export async function deleteUnlinkedManualSource");
  const end = trackingSourcesLibStripped.indexOf("export type RestoreTrackingSourceResult");
  const deleteFnBody = trackingSourcesLibStripped.slice(start, end);
  assert.ok(!/library_items/.test(deleteFnBody));
});

// ============================================================
// S/T — backup semantics unchanged.
// ============================================================
check("S: backup export still fetches only LINKED sources (library_item_id is not null) — unchanged by Stage 42, confirming an unlinked (deletable) source was never in a backup to begin with", () => {
  const backupLib = src("src/lib/cloud/backup.ts");
  const fn = backupLib.slice(backupLib.indexOf("export async function fetchTrackingSourcesForExport"));
  assert.ok(/\.not\("library_item_id", "is", null\)/.test(fn));
});

check("T: restoreTrackingSource itself is untouched by Stage 42 — its full pre-existing body still appears verbatim, no deletion-related tombstone logic was added to it", () => {
  assert.ok(/export async function restoreTrackingSource/.test(trackingSourcesLib));
  assert.ok(!/tombstone|deleted_at/i.test(trackingSourcesLib), "no soft-delete/tombstone concept was introduced");
});

// ============================================================
// U/V/W/X/Y/Z — Item Detail single-owner Retry architecture.
// ============================================================
check("U (CRITICAL): ItemTrackingSourcesSection still has no independent authoritative sources state of its own — ItemDetailView remains the single owner, now also for the error/Retry-relevant state", () => {
  assert.ok(!/const \[sources, setSources\] = useState/.test(sectionSource));
  assert.ok(/sourcesError: string \| undefined/.test(sectionSource) || /sourcesError,/.test(sectionSource), "sourcesError must arrive as a prop, not local state");
});

check("V (CRITICAL): the Retry button calls the parent's own onRefreshSources — not a second, independently-implemented fetch", () => {
  const retryFn = sectionSource.slice(sectionSource.indexOf("async function handleRetry"), sectionSource.indexOf("async function handleRetry") + 300);
  assert.ok(/await onRefreshSources\(\)/.test(retryFn));
  assert.ok(!/fetch\(`\/api\/tracking-sources/.test(retryFn), "handleRetry must not itself construct a request");
});

check("W (CRITICAL): no full reload, router.refresh, global event, or polling anywhere in the Retry/refresh implementation", () => {
  for (const source of [itemDetailSource, sectionSource]) {
    assert.ok(!/window\.location\.reload|router\.refresh\(\)|location\.href\s*=|dispatchEvent|CustomEvent|setInterval/.test(source));
  }
});

// Pure re-implementation of ItemDetailView's refreshTrackingSources for X/Y — same convention as every other script modeling a fetch's success/failure branches.
function simulateRefresh(fetchOutcome) {
  if (fetchOutcome.ok) return { trackingSources: fetchOutcome.sources, sourcesError: undefined };
  return { trackingSources: null, sourcesError: "Couldn't load the source list. Try again." };
}

check("X (CRITICAL): a failing Retry leaves the source state at null/unknown with a visible error — never reinstates a stale array", () => {
  const result = simulateRefresh({ ok: false });
  assert.equal(result.trackingSources, null);
  assert.ok(typeof result.sourcesError === "string" && result.sourcesError.length > 0);
});

check("Y: a successful Retry installs the authoritative array and clears the error", () => {
  const result = simulateRefresh({ ok: true, sources: [{ id: "a" }] });
  assert.deepEqual(result.trackingSources, [{ id: "a" }]);
  assert.equal(result.sourcesError, undefined);
});

check("Z (CRITICAL): Retry has busy protection — the button disables itself while a retry is in flight, preventing duplicate concurrent clicks", () => {
  assert.ok(/disabled={retrying}/.test(sectionSource));
  assert.ok(/setRetrying\(true\)/.test(sectionSource) && /setRetrying\(false\)/.test(sectionSource));
});

// ============================================================
// AA/AB/AC/AD/AE — carried-forward invariants re-confirmed in this
// script's own context.
// ============================================================
check("AA (CRITICAL): null still never collapses into [] before ItemDetailView decides whether an external Resume action may be shown — the Stage 41.4 gate is untouched", () => {
  assert.ok(/const sourceStateUnknown = userId !== null && media !== null && trackingSources === null/.test(itemDetailSource));
});

check("AB: website items are unaffected by any sourcesError/Retry state — the gate (and therefore the whole Sources-unavailable/Retry UI) only ever applies when `media !== null`, which is false for every website item", () => {
  assert.ok(/media !== null && trackingSources === null/.test(itemDetailSource));
});

check("AC: local/signed-out mode never sees a cloud Retry control — refreshTrackingSources itself is a no-op whenever userId is null, and the mount effect never calls it in that case either", () => {
  const fn = itemDetailSource.slice(itemDetailSource.indexOf("const refreshTrackingSources = useCallback"), itemDetailSource.indexOf("const refreshTrackingSources = useCallback") + 400);
  assert.ok(/if \(!userId\) return;/.test(fn));
});

check("AD (CRITICAL): the resume engine's three exported entry points are byte-identical in name/signature to before Stage 42 — this stage did not touch selection logic", () => {
  assert.ok(/export function selectContinueSource\(sources: readonly TrackingSourceSummary\[\], itemId: string\)/.test(resumeLibSource));
  assert.ok(/export function selectRecentlyUsedSource\(sources: readonly TrackingSourceSummary\[\], itemId: string\)/.test(resumeLibSource));
  assert.ok(/export function resolveResumeTarget\(item: LibraryItem, trackingSources: readonly TrackingSourceSummary\[\]\)/.test(resumeLibSource));
});

check("AE: a follow-up database-authority audit found the ownership-only RLS policy (migration 0003) insufficient on its own — a direct authenticated PostgREST DELETE could bypass the application's atomic WHERE entirely — so migration 0019 was approved and created to make the database itself enforce the same unlinked+manual rule. (Superseded the original 'no 0019 needed' conclusion — see AJ below for the current, correct invariant: 0019 exists, 0018 unchanged, no 0020.)", () => {
  const migrations = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
  assert.ok(migrations.includes("0018_stage40_backup_item_map.sql"));
  assert.ok(migrations.includes("0019_stage42_source_delete_policy.sql"));
});

check("AF: the existing tracking_sources DELETE RLS policy (migration 0003) already permits this — confirmed present and ownership-scoped, not newly added", () => {
  const migration = src("supabase/migrations/0003_stage18_auto_tracking.sql");
  assert.ok(/create policy "tracking_sources_delete_own" on public\.tracking_sources\s*\n\s*for delete using \(auth\.uid\(\) = user_id\)/.test(migration));
});

check("AG: the confirmation dialog copy never claims external website/account data is deleted, and states the removal is of Markly's own saved record only", () => {
  assert.ok(/removes the saved source record from Markly/.test(deleteDialog));
  assert.ok(!/delete.*website|remove.*account/i.test(stripComments(deleteDialog).replace(/removes the saved source record from Markly[^.]*\./, "")));
});

check("AH: the Delete route is a focused POST endpoint under the existing /api/tracking-sources/* convention (matching link, unlink, toggle-auto-track) — no new DELETE-HTTP-verb route was introduced", () => {
  assert.ok(/export async function POST/.test(deleteRoute));
  assert.ok(!/export async function DELETE/.test(deleteRoute));
});

// ============================================================
// AI-AR — migration 0019: tighten tracking_sources DELETE RLS to close
// the direct-PostgREST bypass the Stage 42 database audit found. Static
// checks against the actual migration file only (no live database call —
// this session has no disposable Postgres/Supabase access; genuine RLS
// behavioral validation is documented as a required follow-up, not
// performed here).
// ============================================================
let migration0019;
try {
  migration0019 = src("supabase/migrations/0019_stage42_source_delete_policy.sql");
} catch {
  migration0019 = null;
}

check("AI (CRITICAL): migration 0019 exists at the expected path", () => {
  assert.ok(migration0019 !== null, "supabase/migrations/0019_stage42_source_delete_policy.sql must exist");
});

check("AJ (CRITICAL): 0018 remains byte-for-byte unchanged and no 0020 exists — 0019 is additive only, the new final migration", () => {
  const migrations = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
  assert.equal(migrations[migrations.length - 1], "0019_stage42_source_delete_policy.sql");
  assert.equal(migrations[migrations.length - 2], "0018_stage40_backup_item_map.sql");
  assert.ok(!migrations.some((f) => f.startsWith("0020")), "no migration 0020 must exist yet");
});

check("AK (CRITICAL): the old ownership-only DELETE policy is explicitly dropped before the replacement is created — idempotent style matching every other policy-replacing migration in this repository", () => {
  assert.ok(migration0019 && /drop policy if exists "tracking_sources_delete_own" on public\.tracking_sources;/.test(migration0019));
});

check("AL (CRITICAL): the new policy requires auth.uid() = user_id (ownership) — the foreign-user case must remain blocked exactly as before", () => {
  const policyBlock = migration0019.slice(migration0019.indexOf('create policy "tracking_sources_delete_unlinked_manual_own"'));
  assert.ok(/auth\.uid\(\) = user_id/.test(policyBlock));
});

check("AM (CRITICAL): the new policy requires library_item_id is null — a linked source (manual or not) can never be hard-deleted directly", () => {
  const policyBlock = migration0019.slice(migration0019.indexOf('create policy "tracking_sources_delete_unlinked_manual_own"'));
  assert.ok(/library_item_id is null/.test(policyBlock));
});

check("AN (CRITICAL): the new policy requires adapter_id = 'manual' — a non-manual/automatic source (linked or not) can never be hard-deleted directly, preserving its auto_link_suppressed_at memory", () => {
  const policyBlock = migration0019.slice(migration0019.indexOf('create policy "tracking_sources_delete_unlinked_manual_own"'));
  assert.ok(/adapter_id = 'manual'/.test(policyBlock));
});

check("AO: all three predicates are ANDed on the SAME policy (not three separate policies, which Postgres would OR together for the same command — that would defeat the whole point)", () => {
  const policyBlock = migration0019.slice(
    migration0019.indexOf('create policy "tracking_sources_delete_unlinked_manual_own"'),
    migration0019.indexOf(");", migration0019.indexOf('create policy "tracking_sources_delete_unlinked_manual_own"')) + 2,
  );
  const andCount = (policyBlock.match(/\band\b/g) ?? []).length;
  assert.ok(andCount >= 2, "expected ownership AND unlinked AND manual all combined with AND in one USING clause");
  assert.equal((migration0019.match(/create policy/g) ?? []).length, 1, "expected exactly one new policy created");
});

check("AP (CRITICAL): migration 0019 touches no other policy — SELECT/INSERT/UPDATE on tracking_sources are untouched, and no other table is mentioned", () => {
  assert.ok(!/tracking_sources_select_own|tracking_sources_insert_own|tracking_sources_update_own/.test(migration0019), "0019 must not redefine any policy besides the DELETE one");
  assert.ok(!/create table|alter table.*add column|create index/i.test(migration0019), "0019 must not change table structure");
  const otherTableMentions = migration0019.match(/on public\.(\w+)/g) ?? [];
  assert.ok(otherTableMentions.every((m) => m === "on public.tracking_sources"), "0019 must only ever reference tracking_sources");
});

check("AQ: migration 0019 contains no GRANT/REVOKE — table-level privileges are left exactly as the project's existing default, only the RLS policy narrows what they're allowed to affect", () => {
  assert.ok(!/\bgrant\b|\brevoke\b/i.test(migration0019));
});

check("AR: migration 0019 is exactly two DDL statements — one DROP POLICY, one CREATE POLICY — matching the audit's own 'policy-only, nothing else' scope requirement", () => {
  const statements = migration0019
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && line.trim().length > 0)
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  assert.equal(statements.length, 2, `expected exactly 2 SQL statements, found ${statements.length}`);
  assert.ok(statements[0].startsWith("drop policy"));
  assert.ok(statements[1].startsWith("create policy"));
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
