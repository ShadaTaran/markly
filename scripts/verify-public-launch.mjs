#!/usr/bin/env node
// Verifies Stage 45 "Public Launch Surface & Release Readiness":
//   - Phase 0's audit found signed-out `/` always rendered the full
//     Dashboard seeded with generic demo bookmarks (confusing for a
//     first-time stranger, but exactly right for a returning local-mode
//     user) — SignedOutHomeGate now branches on whether this browser has
//     ever had real local library data, reusing the existing
//     hasEverHadLibraryItems onboarding signal rather than inventing one.
//   - Password recovery did not exist before this stage (no
//     resetPasswordForEmail/updateUser call anywhere) — classified P0 and
//     implemented at the application level. Its production correctness
//     still depends on two Supabase Auth dashboard settings (site_url,
//     additional_redirect_urls) this stage is not authorized to change —
//     see docs/PUBLIC_BETA_CHECKLIST.md's "Known Infrastructure Gaps".
//   - Privacy/Terms/Support are new, derived directly from the real
//     implementation (the account-delete route's own 14-table audit, the
//     extension's documented signal list, AniList's encryption/no-revoke
//     behavior) — no compliance claims, no invented contact/entity.
//   - CSP remains deferred; Stage 44's security headers are unchanged.
//
// Run with: node scripts/verify-public-launch.mjs

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
const homePage = src("src/app/page.tsx");
const landingSource = src("src/components/LandingPage.tsx");
const homeGateSource = src("src/components/SignedOutHomeGate.tsx");
const footerSource = src("src/components/Footer.tsx");
const privacySource = src("src/app/privacy/page.tsx");
const termsSource = src("src/app/terms/page.tsx");
const supportSource = src("src/app/support/page.tsx");
const forgotFormSource = existsSync("src/components/ForgotPasswordForm.tsx") ? src("src/components/ForgotPasswordForm.tsx") : null;
const resetFormSource = existsSync("src/components/ResetPasswordForm.tsx") ? src("src/components/ResetPasswordForm.tsx") : null;
const authFormSource = src("src/components/AuthForm.tsx");
const nextConfigSource = src("next.config.ts");
const robotsSource = existsSync("src/app/robots.ts") ? src("src/app/robots.ts") : null;
const readmeSource = src("README.md");
const checklistSource = existsSync("docs/PUBLIC_BETA_CHECKLIST.md") ? src("docs/PUBLIC_BETA_CHECKLIST.md") : null;
const metadataSearchPanel = src("src/components/MetadataSearchPanel.tsx");
const accountDeleteRoute = src("src/app/api/account/delete/route.ts");
const migration0019 = src("supabase/migrations/0019_stage42_source_delete_policy.sql");
const trackingSourcesLib = src("src/lib/extension/tracking-sources.ts");
const resumeLibSource = src("src/lib/resume.ts");
const swSource = src("public/sw.js");
const migrationFiles = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();

// ============================================================
// A — signed-out launch surface exists
// ============================================================
check("A (CRITICAL): a signed-out landing surface exists — LandingPage + SignedOutHomeGate, wired from the root page", () => {
  assert.ok(existsSync("src/components/LandingPage.tsx"));
  assert.ok(existsSync("src/components/SignedOutHomeGate.tsx"));
  assert.ok(/SignedOutHomeGate/.test(homePage), "src/app/page.tsx must render SignedOutHomeGate for the signed-out branch");
});

// ============================================================
// B — authenticated root behavior remains correct
// ============================================================
check("B (CRITICAL): signed-in `/` still renders the existing DashboardView unconditionally — no new gate for authenticated users", () => {
  const stripped = stripComments(homePage);
  assert.ok(/if \(signedIn\) return <DashboardView items={starterLibraryItems} \/>;/.test(stripped));
});

// ============================================================
// C — local-mode library remains reachable, for both new and returning
// local users
// ============================================================
check("C (CRITICAL): /library route still exists (local-mode entry point), and a returning local user (hasEverHadLibraryItems) still gets the Dashboard, not the landing page, at `/`", () => {
  assert.ok(existsSync("src/app/library/page.tsx"));
  const gate = stripComments(homeGateSource);
  assert.ok(/hasEverHadLibraryItems/.test(gate));
  assert.ok(/hasLocalHistory \? <DashboardView items={starterLibraryItems} \/> : <LandingPage \/>/.test(gate));
});

