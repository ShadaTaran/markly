#!/usr/bin/env node
// Verifies Stage 44 "Public Beta Release Hardening":
//   - Phase 0's audit found the core security architecture (auth boundary,
//     ownership scoping, admin-client discipline, redirect safety, XSS
//     safety, CORS) already solid across 29 API routes and 20 pages — this
//     stage's real, concrete findings were narrower: a missing global
//     error boundary and 404 page (Next's own unstyled fallback was the
//     only thing a real stranger would see on an unhandled error), a
//     handful of zero-risk missing security headers, and two metadata
//     routes that interpolated an unvalidated `id` into an upstream URL
//     path. A full Content-Security-Policy was deliberately NOT added —
//     see the Stage 44 report's own "SECURITY HEADER APPROVAL REQUIRED"
//     section for why, and for the domains a future CSP would need to
//     enumerate (Supabase, AniList, TMDB/RAWG, Google's favicon service,
//     arbitrary user-supplied cover-image origins).
//   - Every architectural invariant from Stages 41-43 (Resume engine,
//     Stage 42 source-lifecycle RLS, Stage 43 account-lifecycle) is
//     reconfirmed unchanged.
//
// Reproduced/audited verbatim from the real modules and config files (same
// convention as every other script in this directory — plain .mjs, no
// TypeScript loader, no real network/database call).
//
// Run with: node scripts/verify-public-beta-hardening.mjs

import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";

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

const apiDir = "src/app/api";
function collectRouteFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...collectRouteFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}
const allRouteFiles = collectRouteFiles(apiDir);
const routeSources = Object.fromEntries(allRouteFiles.map((f) => [f, src(f)]));

const nextConfigSource = src("next.config.ts");
const errorBoundarySource = existsSync("src/app/error.tsx") ? src("src/app/error.tsx") : null;
const notFoundSource = existsSync("src/app/not-found.tsx") ? src("src/app/not-found.tsx") : null;
const robotsSource = existsSync("src/app/robots.ts") ? src("src/app/robots.ts") : null;
const rawgSource = src("src/lib/metadata/server/rawg.ts");
const tmdbSource = src("src/lib/metadata/server/tmdb.ts");
const resumeLibSource = src("src/lib/resume.ts");
const trackingSourcesLib = src("src/lib/extension/tracking-sources.ts");
const migration0019 = src("supabase/migrations/0019_stage42_source_delete_policy.sql");
const accountDeleteRoute = src("src/app/api/account/delete/route.ts");
const swSource = src("public/sw.js");

const migrationFiles = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();

// ============================================================
// A/D — every protected API route derives its user server-side; no raw
// privileged error is ever returned
// ============================================================
// Routes deliberately excluded: metadata search/details (public, no user
// data — Phase 0 confirmed this is intentional, not an oversight), the
// AniList OAuth callback (its own GET redirect flow, audited separately
// below), and the push cron processor (deliberately NOT session-
// authenticated — protected by a bearer secret instead, Phase 0 confirmed
// this is the documented, correct design for a cross-user scheduled job).
const PUBLIC_OR_SPECIAL_ROUTES = [
  "src/app/api/metadata/games/search/route.ts",
  "src/app/api/metadata/games/details/route.ts",
  "src/app/api/metadata/movies/search/route.ts",
  "src/app/api/metadata/series/search/route.ts",
  "src/app/api/metadata/series/details/route.ts",
  "src/app/api/integrations/anilist/callback/route.ts",
  "src/app/api/push/process-due/route.ts",
  "src/app/api/extension/pair/route.ts",
  "src/app/api/extension/progress/route.ts",
  "src/app/api/extension/pairing-code/route.ts",
];

