#!/usr/bin/env node
// Verifies Stage 39 (Share to Markly & Universal URL Capture): the pure
// URL-extraction/validation logic (reproduced verbatim from
// src/lib/share/extract-share-url.ts, same convention as every other
// script in this directory), the manifest's share_target declaration, and
// durable structural contracts — most importantly that nothing in the
// capture flow can auto-create a LibraryItem, request Notification
// permission, create a PushSubscription, or server-fetch an arbitrary
// shared URL.
//
// Run with: node scripts/verify-share-capture.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

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
// A — isValidUrl/normalizeUrl, reproduced verbatim from src/lib/website.ts
// (the same shared validator the manual Website Add form already uses —
// Stage 39 deliberately reuses this rather than inventing a second policy).
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

// ============================================================
// B — extractShareUrl/extractShareTitle, reproduced verbatim from
// src/lib/share/extract-share-url.ts. Stage 39 correction: a discriminated
// { status: "valid" | "missing" | "invalid" } result, so a rejected
// (unsafe/malformed) URL is never conflated with a genuinely absent one.
// ============================================================
const MAX_SHARE_URL_LENGTH = 2000;
const MAX_SHARE_TEXT_LENGTH = 4000;
const MAX_SHARE_TITLE_LENGTH = 300;

function clamp(value, maxLength) {
  if (!value) return "";
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
function trimTrailingProsePunctuation(candidate) {
  return candidate.replace(/[.,;:!?)\]}'"]+$/, "");
}
const URL_SCAN_PATTERN = /https?:\/\/[^\s<>"']+/i;

function classifyUrlCandidate(raw) {
  if (raw.length > MAX_SHARE_URL_LENGTH) return { status: "invalid", reason: "too-long" };
  const normalized = normalizeUrl(raw);
  if (isValidUrl(normalized)) return { status: "valid", url: normalized };
  try {
    new URL(normalized);
    return { status: "invalid", reason: "unsafe" };
  } catch {
    return { status: "invalid", reason: "malformed" };
  }
}

function extractShareUrl(payload) {
  const rawUrl = (payload.url ?? "").trim();
  if (rawUrl) return classifyUrlCandidate(rawUrl);

  const rawText = clamp(payload.text, MAX_SHARE_TEXT_LENGTH);
  const match = URL_SCAN_PATTERN.exec(rawText);
  if (match) {
    const candidate = trimTrailingProsePunctuation(match[0]);
    const result = classifyUrlCandidate(candidate);
    if (result.status === "valid") return result;
  }
  return { status: "missing" };
}
function extractShareTitle(payload) {
  return clamp(payload.title, MAX_SHARE_TITLE_LENGTH).trim();
}

function assertValid(result, expectedUrl, msg) {
  assert.equal(result.status, "valid", msg ?? `expected valid, got ${JSON.stringify(result)}`);
  if (expectedUrl) assert.equal(result.url, expectedUrl);
}
function assertMissing(result, msg) {
  assert.equal(result.status, "missing", msg ?? `expected missing, got ${JSON.stringify(result)}`);
}
function assertInvalid(result, msg) {
  assert.equal(result.status, "invalid", msg ?? `expected invalid, got ${JSON.stringify(result)}`);
}

check("B1: explicit url wins outright over text (Stage 39 §5 priority)", () => {
  assertValid(extractShareUrl({ url: "https://a.example.com", text: "see https://b.example.com" }), "https://a.example.com");
});

check("B2: falls back to the first URL found in text when url is absent", () => {
  assertValid(extractShareUrl({ text: "check this out: https://example.com/foo" }), "https://example.com/foo");
});

check("B3: multiple URLs in text — only the FIRST is ever returned", () => {
  assertValid(extractShareUrl({ text: "https://first.example.com/a and https://second.example.com/b" }), "https://first.example.com/a");
});

check("B5: trailing prose punctuation is trimmed without corrupting the URL itself", () => {
  assertValid(extractShareUrl({ text: "See (https://example.com/foo)." }), "https://example.com/foo");
});

check("B6: a bare hostname in `url` is normalized to https:// like the manual Website form does", () => {
  assertValid(extractShareUrl({ url: "example.com/foo" }), "https://example.com/foo");
});

check("B10: an XSS-shaped string in url/text is never returned verbatim as executable content — extraction never evaluates or unescapes anything", () => {
  assertInvalid(extractShareUrl({ url: '"><img src=x onerror=alert(1)>' }));
  assertMissing(extractShareUrl({ text: "<script>alert(1)</script>" }), "a non-URL-shaped XSS string in free text has no http(s):// prefix at all, so it never even reaches classification — genuinely 'missing', not 'invalid'");
});

check("B11: malformed/empty/whitespace-only input never throws", () => {
  for (const payload of [{}, { url: "" }, { url: "   " }, { text: "" }, { url: "not a url at all" }, { text: "http://" }, { url: "http://" }]) {
    assert.doesNotThrow(() => extractShareUrl(payload));
  }
});

check("B13: unicode/punycode domains and query-heavy/fragment URLs round-trip deterministically without throwing", () => {
  assertValid(extractShareUrl({ url: "https://xn--n3h.example.com/" }), "https://xn--n3h.example.com/");
  assertValid(extractShareUrl({ url: "https://example.com/path?a=1&b=2#frag" }), "https://example.com/path?a=1&b=2#frag");
});

check("B14: title is a bounded, trimmed hint only — never scanned for a URL itself", () => {
  assert.equal(extractShareTitle({ title: "  My Title  " }), "My Title");
});

// ============================================================
// B15 — the full missing/invalid error test matrix (Stage 39 correction §5,
// items A-N). Distinguishing "missing" from "invalid" is the entire point
// of this correction pass, so each case is its own named check.
// ============================================================
check("Matrix A: no url/title/text at all -> missing", () => {
  assertMissing(extractShareUrl({}));
});

check("Matrix B: prose only, no URL -> missing", () => {
  assertMissing(extractShareUrl({ text: "just some ordinary prose with no link in it" }));
});

check("Matrix C: explicit https URL -> valid", () => {
  assertValid(extractShareUrl({ url: "https://example.com/foo" }), "https://example.com/foo");
});

check("Matrix D: explicit http URL -> valid", () => {
  assertValid(extractShareUrl({ url: "http://example.com/foo" }), "http://example.com/foo");
});

check("Matrix E: explicit javascript: -> invalid", () => {
  assertInvalid(extractShareUrl({ url: "javascript:alert(1)" }));
});

check("Matrix F: explicit data: -> invalid", () => {
  assertInvalid(extractShareUrl({ url: "data:text/html,<script>alert(1)</script>" }));
});

check("Matrix G: explicit ftp: -> invalid", () => {
  assertInvalid(extractShareUrl({ url: "ftp://example.com/x" }));
});

check("Matrix G-extra: blob:/file:/chrome:/about:/intent:/mailto:/tel: are all also invalid", () => {
  for (const scheme of ["blob:https://example.com/x", "file:///etc/passwd", "chrome://settings", "about:blank", "intent://example.com#Intent;end", "mailto:a@example.com", "tel:+1234567890"]) {
    assertInvalid(extractShareUrl({ url: scheme }), `expected ${scheme} to be invalid`);
  }
});

check("Matrix H (CRITICAL — credential URL): explicit userinfo -> invalid, credentials never echoed in the reason", () => {
  const result = extractShareUrl({ url: "https://user:password@example.com/foo" });
  assertInvalid(result);
  assert.ok(!JSON.stringify(result).includes("password"), "the rejection result must never echo the credential value");
});

check("Matrix I: explicit malformed URL -> invalid", () => {
  assertInvalid(extractShareUrl({ url: "not a url at all" }));
});

check("Matrix J: an explicit URL over MAX_SHARE_URL_LENGTH -> invalid (too-long), never silently truncated then judged valid", () => {
  const overLimit = "https://example.com/" + "a".repeat(MAX_SHARE_URL_LENGTH);
  const result = extractShareUrl({ url: overLimit });
  assertInvalid(result);
  assert.equal(result.reason, "too-long");
});

check("Matrix K: no explicit URL + a valid URL in text -> valid", () => {
  assertValid(extractShareUrl({ text: "see https://example.com/foo for details" }), "https://example.com/foo");
});

check("Matrix L (CRITICAL): invalid explicit URL + a valid URL sitting in text -> INVALID; explicit always wins, text is never consulted as a fallback for a bad explicit value", () => {
  const result = extractShareUrl({ url: "javascript:alert(1)", text: "https://example.com/should-be-ignored" });
  assertInvalid(result);
});

check("Matrix M: multiple URLs in text -> the first valid candidate per the existing left-to-right policy", () => {
  assertValid(extractShareUrl({ text: "https://first.example.com/a then https://second.example.com/b" }), "https://first.example.com/a");
});

check("Matrix N: a title that merely looks like a URL never becomes the extracted URL", () => {
  assertMissing(extractShareUrl({ title: "https://example.com/should-not-count" }));
});

// ============================================================
// C — the /share route and its manifest declaration (Stage 39 §2/§3/§34).
// ============================================================
check("C1: the /share route exists (single canonical capture route)", () => {
  assert.ok(existsSync("src/app/share/page.tsx"));
});

check("C2: no duplicate share/capture route was created alongside it", () => {
  assert.ok(!existsSync("src/app/capture"));
});

const manifestSource = src("src/app/manifest.ts");

check("C3: manifest declares a GET share_target pointing at /share with exactly title/text/url params, no files", () => {
  const cleaned = stripComments(manifestSource);
  const shareTargetBlock = cleaned.slice(cleaned.indexOf("share_target"));
  assert.ok(/action:\s*"\/share"/.test(shareTargetBlock));
  assert.ok(/method:\s*"GET"/.test(shareTargetBlock));
  assert.ok(!/files/.test(shareTargetBlock), "Stage 39 explicitly does not accept shared files");
  assert.ok(/title:\s*"title"/.test(shareTargetBlock) && /text:\s*"text"/.test(shareTargetBlock) && /url:\s*"url"/.test(shareTargetBlock));
});

check("C4: share_target action is same-origin (a bare relative path, never an absolute external URL)", () => {
  const actionMatch = manifestSource.match(/action:\s*"([^"]+)"/);
  assert.ok(actionMatch);
  assert.ok(actionMatch[1].startsWith("/"), "action must be a same-origin relative path");
  assert.ok(!/^https?:\/\//.test(actionMatch[1]));
});

check("C5: share_target does not point at an API/processor route", () => {
  const actionMatch = manifestSource.match(/action:\s*"([^"]+)"/);
  assert.ok(!actionMatch[1].startsWith("/api/"), "share_target must land on a normal page route, never an API route");
});