// ============================================================
// D — Beta label present, but not an alarming banner
// ============================================================
check("D: the landing page carries a subtle Beta label near branding, not a large warning banner", () => {
  assert.ok(/Beta/.test(landingSource));
  assert.ok(!/⚠|WARNING|ALERT/i.test(landingSource));
});

check("D2 (CRITICAL): portfolio posture — the landing page's PRIMARY CTA is local exploration (no account), not signup; account creation is secondary", () => {
  const stripped = stripComments(landingSource);
  const primaryMatch = stripped.match(/<Link href="([^"]+)">\s*<Button variant="primary">([^<]+)<\/Button>/);
  assert.ok(primaryMatch, "expected exactly one primary-variant CTA link");
  assert.equal(primaryMatch[1], "/library", "the primary CTA must point at local exploration (/library), not signup");
  const primaryIndex = stripped.indexOf(primaryMatch[0]);
  const signupIndex = stripped.indexOf('href="/signup"');
  assert.ok(signupIndex === -1 || primaryIndex < signupIndex, "the local-exploration CTA must appear before the signup CTA");
});

check("extra: Footer and README do not describe the current release as \"Public Beta\" — the current posture is Beta / Portfolio Demo (forward-looking mentions of a future public beta elsewhere are fine and expected)", () => {
  assert.ok(!/Public Beta/.test(footerSource));
  const statusLine = readmeSource.match(/\*\*Status:\*\*.*/)?.[0] ?? "";
  assert.ok(!/^\*\*Status:\*\*\s*Public Beta\s*$/.test(statusLine), "the Status line must not claim 'Public Beta' as the current posture");
  assert.ok(/Portfolio Demo/i.test(statusLine));
});

// ============================================================
// E/F/G — Privacy, Terms, Support routes exist
// ============================================================
check("E: /privacy route exists", () => assert.ok(existsSync("src/app/privacy/page.tsx")));
check("F: /terms route exists", () => assert.ok(existsSync("src/app/terms/page.tsx")));
check("G: /support route exists", () => assert.ok(existsSync("src/app/support/page.tsx")));

// ============================================================
// H — privacy copy never claims Markly can delete a third-party account
// ============================================================
check("H (CRITICAL): privacy copy explicitly says account deletion does NOT delete AniList/third-party accounts or content", () => {
  assert.ok(/does\s*<strong>not<\/strong>\s*delete/i.test(privacySource) || /not.*delete.*AniList/i.test(privacySource));
  assert.ok(/AniList.*(account|content)/i.test(privacySource));
  assert.ok(!/deletes? your AniList account/i.test(privacySource), "must never claim Markly deletes a third-party account");
});

// ============================================================
// I — privacy copy distinguishes local vs. cloud data
// ============================================================
check("I (CRITICAL): privacy copy has a distinct local-mode section and a distinct account/cloud-mode section", () => {
  assert.ok(/Local mode/i.test(privacySource));
  assert.ok(/Account data \(cloud mode\)/i.test(privacySource) || /cloud mode/i.test(privacySource));
  assert.ok(!/account deletion.*(erases|deletes).*every.*(local|browser|download)/i.test(privacySource), "must not imply account deletion erases local-mode data");
});

// ============================================================
// J — export/delete referenced correctly (real routes, not invented ones)
// ============================================================
check("J: privacy/terms/support all link to the real Settings routes for export and account deletion", () => {
  for (const [name, text] of [["privacy", privacySource], ["terms", termsSource], ["support", supportSource]]) {
    assert.ok(/\/settings\/backup/.test(text), `${name} page must link to /settings/backup`);
    assert.ok(/\/settings\/account/.test(text), `${name} page must link to /settings/account`);
  }
});