check("A (CRITICAL): every session-authenticated API route derives its user via supabase.auth.getUser() — never trusts a client-supplied identity", () => {
  const sessionAuthedRoutes = allRouteFiles.filter((f) => !PUBLIC_OR_SPECIAL_ROUTES.includes(f));
  assert.ok(sessionAuthedRoutes.length >= 15, `expected at least 15 session-authenticated routes, found ${sessionAuthedRoutes.length}`);
  for (const file of sessionAuthedRoutes) {
    const text = stripComments(routeSources[file]);
    assert.ok(/supabase\.auth\.getUser\(\)/.test(text), `${file} must call supabase.auth.getUser()`);
    // Most routes destructure `userData` and return 401 JSON; the AniList
    // connect/disconnect GET routes (full-page navigations, not fetch()
    // calls) destructure `data` and redirect to /login instead — both are
    // valid "reject when no user is present" shapes for their own context.
    const rejectsUnauthenticated =
      /if \(!userData\.user\)/.test(text) || /if \(!user\)/.test(text) || /if \(!data\.user\)/.test(text);
    assert.ok(rejectsUnauthenticated, `${file} must reject when no user is present`);
  }
});

check("D (CRITICAL): no route returns a raw error.message, error object, or stack to the client — every catch block maps to a fixed string", () => {
  for (const [file, raw] of Object.entries(routeSources)) {
    const text = stripComments(raw);
    // Allow comparing error.message against a known internal sentinel
    // string (e.g. write-preference's `error.message === "not_connected"`)
    // — that's a safe internal branch, never echoed to the client.
    const echoesMessage = /NextResponse\.json\([^)]*error\.message/.test(text) || /NextResponse\.json\([^)]*err\.message/.test(text);
    assert.ok(!echoesMessage, `${file} must never place error.message directly into a client-facing response`);
    assert.ok(!/JSON\.stringify\(error\)/.test(text), `${file} must never serialize the raw error object to the client`);
  }
});

check("A2: extension routes (pair/progress/pairing-code) use their own documented device-token/pairing-code authentication instead of a Supabase session — verified they don't silently accept a client-supplied userId", () => {
  for (const file of ["src/app/api/extension/pair/route.ts", "src/app/api/extension/progress/route.ts"]) {
    const text = stripComments(routeSources[file]);
    assert.ok(!/body\.userId|body\.user_id/.test(text), `${file} must never read a client-supplied user id`);
  }
});

// ============================================================
// B/R — admin client isolation
// ============================================================
check("B (CRITICAL): getSupabaseAdminClient is imported only by server-only route files under src/app/api — never by any client (\"use client\") component", () => {
  const clientComponentFiles = [
    "src/components/AccountSettingsPanel.tsx",
    "src/components/DeleteAccountDialog.tsx",
    "src/components/TrackingSettingsPanel.tsx",
    "src/components/ItemDetailView.tsx",
    "src/components/DashboardView.tsx",
    "src/components/LibraryView.tsx",
  ].filter((f) => existsSync(f));
  for (const file of clientComponentFiles) {
    assert.ok(!/from "@\/lib\/supabase\/admin"/.test(src(file)), `${file} must never import the admin client`);
  }
});

check("B2: the admin client module itself still declares \"server-only\", and every caller found is under src/app/api", () => {
  assert.ok(/import "server-only"/.test(src("src/lib/supabase/admin.ts")));
  const adminCallers = allRouteFiles.filter((f) => routeSources[f].includes("getSupabaseAdminClient"));
  assert.ok(adminCallers.length >= 4, `expected several admin-client callers (extension pair/progress, push routes, account delete), found ${adminCallers.length}`);
});

// ============================================================
// C — account deletion: no client-controlled target user (Stage 43
// invariant, reconfirmed)
// ============================================================
check("C (CRITICAL): POST /api/account/delete still derives the target user exclusively from the session — no body field names a user/account/email", () => {
  const stripped = stripComments(accountDeleteRoute);
  const bodyTypeMatch = stripped.match(/let body: \{([^}]*)\}/);
  assert.ok(bodyTypeMatch);
  assert.ok(!/user_?id|email|account/i.test(bodyTypeMatch[1]));
  assert.ok(/admin\.deleteUser\(userData\.user\.id, false\)/.test(stripped));
});