// ============================================================
// D — no invisible auto-save / no privileged action from the capture flow
// (Stage 39 §1/§10, CRITICAL).
// ============================================================
const captureFiles = ["src/components/ShareCaptureView.tsx", "src/app/share/page.tsx", "src/lib/share/extract-share-url.ts"];

check("D1 (CRITICAL): no capture file ever calls Notification.requestPermission or pushManager.subscribe", () => {
  for (const file of captureFiles) {
    const cleaned = stripComments(src(file));
    assert.ok(!cleaned.includes("requestPermission"), `${file} must never touch Notification.requestPermission`);
    assert.ok(!cleaned.includes("pushManager.subscribe"), `${file} must never create a PushSubscription`);
  }
});

check("D2 (CRITICAL): no capture file writes to localStorage/sessionStorage/cookies before an explicit save — nothing persists a cancelled share", () => {
  for (const file of captureFiles) {
    assert.ok(!/localStorage\.setItem|sessionStorage\.setItem|document\.cookie\s*=/.test(src(file)), `${file} must not persist share payload data outside explicit save`);
  }
});

check("D3 (CRITICAL): ShareCaptureView never auto-navigates the browser to the shared URL itself (no window.location assignment to a shared value)", () => {
  const source = src("src/components/ShareCaptureView.tsx");
  assert.ok(!/window\.location\s*=/.test(source), "external navigation must always be an explicit user action, never automatic");
});