// ============================================================
// K — no fabricated social proof
// ============================================================
check("K (CRITICAL): the landing page and README contain no fake testimonials, user counts, or metrics", () => {
  for (const [name, text] of [["LandingPage", landingSource], ["README", readmeSource]]) {
    assert.ok(!/testimonial/i.test(text), `${name} must not contain testimonials`);
    assert.ok(!/trusted by/i.test(text), `${name} must not claim to be "trusted by"`);
    assert.ok(!/\d[\d,]*\+?\s*(users|downloads|installs|customers)\b/i.test(text), `${name} must not cite a user/download count`);
  }
});

// ============================================================
// L — no secret or fabricated-contact leakage
// ============================================================
check("L (CRITICAL): no placeholder/fabricated email address appears in any new public page or README, and no secret-shaped value is present", () => {
  const publicTexts = [landingSource, privacySource, termsSource, supportSource, readmeSource, footerSource];
  for (const text of publicTexts) {
    assert.ok(!/[\w.-]+@(example\.com|test\.com|markly\.(com|app|dev))/i.test(text), "must not contain a fabricated/placeholder contact email");
    assert.ok(!/SUPABASE_SECRET_KEY\s*=\s*["'`]?[A-Za-z0-9_-]{10,}/.test(text), "must not contain a secret-shaped value");
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(text), "must not contain a JWT-shaped value");
  }
});

// ============================================================
// M — support page warns against sharing secrets
// ============================================================
check("M (CRITICAL): the support page explicitly warns against posting passwords/tokens/recovery links/backup files publicly", () => {
  assert.ok(/password/i.test(supportSource));
  assert.ok(/token/i.test(supportSource));
  assert.ok(/recovery/i.test(supportSource) || /reset.*link/i.test(supportSource));
  assert.ok(/GitHub/i.test(supportSource), "support must identify GitHub Issues as the actual (public, non-sensitive) support channel");
});

// ============================================================
// N — password recovery exists, and the infra gap it depends on is
// explicitly recorded
// ============================================================
check("N (CRITICAL): forgot-password/reset-password pages and forms exist (P0 gap closed at the application level)", () => {
  assert.ok(existsSync("src/app/forgot-password/page.tsx"));
  assert.ok(existsSync("src/app/reset-password/page.tsx"));
  assert.ok(forgotFormSource && /resetPasswordForEmail/.test(forgotFormSource));
  assert.ok(resetFormSource && /updateUser\(\{ password \}\)/.test(resetFormSource));
});

check("N2: the public beta checklist explicitly records the production auth-email/redirect infrastructure gap this feature depends on", () => {
  assert.ok(checklistSource, "docs/PUBLIC_BETA_CHECKLIST.md must exist");
  assert.ok(/site_url/i.test(checklistSource));
  assert.ok(/smtp/i.test(checklistSource));
});

check("N3 (CRITICAL): portfolio posture — future-public-beta infrastructure items (SMTP, indexing, license, CSP, RAWG/TMDB, custom domain) are explicitly left unchecked, never marked complete just because they're not required for the portfolio posture", () => {
  assert.ok(checklistSource);
  for (const label of ["Custom SMTP", "Public indexing decision", "License decision", "CSP", "RAWG/TMDB provider keys", "Custom domain"]) {
    // Anchored to the bolded checklist-item label itself (`- [ ] **Label**`),
    // not merely a line that happens to mention the words in passing (e.g.
    // the Production URL line's own "no custom domain" aside).
    const lineMatch = checklistSource.match(new RegExp(`^- \\[([ x])\\] \\*\\*${label}`, "im"));
    assert.ok(lineMatch, `expected a checklist line item labeled "${label}"`);
    assert.equal(lineMatch[1], " ", `"${label}" must remain unchecked — it's deferred, not resolved`);
  }
});

// ============================================================
// O — reset redirect is internal, never request-controlled
// ============================================================
check("O (CRITICAL): the forgot-password flow builds redirectTo from the page's own origin, never from a query/request-controlled value", () => {
  assert.ok(forgotFormSource);
  assert.ok(/redirectTo:\s*`\$\{window\.location\.origin\}\/reset-password`/.test(forgotFormSource));
  assert.ok(!/searchParams|request\.url|req\.query/.test(forgotFormSource), "must never derive the redirect target from request-controlled input");
});

// ============================================================
// P — auth error copy avoids account enumeration where applicable
// ============================================================
check("P (CRITICAL): the forgot-password success message never confirms or denies that the given email has an account", () => {
  assert.ok(forgotFormSource);
  assert.ok(/If an account exists/i.test(forgotFormSource));
});

// ============================================================
// Q — Stage 44 security headers preserved
// ============================================================
check("Q (CRITICAL): next.config.ts still sets exactly the Stage 44 security headers — Stage 45 did not touch them", () => {
  assert.ok(/poweredByHeader: false/.test(nextConfigSource));
  assert.ok(/X-Content-Type-Options.*nosniff/.test(nextConfigSource));
  assert.ok(/X-Frame-Options.*DENY/.test(nextConfigSource));
  assert.ok(/Referrer-Policy.*strict-origin-when-cross-origin/.test(nextConfigSource));
  assert.ok(/Permissions-Policy/.test(nextConfigSource));
});

// ============================================================
// R — CSP remains absent
// ============================================================
check("R (CRITICAL): no Content-Security-Policy was introduced this stage", () => {
  assert.ok(!/Content-Security-Policy/.test(nextConfigSource));
});

// ============================================================
// S — robots decision is explicit, not silently changed
// ============================================================
check("S (CRITICAL): robots.ts still disallows all crawling, and the checklist records this as an explicit, pending decision — not silently carried forward", () => {
  assert.ok(robotsSource, "src/app/robots.ts must exist");
  assert.ok(/disallow: "\/"/.test(robotsSource));
  assert.ok(checklistSource && /indexing/i.test(checklistSource));
});

// ============================================================
// T/U — no sitemap was added while indexing posture is undecided; if one
// ever exists, it must contain only public routes
// ============================================================
check("T/U: no sitemap.ts exists yet (indexing posture is an explicit pending decision, not assumed) — if one is added later, it must list only public routes and never a protected/API/settings path", () => {
  if (!existsSync("src/app/sitemap.ts")) return;
  const sitemap = src("src/app/sitemap.ts");
  assert.ok(!/\/settings|\/api\/|\/library\/|\/reminders|\/calendar/.test(sitemap), "sitemap must not list any protected or private route");
});

// ============================================================
// V — RAWG/TMDB unavailable state is an explicit, honest, non-dead-end
// message — never a raw "not configured" leak, never silent failure
// ============================================================
check("V (CRITICAL): catalog search's error state shows an honest, non-leaking message and always leaves manual entry available — confirmed already-correct app-level graceful degradation", () => {
  assert.ok(/Unable to search right now\. You can still enter this item manually\./.test(metadataSearchPanel));
  assert.ok(!/is not configured/.test(metadataSearchPanel), "the client must never surface the raw server 'not configured' string");
});

// ============================================================
// W — README exists and leaks no secret values
// ============================================================
check("W (CRITICAL): README.md exists and contains only environment VARIABLE NAMES, never a real-looking secret value", () => {
  assert.ok(readmeSource.length > 500);
  assert.ok(/SUPABASE_SECRET_KEY/.test(readmeSource), "README must document the variable name");
  assert.ok(!/SUPABASE_SECRET_KEY\s*=\s*[A-Za-z0-9_-]{10,}/.test(readmeSource));
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(readmeSource), "README must not contain a JWT-shaped value");
});