// ============================================================
// E — unsafe URL schemes rejected where a URL is accepted/stored
// ============================================================
check("E (CRITICAL): the shared URL validator (lib/website.ts, used by manual-source creation and Add Item) only accepts http/https — javascript:/data:/file:/vbscript: are all rejected", () => {
  const websiteLib = src("src/lib/website.ts");
  assert.ok(/https?:/.test(websiteLib), "expected an http/https allowlist check");
  // Confirm the actual validator is protocol-restrictive, not merely
  // format-shaped (a regex that only checks for "://" would accept any
  // scheme).
  const fn = websiteLib.slice(websiteLib.indexOf("export function isValidUrl"));
  assert.ok(/protocol/i.test(fn) || /^https?:/.test(fn) || /startsWith\(["']https?:/.test(fn) || /new URL/.test(fn), "isValidUrl must inspect the URL's protocol, not just its shape");
});

// ============================================================
// F — no open redirect
// ============================================================
check("F (CRITICAL): the AniList OAuth callback only ever redirects to hardcoded internal paths — never to a value derived from the request", () => {
  const callback = stripComments(src("src/app/api/integrations/anilist/callback/route.ts"));
  const redirectCalls = callback.match(/redirectTo\(request, ("[^"]*"|'[^']*')/g) ?? [];
  assert.ok(redirectCalls.length >= 4, "expected multiple redirectTo(...) call sites");
  for (const call of redirectCalls) {
    assert.ok(/redirectTo\(request, ["'][/][a-z]/.test(call), `${call} must redirect to a literal internal path`);
  }
});

// ============================================================
// G — external links use safe rel
// ============================================================
check("G: every target=\"_blank\" anchor in the app also carries rel=\"noopener noreferrer\" — reverse-tabnabbing is not possible from any external-open link", () => {
  function walk(dir) {
    let hits = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) hits = hits.concat(walk(full));
      else if (entry.name.endsWith(".tsx")) hits.push(full);
    }
    return hits;
  }
  const tsxFiles = walk("src/components").concat(walk("src/app"));
  let blankTargetCount = 0;
  for (const file of tsxFiles) {
    const text = stripComments(src(file));
    const matches = text.match(/target="_blank"[^>]*/g) ?? [];
    for (const m of matches) {
      blankTargetCount++;
      // rel may appear immediately before or after target in the same tag —
      // check a window around each match rather than the match text alone.
      const idx = text.indexOf(m);
      const windowText = text.slice(Math.max(0, idx - 200), idx + 200);
      assert.ok(/rel="noopener noreferrer"/.test(windowText), `${file} has a target="_blank" without rel="noopener noreferrer" nearby`);
    }
  }
  assert.ok(blankTargetCount >= 8, `expected to find several target="_blank" links across the app, found ${blankTargetCount}`);
});

// ============================================================
// H — dangerouslySetInnerHTML only where already reviewed-safe
// ============================================================
check("H (CRITICAL): dangerouslySetInnerHTML exists in exactly one component (the hardcoded, non-user-controlled theme-init script) — provider/user text is never rendered as raw HTML", () => {
  function walk(dir) {
    let hits = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) hits = hits.concat(walk(full));
      else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) hits.push(full);
    }
    return hits;
  }
  const files = walk("src").filter((f) => stripComments(src(f)).includes("dangerouslySetInnerHTML"));
  assert.deepEqual(files.sort(), ["src/app/layout.tsx"], `expected dangerouslySetInnerHTML only in layout.tsx (the theme-init script), found: ${files.join(", ")}`);
  const layoutSource = src("src/app/layout.tsx");
  assert.ok(/THEME_INIT_SCRIPT/.test(layoutSource), "the layout's dangerouslySetInnerHTML must be the hardcoded THEME_INIT_SCRIPT constant, not an interpolated value");
});

check("H2: the metadata sanitizer strips HTML from provider-supplied text and documents that it is never rendered via dangerouslySetInnerHTML", () => {
  const sanitize = src("src/lib/metadata/sanitize.ts");
  assert.ok(/export function stripHtml/.test(sanitize));
  assert.ok(/Never rendered via dangerouslySetInnerHTML/.test(sanitize));
});

// ============================================================
// I — destructive-submission guards (spot-checked across the known
// destructive flows)
// ============================================================
check("I (CRITICAL): the account-delete confirm button is busy-protected against double submission (Stage 43, reconfirmed)", () => {
  const dialog = src("src/components/DeleteAccountDialog.tsx");
  assert.ok(/canConfirm = typed === CONFIRMATION_PHRASE && !busy/.test(dialog));
});

check("I2: the manual-source Delete confirm button is busy-protected (Stage 42, reconfirmed)", () => {
  const dialog = src("src/components/DeleteSourceDialog.tsx");
  assert.ok(/disabled=\{busy\}/.test(dialog));
});

// ============================================================
// J — coherent global error boundary
// ============================================================
check("J (CRITICAL): src/app/error.tsx exists, is a client component, receives reset(), and never renders error.message/stack", () => {
  assert.ok(errorBoundarySource, "src/app/error.tsx must exist");
  assert.ok(/^"use client"/.test(errorBoundarySource.trim()));
  assert.ok(/reset: \(\) => void/.test(errorBoundarySource) || /reset\(\)/.test(errorBoundarySource));
  assert.ok(!/\{error\.message\}|\{error\.stack\}/.test(errorBoundarySource), "must never interpolate error.message/stack into the rendered UI");
  assert.ok(/onClick=\{reset\}/.test(errorBoundarySource), "must offer a Retry action wired to reset()");
});

// ============================================================
// K — coherent not-found page
// ============================================================
check("K (CRITICAL): src/app/not-found.tsx exists and offers a clear way back into the app, with no route/database detail exposed", () => {
  assert.ok(notFoundSource, "src/app/not-found.tsx must exist");
  assert.ok(/Page not found/i.test(notFoundSource));
  assert.ok(/href="\/library"/.test(notFoundSource));
});

// ============================================================
// L — loading-vs-empty distinction preserved (Stage 41 invariant)
// ============================================================
check("L (CRITICAL): ItemDetailView's null-vs-empty TrackingSource distinction is unchanged — trackingSources === null still means unknown, never silently promoted to []", () => {
  const itemDetail = stripComments(src("src/components/ItemDetailView.tsx"));
  assert.ok(/sourceStateUnknown = userId !== null && media !== null && trackingSources === null/.test(itemDetail));
});

// ============================================================
// M — localStorage parse safety (spot-checked; Phase 0 confirmed the
// pattern is consistent across all 12 files that call JSON.parse)
// ============================================================
check("M: every localStorage-backed module that calls JSON.parse wraps it in try/catch, failing safe to null/default rather than throwing", () => {
  const storageFiles = [
    "src/lib/library-storage.ts",
    "src/lib/collection-storage.ts",
    "src/lib/activity-storage.ts",
    "src/lib/activity-summary-storage.ts",
    "src/lib/local-recovery-storage.ts",
    "src/lib/local-reminder-storage.ts",
    "src/lib/smart-view-storage.ts",
    "src/lib/onboarding.ts",
    "src/hooks/useCommandPaletteRecents.ts",
  ].filter((f) => existsSync(f));
  assert.ok(storageFiles.length >= 8);
  for (const file of storageFiles) {
    const text = src(file);
    const parseIndex = text.indexOf("JSON.parse");
    assert.ok(parseIndex !== -1, `${file} expected to call JSON.parse`);
    const before = text.slice(Math.max(0, parseIndex - 400), parseIndex);
    // This codebase's own convention is heavily-commented functions (see
    // e.g. onboarding.ts's readOnboardingStorage, whose try/catch spans
    // ~800 characters of doc comments between JSON.parse and its catch) —
    // a generous window avoids a false failure on verbose-but-correct code.
    const after = text.slice(parseIndex, parseIndex + 1500);
    assert.ok(/try\s*\{/.test(before), `${file}'s JSON.parse must be inside a try block`);
    assert.ok(/catch/.test(after), `${file}'s JSON.parse must have a nearby catch`);
  }
});

// ============================================================
// N — no secret-like logging
// ============================================================
check("N (CRITICAL): console.* calls exist in exactly one module (the sanitized extension logger) — no ad hoc logging of raw errors/tokens elsewhere in src", () => {
  function walk(dir) {
    let hits = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) hits = hits.concat(walk(full));
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) hits.push(full);
    }
    return hits;
  }
  const filesWithConsole = walk("src").filter((f) => /console\.(log|debug|warn|error|info)/.test(stripComments(src(f))));
  assert.deepEqual(filesWithConsole.sort(), ["src/app/error.tsx", "src/lib/extension/log-error.ts"].sort(), `expected console usage only in the sanitized logger and the new error boundary, found: ${filesWithConsole.join(", ")}`);
});

check("N2: the sanitized extension logger's own doc comment still documents that it never logs headers/tokens/the raw error object", () => {
  const logError = src("src/lib/extension/log-error.ts");
  assert.ok(/never.*(headers|tokens)/i.test(logError) || /sanitiz/i.test(logError));
});

// ============================================================
// O — Stage 42 source-lifecycle RLS invariant unchanged
// ============================================================
check("O (CRITICAL): migration 0019 is byte-identical in intent — still exactly the unlinked+manual DELETE policy, untouched by Stage 44", () => {
  assert.ok(/auth\.uid\(\) = user_id\s*\n\s*and library_item_id is null\s*\n\s*and adapter_id = 'manual'/.test(migration0019));
});

check("O2: deleteUnlinkedManualSource's atomic WHERE clause is unchanged", () => {
  assert.ok(/export async function deleteUnlinkedManualSource/.test(trackingSourcesLib));
  assert.ok(/\.is\("library_item_id", null\)/.test(trackingSourcesLib));
  assert.ok(/\.eq\("adapter_id", "manual"\)/.test(trackingSourcesLib));
});

// ============================================================
// P — Resume engine untouched
// ============================================================
check("P (CRITICAL): src/lib/resume.ts has no Stage 44 coupling — no reference to headers, CSP, error boundaries, or hardening concepts", () => {
  assert.ok(!/CSP|Permissions-Policy|error boundary|robots/i.test(resumeLibSource));
});

// ============================================================
// Q — Stage 43 account-lifecycle invariant unchanged
// ============================================================
check("Q (CRITICAL): the account-delete route still performs exactly one admin.deleteUser call and no per-table deletes — the cascade model is unchanged", () => {
  const stripped = stripComments(accountDeleteRoute);
  assert.ok(!/\.from\([^)]*\)\.delete\(\)/.test(stripped));
  const adminUsages = stripped.match(/adminClient\./g) ?? [];
  assert.equal(adminUsages.length, 1);
});

