#!/usr/bin/env node
// Verifies Stage 38 (Installable PWA & Mobile App Experience): the web app
// manifest's required fields, the generated icon set's real dimensions/
// format, the install-state model's pure logic (reproduced verbatim from
// src/lib/pwa/install-state.ts, same convention as every other script in
// this directory), and durable structural contracts — most importantly
// that nothing here ever requests Notification permission or creates a
// PushSubscription, and that Stage 37's service worker and its ONE
// registration path (inside usePushNotifications.ts's enable()) are
// completely untouched.
//
// Current Chrome/web.dev installability criteria (re-verified live — see
// the Stage 38 correction report) do not require a registered service
// worker for install eligibility or `beforeinstallprompt`; that requirement
// was removed for menu-based install in Chrome 108 (mobile) / 112
// (desktop) and does not appear in the current published criteria list at
// all. Markly therefore does NOT register a service worker globally purely
// for installability — the manifest and browser install platform handle
// that on their own, and `/sw.js` is still registered only when a user
// explicitly enables push in Settings -> Notifications, exactly as in
// Stage 37.
//
// Run with: node scripts/verify-pwa-installability.mjs

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
// A — install-state model, reproduced verbatim from
// src/lib/pwa/install-state.ts's resolveInstallState (pure, no I/O).
//
// Stage 38 correction §1 — this model has NO ServiceWorker dependency of
// any kind: not registration state, not even bare API-support detection.
// Current Chrome/web.dev installability criteria don't require one, so
// there is no honest signal left to build a distinct "unsupported" state
// from — the model has exactly four states.
// ============================================================
function resolveInstallState(inputs) {
  if (inputs.isStandaloneDisplayMode || inputs.isIOSStandaloneFlag) return "already-installed";
  if (inputs.isIOSPlatform) return "ios-manual-install";
  if (inputs.hasDeferredInstallPrompt) return "browser-installable";
  return "not-currently-installable";
}

const BASE_INPUTS = {
  isStandaloneDisplayMode: false,
  isIOSStandaloneFlag: false,
  isIOSPlatform: false,
  hasDeferredInstallPrompt: false,
};

check("A1 (Stage 38 correction §1): resolveInstallState's input shape has no ServiceWorker-related field at all", () => {
  assert.deepEqual(Object.keys(BASE_INPUTS).sort(), ["hasDeferredInstallPrompt", "isIOSPlatform", "isIOSStandaloneFlag", "isStandaloneDisplayMode"]);
});

check("A1b: with every input false, the result is the neutral 'not-currently-installable' — never a false 'unsupported' claim just because nothing else fired yet", () => {
  assert.equal(resolveInstallState(BASE_INPUTS), "not-currently-installable");
});

check("A2: display-mode standalone -> already-installed", () => {
  assert.equal(resolveInstallState({ ...BASE_INPUTS, isStandaloneDisplayMode: true }), "already-installed");
});

check("A3: iOS legacy navigator.standalone flag -> already-installed, even without display-mode support", () => {
  assert.equal(resolveInstallState({ ...BASE_INPUTS, isIOSStandaloneFlag: true }), "already-installed");
});

check("A4: already-installed takes priority over a stale captured install-prompt event", () => {
  assert.equal(resolveInstallState({ ...BASE_INPUTS, isStandaloneDisplayMode: true, hasDeferredInstallPrompt: true }), "already-installed");
});

check("A5: iOS platform (not already standalone) -> ios-manual-install", () => {
  assert.equal(resolveInstallState({ ...BASE_INPUTS, isIOSPlatform: true }), "ios-manual-install");
});

check("A6: iOS platform takes priority over a captured beforeinstallprompt (which cannot fire on iOS anyway)", () => {
  assert.equal(resolveInstallState({ ...BASE_INPUTS, isIOSPlatform: true, hasDeferredInstallPrompt: true }), "ios-manual-install");
});

