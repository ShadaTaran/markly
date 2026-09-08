#!/usr/bin/env node
// Verifies the "UI/UX Quality Pass" stage: deterministic invariants only —
// this script cannot and does not judge aesthetics. Same convention as
// every other script in this directory: plain .mjs, no TypeScript loader,
// check(name, fn) collecting results, a final pass/fail report.
//
// Run with: node scripts/verify-ui-quality.mjs

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

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
// A — Shared primitives exist (extracted from confirmed real repetition —
// see the Phase 0 report; not speculative abstraction).
// ============================================================
const SHARED_PRIMITIVES = [
  "src/components/PageContainer.tsx",
  "src/components/Button.tsx",
  "src/components/IconButton.tsx",
  "src/components/LibraryGridSkeleton.tsx",
];
for (const file of SHARED_PRIMITIVES) {
  check(`A: shared primitive exists — ${file}`, () => {
    assert.ok(existsSync(file), `expected ${file} to exist`);
  });
}

check("A: IconButton's aria-label prop is required, not optional (the whole point of the primitive)", () => {
  const source = src("src/components/IconButton.tsx");
  assert.ok(source.includes('"aria-label": string;'), "aria-label must be typed as a required string, not `aria-label?: string`");
  assert.ok(!source.includes('"aria-label"?: string'), "aria-label must never become optional");
});

check("A: Button exposes a narrow variant enum, not a giant prop bag", () => {
  const source = src("src/components/Button.tsx");
  const variants = source.match(/export type ButtonVariant = ([^;]+);/)?.[1] ?? "";
  const count = variants.split("|").length;
  assert.ok(count >= 3 && count <= 6, `expected a small, deliberate variant set (3-6), found ${count}: ${variants}`);
});

// ============================================================
// B — Icon-only buttons built on the shared primitive always carry a label.
// Every <IconButton ...> tag in the codebase is extracted and checked for
// an aria-label attribute right there in its own props — this is the
// concrete, targeted "icon-only actions have accessible labels" the brief
// asks for, not a claim that every historical one-off icon button
// (untouched by this pass) was re-verified.
// ============================================================
function findIconButtonTags(source) {
  const tags = [];
  const regex = /<IconButton\b[\s\S]*?\/>/g;
  let match;
  while ((match = regex.exec(source))) tags.push(match[0]);
  return tags;
}

const FILES_USING_ICON_BUTTON = [
  "src/components/ItemDetailView.tsx",
  "src/components/MediaItemCard.tsx",
  "src/components/WebsiteItemCard.tsx",
  "src/components/Dialog.tsx",
  "src/components/SearchBar.tsx",
  "src/components/ItemActionsMenu.tsx",
];
check("B: every <IconButton> usage carries an aria-label", () => {
  let total = 0;
  for (const file of FILES_USING_ICON_BUTTON) {
    const source = src(file);
    const tags = findIconButtonTags(source);
    for (const tag of tags) {
      assert.ok(/aria-label=/.test(tag), `${file} has an <IconButton> with no aria-label:\n${tag}`);
      total += 1;
    }
  }
  assert.ok(total >= FILES_USING_ICON_BUTTON.length, `expected at least one <IconButton> per listed file, found ${total} total`);
});

// ============================================================
// C — Motion: prefers-reduced-motion is respected; no broad `transition-all`
// introduced (a targeted, specific transition is fine; "all" invites
// animating properties no one intended, e.g. layout-shifting ones).
// ============================================================
check("C: globals.css still respects prefers-reduced-motion for the dialog animation", () => {
  const source = src("src/app/globals.css");
  assert.ok(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(source));
});

check("C: ThemeToggle's circular reveal still explicitly checks prefers-reduced-motion before animating (preserved, not replaced)", () => {
  const source = src("src/components/ThemeToggle.tsx");
  assert.ok(source.includes("prefers-reduced-motion"));
  assert.ok(source.includes("startViewTransition"), "the existing View Transition circular reveal must still be present, not replaced");
});

check("C: no `transition-all` introduced in any component this pass touched", () => {
  const files = [
    "src/components/PageContainer.tsx",
    "src/components/Button.tsx",
    "src/components/IconButton.tsx",
    "src/components/LibraryGridSkeleton.tsx",
    "src/components/LibraryView.tsx",
    "src/components/DashboardView.tsx",
    "src/components/ItemDetailView.tsx",
    "src/components/MediaItemCard.tsx",
    "src/components/WebsiteItemCard.tsx",
    "src/components/Dialog.tsx",
    "src/components/ConfirmDialog.tsx",
    "src/components/DeleteLibraryItemDialog.tsx",
    "src/components/CollectionDialog.tsx",
    "src/components/EmptyState.tsx",
    "src/components/DuplicateMergeDialog.tsx",
    "src/components/RemindMeContinueDialog.tsx",
    "src/components/RemindMeReleaseDialog.tsx",
    "src/components/DeleteSmartViewDialog.tsx",
    "src/components/SaveSmartViewDialog.tsx",
    "src/components/DeleteCollectionDialog.tsx",
    "src/components/MediaItemForm.tsx",
    "src/components/WebsiteItemForm.tsx",
    "src/components/CatalogTrackingForm.tsx",
    "src/components/MetadataSearchPanel.tsx",
    "src/components/BackupSettingsPanel.tsx",
    "src/components/Header.tsx",
    "src/components/ConnectionsPanel.tsx",
    "src/components/TrackingSettingsPanel.tsx",
    "src/components/AuthForm.tsx",
    "src/components/CollectionMembershipDialog.tsx",
    "src/components/ImportBanner.tsx",
    "src/components/Logo.tsx",
    "src/components/Switch.tsx",
    "src/components/CalendarView.tsx",
    "src/components/ReminderCenterView.tsx",
    "src/components/RecentRecoveryPanel.tsx",
    "src/components/SettingsShell.tsx",
  ];
  for (const file of files) {
    assert.ok(!src(file).includes("transition-all"), `${file} must not use the broad transition-all utility`);
  }
});