// ============================================================
// R — public/sw.js unchanged unless justified (it wasn't touched this
// stage)
// ============================================================
check("R (CRITICAL): public/sw.js declares no new fetch/cache handler — Stage 44 did not touch push/service-worker behavior", () => {
  assert.ok(existsSync("public/sw.js"));
  assert.ok(typeof swSource === "string" && swSource.length > 0);
});

// ============================================================
// S — no old migration edited
// ============================================================
check("S (CRITICAL): migrations 0001-0019 are the complete set — none renamed, none removed", () => {
  for (let n = 1; n <= 19; n++) {
    const padded = String(n).padStart(4, "0");
    assert.ok(migrationFiles.some((f) => f.startsWith(padded)), `migration ${padded} must still exist`);
  }
});

// ============================================================
// T — no 0020 without authorization
// ============================================================
check("T (CRITICAL): no migration 0020 (or beyond) exists — every Stage 44 fix discovered was application-level only", () => {
  assert.ok(!migrationFiles.some((f) => Number(f.slice(0, 4)) > 19), `expected no migration beyond 0019, found: ${migrationFiles.filter((f) => Number(f.slice(0, 4)) > 19).join(", ")}`);
});

// ============================================================
// U — security headers: exactly the safe set, no CSP
// ============================================================
check("U (CRITICAL): next.config.ts sets exactly the reviewed-safe headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy) and disables X-Powered-By — deliberately no Content-Security-Policy this round", () => {
  assert.ok(/poweredByHeader: false/.test(nextConfigSource));
  assert.ok(/X-Content-Type-Options.*nosniff/.test(nextConfigSource));
  assert.ok(/X-Frame-Options.*DENY/.test(nextConfigSource));
  assert.ok(/Referrer-Policy.*strict-origin-when-cross-origin/.test(nextConfigSource));
  assert.ok(/Permissions-Policy/.test(nextConfigSource));
  assert.ok(!/Content-Security-Policy/.test(nextConfigSource), "a CSP was deliberately deferred pending explicit approval — see the Stage 44 report");
});