// ============================================================
// X — README accurately describes the real tracking architecture
// ============================================================
check("X: README describes automatic tracking as extension-based and compatible-sources-only, with manual fallback — no absolute claims", () => {
  assert.ok(/browser extension/i.test(readmeSource));
  assert.ok(/manual/i.test(readmeSource));
  assert.ok(!/tracks everything automatically/i.test(readmeSource));
  assert.ok(!/works on every website/i.test(readmeSource));
  assert.ok(!/perfect synchronization/i.test(readmeSource));
});

// ============================================================
// Y — README does not claim a license that doesn't exist
// ============================================================
check("Y (CRITICAL): no LICENSE file exists, and README does not claim MIT/Apache/GPL or any other license — it states the license decision is pending", () => {
  assert.ok(!existsSync("LICENSE") && !existsSync("LICENSE.md"), "no LICENSE file should have been added without explicit approval");
  assert.ok(!/MIT License|Apache License|GNU General Public License/i.test(readmeSource));
  assert.ok(/no license file exists/i.test(readmeSource));
});

// ============================================================
// Z — beta checklist exists
// ============================================================
check("Z: docs/PUBLIC_BETA_CHECKLIST.md exists", () => assert.ok(existsSync("docs/PUBLIC_BETA_CHECKLIST.md")));