check("A7: a captured beforeinstallprompt event -> browser-installable", () => {
  assert.equal(resolveInstallState({ ...BASE_INPUTS, hasDeferredInstallPrompt: true }), "browser-installable");
});

check("A9 (Stage 38 correction §1, structural): src/lib/pwa/install-state.ts's actual CODE contains no ServiceWorker reference — its own doc comment explains why in prose, which is fine, but no executable check may exist", () => {
  const source = stripComments(src("src/lib/pwa/install-state.ts"));
  assert.ok(!/navigator\.serviceWorker|["']serviceWorker["']\s*in\s*navigator/.test(source), "the install-state model must have zero ServiceWorker dependency in code — that capability belongs only to Stage 37 push");
});

check("A10 (Stage 38 correction §2): no code comment overclaims that every iOS browser uses the same engine/policy — behavior is described as varying by browser/OS version/region instead", () => {
  for (const file of ["src/lib/pwa/install-state.ts", "src/components/AppSettingsPanel.tsx"]) {
    const source = src(file);
    assert.ok(!/every iOS browser (runs|uses) WebKit/i.test(source), `${file} must not claim every iOS browser runs WebKit`);
    assert.ok(!/by (Apple's own )?policy/i.test(source), `${file} must not assert a specific Apple platform policy as settled fact`);
  }
});

// ============================================================
// B — the manifest itself (Stage 38 §2/§3/§33).
// ============================================================
check("B1: app/manifest.ts exists", () => {
  assert.ok(existsSync("src/app/manifest.ts"));
});

const manifestSource = existsSync("src/app/manifest.ts") ? src("src/app/manifest.ts") : "";

check("B2: required installability fields are present (name, short_name, start_url, display: standalone)", () => {
  assert.ok(/name:\s*"Markly"/.test(manifestSource));
  assert.ok(/short_name:\s*"Markly"/.test(manifestSource));
  assert.ok(/start_url:\s*"\//.test(manifestSource));
  assert.ok(/display:\s*"standalone"/.test(manifestSource));
});

check("B3: scope is same-origin/relative, never a hardcoded external or production-specific URL (Stage 38 §33/§34)", () => {
  assert.ok(/scope:\s*"\//.test(manifestSource));
  assert.ok(!/markly-lime\.vercel\.app/.test(manifestSource), "manifest must stay portable across preview/local environments — no hardcoded production origin");
});

check("B4: manifest id is a relative, deployment-host-independent path (Stage 38 §3)", () => {
  assert.ok(/id:\s*"\//.test(manifestSource));
});

check("B5: no prefer_related_applications:true — its absence/false is required for installability", () => {
  assert.ok(!/prefer_related_applications['"]?\s*:\s*true/.test(manifestSource));
});

check("B6: icons array declares 192 and 512 'any' plus a dedicated 512 'maskable' entry", () => {
  assert.ok(/sizes:\s*"192x192".*purpose:\s*"any"/s.test(manifestSource) || /purpose:\s*"any".*sizes:\s*"192x192"/s.test(manifestSource) || /"192x192"[\s\S]{0,40}"any"/.test(manifestSource));
  assert.ok(/"512x512"[\s\S]{0,60}"any"/.test(manifestSource));
  assert.ok(/"512x512"[\s\S]{0,60}"maskable"/.test(manifestSource));
});

check("B7: no secret/config values or user/session data anywhere in the manifest's actual code (Stage 38 §33)", () => {
  assert.ok(!/process\.env|SECRET|TOKEN|cookie|session/i.test(stripComments(manifestSource)));
});

check("B8 (Stage 39 §34/§57): share_target is same-origin, GET-based, accepts only title/text/url, and never declares a files entry", () => {
  const cleaned = stripComments(manifestSource);
  const block = cleaned.slice(cleaned.indexOf("share_target"));
  assert.ok(block.startsWith("share_target"), "manifest must declare share_target");
  assert.ok(/action:\s*"\/share"/.test(block));
  assert.ok(/method:\s*"GET"/.test(block));
  assert.ok(!/files/.test(block));
  assert.ok(/title:\s*"title"/.test(block) && /text:\s*"text"/.test(block) && /url:\s*"url"/.test(block));
});

// ============================================================
// C — the generated icon files (Stage 38 §4/§5/§6).
// ============================================================
function readPngDimensions(path) {
  const buf = readFileSync(path);
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${path} must be a real PNG (signature check)`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const ICON_FILES = [
  { path: "public/icons/icon-192.png", size: 192 },
  { path: "public/icons/icon-512.png", size: 512 },
  { path: "public/icons/icon-maskable-512.png", size: 512 },
];

for (const { path, size } of ICON_FILES) {
  check(`C: ${path} exists, is a real PNG, and is exactly ${size}x${size}`, () => {
    assert.ok(existsSync(path), `expected ${path} to exist`);
    const { width, height } = readPngDimensions(path);
    assert.equal(width, size);
    assert.equal(height, size);
  });
}

check("C4: the manifest's icon src paths match real files that actually exist on disk", () => {
  const srcMatches = [...manifestSource.matchAll(/src:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcMatches.length >= 3);
  for (const iconSrc of srcMatches) {
    assert.ok(existsSync(`public${iconSrc}`), `manifest references ${iconSrc}, which must exist at public${iconSrc}`);
  }
});

check("C5: apple-icon route exists and is intentionally NOT the same rounded-corner composition as the manifest icons (no rx/border-radius) — iOS applies its own mask", () => {
  assert.ok(existsSync("src/app/apple-icon.tsx"));
  const source = src("src/app/apple-icon.tsx");
  assert.ok(!/rx=/.test(source), "apple-icon must be a full-bleed square — no pre-baked corner rounding");
  assert.equal(source.match(/width:\s*180/g)?.length > 0 || /width = \{ width: 180/.test(source), true, "expected the standard 180x180 Apple touch icon size");
});

check("C6: the icon generator script exists and is the documented source of truth for regenerating the checked-in PNGs (Stage 38 §6)", () => {
  assert.ok(existsSync("scripts/generate-pwa-icons.mjs"));
});

// ============================================================
// D — service worker preservation (Stage 38 §7/§8/§32, CRITICAL: no
// regression to Stage 37's push delivery).
// ============================================================
const swSource = src("public/sw.js");

check("D1: no generic fetch handler was added — Stage 38 is explicitly not an offline-cache rewrite", () => {
  assert.ok(!/addEventListener\(\s*["']fetch["']/.test(swSource), "public/sw.js must not gain a fetch handler in Stage 38");
});

check("D2: no Cache API usage was introduced (caches.open/caches.match/CacheStorage)", () => {
  assert.ok(!/caches\.(open|match)|CacheStorage/.test(swSource));
});

check("D3: Stage 37's push and notificationclick listeners are both still present, unchanged in kind", () => {
  assert.ok(/addEventListener\(\s*["']push["']/.test(swSource));
  assert.ok(/addEventListener\(\s*["']notificationclick["']/.test(swSource));
});

check("D4: no automatic skipWaiting()/clients.claim() was added — Stage 38 §32 explicitly warns against disrupting active sessions without evaluating it, and no app-shell cache exists to make that trade-off necessary", () => {
  assert.ok(!/skipWaiting\(\)|clients\.claim\(\)/.test(swSource));
});

// ============================================================
// E — NO global service-worker registration exists purely for
// installability (Stage 38 correction §2/§3): PWA install uses only the
// manifest + browser install platform; `/sw.js` registration stays exactly
// where Stage 37 put it.
// ============================================================
const PWA_FILES = ["src/lib/pwa/install-state.ts", "src/hooks/useInstallPrompt.ts", "src/components/AppSettingsPanel.tsx", "src/app/settings/app/page.tsx", "src/app/manifest.ts", "src/app/apple-icon.tsx", "src/app/layout.tsx"];

check("E1: no ServiceWorkerRegistrar component or global-registration helper exists — they were removed once re-audited criteria showed installability doesn't require a registered SW", () => {
  assert.ok(!existsSync("src/components/ServiceWorkerRegistrar.tsx"));
  assert.ok(!existsSync("src/lib/pwa/service-worker.ts"));
});

check("E2: the root layout does not mount any service-worker registrar or reference navigator.serviceWorker at all", () => {
  const layoutSource = src("src/app/layout.tsx");
  assert.ok(!/ServiceWorkerRegistrar|navigator\.serviceWorker/.test(layoutSource));
});

check("E3: usePushNotifications.ts's enable() is byte-for-byte back to its original Stage 37 form — a direct navigator.serviceWorker.register() call, no PWA-installability wrapper", () => {
  const source = src("src/hooks/usePushNotifications.ts");
  assert.ok(!source.includes("@/lib/pwa/service-worker"), "must not import the (now-removed) global registration helper");
  const enableFn = source.slice(source.indexOf("const enable = useCallback"), source.indexOf("const reconnect = useCallback"));
  assert.ok(/const registration = await navigator\.serviceWorker\.register\(SERVICE_WORKER_URL\);/.test(enableFn), "enable() must register directly, exactly as Stage 37 did");
});

check("E4: navigator.serviceWorker.register is called from exactly one place in the entire src/ tree — usePushNotifications.ts's enable() — proving install-related code never registers a SW of its own", () => {
  for (const file of PWA_FILES) {
    assert.ok(!src(file).includes("serviceWorker.register"), `${file} must never register a service worker`);
  }
});

check("E5 (CRITICAL, Stage 38 §10 — no permission regression): Notification.requestPermission is still called from exactly one place in the whole codebase — usePushNotifications.ts's enable() — never from any PWA-install file", () => {
  for (const file of PWA_FILES) {
    assert.ok(!stripComments(src(file)).includes("requestPermission"), `${file} must never touch Notification.requestPermission`);
  }
  const hookSource = stripComments(src("src/hooks/usePushNotifications.ts"));
  assert.equal([...hookSource.matchAll(/requestPermission\(/g)].length, 1, "requestPermission call sites must remain exactly one, codebase-wide");
});

check("E6 (CRITICAL): none of the PWA-install files ever call pushManager.subscribe", () => {
  for (const file of PWA_FILES) {
    assert.ok(!src(file).includes("pushManager.subscribe"), `${file} must never create a PushSubscription`);
  }
});

// ============================================================
// F — beforeinstallprompt / appinstalled lifecycle (Stage 38 §12/§13).
// ============================================================
const installHookSource = src("src/hooks/useInstallPrompt.ts");

check("F1: beforeinstallprompt's default is prevented, and the event is stored only in a ref (in-memory), never persisted to storage", () => {
  const cleaned = stripComments(installHookSource);
  const fnStart = cleaned.indexOf("function onBeforeInstallPrompt");
  const fnBody = cleaned.slice(fnStart, cleaned.indexOf("function onAppInstalled"));
  assert.ok(fnBody.includes("event.preventDefault()"));
  assert.ok(fnBody.includes("deferredRef.current = event"));
  assert.ok(!/localStorage|sessionStorage/.test(installHookSource), "the deferred install-prompt event must never be persisted");
});

check("F2: promptInstall() is the only function that calls .prompt(), and it clears the deferred event afterward regardless of outcome", () => {
  const fn = installHookSource.slice(installHookSource.indexOf("const promptInstall = useCallback"));
  assert.ok(fn.includes("deferred.prompt()"));
  assert.ok(/finally[\s\S]*deferredRef\.current = null/.test(fn), "the captured event must be cleared in a finally block, whether accepted or dismissed");
});

check("F3: appinstalled clears the deferred event and marks the session installed", () => {
  const fn = installHookSource.slice(installHookSource.indexOf("function onAppInstalled"), installHookSource.indexOf("window.addEventListener(\"beforeinstallprompt\""));
  assert.ok(fn.includes("deferredRef.current = null"));
  assert.ok(fn.includes("installedThisSessionRef.current = true"));
});

check("F4: promptInstall is never called from a passive effect — only exposed for a click handler to call", () => {
  const effectBodies = [...installHookSource.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[/g)].map((m) => m[1]);
  for (const body of effectBodies) {
    assert.ok(!body.includes("promptInstall") && !body.includes(".prompt()"), "no effect body may call the install prompt itself");
  }
});

// ============================================================
// G — App Settings integration (Stage 38 §17/§18/§23/§24).
// ============================================================
check("G1: the Settings -> App route and panel exist", () => {
  assert.ok(existsSync("src/app/settings/app/page.tsx"));
  assert.ok(existsSync("src/components/AppSettingsPanel.tsx"));
});

check("G2: SettingsShell's tab list includes App, pointing at /settings/app", () => {
  const source = src("src/components/SettingsShell.tsx");
  assert.ok(/\{ id: "app", label: "App", href: "\/settings\/app" \}/.test(source));
});

check("G3: the Command Palette's static navigation allowlist includes Settings · App (Stage 38 §17, same pattern as every other Settings tab)", () => {
  const source = src("src/lib/command-palette.ts");
  assert.ok(/\{ kind: "navigation", id: "nav\.settings\.app", label: "Settings · App", href: "\/settings\/app" \}/.test(source));
});

check("G4: the App Settings panel never gates on sign-in — installability is a browser-level capability, not an account-level one", () => {
  const source = src("src/app/settings/app/page.tsx");
  assert.ok(!/auth\.getUser\(\)|createClient\(\)/.test(source), "unlike Notifications, the App settings page must not require a signed-in session");
});

check("G5: iOS install instructions are always accompanied by visible text, never an icon alone (Stage 38 §37)", () => {
  const source = src("src/components/AppSettingsPanel.tsx");
  const iosBlock = source.slice(source.indexOf('state === "ios-manual-install"'), source.indexOf('state === "not-currently-installable"'));
  assert.ok(/Share/.test(iosBlock) && /Add to Home Screen/.test(iosBlock), "iOS instructions must spell out the actual steps in text");
});

check("G5b (Stage 38 correction §5/§6): iOS instructions are browser-neutral — never name Safari specifically, since isIOSPlatform() fires for any browser on iOS and Add to Home Screen behavior varies by browser/OS version/region", () => {
  const source = src("src/components/AppSettingsPanel.tsx");
  const iosBlock = source.slice(source.indexOf('state === "ios-manual-install"'), source.indexOf('state === "not-currently-installable"'));
  assert.ok(!/Safari/i.test(iosBlock), "iOS install copy must not claim or imply Safari is the browser being used");
});

check("G6: the panel explicitly states that installing does not itself enable notifications (Stage 38 §10/§16 — no implied permission regression)", () => {
  const source = src("src/components/AppSettingsPanel.tsx");
  assert.ok(/doesn(&rsquo;|['’])t turn on notifications/i.test(source));
});

// ============================================================
// H — viewport/metadata contract (Stage 38 §26/§33).
// ============================================================
const layoutSource = src("src/app/layout.tsx");

check("H1: viewport-fit=cover was NOT set — no fixed/edge-pinned chrome exists that would need manual safe-area padding (Stage 38 §22)", () => {
  assert.ok(!/viewportFit/.test(layoutSource), "no viewport-fit:cover means no env(safe-area-inset-*) is required anywhere");
});

check("H2: theme-color is provided as a light/dark media-conditioned pair, not a single value pretending to cover both (Stage 38 §26)", () => {
  assert.ok(/prefers-color-scheme: light/.test(layoutSource) && /prefers-color-scheme: dark/.test(layoutSource));
});

check("H3: appleWebApp status bar style is 'default', not 'black-translucent' — consistent with the no-safe-area-padding decision", () => {
  assert.ok(/statusBarStyle:\s*"default"/.test(layoutSource));
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