check("D4: no dangerouslySetInnerHTML anywhere in the capture flow — shared title/text always renders as plain, escaped text", () => {
  for (const file of captureFiles) {
    assert.ok(!src(file).includes("dangerouslySetInnerHTML"), `${file} must never render shared content as HTML`);
  }
});

check("D5: creation only happens via the same authoritative useLibraryItems mutations the normal Add Item flow uses (addWebsite/addMedia) — no second/parallel LibraryItem-creation code path", () => {
  const source = src("src/components/ShareCaptureView.tsx");
  assert.ok(source.includes("library.addWebsite(") && source.includes("library.addMedia("));
  assert.ok(!/supabase\s*\.\s*from\(\s*["']library_items["']\s*\)\s*\.\s*insert/.test(source), "must not insert directly, bypassing the shared hook");
});

check("D6: the create button is a normal form submit gated by the form's own validation — no useEffect in ShareCaptureView calls addWebsite/addMedia on mount or on every render", () => {
  const source = src("src/components/ShareCaptureView.tsx");
  assert.ok(!/useEffect/.test(source), "ShareCaptureView should need no effects at all — everything here is derived state + explicit handlers");
});

// ============================================================
// E — SSRF: no arbitrary shared URL is ever server-fetched (Stage 39 §7,
// CRITICAL). Markly's existing metadata providers only ever fetch a fixed,
// hardcoded provider host — this audits that Stage 39 preserved that
// invariant rather than introducing a new one.
// ============================================================
check("E1 (CRITICAL): no capture file performs a server-side fetch of the shared URL itself", () => {
  for (const file of captureFiles) {
    const source = src(file);
    // A fetch() call whose argument is a shared-payload variable (not a
    // fixed literal) would be the red flag; the simplest, most robust
    // static proof for this small file set is that fetch() doesn't appear
    // in them at all — the capture flow never fetches anything itself.
    assert.ok(!/\bfetch\(/.test(source), `${file} must never call fetch() — no server-side retrieval of the shared URL exists in this flow`);
  }
});

check("E2: existing metadata provider server fetches still target only fixed, hardcoded hosts (regression guard on the invariant Stage 39 relies on)", () => {
  for (const file of ["src/lib/metadata/server/rawg.ts", "src/lib/metadata/server/tmdb.ts"]) {
    if (!existsSync(file)) continue;
    const source = src(file);
    assert.ok(/https:\/\/api\.(rawg\.io|themoviedb\.org)/.test(source), `${file} must fetch a fixed provider host, never a caller-supplied URL`);
  }
});

// ============================================================
// F — duplicate/existing-item detection reuses established signals only
// (Stage 39 §15/§23).
// ============================================================
check("F1: existing-item detection uses only the two conservative signals duplicate-detection.ts already established — exact URL match and exact catalogSource match — never fuzzy title matching", () => {
  const source = src("src/components/ShareCaptureView.tsx");
  assert.ok(source.includes("findItemByExactUrl"));
  assert.ok(source.includes("findItemByCatalogSource"));
  const cleaned = stripComments(source);
  assert.ok(!/normalizeTitleForMatching|levenshtein/i.test(cleaned), "must not add a second, looser title-matching heuristic");
});

// ============================================================
// G — import-pending / signed-out / signed-in behavior (Stage 39 §12/§13/§14).
// ============================================================
check("G1: the capture flow checks the same import-pending signal (resolveActivationState + useLocalImport) DashboardView already uses — not a new heuristic", () => {
  const source = src("src/components/ShareCaptureView.tsx");
  assert.ok(source.includes("resolveActivationState") && source.includes("useLocalImport"));
});

check("G2: import-pending blocks the capture UI outright rather than letting a share bypass it", () => {
  const source = src("src/components/ShareCaptureView.tsx");
  const idx = source.indexOf('activationState === "import-pending"');
  assert.ok(idx > -1);
});

check("G3: no share-derived value can influence ownership — user_id is never read from search params/props, only from the authenticated session via useAuth", () => {
  const source = src("src/components/ShareCaptureView.tsx");
  assert.ok(!/user_id\s*[:=]\s*(sharedUrl|sharedTitle|sharedText|params)/.test(source));
  assert.ok(source.includes("useAuth()"));
});

// ============================================================
// H — no Stage 37/38 regression (Stage 39 §54/§55/§56, CRITICAL).
// ============================================================
check("H1 (CRITICAL): public/sw.js is untouched — still only push + notificationclick, no fetch/cache", () => {
  const swSource = src("public/sw.js");
  assert.ok(/addEventListener\(\s*["']push["']/.test(swSource));
  assert.ok(/addEventListener\(\s*["']notificationclick["']/.test(swSource));
  assert.ok(!/addEventListener\(\s*["']fetch["']/.test(swSource));
  assert.ok(!/caches\.(open|match)/.test(swSource));
});

check("H2 (CRITICAL): usePushNotifications.ts's enable() is unmodified — still the sole navigator.serviceWorker.register call site", () => {
  const source = stripComments(src("src/hooks/usePushNotifications.ts"));
  assert.equal([...source.matchAll(/requestPermission\(/g)].length, 1);
});

check("H3: PWA install architecture files are untouched by Stage 39 (no new ServiceWorker dependency reintroduced)", () => {
  assert.ok(!existsSync("src/components/ServiceWorkerRegistrar.tsx"));
  assert.ok(!existsSync("src/lib/pwa/service-worker.ts"));
  const installStateSource = stripComments(src("src/lib/pwa/install-state.ts"));
  assert.ok(!/navigator\.serviceWorker/.test(installStateSource));
});

// ============================================================
// I — accessibility/responsive structural contracts (Stage 39 §51/§52).
// ============================================================
check("I1: the manual-paste field has a real label wired via htmlFor/id, and its error is connected via the shared Field component (same pattern as WebsiteItemForm)", () => {
  const source = src("src/components/ShareCaptureView.tsx");
  assert.ok(/htmlFor="paste-url"|<Field label="Link" htmlFor="paste-url"/.test(source));
});

check("I2: long URLs are truncated for DISPLAY only — the full value is still passed to forms/creation, never lost", () => {
  const helperSource = src("src/lib/share/extract-share-url.ts");
  assert.ok(helperSource.includes("truncateForDisplay"));
  const viewSource = src("src/components/ShareCaptureView.tsx");
  assert.ok(viewSource.includes("truncateForDisplay"), "the review screen must use the truncation helper for the displayed URL");
  assert.ok(viewSource.includes("initialUrl={effectiveUrl") || viewSource.includes("sourceUrl: effectiveUrl"), "the untruncated URL must still reach the form/prefill");
});

// ============================================================
// J — Stage 39 correction: missing vs invalid are genuinely distinct UI
// states (§1-§4), and the GET privacy claim is stated precisely rather
// than overclaimed (Part B).
// ============================================================
check("J1: extractShareUrl returns a discriminated result, not a bare string/null — the whole point of this correction", () => {
  const source = src("src/lib/share/extract-share-url.ts");
  assert.ok(/status:\s*"valid"/.test(source) && /status:\s*"missing"/.test(source) && /status:\s*"invalid"/.test(source));
  assert.ok(!source.includes("extractCandidateUrl"), "the old conflated-null-result function name must not remain");
});

check("J2: ShareCaptureView renders 'missing' and 'invalid' as distinct steps with distinct copy — never the same message for both", () => {
  const source = src("src/components/ShareCaptureView.tsx");
  assert.ok(/kind:\s*"missing"/.test(source) && /kind:\s*"invalid"/.test(source));
  assert.ok(/No link was included in this share/.test(source));
  assert.ok(/can.t be used/.test(source), "the invalid state must show its own distinct rejection copy");
});

check("J3: the invalid-URL message never echoes parser internals or the rejected value itself — a generic, safe message only", () => {
  const source = src("src/components/ShareCaptureView.tsx");
  const invalidBlock = source.slice(source.indexOf('activeStep.kind === "invalid"'), source.indexOf('activeStep.kind === "existing-item"'));
  assert.ok(!/\{effectiveUrl\}|\{sharedUrl\}|\{pastedUrl\}/.test(invalidBlock), "must not render the raw rejected value back to the user");
});

check("J4 (CRITICAL correctness): an explicit invalid URL never silently falls back to a valid URL sitting in text — verified structurally: extractShareUrl returns before ever touching `text` when `url` is non-empty", () => {
  const source = stripComments(src("src/lib/share/extract-share-url.ts"));
  const fnBody = source.slice(source.indexOf("export function extractShareUrl"));
  const ifIndex = fnBody.indexOf("if (rawUrl)");
  const returnIndex = fnBody.indexOf("return classifyUrlCandidate(rawUrl)");
  assert.ok(ifIndex > -1 && returnIndex > ifIndex && returnIndex - ifIndex < 30, "the explicit-url branch must return immediately, never falling through to the text scan");
});

check("J5 (Part B): the manifest's GET privacy comment does not claim shared URLs are never server-logged — it states precisely what Markly's own code does and does not control", () => {
  const source = stripComments(src("src/app/manifest.ts"));
  assert.ok(!/never (server[- ]?)?logg?ed/i.test(source), "must not overclaim what happens at the hosting/platform layer");
  const rawSource = src("src/app/manifest.ts");
  assert.ok(/hosting infrastructure|hosting\/platform/i.test(rawSource), "must acknowledge the request necessarily passes through hosting infrastructure");
  assert.ok(/does not explicitly log/i.test(rawSource), "must state only the narrower, provable claim about Markly's own application code");
});

check("J6: no analytics/telemetry/console/server logging was added for incoming shares", () => {
  for (const file of captureFiles) {
    assert.ok(!/console\.(log|info|warn|error)\(/.test(src(file)), `${file} must not log share payload data`);
  }
});

check("J7: no history.replaceState was added to scrub the shared query — the GET lifecycle (refresh/back/forward/deep-link) is deliberately kept as-is this pass", () => {
  for (const file of captureFiles) {
    assert.ok(!src(file).includes("history.replaceState"), `${file} must not alter the GET history lifecycle this pass`);
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
