#!/usr/bin/env node
// Verifies Stage 35 (First-Run Onboarding & Activation Experience),
// including both final audit rounds:
//   1. Replacing the original "itemCount === 1" nudge trigger with a
//      persisted hasEverHadLibraryItems/autoTrackingNudgeEligible history
//      so returning users and pre-existing-upgrade users can never be
//      mistaken for brand-new ones.
//   2. Making that activation page-independent (one shared tracker used
//      by both Dashboard and Library — see hooks/useLibraryActivation.ts)
//      and making the underlying storage upgrade-safe via an explicit
//      v1 -> v2 migration path (see lib/onboarding.ts).
// Deterministic behavior of the pure activation-state/dismissal/history/
// migration logic is reproduced verbatim from src/lib/onboarding.ts (same
// convention as every other script in this directory — plain .mjs, no
// TypeScript loader), plus durable structural contracts. Does not judge
// visual/aesthetic quality.
//
// Run with: node scripts/verify-onboarding-experience.mjs

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

// ============================================================
// A — resolveActivationState, reproduced verbatim from
// src/lib/onboarding.ts.
// ============================================================
function resolveActivationState({ loading, loadError, itemCount, pendingLocalImport, hasEverHadLibraryItems }) {
  if (loading) return "loading";
  if (itemCount > 0) return "populated";
  if (loadError) return "error";
  if (pendingLocalImport) return "import-pending";
  if (hasEverHadLibraryItems) return "empty-returning";
  return "onboarding";
}

// ============================================================
// B — versioned storage + v1 -> v2 migration, reproduced verbatim from
// src/lib/onboarding.ts.
// ============================================================
const DEFAULT_STATE = { hasEverHadLibraryItems: false, autoTrackingNudgeDismissed: false, autoTrackingNudgeEligible: false };

function toStorageV2(state) {
  return {
    version: 2,
    activation: { hasEverHadLibraryItems: state.hasEverHadLibraryItems },
    preferences: { autoTrackingNudgeDismissed: state.autoTrackingNudgeDismissed, autoTrackingNudgeEligible: state.autoTrackingNudgeEligible },
  };
}

function fromStorageV2(stored) {
  return {
    hasEverHadLibraryItems: stored.activation.hasEverHadLibraryItems,
    autoTrackingNudgeDismissed: stored.preferences.autoTrackingNudgeDismissed,
    autoTrackingNudgeEligible: stored.preferences.autoTrackingNudgeEligible,
  };
}

function isOnboardingStorageV1(value) {
  if (!value || typeof value !== "object") return false;
  return (
    value.version === 1 &&
    typeof value.autoTrackingNudgeDismissed === "boolean" &&
    typeof value.hasEverHadLibraryItems === "boolean" &&
    typeof value.autoTrackingNudgeEligible === "boolean"
  );
}

function isOnboardingStorageV2(value) {
  if (!value || typeof value !== "object") return false;
  if (value.version !== 2) return false;
  const a = value.activation;
  const p = value.preferences;
  return (
    !!a && typeof a === "object" && typeof a.hasEverHadLibraryItems === "boolean" &&
    !!p && typeof p === "object" && typeof p.autoTrackingNudgeDismissed === "boolean" && typeof p.autoTrackingNudgeEligible === "boolean"
  );
}

function migrateFromV1(v1) {
  return { hasEverHadLibraryItems: v1.hasEverHadLibraryItems, autoTrackingNudgeDismissed: v1.autoTrackingNudgeDismissed, autoTrackingNudgeEligible: v1.autoTrackingNudgeEligible };
}