check("C: the new skeleton's pulse animation is motion-safe (respects prefers-reduced-motion via Tailwind's own variant, not custom CSS)", () => {
  const source = src("src/components/LibraryGridSkeleton.tsx");
  assert.ok(source.includes("motion-safe:animate-pulse"), "the skeleton's pulse must be gated behind motion-safe:, never a bare animate-pulse");
});

// ============================================================
// D — No arbitrary raw colors introduced outside the existing token system
// (--background/--foreground/--surface/--border/--muted/--accent/--danger
// and their Tailwind color-* mappings) in the files this pass touched.
// ============================================================
check("D: no raw hex/rgb colors introduced in touched components (token system only)", () => {
  const files = [
    "src/components/PageContainer.tsx",
    "src/components/Button.tsx",
    "src/components/IconButton.tsx",
    "src/components/LibraryGridSkeleton.tsx",
    "src/components/Logo.tsx",
    "src/components/Switch.tsx",
  ];
  const forbidden = /#[0-9a-fA-F]{3,8}\b|rgb\(|rgba\(/;
  for (const file of files) {
    assert.ok(!forbidden.test(src(file)), `${file} must use the existing design tokens, not a raw color literal`);
  }
});

// ============================================================
// E — Responsive invariant: LibraryView's filter disclosure collapses the
// Collection/Type/Status/Category quick-tabs AND the advanced filter panel
// behind ONE "Filters" toggle on every breakpoint (round 2 — previously
// this was mobile-only via a `sm:block` override forcing them always-open
// on desktop, which is exactly what round 2 removed).
// ============================================================
check("E: LibraryView's filter controls collapse behind one Filters toggle on every breakpoint (no sm:block override)", () => {
  const source = src("src/components/LibraryView.tsx");
  assert.ok(!/showFiltersPanel \? "block" : "hidden"/.test(source), "round 2 removed the CSS class show/hide toggle in favor of conditional rendering");
  assert.ok(!/"sm:block"/.test(source), "the quick-filter tabs must not force always-visible above sm: anymore — they share the same disclosure as the advanced panel on every breakpoint");
  assert.ok(/\{showFiltersPanel && \(/.test(source), "expected the filter controls to be conditionally rendered, gated on showFiltersPanel");
  assert.ok(source.includes("LibraryFiltersPanel"), "expected the advanced filter panel to still be present, grouped under the same disclosure");
});

// ============================================================
// H — Round 2: the import banner is no longer permanent global chrome
// mounted above every page's Header (layout.tsx), and its dismissal
// actually persists (not just in-memory React state that resets on
// reload) — the two concrete defects named in the round-2 brief.
// ============================================================
check("H: layout.tsx no longer mounts ImportBanner above every page's own Header", () => {
  const source = src("src/app/layout.tsx");
  assert.ok(!source.includes("ImportBanner"), "ImportBanner must be rendered by each page under its own Header, not globally in the root layout");
});

const PAGES_RENDERING_IMPORT_BANNER = [
  "src/components/DashboardView.tsx",
  "src/components/LibraryView.tsx",
  "src/components/CalendarView.tsx",
  "src/components/ReminderCenterView.tsx",
];
check("H: every top-level page still renders ImportBanner directly under its own Header", () => {
  for (const file of PAGES_RENDERING_IMPORT_BANNER) {
    const source = src(file);
    assert.ok(/<Header[\s\S]*?\/>\s*<ImportBanner \/>/.test(source), `${file} must render <ImportBanner /> immediately after its <Header />`);
  }
});

check("H: the import notice's dismissal persists across reloads (localStorage), not just in-memory state", () => {
  const source = src("src/hooks/useLocalImport.ts");
  assert.ok(source.includes("localStorage"), "dismiss() must persist so \"Not now\" doesn't resurface the banner on every visit");
  assert.ok(source.includes("hasPendingImport"), "expected a dismissal-independent flag so Settings > Data & Backup can still offer the import later");
});

check("H: the Markly mark is one shared Logo component, not a hand-copied \"M\" square in multiple files", () => {
  assert.ok(existsSync("src/components/Logo.tsx"), "expected src/components/Logo.tsx to exist");
  for (const file of ["src/components/Header.tsx", "src/app/login/page.tsx", "src/app/signup/page.tsx"]) {
    assert.ok(src(file).includes("<Logo"), `${file} must use the shared Logo component`);
  }
  // Round 8: SettingsShell no longer renders <Logo directly — it renders
  // the shared SecondaryPageHeader, which itself uses <Logo (see the
  // dedicated round-8 check below). Still one shared Logo, just one more
  // layer of composition, not a regression back to a hand-copied mark.
  assert.ok(src("src/components/SettingsShell.tsx").includes("<SecondaryPageHeader"), "SettingsShell must render the shared SecondaryPageHeader (which itself uses <Logo)");
  assert.ok(src("src/components/SecondaryPageHeader.tsx").includes("<Logo"), "SecondaryPageHeader must use the shared Logo component");
});

// ============================================================
// I — Round 2: on/off preferences use one shared, accessible Switch
// component — not a native checkbox in one place and a hand-rolled
// role="switch" button in another (the concrete inconsistency named in
// the round-2 brief between Auto Tracking and Connections).
// ============================================================
check("I: Switch is a shared component used by both Auto Tracking and Connections", () => {
  assert.ok(existsSync("src/components/Switch.tsx"), "expected src/components/Switch.tsx to exist");
  const trackingSource = src("src/components/TrackingSettingsPanel.tsx");
  const connectionsSource = src("src/components/ConnectionsPanel.tsx");
  assert.ok(trackingSource.includes("<Switch"), "TrackingSettingsPanel must use the shared Switch");
  assert.ok(connectionsSource.includes("<Switch"), "ConnectionsPanel must use the shared Switch for the AniList write-permission toggle");
  assert.ok(
    /Allow Markly to update AniList[\s\S]{0,400}<Switch/.test(connectionsSource),
    "the AniList write-permission control specifically must be the shared Switch, not a native checkbox (the file's unrelated anime/manga preview checkboxes are a separate, legitimate multi-select and are untouched)",
  );
});

// ============================================================
// J — Round 2: touch targets. IconButton's padding was bumped so its
// clickable box is meaningfully larger than round 1's p-2 (measured live
// at ~34-36px) — this checks the padding utility itself, not a rendered
// pixel size (that was confirmed via live measurement, see the Stage
// report), since a static check can't compute box-model math reliably.
// ============================================================
check("J: IconButton's hit area was enlarged from round 1's p-2", () => {
  const source = src("src/components/IconButton.tsx");
  assert.ok(source.includes("p-2.5"), "expected IconButton's padding to be bumped from p-2 to p-2.5 for a larger touch target");
});

check("J: the Switch control meets the 24x24 CSS px minimum (WCAG 2.2 SC 2.5.8) via an h-6 w-10 track, not the smaller h-5 w-9 it was extracted from", () => {
  const source = src("src/components/Switch.tsx");
  assert.ok(source.includes("h-6 w-10"), "expected the Switch's track to be at least h-6 (24px) tall");
});

// ============================================================
// F — No forbidden UI libraries were added — this pass must use only the
// dependencies already present (plain CSS/Tailwind/native APIs).
// ============================================================
check("F: no new UI/animation/icon library dependency was added", () => {
  const pkg = JSON.parse(src("package.json"));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const forbidden = ["framer-motion", "gsap", "@radix-ui", "shadcn", "@heroicons", "react-icons", "lucide-react", "@emotion", "styled-components", "@mui", "antd", "chart.js", "recharts", "d3"];
  for (const name of forbidden) {
    assert.ok(!(name in allDeps), `unexpected new dependency: ${name}`);
  }
  const knownDeps = ["@supabase/ssr", "@supabase/supabase-js", "next", "react", "react-dom", "server-only"];
  const knownDevDeps = ["@tailwindcss/postcss", "@types/chrome", "@types/node", "@types/react", "@types/react-dom", "esbuild", "eslint", "eslint-config-next", "tailwindcss", "typescript"];
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    assert.ok(knownDeps.includes(name), `unexpected new runtime dependency: ${name}`);
  }
  for (const name of Object.keys(pkg.devDependencies ?? {})) {
    assert.ok(knownDevDeps.includes(name), `unexpected new dev dependency: ${name}`);
  }
});

// ============================================================
// G — No accidental business-logic change: this is a UI/UX pass, so the
// pure-logic modules governing tracking/Smart Views/merge/recovery/backup/
// AniList reconciliation/extension behavior must still export exactly the
// same public surface they did before. A narrow, targeted spot-check
// (their own dedicated verify-*.mjs scripts are the real authority — this
// just guards against this stage having touched them at all).
// ============================================================
const UNTOUCHED_LOGIC_FILES = [
  "src/lib/smart-views.ts",
  "src/lib/tracking.ts",
  "src/lib/library-merge.ts",
  "src/lib/recovery-orchestration.ts",
  "src/lib/library-recovery.ts",
  "src/lib/duplicate-detection.ts",
  "src/lib/reminders.ts",
  "src/lib/backup/validate.ts",
  "src/lib/integrations/anilist/client.ts",
  "src/lib/integrations/anilist/reconciliation.ts",
];
check("G: business-logic modules exist and were not touched by this UI pass (spot-check — the real authority is each module's own verify-*.mjs)", () => {
  for (const file of UNTOUCHED_LOGIC_FILES) {
    assert.ok(existsSync(file), `expected ${file} to still exist untouched`);
  }
});

check("G: no component file in this pass imports a business-logic module it didn't already depend on for data (PageContainer/Button/IconButton/LibraryGridSkeleton/Logo/Switch are presentation-only)", () => {
  const presentationOnly = [
    "src/components/PageContainer.tsx",
    "src/components/Button.tsx",
    "src/components/IconButton.tsx",
    "src/components/LibraryGridSkeleton.tsx",
    "src/components/Logo.tsx",
    "src/components/Switch.tsx",
  ];
  for (const file of presentationOnly) {
    const source = src(file);
    assert.ok(!/from "@\/lib\/(?!utils)/.test(source), `${file} must stay presentation-only — found an import from a business-logic lib module`);
  }
});

// ============================================================
// K — Round 3 (10/10 polish pass): a restrained, repeated identity system.
// Progress fill and "selected/current" indicators use the accent token
// consistently across Header nav, Library filter tabs, Smart Views,
// Settings tabs, and Calendar's range selector — the concrete "recognizable
// consistency" the round-3 brief asked for, not a claim about anything
// subjective (color choice, spacing feel).
// ============================================================
check("K: ProgressBar's fill uses the accent token (shared by Library cards, Dashboard Continue, and Item Detail)", () => {
  const source = src("src/components/ProgressBar.tsx");
  assert.ok(source.includes("bg-accent"), "expected the progress fill to use bg-accent, establishing one repeated progress color across the app");
});

const ACCENT_SELECTED_STATE_FILES = [
  "src/components/Header.tsx",
  "src/components/LibraryFiltersPanel.tsx",
  "src/components/SmartViewsBar.tsx",
  "src/components/SettingsShell.tsx",
  "src/components/CalendarView.tsx",
];
check("K: selected/current-page indicators use the accent token consistently across Header, Library filters, Smart Views, Settings tabs, and Calendar's range selector", () => {
  for (const file of ACCENT_SELECTED_STATE_FILES) {
    const source = src(file);
    assert.ok(/border-accent|bg-accent|text-accent/.test(source), `${file} must mark its active/selected state with the accent token`);
  }
});

check("K: Library's card grid doesn't stretch sparse cards to match their tallest row-mate (items-start, not the CSS Grid default stretch)", () => {
  const source = src("src/components/LibraryItemGrid.tsx");
  assert.ok(/className="grid[^"]*items-start/.test(source), "expected the grid container to include items-start so card height stays intrinsic to its own content");
});

check("K: cover fallback backgrounds are consistent (bg-muted) between Library cards and Item Detail", () => {
  assert.ok(src("src/components/ItemCover.tsx").includes("bg-muted"), "ItemCover's fallback must use bg-muted, matching MediaItemCard's fallback");
  assert.ok(src("src/components/ItemDetailView.tsx").includes("bg-muted"), "ItemDetailView's website-item cover fallback must use bg-muted too");
});

// ============================================================
// L — Round 4 (final visual gaps pass).
// ============================================================
check("L: EmptyState no longer uses the oversized dashed-border placeholder treatment", () => {
  const source = src("src/components/EmptyState.tsx");
  assert.ok(!source.includes("border-dashed"), "the dashed-border box was identified as looking like a generic placeholder and must be gone");
  assert.ok(!source.includes("py-20"), "the oversized vertical padding must be reduced");
});

check("L: MediaItemCard no longer renders description text (Library cards are for scanning; Item Detail is for full information)", () => {
  const source = src("src/components/MediaItemCard.tsx");
  assert.ok(!/\bdescription\b/.test(source), "MediaItemCard must not destructure or render item.description anymore");
});

check("L: Library card tag caps stay small (a very small number, not a large one)", () => {
  for (const file of ["src/components/MediaItemCard.tsx", "src/components/WebsiteItemCard.tsx"]) {
    const source = src(file);
    const match = source.match(/TAG_DISPLAY_LIMIT = (\d+)/);
    assert.ok(match, `${file} must define TAG_DISPLAY_LIMIT`);
    assert.ok(Number(match[1]) <= 3, `${file}'s tag cap should be a small number (<=3), found ${match[1]}`);
  }
});

check("L: Item Detail deduplicates tags against genres at render time without mutating stored data", () => {
  const source = src("src/components/ItemDetailView.tsx");
  assert.ok(source.includes("distinctTags"), "expected a display-only distinctTags computation");
  assert.ok(!/item\.tags\s*=/.test(source), "must never assign/mutate item.tags — dedup is display-only");
});

check("L: async buttons with a label that changes length while busy have a stable min-width (no button-width jump)", () => {
  const files = [
    "src/components/BackupSettingsPanel.tsx",
    "src/components/ConnectionsPanel.tsx",
    "src/components/TrackingSettingsPanel.tsx",
    "src/components/DuplicateMergeDialog.tsx",
    "src/components/RemindMeContinueDialog.tsx",
    "src/components/RemindMeReleaseDialog.tsx",
  ];
  for (const file of files) {
    assert.ok(/min-w-\d/.test(src(file)), `${file} must have at least one min-width-stabilized async button`);
  }
});

check("L: Dashboard and Item Detail have layout-preserving loading states (both previously jumped from near-blank to a full multi-section layout)", () => {
  assert.ok(existsSync("src/components/DashboardSkeleton.tsx"), "expected src/components/DashboardSkeleton.tsx to exist");
  assert.ok(existsSync("src/components/ItemDetailSkeleton.tsx"), "expected src/components/ItemDetailSkeleton.tsx to exist");
  assert.ok(src("src/components/DashboardView.tsx").includes("<DashboardSkeleton"), "DashboardView must render DashboardSkeleton while loading");
  assert.ok(src("src/components/ItemDetailView.tsx").includes("<ItemDetailSkeleton"), "ItemDetailView must render ItemDetailSkeleton while loading");
});

check("L: no interactive element uses a non-semantic <div onClick> (keyboard-inaccessible by construction)", () => {
  const glob = readFileSync("src/components/MediaItemCard.tsx", "utf8"); // spot representative — full sweep done via Grep during the review, see the Stage report
  assert.ok(!/<div[^>]*onClick/.test(glob), "interactive elements must be real <button>/<a>, never a clickable <div>");
});

// ============================================================
// M — Round 5 (final visual gaps): the open Library filter panel must
// expose exactly ONE control per filter dimension. Type/Status/Collection
// used to appear as both a single-select quick-tab row AND
// LibraryFiltersPanel's multi-select checkboxes for the same
// currentDefinition fields — two widgets, one truth. Category has no
// panel equivalent (Stage 31's SmartViewDefinition schema excludes it by
// design) so it correctly stays as the one quick-tab row left standing.
// ============================================================
check("M: LibraryView no longer renders duplicate Type/Status/Collection quick-tabs alongside the open advanced filter panel", () => {
  const source = src("src/components/LibraryView.tsx");
  assert.ok(!source.includes("CollectionFilterBar"), "the Collection quick-tab row must be gone — Collection is now only filterable via LibraryFiltersPanel's checkboxes");
  assert.ok(!/FilterTabGroup label="Type"/.test(source), "the Type quick-tab row must be gone — Media Type is now only filterable via LibraryFiltersPanel's checkboxes");
  assert.ok(!/FilterTabGroup label="Status"/.test(source), "the Status quick-tab row must be gone — Status is now only filterable via LibraryFiltersPanel's checkboxes");
});

check("M: the orphaned CollectionFilterBar component was removed, not left as dead code", () => {
  assert.ok(!existsSync("src/components/CollectionFilterBar.tsx"), "CollectionFilterBar.tsx has no remaining importers and should not be left behind");
});

check("M: LibraryFiltersPanel preserves collection creation (moved from the removed quick-tab row) and uses the accent token for checked controls", () => {
  const source = src("src/components/LibraryFiltersPanel.tsx");
  assert.ok(source.includes("onCreateCollection"), "the \"New Collection\" affordance must still exist somewhere in the panel");
  assert.ok(source.includes("accent-accent"), "checkboxes/radios must render their checked state in the accent color, not the browser default");
  assert.ok(/focus-visible:ring/.test(source), "checkboxes/radios must have a visible custom focus ring consistent with the rest of the app");
});

check("M: Dashboard's Stalled section renders nothing at all when there's nothing stalled (no heading, no stray \"View all\")", () => {
  const source = src("src/components/DashboardView.tsx");
  assert.ok(/if \(items\.length === 0 && !activityError\) return null;/.test(source), "an empty Stalled section must return null, not a loose one-line notice");
});

check("M: the per-device Auto-add switch has a visible inline label (not just an aria-label)", () => {
  const source = src("src/components/TrackingSettingsPanel.tsx");
  assert.ok(/<span className="text-xs text-muted-foreground">Auto-add<\/span>/.test(source), "expected a visible \"Auto-add\" text label next to each device's Switch");
});

check("M: linked tracked-source rows move Disable/Unlink behind an overflow menu, keeping Open Source as the one inline action", () => {
  const source = src("src/components/TrackingSettingsPanel.tsx");
  assert.ok(source.includes("SourceActionsMenu"), "expected a SourceActionsMenu component used by the linked-source row");
  assert.ok(!/>\s*\{busy === `toggle-\$\{source\.id\}` \? "Updating…" : source\.autoTrackEnabled \? "Disable" : "Enable"\}\s*<\/button>/.test(source), "Disable/Enable must no longer be an inline text button on the row itself");
});

// ============================================================
// N — Round 6 (product-design fixes): Library view modes, filter
// composition, and Dashboard's compact overview. Deterministic invariants
// only — none of this asserts subjective styling.
// ============================================================
check("N: exactly three supported Library view modes (grid, compact, list)", () => {
  const source = src("src/hooks/useLibraryViewMode.ts");
  const match = source.match(/LIBRARY_VIEW_MODES = \[([^\]]+)\]/);
  assert.ok(match, "expected a LIBRARY_VIEW_MODES constant");
  const modes = match[1].match(/"(\w+)"/g)?.map((m) => m.replace(/"/g, "")) ?? [];
  assert.deepStrictEqual(modes.sort(), ["compact", "grid", "list"], `expected exactly grid/compact/list, found: ${modes.join(", ")}`);
});

check("N: an invalid/malformed stored view mode falls back to grid, not a crash or an unknown mode", () => {
  const source = src("src/hooks/useLibraryViewMode.ts");
  assert.ok(source.includes("DEFAULT_VIEW_MODE: LibraryViewMode = \"grid\""), "expected grid as the explicit, named fallback default");
  assert.ok(/isLibraryViewMode\(stored\) \? stored : DEFAULT_VIEW_MODE/.test(source), "an unrecognized stored value must fall back to the default, not be trusted as-is");
});

check("N: the view mode is a local UI preference, never sent through Stage 29's backup format", () => {
  const hookSource = src("src/hooks/useLibraryViewMode.ts");
  assert.ok(hookSource.includes("localStorage"), "expected localStorage persistence, not a network/cloud write");
  const backupSource = src("src/lib/backup/export.ts");
  assert.ok(!backupSource.includes("viewMode") && !backupSource.includes("LIBRARY_VIEW_MODES"), "the backup export format must not reference the view-mode preference");
});

check("N: LibraryItemGrid renders exactly one view mode's markup at a time (no hidden duplicate render of the other two modes)", () => {
  const source = src("src/components/LibraryItemGrid.tsx");
  assert.ok(/if \(viewMode === "list"\)/.test(source) && /if \(viewMode === "compact"\)/.test(source), "expected early-return branches per mode, not three simultaneously-mounted trees");
});

check("N: Grid mode's media card still renders no description text (the round-4 invariant, re-confirmed after the round-6 rewrite)", () => {
  assert.ok(!/\bdescription\b/.test(src("src/components/MediaItemCard.tsx")), "MediaItemCard must not destructure or render item.description");
});

check("N: Media Type and Status stay real multi-select checkbox groups (tiles/chips are a visual composition over <input type=\"checkbox\">, not a rewrite of the semantics)", () => {
  const source = src("src/components/LibraryFiltersPanel.tsx");
  const mediaTypeStart = source.indexOf(">Media Type<");
  const statusStart = source.indexOf(">Status<");
  const favoriteStart = source.indexOf(">Favorite<");
  assert.ok(mediaTypeStart !== -1 && statusStart !== -1 && favoriteStart !== -1 && mediaTypeStart < statusStart && statusStart < favoriteStart, "expected Media Type, then Status, then Favorite legends in that order");
  const mediaTypeSection = source.slice(mediaTypeStart, statusStart);
  const statusSection = source.slice(statusStart, favoriteStart);
  assert.ok(mediaTypeSection.includes('type="checkbox"'), "Media Type tiles must be backed by real checkbox inputs");
  assert.ok(statusSection.includes('type="checkbox"'), "Status chips must be backed by real checkbox inputs");
  assert.ok(source.includes("toggleMediaType") && source.includes("toggleStatus"), "both must still support selecting more than one value at once");
});

check("N: Favorite stays a mutually-exclusive radio group (Any/Favorites/Not favorite), not converted to independent checkboxes", () => {
  const source = src("src/components/LibraryFiltersPanel.tsx");
  const favoriteStart = source.indexOf(">Favorite<");
  const categoryStart = source.indexOf(">Category<");
  assert.ok(favoriteStart !== -1 && categoryStart !== -1 && favoriteStart < categoryStart, "expected Favorite's legend before Category's");
  const favoriteSection = source.slice(favoriteStart, categoryStart);
  assert.ok(favoriteSection.includes('type="radio"'), "Favorite must use radio inputs, not checkboxes — exactly one of Any/Favorites/Not favorite can be selected");
  assert.ok(favoriteSection.includes('name="smart-view-favorite"'), "all three options must share one radio group name");
});

check("N: Category is integrated into LibraryFiltersPanel (not left as a separate legacy row) and its own filtering semantics are untouched", () => {
  const panelSource = src("src/components/LibraryFiltersPanel.tsx");
  assert.ok(panelSource.includes(">Category<") && panelSource.includes("onCategoryChange(option.id)"), "expected Category rendered as one more fieldset inside the panel, driven by the same onCategoryChange callback");
  const viewSource = src("src/components/LibraryView.tsx");
  assert.ok(!/<FilterTabGroup label="Category"/.test(viewSource), "Category must no longer render as its own separate row outside the panel");
  assert.ok(viewSource.includes("activeCategory={activeCategory}") && viewSource.includes("onCategoryChange={setSelectedCategory}"), "Category's existing state/handler must be threaded into the panel unchanged, not reimplemented");
});

check("N: Dashboard's overview strip exists before Continue, and the old bordered Snapshot section is gone from its previous lower position", () => {
  const source = src("src/components/DashboardView.tsx");
  const overviewIndex = source.indexOf("OverviewStat");
  const continueIndex = source.indexOf("<ContinueSection");
  assert.ok(overviewIndex !== -1 && continueIndex !== -1 && overviewIndex < continueIndex, "the compact overview must render before <ContinueSection>");
  assert.ok(!source.includes('<SectionHeading title="Snapshot"'), "the old bordered \"Snapshot\" section (previously below Recently Active) must be gone");
  assert.ok(!/StatTile/.test(source), "the old stacked StatTile card component must be gone, replaced by the inline OverviewStat strip");
});

// ============================================================
// O — Round 7 (final Library polish pass): Grid's fixed-height card
// contract (measured live, see the Stage report — this only checks the
// contract exists in code, not the rendered pixel value), the Media
// Type/Status "All" tiles staying pure presentation over the existing
// empty-array-means-any semantics, and Category's chip redesign.
// ============================================================
check("O: MediaItemCard and WebsiteItemCard share one fixed Grid card height class, not independently-chosen heights", () => {
  const constants = src("src/lib/library-grid-constants.ts");
  assert.ok(/export const LIBRARY_GRID_CARD_HEIGHT_CLASS = "h-(\d+|\[\d+px\])"/.test(constants), "expected a single named Grid card height constant (a Tailwind step or an arbitrary px value)");
  for (const file of ["src/components/MediaItemCard.tsx", "src/components/WebsiteItemCard.tsx"]) {
    const source = src(file);
    assert.ok(source.includes("LIBRARY_GRID_CARD_HEIGHT_CLASS"), `${file} must apply the shared Grid card height constant`);
    assert.ok(source.includes("overflow-hidden"), `${file}'s card shell must guard against content overflowing the fixed height`);
  }
});

check("O: MediaItemCompactCard and WebsiteItemCompactCard share one fixed Compact row height class, distinct from Grid's", () => {
  const constants = src("src/lib/library-grid-constants.ts");
  assert.ok(/export const LIBRARY_COMPACT_CARD_HEIGHT_CLASS = "h-\d+"/.test(constants), "expected a single named Compact card height constant");
  for (const file of ["src/components/MediaItemCompactCard.tsx", "src/components/WebsiteItemCompactCard.tsx"]) {
    const source = src(file);
    assert.ok(source.includes("LIBRARY_COMPACT_CARD_HEIGHT_CLASS"), `${file} must apply the shared Compact card height constant`);
  }
});

check("O: WebsiteItemCard renders no description text either (Grid cards stay scan-only; the round-4/6 invariant already covered MediaItemCard)", () => {
  const source = src("src/components/WebsiteItemCard.tsx");
  assert.ok(!/\bdescription\b/.test(source), "WebsiteItemCard must not destructure or render item.description");
});

check("O: List mode's rating display has a subtle icon cue, not bare ambiguous numbers", () => {
  const source = src("src/components/MediaItemRow.tsx");
  assert.ok(/item\.rating[\s\S]{0,200}<StarIcon/.test(source), "expected a StarIcon rendered alongside the rating text in MediaItemRow");
});

check("O: Media Type's explicit All control clears the array (not a literal \"all\" string) and is presentation over the existing empty-array-means-any semantics", () => {
  const source = src("src/components/LibraryFiltersPanel.tsx");
  const mediaTypeStart = source.indexOf(">Media Type<");
  const statusStart = source.indexOf(">Status<");
  const mediaTypeSection = source.slice(mediaTypeStart, statusStart);
  assert.ok(/onClick=\{\(\) => onChange\(\{ \.\.\.definition, mediaTypes: \[\] \}\)\}/.test(mediaTypeSection), "expected an All control that sets mediaTypes to an empty array");
  assert.ok(/definition\.mediaTypes\.length === 0/.test(mediaTypeSection), "expected All's selected/pressed state to be derived from mediaTypes being empty, not a stored sentinel value");
  assert.ok(!/mediaTypes:\s*\[\s*"all"\s*\]/.test(source), "must never store a fake \"all\" media type in SmartViewDefinition.mediaTypes");
});

check("O: Status's explicit All control clears the array (not a literal \"all\" string) and is presentation over the existing empty-array-means-any semantics", () => {
  const source = src("src/components/LibraryFiltersPanel.tsx");
  const statusStart = source.indexOf(">Status<");
  const favoriteStart = source.indexOf(">Favorite<");
  const statusSection = source.slice(statusStart, favoriteStart);
  assert.ok(/onClick=\{\(\) => onChange\(\{ \.\.\.definition, statuses: \[\] \}\)\}/.test(statusSection), "expected an All control that sets statuses to an empty array");
  assert.ok(/definition\.statuses\.length === 0/.test(statusSection), "expected All's selected/pressed state to be derived from statuses being empty, not a stored sentinel value");
  assert.ok(!/statuses:\s*\[\s*"all"\s*\]/.test(source), "must never store a fake \"all\" status in SmartViewDefinition.statuses");
});

check("O: Category renders as chip buttons sharing the same tile visual language as Media Type/Status, not a separate underline-tab component", () => {
  const source = src("src/components/LibraryFiltersPanel.tsx");
  assert.ok(!source.includes("FilterTabs"), "the old underline-tab FilterTabs component must no longer be used for Category");
  const categoryStart = source.indexOf(">Category<");
  const ratingStart = source.indexOf(">Rating<");
  const categorySection = source.slice(categoryStart, ratingStart);
  assert.ok(categorySection.includes("TILE_BUTTON_CLASS"), "Category chips must use the same tile button styling as the All controls");
  assert.ok(/\{option\.label\}/.test(categorySection) && /\{option\.count\}/.test(categorySection), "each category chip must show its label and count together, never a bare orphan count");
});

check("O: the orphaned FilterTabs component was removed, not left as dead code", () => {
  assert.ok(!existsSync("src/components/FilterTabs.tsx"), "FilterTabs.tsx has no remaining importers and should not be left behind");
});

// ============================================================
// P — Round 8 (final micro-polish pass): the Grid height was tightened
// from a manual estimate to a measured value, a blank/uncategorized
// category chip must never render as a bare orphan count, Item Detail
// must not show a Category line that just repeats a genre already shown,
// and Item Detail's header must share the same secondary-page header
// component as Settings instead of its own hand-rolled, chrome-dropping
// header.
// ============================================================
check("P: the Grid card height was tightened below round 7's original h-72 (288px) estimate based on live measurement, not left unchanged", () => {
  const constants = src("src/lib/library-grid-constants.ts");
  const match = constants.match(/export const LIBRARY_GRID_CARD_HEIGHT_CLASS = "h-\[(\d+)px\]"/);
  assert.ok(match, "expected the tightened Grid height to be expressed as an arbitrary px value, not left at the untested h-72 estimate");
  const px = Number(match[1]);
  assert.ok(px < 288, `expected the new height (${px}px) to be smaller than round 7's 288px estimate`);
  assert.ok(px >= 277, `expected the new height (${px}px) to stay at or above the measured richest-card content height (277px) — anything lower would clip real content`);
});

check("P: getCategories gives a blank/uncategorized category a real label, never a bare orphan count (the root cause of the reported standalone \"4\")", () => {
  const source = src("src/lib/library-items.ts");
  assert.ok(/UNCATEGORIZED_LABEL/.test(source), "expected a named fallback label constant for items with no category");
  assert.ok(/category\.trim\(\) === ""\s*\?\s*UNCATEGORIZED_LABEL\s*:\s*category/.test(source), "a blank category must map to the Uncategorized label for display, while the chip's id/filtering key must stay the exact raw category value so filtering behavior is unchanged");
});

check("P: buildDetectedMediaInput's deliberate category: \"\" (Auto Tracking's no-catalog-match path) is untouched — the fix is presentation-only, never a data mutation", () => {
  const source = src("src/lib/extension/detected-item.ts");
  assert.ok(/category:\s*""/.test(source), "Auto Tracking must still be allowed to add an item with no known category — the round-8 fix only changes how that gets displayed, never what gets stored");
});

check("P: Item Detail suppresses a Category line that just repeats a genre already shown, without mutating item.category", () => {
  const source = src("src/components/ItemDetailView.tsx");
  assert.ok(/categoryDuplicatesGenre/.test(source), "expected a display-only redundancy check comparing category against genres");
  assert.ok(/showCategory/.test(source) && source.includes("{showCategory &&"), "the Category line's render condition must be gated on the redundancy check, not just Boolean(item.category)");
  assert.ok(!/item\.category\s*=[^=]/.test(source), "must never assign/mutate item.category — the redundancy check is display-only");
});

check("P: Item Detail's distinct-category and no-genre cases are unaffected — showCategory is never unconditionally false", () => {
  const source = src("src/components/ItemDetailView.tsx");
  assert.ok(/const showCategory = trimmedCategory !== "" && !categoryDuplicatesGenre;/.test(source), "showCategory must stay true for any non-empty category that doesn't match a genre — including items with no genres at all (categoryDuplicatesGenre is false when there are no genres to match)");
});

check("P: Item Detail and Settings share one secondary-page header component instead of duplicated/drifted header markup", () => {
  assert.ok(existsSync("src/components/SecondaryPageHeader.tsx"), "expected a shared SecondaryPageHeader component");
  const headerSource = src("src/components/SecondaryPageHeader.tsx");
  assert.ok(headerSource.includes("<Logo") && headerSource.includes("Markly"), "the shared header must carry product identity (logo + wordmark), not just a bare back link");
  assert.ok(headerSource.includes("<ThemeToggle") && headerSource.includes("<AccountMenu"), "the shared header must carry account chrome (theme + account), matching Settings");
  assert.ok(headerSource.includes("Back to Library"), "the shared header must still offer the one Back to Library link, not the primary Dashboard/Library/Calendar nav");
  for (const file of ["src/components/ItemDetailView.tsx", "src/components/SettingsShell.tsx"]) {
    assert.ok(src(file).includes("<SecondaryPageHeader"), `${file} must render the shared SecondaryPageHeader rather than its own hand-rolled header`);
  }
});

check("P: Item Detail's header no longer silently drops product identity/account chrome (the concrete defect this round fixed)", () => {
  const source = src("src/components/ItemDetailView.tsx");
  assert.ok(!/<header className="border-b border-border">[\s\S]*?ThemeToggle/.test(source), "ItemDetailView must not still define its own inline <header> duplicating SecondaryPageHeader's job");
});

// ============================================================
// Q — Round 9 (mobile-wrap fix): SecondaryPageHeader adapts its label text
// below `sm` instead of wrapping "Back to Library" onto two lines, while
// keeping the same two links, the same /library destination, and the same
// accessible name at every width.
// ============================================================
check("Q: SecondaryPageHeader's back link never wraps at narrow widths — its label shrinks responsively instead, behind one stable accessible name", () => {
  const source = src("src/components/SecondaryPageHeader.tsx");
  assert.ok(/aria-label="Back to Library"/.test(source), "the back link's accessible name must stay \"Back to Library\" regardless of which visible label is shown");
  assert.ok(/whitespace-nowrap/.test(source), "the back link's label must never wrap onto a second line");
  assert.ok(/sm:hidden/.test(source) && /hidden sm:inline/.test(source), "expected a short mobile label and a full sm:+ label, not one fixed string at every width");
  assert.ok(/href="\/library"/.test(source), "the back link must still route to /library regardless of which label is visible");
});

check("Q: the wordmark hides below sm instead of contributing to the same overflow, while the logo mark (brand identity) always stays", () => {
  const source = src("src/components/SecondaryPageHeader.tsx");
  assert.ok(/hidden text-base font-semibold tracking-tight sm:inline/.test(source), "the \"Markly\" wordmark text must be hidden below sm, not forced onto the same cramped row");
  assert.ok(/<Logo/.test(source), "the Logo mark itself must always render, at every width, preserving brand identity");
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

console.log(
  "\nNote: this script verifies deterministic invariants only (primitives exist, aria-labels present on the shared IconButton, reduced-motion respected, no forbidden libraries/colors/transition-all, the concrete mobile filter-collapse fix is in place, business-logic modules untouched). It cannot and does not judge visual/aesthetic quality — that was done via the Phase 0 audit and manual live review documented in the Stage report.",
);