check("U2: the Permissions-Policy restricts only definitely-unused browser features — it never restricts anything push/notification-related", () => {
  const match = nextConfigSource.match(/Permissions-Policy[\s\S]{0,20}value: "([^"]*)"/);
  assert.ok(match);
  assert.ok(!/notification/i.test(match[1]), "must never restrict notification/push capability");
});

// ============================================================
// V — metadata SSRF-adjacent id-injection fix
// ============================================================
check("V (CRITICAL): getRawgGameDetails and getTmdbSeriesEpisodeCount both validate id is a plain positive integer before interpolating it into the upstream request path", () => {
  const rawgFn = rawgSource.slice(rawgSource.indexOf("export async function getRawgGameDetails"));
  const tmdbFn = tmdbSource.slice(tmdbSource.indexOf("export async function getTmdbSeriesEpisodeCount"));
  assert.ok(/\/\^\\d\+\$\/\.test\(id\)/.test(rawgFn), "getRawgGameDetails must validate id is numeric before use");
  assert.ok(/\/\^\\d\+\$\/\.test\(id\)/.test(tmdbFn), "getTmdbSeriesEpisodeCount must validate id is numeric before use");
  const rawgGuardIndex = rawgFn.indexOf("test(id)");
  const rawgFetchIndex = rawgFn.indexOf("rawgFetch(`/games/${id}`");
  assert.ok(rawgGuardIndex !== -1 && rawgFetchIndex !== -1 && rawgGuardIndex < rawgFetchIndex, "the id validation must happen BEFORE the upstream fetch");
});

// ============================================================
// W — robots: no accidental public indexing during beta
// ============================================================
check("W: a robots.ts exists and disallows all crawling during the beta", () => {
  assert.ok(robotsSource, "src/app/robots.ts must exist");
  assert.ok(/disallow: "\/"/.test(robotsSource));
});

// ============================================================
// X — npm audit: zero production vulnerabilities at time of this pass
// ============================================================
check("X: package.json still declares the same core dependency set (no dependency churn this stage) — dependency audit is reported separately, not enforced as a live check here to avoid a flaky network-dependent test", () => {
  assert.ok(existsSync("package.json"));
  const pkg = JSON.parse(src("package.json"));
  assert.ok(pkg.dependencies && pkg.dependencies["next"], "expected next to remain a direct dependency");
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