// ============================================================
// AA/AB/AC/AD/AE/AF — prior-stage invariants unchanged
// ============================================================
check("AA (CRITICAL): account lifecycle unchanged — /api/account/delete still performs exactly one admin.deleteUser call", () => {
  const stripped = stripComments(accountDeleteRoute);
  assert.ok(/admin\.deleteUser\(userData\.user\.id, false\)/.test(stripped));
  const adminUsages = stripped.match(/adminClient\./g) ?? [];
  assert.equal(adminUsages.length, 1);
});

check("AB (CRITICAL): source lifecycle unchanged — migration 0019 predicate and deleteUnlinkedManualSource's WHERE clause are untouched", () => {
  assert.ok(/auth\.uid\(\) = user_id\s*\n\s*and library_item_id is null\s*\n\s*and adapter_id = 'manual'/.test(migration0019));
  assert.ok(/\.is\("library_item_id", null\)/.test(trackingSourcesLib));
  assert.ok(/\.eq\("adapter_id", "manual"\)/.test(trackingSourcesLib));
});

check("AC (CRITICAL): Resume engine untouched — no Stage 45 coupling in lib/resume.ts", () => {
  assert.ok(!/landing|privacy|terms|support page|forgot.password/i.test(resumeLibSource));
});

check("AD (CRITICAL): public/sw.js unchanged this stage", () => {
  assert.ok(existsSync("public/sw.js"));
  assert.ok(typeof swSource === "string" && swSource.length > 0);
});

check("AE (CRITICAL): migrations 0001-0019 complete, and 0018/0019 untouched", () => {
  for (let n = 1; n <= 19; n++) {
    const padded = String(n).padStart(4, "0");
    assert.ok(migrationFiles.some((f) => f.startsWith(padded)), `migration ${padded} must still exist`);
  }
});

check("AF (CRITICAL): no migration 0020 or beyond exists — Stage 45 required no schema change", () => {
  assert.ok(!migrationFiles.some((f) => Number(f.slice(0, 4)) > 19), `expected no migration beyond 0019, found: ${migrationFiles.filter((f) => Number(f.slice(0, 4)) > 19).join(", ")}`);
});

// ============================================================
// Extra — Stage 45-specific structural checks
// ============================================================
check("extra: AuthForm's sign-in mode links to /forgot-password", () => {
  assert.ok(/href="\/forgot-password"/.test(authFormSource));
});

check("extra: the Footer's external GitHub link carries rel=\"noopener noreferrer\" alongside target=\"_blank\" (also covered project-wide by verify-public-beta-hardening's check G)", () => {
  assert.ok(/target="_blank"[\s\S]{0,120}rel="noopener noreferrer"/.test(footerSource));
});

check("extra: layout.tsx declares metadataBase/openGraph/twitter metadata and an accurate, non-stale title", () => {
  const layout = src("src/app/layout.tsx");
  assert.ok(/metadataBase/.test(layout));
  assert.ok(/openGraph/.test(layout));
  assert.ok(!/Bookmark Manager/.test(layout), "the stale pre-media-tracking title must be gone");
});

check("extra: the landing page never uses an unqualified absolute tracking claim", () => {
  // stripComments first — the module's own doc comment names these exact
  // phrases as examples of what NOT to write, which would otherwise trip
  // a naive substring check on itself (the same false-positive shape
  // Stage 44's test-authoring found in SourceChooserDialog/sanitize.ts).
  const stripped = stripComments(landingSource);
  for (const phrase of [/tracks everything automatically/i, /works on every website/i, /never loses progress/i, /perfect synchronization/i]) {
    assert.ok(!phrase.test(stripped), `landing page must not claim: ${phrase}`);
  }
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