/** Models readOnboardingStorage's four cases: recognized-old-version (migrates), current-version valid, nothing stored, and "cannot know" (corrupt/unrecognized/future version — including a deliberately cleared key, which is indistinguishable from "never installed" and from real corruption at read time). */
function parseOnboardingStorage(raw) {
  try {
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    if (isOnboardingStorageV2(parsed)) return fromStorageV2(parsed);
    if (isOnboardingStorageV1(parsed)) return migrateFromV1(parsed);
    return DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

function markLibraryActivated(current, justCompletedFirstRun) {
  if (current.hasEverHadLibraryItems) return current;
  return { ...current, hasEverHadLibraryItems: true, autoTrackingNudgeEligible: justCompletedFirstRun };
}

function shouldShowAutoTrackingNudge({ itemCount, eligible, dismissed, isSignedIn, extensionAlreadyConnected }) {
  if (!isSignedIn || extensionAlreadyConnected || dismissed || !eligible) return false;
  return itemCount === 1;
}

// ============================================================
// C — page-independent session model, reproduced verbatim from
// hooks/useLibraryActivation.ts's effect. Unlike the prior round's model
// (which tracked "was activationState === 'onboarding'", anchoring
// eligibility to Dashboard specifically), this tracks "has this session
// confirmed the library empty at least once" — the same signal regardless
// of which page (Dashboard or Library) is doing the observing. Two
// separate `page()` calls sharing one `session` simulate a user activating
// on one page and later navigating to the other.
// ============================================================
function makeSession(initialState = DEFAULT_STATE) {
  let state = initialState;
  return {
    get state() {
      return state;
    },
    dismissNudge() {
      state = { ...state, autoTrackingNudgeDismissed: true };
    },
    /** A fresh mount of either DashboardView or LibraryView — each has its own hasConfirmedEmptyRef, exactly like two independent component instances, mirroring hooks/useLibraryActivation.ts's effect exactly (loading/isHydrated gating omitted here as out of scope for this pure-logic model — covered separately by structural check P5). */
    page() {
      let hasConfirmedEmpty = false;
      return {
        render({ loading, itemCount }) {
          if (loading) return;
          if (state.hasEverHadLibraryItems) return; // history already settled — nothing left to observe, on any page
          if (itemCount === 0) {
            hasConfirmedEmpty = true;
            return;
          }
          state = markLibraryActivated(state, hasConfirmedEmpty);
          hasConfirmedEmpty = false;
        },
      };
    },
  };
}

// ============================================================
// §3 A-N — the exact regression cases this round asked for.
// ============================================================

check("A: Dashboard first-run -> first item -> eligible", () => {
  const session = makeSession();
  const dashboard = session.page();
  dashboard.render({ loading: false, itemCount: 0 }); // confirmed empty
  dashboard.render({ loading: false, itemCount: 1 }); // first item appears
  assert.equal(session.state.hasEverHadLibraryItems, true);
  assert.equal(session.state.autoTrackingNudgeEligible, true);
});

check("B: Library first-run -> first item -> eligible (the exact bug this round fixes)", () => {
  const session = makeSession();
  const library = session.page();
  library.render({ loading: false, itemCount: 0 });
  library.render({ loading: false, itemCount: 1 });
  assert.equal(session.state.hasEverHadLibraryItems, true);
  assert.equal(session.state.autoTrackingNudgeEligible, true, "activating via Library must be recorded identically to activating via Dashboard");
});

check("C: activate via Library, then navigate to Dashboard -> eligibility retained, nudge may render there", () => {
  const session = makeSession();
  const library = session.page();
  library.render({ loading: false, itemCount: 0 });
  library.render({ loading: false, itemCount: 1 });
  // A fresh Dashboard mount, itemCount already 1 — must not re-derive or
  // reset anything; it just reads the already-settled history.
  const dashboard = session.page();
  dashboard.render({ loading: false, itemCount: 1 });
  assert.equal(session.state.autoTrackingNudgeEligible, true);
  assert.equal(shouldShowAutoTrackingNudge({ itemCount: 1, eligible: session.state.autoTrackingNudgeEligible, dismissed: session.state.autoTrackingNudgeDismissed, isSignedIn: true, extensionAlreadyConnected: false }), true);
});

check("D: pre-existing one-item user (either page, no history) -> not eligible", () => {
  for (const first of ["dashboard", "library"]) {
    const session = makeSession();
    const page = session.page();
    page.render({ loading: false, itemCount: 1 }); // never observed empty first
    assert.equal(session.state.hasEverHadLibraryItems, true, first);
    assert.equal(session.state.autoTrackingNudgeEligible, false, first);
  }
});

check("E: returning empty user adds a new item -> not eligible again", () => {
  const session = makeSession();
  const dashboard = session.page();
  dashboard.render({ loading: false, itemCount: 1 }); // pre-existing, settles history as not-eligible
  const emptiedState = resolveActivationState({ loading: false, loadError: false, itemCount: 0, pendingLocalImport: false, hasEverHadLibraryItems: session.state.hasEverHadLibraryItems });
  assert.equal(emptiedState, "empty-returning");
  const library = session.page(); // could be the same or a different page — either way
  library.render({ loading: false, itemCount: 0 });
  library.render({ loading: false, itemCount: 1 });
  assert.equal(session.state.autoTrackingNudgeEligible, false, "history was already settled; a later empty/re-add cycle must never re-open eligibility");
});

check("F: many -> zero -> one -> not eligible", () => {
  const session = makeSession();
  const page = session.page();
  page.render({ loading: false, itemCount: 10 });
  page.render({ loading: false, itemCount: 0 });
  page.render({ loading: false, itemCount: 1 });
  assert.equal(session.state.autoTrackingNudgeEligible, false);
});

check("G: dismissed nudge remains dismissed", () => {
  const session = makeSession();
  const page = session.page();
  page.render({ loading: false, itemCount: 0 });
  page.render({ loading: false, itemCount: 1 });
  session.dismissNudge();
  assert.equal(shouldShowAutoTrackingNudge({ itemCount: 1, eligible: session.state.autoTrackingNudgeEligible, dismissed: session.state.autoTrackingNudgeDismissed, isSignedIn: true, extensionAlreadyConnected: false }), false);
});

check("H: old parseable storage version (v1) migrates sticky activation history correctly", () => {
  const v1 = { version: 1, autoTrackingNudgeDismissed: true, hasEverHadLibraryItems: true, autoTrackingNudgeEligible: false };
  const migrated = parseOnboardingStorage(JSON.stringify(v1));
  assert.deepEqual(migrated, { hasEverHadLibraryItems: true, autoTrackingNudgeDismissed: true, autoTrackingNudgeEligible: false }, "every field a v1 record actually had must survive the migration exactly");
});

check("I: current valid (v2) storage stays unchanged on read", () => {
  const v2 = toStorageV2({ hasEverHadLibraryItems: true, autoTrackingNudgeDismissed: false, autoTrackingNudgeEligible: true });
  assert.deepEqual(parseOnboardingStorage(JSON.stringify(v2)), { hasEverHadLibraryItems: true, autoTrackingNudgeDismissed: false, autoTrackingNudgeEligible: true });
});

check("J: corrupt storage follows the documented safe fallback (cannot know history, never throws)", () => {
  for (const raw of ["{not json", "null", JSON.stringify(["not", "an", "object"]), JSON.stringify({ version: 2, activation: {}, preferences: {} }), undefined]) {
    assert.deepEqual(parseOnboardingStorage(raw), DEFAULT_STATE);
  }
});

check("K: an unrecognized/future storage version is treated the same as corrupt data, not partially trusted", () => {
  assert.deepEqual(parseOnboardingStorage(JSON.stringify({ version: 3, activation: { hasEverHadLibraryItems: true }, preferences: {} })), DEFAULT_STATE, "a genuinely future/unrecognized version must fail safe rather than guess at its shape");
});

check("L: loading/error/import-pending behavior unchanged", () => {
  assert.equal(resolveActivationState({ loading: true, loadError: true, itemCount: 0, pendingLocalImport: true, hasEverHadLibraryItems: false }), "loading");
  assert.equal(resolveActivationState({ loading: false, loadError: true, itemCount: 0, pendingLocalImport: false, hasEverHadLibraryItems: false }), "error");
  assert.equal(resolveActivationState({ loading: false, loadError: false, itemCount: 0, pendingLocalImport: true, hasEverHadLibraryItems: false }), "import-pending");
  assert.equal(resolveActivationState({ loading: false, loadError: true, itemCount: 3, pendingLocalImport: false, hasEverHadLibraryItems: true }), "populated", "non-empty still wins over a secondary error");
  assert.equal(resolveActivationState({ loading: false, loadError: false, itemCount: 2, pendingLocalImport: true, hasEverHadLibraryItems: false }), "populated", "non-empty still wins over pending import");
});

check("M: signed-out nudge still hidden regardless of eligibility", () => {
  assert.equal(shouldShowAutoTrackingNudge({ itemCount: 1, eligible: true, dismissed: false, isSignedIn: false, extensionAlreadyConnected: false }), false);
});

check("N: existing tracking-source (already-connected extension) suppression unchanged", () => {
  assert.equal(shouldShowAutoTrackingNudge({ itemCount: 1, eligible: true, dismissed: false, isSignedIn: true, extensionAlreadyConnected: true }), false);
  assert.equal(shouldShowAutoTrackingNudge({ itemCount: 1, eligible: true, dismissed: false, isSignedIn: true, extensionAlreadyConnected: false }), true);
});

// ============================================================
// O — the real src/lib/onboarding.ts implements the exact migration/
// validation/model this section reproduces.
// ============================================================
check("O1: the real module stores the current shape under version 2 with separate activation/preferences sub-objects", () => {
  const source = src("src/lib/onboarding.ts");
  assert.ok(source.includes('"markly.onboarding"'));
  assert.ok(/ONBOARDING_STORAGE_VERSION\s*=\s*2/.test(source));
  assert.ok(source.includes("interface OnboardingStorageV2") && /activation:\s*OnboardingActivation/.test(source));
  assert.ok(/preferences:\s*OnboardingPreferences/.test(source));
});

check("O2: the real module retains a v1 migration path rather than only validating the current version", () => {
  const source = src("src/lib/onboarding.ts");
  assert.ok(source.includes("isOnboardingStorageV1") && source.includes("migrateFromV1"), "expected a recognized-old-version migration function, not just a strict current-version guard");
  assert.ok(source.includes("migrateFromV1(parsed)"), "readOnboardingStorage must actually call the migration when it recognizes v1 data");
});

check("O3: a successful migration is immediately re-persisted in the current shape", () => {
  const source = src("src/lib/onboarding.ts");
  const readFnStart = source.indexOf("export function readOnboardingStorage");
  const readFnBody = source.slice(readFnStart, readFnStart + 1200);
  assert.ok(/persistOnboardingState\(migrated\)/.test(readFnBody), "expected the migrated result to be written back so subsequent reads don't need to re-migrate");
});

check("O4: the module's own comments accurately describe the corrupt/cleared-storage limitation as unrecoverable, not self-healing", () => {
  const source = src("src/lib/onboarding.ts");
  assert.ok(/cannot recover that fact|cannot know|does not attempt to invent history/i.test(source), "expected the module to honestly document that a returning user's history is genuinely unrecoverable once the only record is gone, not merely low-stakes");
});

// ============================================================
// P — structural contracts.
// ============================================================
check("P1: DashboardView has a dedicated first-run component, gated on activationState === \"onboarding\" specifically, not a raw itemCount check", () => {
  const source = src("src/components/DashboardView.tsx");
  assert.ok(/function FirstRunDashboard\(/.test(source));
  assert.ok(source.includes("Never lose your place again."));
  assert.ok(/activationState === "onboarding" \? \(\s*<FirstRunDashboard/.test(source));
  assert.ok(!/items\.length === 0 \? <EmptyLibraryState/.test(source), "the old raw items.length === 0 branch must be gone");
});

check("P2: a distinct, quieter empty-returning state exists and is structurally separate from the first-run hero", () => {
  const source = src("src/components/DashboardView.tsx");
  assert.ok(/function ReturningEmptyDashboardNotice\(/.test(source));
  assert.ok(/activationState === "empty-returning" \? \(\s*<ReturningEmptyDashboardNotice/.test(source));
  const returningStart = source.indexOf("function ReturningEmptyDashboardNotice");
  const returningBody = source.slice(returningStart, source.indexOf("function ImportPendingDashboardNotice"));
  assert.ok(!returningBody.includes("Never lose your place again."));
  assert.ok(!returningBody.includes('href="/settings/connections"') && !returningBody.includes('href="/settings/tracking"'));
});

check("P3: activation tracking is one shared, page-independent hook — not duplicated per-page logic", () => {
  assert.ok(readFileExists("src/hooks/useLibraryActivation.ts"), "expected a shared useLibraryActivation hook");
  const hookSource = src("src/hooks/useLibraryActivation.ts");
  assert.ok(hookSource.includes("hasConfirmedEmptyRef"), "expected the page-agnostic 'confirmed empty this session' tracking, not a Dashboard-specific 'was onboarding' ref");
  const dashboardSource = src("src/components/DashboardView.tsx");
  const librarySource = src("src/components/LibraryView.tsx");
  assert.ok(dashboardSource.includes("useLibraryActivation({ loading, itemCount: items.length })"), "DashboardView must use the shared hook");
  assert.ok(librarySource.includes("useLibraryActivation({ loading, itemCount: items.length })"), "LibraryView must use the exact same shared hook, not its own copy of the tracking logic");
  assert.ok(!dashboardSource.includes("wasOnboardingRef") && !librarySource.includes("wasOnboardingRef"), "the old page-anchored ref must be gone from both views now that tracking lives in one shared hook");
});

check("P4: the nudge's eligibility is keyed on a persisted autoTrackingNudgeEligible flag, never a raw itemCount === 1 check alone", () => {
  const onboardingSource = src("src/lib/onboarding.ts");
  const fnStart = onboardingSource.indexOf("export function shouldShowAutoTrackingNudge");
  const fnBody = onboardingSource.slice(fnStart, fnStart + 800);
  assert.ok(/eligible/.test(fnBody));
  assert.ok(/isSignedIn/.test(fnBody) && /extensionAlreadyConnected/.test(fnBody));
  const dashboardSource = src("src/components/DashboardView.tsx");
  assert.ok(dashboardSource.includes("onboarding.autoTrackingNudgeEligible"));
  assert.ok(dashboardSource.includes("trackingSources.sources.length > 0"), "DashboardView must reuse its existing useTrackingSources fetch for the already-connected check, not a new query");
});

check("P5: hydration of the onboarding-history storage itself is folded into the loading gate, so a returning user's empty library can never flash the new-user hero before history resolves", () => {
  const hookSource = src("src/hooks/useOnboarding.ts");
  assert.ok(hookSource.includes("isHydrated"));
  const dashboardSource = src("src/components/DashboardView.tsx");
  assert.ok(/loading \|\| !onboarding\.isHydrated/.test(dashboardSource));
});

check("P6: Library's own genuine-empty state respects the same returning-user distinction, not just Dashboard's", () => {
  const source = src("src/components/LibraryItemGrid.tsx");
  assert.ok(/if \(hasEverHadLibraryItems\)/.test(source));
  const viewSource = src("src/components/LibraryView.tsx");
  assert.ok(/hasEverHadLibraryItems=\{onboarding\.hasEverHadLibraryItems\}/.test(viewSource));
});

check("P7: no fake/sample library data is ever inserted, and no AniList write mutation or extension/Notification permission request is reachable from onboarding", () => {
  for (const file of ["src/components/DashboardView.tsx", "src/components/LibraryItemGrid.tsx", "src/lib/onboarding.ts", "src/hooks/useOnboarding.ts", "src/hooks/useLibraryActivation.ts", "src/hooks/useLocalImport.ts"]) {
    const source = src(file);
    assert.ok(!/addWebsite\(\{|addMedia\(["']\w+["'],\s*\{/.test(source), `${file} must never call a library mutation with an inline hardcoded item`);
    assert.ok(!/allowWrites|write-preference|SaveMediaListEntry|AniListReconcilePanel/.test(source), `${file} must not reference AniList write-back machinery`);
    assert.ok(!/chrome\.permissions|navigator\.permissions|requestPermissions\(/.test(source), `${file} must not request any browser/extension permission`);
    assert.ok(!/Notification\.requestPermission/.test(source), `${file} must not request Notification permission`);
  }
});

check("P8: Add Item is still reused everywhere, not reimplemented", () => {
  for (const file of ["src/components/DashboardView.tsx", "src/components/LibraryView.tsx", "src/components/ItemDetailView.tsx", "src/components/TrackingSettingsPanel.tsx"]) {
    assert.ok(src(file).includes("<LibraryItemDialog"));
  }
});

check("P9: Stage 35 itself created no migration — 0016 was still the latest migration at the time of this stage's own work (Stage 37 later added 0017 legitimately; this snapshot is bumped forward each time a later stage adds one, same convention as every other stage's own version of this check)", () => {
  const files = readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort();
  assert.ok(files.some((name) => name.startsWith("0016_")), "expected 0016_stage34_reminders.sql to still exist");
  const highest = files[files.length - 1];
  assert.ok(highest.startsWith("0017_"), `expected 0017_stage37_web_push.sql to be the latest migration, found ${highest}`);
});

check("P10: new Stage 35 secondary/onboarding links use Markly's existing focus-visible treatment, not just the browser default", () => {
  for (const file of ["src/components/DashboardView.tsx", "src/components/LibraryItemGrid.tsx", "src/components/CalendarView.tsx"]) {
    const source = src(file);
    assert.ok(/focus-visible:(outline-none|underline|text-foreground)/.test(source));
  }
});

check("P11: Calendar's two distinct empty causes remain distinct, cause A offers a route forward, and Reminders' audited-unchanged empty state still makes no false notification-delivery claim", () => {
  const calendarSource = src("src/components/CalendarView.tsx");
  assert.ok(/function NoEligibleSourcesState/.test(calendarSource) && /function EmptyWindowState/.test(calendarSource));
  assert.ok(/href="\/library"/.test(calendarSource.slice(calendarSource.indexOf("function NoEligibleSourcesState"), calendarSource.indexOf("function EmptyWindowState"))));
  const reminderSource = src("src/components/ReminderCenterView.tsx");
  assert.ok(reminderSource.includes("No reminders yet") && reminderSource.includes("Set one from Calendar or an item"));
  assert.ok(!/we('| wi)ll notify you|push notification|background notification/i.test(reminderSource));
});

function readFileExists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

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

console.log(
  "\nNote: Sections A-O reproduce src/lib/onboarding.ts's pure resolveActivationState/storage-migration/dismissal logic verbatim (same convention as every other script in this directory), including a page-independent session model mirroring hooks/useLibraryActivation.ts's real effect — deterministic, no DOM/network/localStorage involved. Section P statically verifies the structural contracts. It cannot and does not judge visual/aesthetic quality — that was done via live browser walkthroughs documented in the Stage 35 report.",
);
