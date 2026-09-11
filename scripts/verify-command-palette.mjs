#!/usr/bin/env node
// Verifies Stage 36 (Global Search & Command Palette): deterministic
// behavior of the pure search/ranking/normalization/recents-storage logic,
// reproduced verbatim from src/lib/command-palette.ts and
// src/hooks/useCommandPaletteRecents.ts (same convention as every other
// script in this directory — plain .mjs, no TypeScript loader), plus
// durable structural contracts (route allowlist, no side effects from
// searching, Add Item reuse, first-run compatibility). Does not judge
// visual/aesthetic quality — that was done via live browser walkthroughs
// documented in the Stage 36 report.
//
// Run with: node scripts/verify-command-palette.mjs

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
// A — normalizePaletteQuery / normalizeTitleForMatching, reproduced
// verbatim from src/lib/title-normalization.ts (Stage 27's shared
// normalizer, reused here for ranking only — see check M for the
// no-shared-mutable-state guarantee).
// ============================================================
const MAX_QUERY_LENGTH = 300;

function normalizeTitleForMatching(title) {
  return title
    .normalize("NFKC")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‒–—―]/g, "-")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function normalizePaletteQuery(raw) {
  return normalizeTitleForMatching(raw.slice(0, MAX_QUERY_LENGTH));
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const ITEM_TYPE_LABELS = { website: "Website", anime: "Anime", manga: "Manga", novel: "Books & Novels", game: "Game", movie: "Movie", series: "Series", article: "Article", video: "Video", other: "Other" };

function buildSearchDocument(item) {
  return {
    item,
    normalizedTitle: normalizeTitleForMatching(item.title),
    titleWords: normalizeTitleForMatching(item.title).split(" ").filter(Boolean),
    normalizedTags: (item.tags ?? []).map((t) => normalizeTitleForMatching(t)),
    normalizedCategory: normalizeTitleForMatching(item.category ?? ""),
    normalizedTypeLabel: normalizeTitleForMatching(ITEM_TYPE_LABELS[item.type] ?? item.type),
    normalizedDomain: item.type === "website" ? normalizeTitleForMatching(getDomain(item.url)) : null,
  };
}

function scoreLibraryItem(doc, normalizedQuery) {
  if (!normalizedQuery) return 0;
  if (doc.normalizedTitle === normalizedQuery) return 100;
  if (doc.normalizedTitle.startsWith(normalizedQuery)) return 80;
  if (doc.titleWords.some((w) => w.startsWith(normalizedQuery))) return 60;
  if (doc.normalizedTitle.includes(normalizedQuery)) return 40;
  const metadataMatch =
    doc.normalizedTags.some((t) => t.includes(normalizedQuery)) ||
    doc.normalizedCategory.includes(normalizedQuery) ||
    doc.normalizedTypeLabel.includes(normalizedQuery) ||
    (doc.normalizedDomain !== null && doc.normalizedDomain.includes(normalizedQuery));
  return metadataMatch ? 20 : 0;
}

function searchLibraryItems(docs, query, limit) {
  const normalizedQuery = normalizePaletteQuery(query);
  if (!normalizedQuery) return [];
  const scored = [];
  for (const doc of docs) {
    const score = scoreLibraryItem(doc, normalizedQuery);
    if (score > 0) scored.push({ kind: "library", item: doc.item, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const titleCompare = a.item.title.localeCompare(b.item.title, undefined, { sensitivity: "base" });
    if (titleCompare !== 0) return titleCompare;
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
  });
  return scored.slice(0, limit);
}

check("A1: query normalization is case-insensitive, trim-aware, and collapses incidental whitespace", () => {
  assert.equal(normalizePaletteQuery("  GitHub  "), normalizePaletteQuery("github"));
  assert.equal(normalizePaletteQuery("git   hub"), normalizeTitleForMatching("git hub"));
});

check("A2: query normalization folds smart quotes/dashes and NFKC-normalizes Unicode, same as titles", () => {
  assert.equal(normalizePaletteQuery("don’t"), normalizePaletteQuery("don't"));
  assert.equal(normalizePaletteQuery("café"), "café");
});

check("A3: query length is bounded — a huge pasted string is truncated, never thrown on", () => {
  const huge = "a".repeat(100000);
  assert.doesNotThrow(() => normalizePaletteQuery(huge));
  assert.ok(normalizePaletteQuery(huge).length <= MAX_QUERY_LENGTH);
});

check("A4: normalization never destroys meaningful distinguishing characters — different titles stay different keys", () => {
  assert.notEqual(normalizePaletteQuery("Lord of Mysteries"), normalizePaletteQuery("Lord of Mysteries 2"));
});

// ============================================================
// B — ranking tiers (Stage 36 §8/§75).
// ============================================================
check("B1: exact normalized title outranks a prefix match, which outranks a word-prefix match, which outranks a plain contains match", () => {
  const items = [
    { id: "1", type: "website", title: "Fantasy", url: "https://a.example", tags: [], category: "" },
    { id: "2", type: "website", title: "Fantasy World", url: "https://b.example", tags: [], category: "" },
    { id: "3", type: "website", title: "My Fantasy List", url: "https://c.example", tags: [], category: "" },
    { id: "4", type: "website", title: "Unrelated", url: "https://d.example", tags: ["fantasy"], category: "" },
  ];
  const docs = items.map(buildSearchDocument);
  const results = searchLibraryItems(docs, "fantasy", 10);
  assert.deepEqual(results.map((r) => r.item.id), ["1", "2", "3", "4"], "expected exact > prefix > word-prefix/contains > tag-only, in that order");
  assert.equal(results[0].score, 100);
  assert.equal(results[1].score, 80);
});

check("B2: a title word starting with the query outranks a mere substring match embedded elsewhere in the title", () => {
  const items = [
    { id: "word-prefix", type: "website", title: "Lord of Mysteries", url: "https://a.example", tags: [], category: "" },
    // "myster" appears mid-word inside "bigmystery" — a real substring
    // match, but no WORD in the title starts with "myster" (words are
    // "a", "bigmystery", "puzzle"), so this must land one tier lower.
    { id: "contains-only", type: "website", title: "A Bigmystery Puzzle", url: "https://b.example", tags: [], category: "" },
  ];
  const docs = items.map(buildSearchDocument);
  const results = searchLibraryItems(docs, "myster", 10);
  assert.equal(results[0].item.id, "word-prefix");
  assert.ok(results[0].score > results[1].score);
});

check("B3 (test §77): a title match outranks an unrelated item whose media TYPE happens to match the query text", () => {
  const items = [
    { id: "title-match", type: "movie", title: "Anime", url: undefined, tags: [], category: "" },
    { id: "type-match-only", type: "anime", title: "Something Else Entirely", url: undefined, tags: [], category: "" },
  ];
  const docs = items.map(buildSearchDocument);
  const results = searchLibraryItems(docs, "anime", 10);
  assert.equal(results[0].item.id, "title-match", "the literal title \"Anime\" must outrank an item that merely has media type anime");
});

check("B4 (test §67): a tag match never outscores a title starts-with match", () => {
  const items = [
    { id: "tag-only", type: "website", title: "Completely Different", url: "https://a.example", tags: ["fantasy"], category: "" },
    { id: "title-prefix", type: "website", title: "Fantasy Adventures", url: "https://b.example", tags: [], category: "" },
  ];
  const docs = items.map(buildSearchDocument);
  const results = searchLibraryItems(docs, "fantasy", 10);
  assert.equal(results[0].item.id, "title-prefix");
});

check("B5 (test §78): a website's hostname matches, and a malformed website URL never throws", () => {
  const items = [
    { id: "gh", type: "website", title: "My Code Host", url: "https://github.com/anthropics", tags: [], category: "" },
    { id: "malformed", type: "website", title: "Broken Link Item", url: "not a valid url at all", tags: [], category: "" },
  ];
  assert.doesNotThrow(() => items.map(buildSearchDocument));
  const docs = items.map(buildSearchDocument);
  const results = searchLibraryItems(docs, "github.com", 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].item.id, "gh");
});

check("B6: no fuzzy typo magic — a query one letter off from a title scores no match, per v1's documented scope", () => {
  const docs = [buildSearchDocument({ id: "1", type: "website", title: "Fantasy", url: "https://a.example", tags: [], category: "" })];
  assert.equal(searchLibraryItems(docs, "fantesy", 10).length, 0);
});

check("B7: deterministic tie-break on equal score — title, then id — never depends on input array order", () => {
  const items = [
    { id: "z-id", type: "website", title: "Same Title", url: "https://a.example", tags: [], category: "" },
    { id: "a-id", type: "website", title: "Same Title", url: "https://b.example", tags: [], category: "" },
  ];
  const docs = items.map(buildSearchDocument);
  const forward = searchLibraryItems(docs, "same title", 10).map((r) => r.item.id);
  const reversed = searchLibraryItems([...docs].reverse(), "same title", 10).map((r) => r.item.id);
  assert.deepEqual(forward, ["a-id", "z-id"]);
  assert.deepEqual(reversed, forward, "tie-break must not depend on input array order");
});

check("B8: results are capped, never dumping hundreds of matches", () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ id: String(i), type: "website", title: "Match Item " + i, url: "https://a.example", tags: [], category: "" }));
  const docs = items.map(buildSearchDocument);
  const results = searchLibraryItems(docs, "match", 10);
  assert.equal(results.length, 10);
});

// ============================================================
// C — recents storage: versioned, validated, deduped, capped, and
// resolved against the CURRENT authoritative library only (Stage 36
// §16/§17/§58/§59/§71/§72/§79/§85). Reproduced verbatim from
// src/hooks/useCommandPaletteRecents.ts.
// ============================================================
const RECENTS_VERSION = 1;
const MAX_RECENTS = 8;

function isRecentsStorageShape(value) {
  if (!value || typeof value !== "object") return false;
  return value.version === RECENTS_VERSION && Array.isArray(value.recentItemIds) && value.recentItemIds.every((id) => typeof id === "string");
}

function parseRecentsStorage(raw) {
  try {
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return isRecentsStorageShape(parsed) ? parsed.recentItemIds.slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

function withRecordedId(current, id) {
  return [id, ...current.filter((existing) => existing !== id)].slice(0, MAX_RECENTS);
}

function resolveRecentItems(recentIds, items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const resolved = [];
  for (const id of recentIds) {
    const item = byId.get(id);
    if (item) resolved.push(item);
  }
  return resolved;
}

check("C1 (test §79): opening A, B, A records [A, B] — moved to front, not duplicated", () => {
  let recents = [];
  recents = withRecordedId(recents, "A");
  recents = withRecordedId(recents, "B");
  recents = withRecordedId(recents, "A");
  assert.deepEqual(recents, ["A", "B"]);
});

check("C2: the cap is enforced — recording beyond the max drops the oldest", () => {
  let recents = [];
  for (const id of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) recents = withRecordedId(recents, id);
  assert.equal(recents.length, MAX_RECENTS);
  assert.deepEqual(recents, ["9", "8", "7", "6", "5", "4", "3", "2"], "oldest (\"1\") must be dropped, most-recent-first order preserved");
});

check("C3: a deleted/unknown id is silently filtered out when resolving against the current library, never rendered broken", () => {
  const items = [{ id: "exists", title: "Still Here", type: "website", url: "https://a.example", tags: [], category: "" }];
  const resolved = resolveRecentItems(["exists", "deleted-long-ago"], items);
  assert.deepEqual(resolved.map((i) => i.id), ["exists"]);
});

check("C4 (test §85, account-switch privacy): stored ids from a previous account resolve to nothing against a different account's library — no title/history leakage", () => {
  const userAIds = ["a-item-1", "a-item-2"];
  const userBLibrary = [{ id: "b-item-1", title: "User B's Private Item", type: "website", url: "https://b.example", tags: [], category: "" }];
  const resolved = resolveRecentItems(userAIds, userBLibrary);
  assert.equal(resolved.length, 0, "none of User A's stored ids exist in User B's library, so User B must see zero Recents, never User A's titles");
});

check("C5: corrupt/malformed recents storage falls back to an empty list, never throws", () => {
  for (const raw of ["{not json", "null", JSON.stringify(["a", "b"]), JSON.stringify({ version: 2, recentItemIds: ["a"] }), JSON.stringify({ version: 1, recentItemIds: [1, 2] }), undefined]) {
    assert.doesNotThrow(() => parseRecentsStorage(raw));
    assert.deepEqual(parseRecentsStorage(raw), []);
  }
});

check("C6: recents storage never stores full item data, only ids — the real module's write path proves this statically", () => {
  const source = src("src/hooks/useCommandPaletteRecents.ts");
  assert.ok(source.includes("recentItemIds: string[]"), "expected the persisted shape to be an array of ids only");
  // Field-ACCESS patterns only (item.title, .imageUrl, etc.) — not a bare
  // substring match, which would also flag this file's own prose comments
  // explaining that it deliberately never stores titles.
  assert.ok(!/\.(title|imageUrl|description|coverUrl)\b/.test(source), "the recents hook must never read/persist item title/cover/description fields — ids only");
});

check("C7: the recents storage key is versioned and namespaced under the app's markly. convention", () => {
  const source = src("src/hooks/useCommandPaletteRecents.ts");
  assert.ok(/"markly\.commandPalette"/.test(source));
  assert.ok(/STORAGE_VERSION\s*=\s*1/.test(source));
});

// ============================================================
// D — global shortcut semantics (Stage 36 §1/§80).
// ============================================================
function shouldToggleOnKeydown(event) {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !event.isComposing;
}

check("D1: Ctrl+K and Cmd+K both trigger the shortcut", () => {
  assert.equal(shouldToggleOnKeydown({ ctrlKey: true, metaKey: false, key: "k", isComposing: false }), true);
  assert.equal(shouldToggleOnKeydown({ ctrlKey: false, metaKey: true, key: "k", isComposing: false }), true);
});

check("D2: plain \"k\" with no modifier never triggers it", () => {
  assert.equal(shouldToggleOnKeydown({ ctrlKey: false, metaKey: false, key: "k", isComposing: false }), false);
});

check("D3: an IME composition in progress suppresses the shortcut even with the modifier held", () => {
  assert.equal(shouldToggleOnKeydown({ ctrlKey: true, metaKey: false, key: "k", isComposing: true }), false);
});

check("D4: the key check is case-insensitive on the letter (Shift+Ctrl+K still counts as \"k\")", () => {
  assert.equal(shouldToggleOnKeydown({ ctrlKey: true, metaKey: false, key: "K", isComposing: false }), true);
});

check("D5: the real provider implements exactly this predicate, not a broader/narrower one", () => {
  const source = src("src/components/CommandPaletteProvider.tsx");
  assert.ok(/event\.metaKey \|\| event\.ctrlKey/.test(source));
  assert.ok(/event\.key\.toLowerCase\(\) !== "k"/.test(source));
  assert.ok(/event\.isComposing/.test(source));
  assert.ok(/event\.preventDefault\(\)/.test(source), "must prevent the browser default only when actually handling the shortcut");
});

// ============================================================
// E — keyboard selection behavior (Stage 36 §24/§81/§82).
// ============================================================
function moveActiveIndex(current, direction, length) {
  if (length === 0) return 0;
  if (direction === "down") return (current + 1) % length;
  return (current - 1 + length) % length;
}

check("E1: ArrowDown moves to the next result, ArrowUp to the previous", () => {
  assert.equal(moveActiveIndex(0, "down", 5), 1);
  assert.equal(moveActiveIndex(1, "up", 5), 0);
});

check("E2 (documented choice): selection wraps top<->bottom rather than clamping at the edges", () => {
  assert.equal(moveActiveIndex(4, "down", 5), 0, "ArrowDown at the last result wraps to the first");
  assert.equal(moveActiveIndex(0, "up", 5), 4, "ArrowUp at the first result wraps to the last");
});

check("E3 (test §82): when the result count shrinks, an out-of-range active index is never left dangling — the real component resets it on every query/result-count change", () => {
  const source = src("src/components/CommandPalette.tsx");
  assert.ok(/setActiveIndex\(0\)/.test(source) && /\[query, effectiveResults\.length\]/.test(source), "expected activeIndex to reset to 0 whenever the query or result count changes");
});

check("E4: Home/End jump to the first/last result", () => {
  const source = src("src/components/CommandPalette.tsx");
  assert.ok(source.includes('event.key === "Home"') && source.includes('event.key === "End"'));
});

check("E5: no Vim-style bindings were added", () => {
  const source = src("src/components/CommandPalette.tsx");
  assert.ok(!/["']j["']|["']k["']/.test(source.replace(/event\.key\.toLowerCase\(\) !== "k"/g, "")), "expected no j/k navigation bindings in the palette itself");
});

// ============================================================
// F — result assembly / grouping (Stage 36 §15/§19/§20/§69/§84).
// ============================================================
const QUICK_ACTION_NAV_IDS = ["nav.dashboard", "nav.library", "nav.calendar", "nav.reminders"];
const NAVIGATION_COMMANDS = [
  { kind: "navigation", id: "nav.dashboard", label: "Dashboard", href: "/" },
  { kind: "navigation", id: "nav.library", label: "Library", href: "/library" },
  { kind: "navigation", id: "nav.calendar", label: "Calendar", href: "/calendar" },
  { kind: "navigation", id: "nav.reminders", label: "Reminders", href: "/reminders" },
  { kind: "navigation", id: "nav.share", label: "Capture URL", href: "/share" },
  { kind: "navigation", id: "nav.settings.connections", label: "Settings · Connections", href: "/settings/connections" },
  { kind: "navigation", id: "nav.settings.tracking", label: "Settings · Auto Tracking", href: "/settings/tracking" },
  { kind: "navigation", id: "nav.settings.notifications", label: "Settings · Notifications", href: "/settings/notifications" },
  { kind: "navigation", id: "nav.settings.recovery", label: "Settings · Recently Changed", href: "/settings/recovery" },
  { kind: "navigation", id: "nav.settings.backup", label: "Settings · Data & Backup", href: "/settings/backup" },
  { kind: "navigation", id: "nav.settings.app", label: "Settings · App", href: "/settings/app" },
];
const ADD_ITEM_ACTION = { kind: "action", id: "action.add-item", label: "Add Item" };

function buildPaletteResults({ query, docs, recentItems }) {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      library: [],
      navigation: NAVIGATION_COMMANDS.filter((c) => QUICK_ACTION_NAV_IDS.includes(c.id)),
      actions: [ADD_ITEM_ACTION],
      recent: recentItems.slice(0, MAX_RECENTS).map((item) => ({ kind: "library", item, score: 0 })),
    };
  }
  const normalizedQuery = normalizePaletteQuery(trimmed);
  const library = searchLibraryItems(docs, trimmed, 10);
  const navigation = NAVIGATION_COMMANDS.filter((c) => normalizeTitleForMatching(c.label).includes(normalizedQuery)).slice(0, 5);
  const actions = [ADD_ITEM_ACTION].filter((c) => normalizeTitleForMatching(c.label).includes(normalizedQuery));
  return { library, navigation, actions, recent: [] };
}

check("F1 (test §84): empty library still shows Navigation + Add Item on an empty query — never a broken Library group", () => {
  const groups = buildPaletteResults({ query: "", docs: [], recentItems: [] });
  assert.equal(groups.library.length, 0);
  assert.ok(groups.navigation.length > 0);
  assert.ok(groups.actions.some((a) => a.id === "action.add-item"));
});

check("F2 (test §69): a query with no Library/Navigation/Action matches reports no-results, and Add Item stays reachable as a fallback in the real component (not dependent on text-matching the words \"Add Item\")", () => {
  const groups = buildPaletteResults({ query: "zzz-absolutely-no-match-zzz", docs: [buildSearchDocument({ id: "1", type: "website", title: "Something", url: "https://a.example", tags: [], category: "" })], recentItems: [] });
  assert.equal(groups.library.length, 0);
  assert.equal(groups.navigation.length, 0);
  assert.equal(groups.actions.length, 0);
  const source = src("src/components/CommandPalette.tsx");
  assert.ok(/hasAnyMatch \|\| !isSearching \? flatResults : \[\{ kind: "action", id: "action.add-item"/.test(source), "expected a guaranteed Add Item fallback in the true no-results case");
});

check("F3: the empty-query view never shows a bare \"No results\" — it shows curated Quick Actions and Recent instead", () => {
  const source = src("src/components/CommandPalette.tsx");
  assert.ok(/isSearching && !hasAnyMatch/.test(source), "the \"No results\" block must be gated on isSearching, never shown for an empty query");
});

check("F4: static commands never come from searchable item data — only a fixed allowlist (Stage 36 §48, no open redirects)", () => {
  const source = src("src/lib/command-palette.ts");
  const nonRouteHrefs = NAVIGATION_COMMANDS.filter((c) => !c.href.startsWith("/"));
  assert.equal(nonRouteHrefs.length, 0, "every navigation command must be an internal route");
  assert.ok(source.includes("const NAVIGATION_COMMANDS: readonly PaletteNavigationResult[] ="), "expected one fixed, centrally-defined navigation command list");
});

check("F5: every static command has a stable id never derived from its displayed label (Stage 36 §43)", () => {
  for (const command of [...NAVIGATION_COMMANDS, ADD_ITEM_ACTION]) {
    assert.notEqual(command.id, command.label);
    assert.ok(/^(nav|action)\./.test(command.id));
  }
});

// ============================================================
// G — performance fixture (Stage 36 §22/§74): 500/1,000/5,000 items,
// correct ranking, bounded results, no exceptions. A coarse sanity check,
// not a precise microbenchmark (per the brief's own instruction).
// ============================================================
for (const n of [500, 1000, 5000]) {
  check(`G: ${n} items — exact title, prefix, substring, tag, domain, and no-result queries all resolve correctly, bounded, without throwing`, () => {
    const items = Array.from({ length: n }, (_, i) => ({
      id: "perf-" + i,
      type: i % 7 === 0 ? "website" : "anime",
      title: "Performance Fixture Item " + i,
      url: i % 7 === 0 ? `https://example${i}.com` : undefined,
      tags: ["perf", "bucket" + (i % 50)],
      category: "Testing",
    }));
    // One deliberately findable needle per query kind.
    items[Math.floor(n / 2)] = { id: "needle-exact", type: "anime", title: "Needle Exact Title", url: undefined, tags: [], category: "" };
    items[Math.floor(n / 3)] = { id: "needle-domain", type: "website", title: "Needle Domain Item", url: "https://needle-domain.example.com/path", tags: [], category: "" };

    let docs;
    assert.doesNotThrow(() => {
      docs = items.map(buildSearchDocument);
    });

    for (const [query, expectFirstId] of [
      ["Needle Exact Title", "needle-exact"],
      ["Performance Fixture", null],
      ["needle-domain.example.com", "needle-domain"],
      ["bucket7", null],
      ["absolutely-nothing-matches-this-xyz", undefined],
    ]) {
      let results;
      assert.doesNotThrow(() => {
        results = searchLibraryItems(docs, query, 10);
      }, `query ${JSON.stringify(query)} at n=${n} must never throw`);
      assert.ok(results.length <= 10, `results must be bounded regardless of dataset size (n=${n})`);
      if (expectFirstId === undefined) {
        assert.equal(results.length, 0, `query ${JSON.stringify(query)} should match nothing`);
      } else if (expectFirstId !== null) {
        assert.equal(results[0]?.item.id, expectFirstId, `query ${JSON.stringify(query)} at n=${n} should rank the exact/domain needle first`);
      }
    }
  });
}

// ============================================================
// H — no side effects from searching (Stage 36 §41/§86): opening,
// typing, and closing the palette must never touch Activity, tracking
// sources, AniList, or reminders. The only legitimate write path is the
// explicit Add Item command, which goes through the same mutations every
// other Add Item entry point uses.
// ============================================================
check("H1: CommandPalette never calls a tracking/rating/status/favorite/reminder/AniList mutation", () => {
  const source = src("src/components/CommandPalette.tsx");
  assert.ok(!/toggleFavorite|quickIncrementProgress|quickAdjustPlaytime|quickSetNovelProgress|updateTracking|createReminder|allowWrites|SaveMediaListEntry/.test(source), "the palette must only ever call addWebsite/addMedia (via the Add Item dialog), nothing else");
});

check("H2: the only useLibraryItems mutations CommandPalette calls are addWebsite/addMedia (Add Item), never delete/merge/update", () => {
  const source = src("src/components/CommandPalette.tsx");
  assert.ok(source.includes("library.addWebsite(values)") && source.includes("library.addMedia("));
  assert.ok(!/library\.(deleteItem|mergeItems|updateMedia|updateWebsite|restoreDeletedItem|restoreMergedItems)/.test(source));
});

check("H3: no browser-extension/Notification permission request is reachable from the palette", () => {
  for (const file of ["src/components/CommandPalette.tsx", "src/components/CommandPaletteProvider.tsx", "src/components/CommandPaletteTriggerButton.tsx", "src/lib/command-palette.ts", "src/hooks/useCommandPaletteRecents.ts"]) {
    const source = src(file);
    assert.ok(!/chrome\.permissions|navigator\.permissions|requestPermissions\(|Notification\.requestPermission/.test(source), `${file} must not request any permission`);
  }
});

check("H4: Add Item's Activity logging reuses the same useActivity instance as every other mutation this component makes — not a bypass, not a duplicate log path", () => {
  const source = src("src/components/CommandPalette.tsx");
  assert.ok(source.includes("useActivity(userId)") && source.includes("activity.logEvent"));
});

// ============================================================
// I — Stage 35 onboarding compatibility (Stage 36 §61): the palette must
// never call onboarding persistence directly — activation is observed
// through normal library state exactly as before.
// ============================================================
check("I1: CommandPalette never imports or calls onboarding persistence directly", () => {
  const source = src("src/components/CommandPalette.tsx");
  assert.ok(!/useOnboarding|useLibraryActivation|recordLibraryActivated|markLibraryActivated/.test(source), "adding an item through the palette must be observed by Dashboard/Library's existing activation tracking through ordinary library state, never called directly from here");
});

// ============================================================
// J — architectural contracts: single mount point, lazy data, reused
// primitives (Stage 36 §3/§4/§5/§6/§31).
// ============================================================
check("J1: the palette is mounted exactly once, at the root layout, not per-page", () => {
  const layoutSource = src("src/app/layout.tsx");
  assert.ok(layoutSource.includes("<CommandPaletteProvider>"));
  for (const view of ["src/components/DashboardView.tsx", "src/components/LibraryView.tsx", "src/components/CalendarView.tsx", "src/components/ReminderCenterView.tsx"]) {
    assert.ok(!src(view).includes("CommandPaletteProvider"), `${view} must not mount its own CommandPaletteProvider`);
  }
});

check("J2: the expensive data hooks (useLibraryItems/useActivity) only ever mount while the palette is open — the provider conditionally renders CommandPalette, it doesn't always mount it", () => {
  const providerSource = src("src/components/CommandPaletteProvider.tsx");
  assert.ok(/\{isOpen && <CommandPalette/.test(providerSource), "expected CommandPalette to be conditionally rendered on isOpen, not always mounted with an internal early return");
});

check("J3: Header exposes exactly one search affordance — the global Command Palette trigger. Library's in-place filter SearchBar lives in Library's own content toolbar instead (see section K), so the two never compete in the same header slot", () => {
  const headerSource = src("src/components/Header.tsx");
  assert.ok(!/SearchBar/.test(headerSource), "Header must not reference the Library-local SearchBar at all");
  assert.ok(headerSource.includes("<CommandPaletteTriggerButton"), "expected the global palette trigger to still be present");
});

check("J4: Library results reuse the existing cover/favicon primitives, not a second fallback implementation", () => {
  const source = src("src/components/CommandPalette.tsx");
  assert.ok(source.includes("<LibraryCoverThumb") && source.includes("<WebsiteFaviconThumb"));
});

check("J5: Add Item is reused via the one shared LibraryItemDialog, not a second implementation", () => {
  const source = src("src/components/CommandPalette.tsx");
  assert.ok(source.includes("<LibraryItemDialog"));
});

check("J6: no clickable divs among result rows — every result row (role=\"option\") is a real <button>, not a <div> (the backdrop's own click-to-dismiss <div onClick={onClose}> is a separate, established pattern — same one Dialog.tsx already uses — not a result row)", () => {
  const source = src("src/components/CommandPalette.tsx");
  const occurrences = [...source.matchAll(/role="option"/g)];
  assert.ok(occurrences.length > 0, "expected at least one role=\"option\" element to check");
  for (const occurrence of occurrences) {
    const before = source.slice(0, occurrence.index);
    const lastButton = before.lastIndexOf("<button");
    const lastDiv = before.lastIndexOf("<div");
    assert.ok(lastButton > lastDiv, `the role="option" at offset ${occurrence.index} must belong to the nearest preceding <button>, not a <div>`);
  }
});

check("J7: no new dependency was added for this stage — no existing fuzzy-search/command-menu package existed to justify reusing, and none was introduced", () => {
  const pkg = JSON.parse(src("package.json"));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const forbidden = ["cmdk", "fuse.js", "fuzzysort", "kbar", "@radix-ui", "downshift"];
  for (const name of forbidden) assert.ok(!(name in allDeps), `unexpected new search/command-menu dependency: ${name}`);
});

check("J8: Stage 36 itself created no migration — 0016 was still the latest migration at the time of this stage's own work (Stage 37 later added 0017 legitimately; this snapshot is bumped forward each time a later stage adds one, same convention as every other stage's own version of this check)", () => {
  const files = readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort();
  assert.ok(files.some((name) => name.startsWith("0016_")), "expected 0016_stage34_reminders.sql to still exist");
  const highest = files[files.length - 1];
  assert.ok(highest.startsWith("0017_"), `expected 0017_stage37_web_push.sql to be the latest migration, found ${highest}`);
});

// ============================================================
// K — "final search affordance consistency" pass: Library's inline filter
// SearchBar used to be rendered inside Header (Library was the only page
// that passed onSearchQueryChange to it), sitting directly beside the
// global Command Palette trigger — two search-shaped controls competing
// in one header slot. It was relocated into LibraryView's own content
// toolbar, reusing the same component and the same currentDefinition.query
// state/handler unchanged; Header now exposes exactly one search
// affordance, on every page, with no exceptions.
// ============================================================
check("K1: Header no longer conditionally renders the Library SearchBar — no trace of the old per-page search prop contract remains", () => {
  const source = src("src/components/Header.tsx");
  assert.ok(!/SearchBar|searchQuery|onSearchQueryChange/.test(source), "Header must have no remaining reference to SearchBar or the old search props");
});

check("K2: Header still renders the CommandPaletteTriggerButton", () => {
  const source = src("src/components/Header.tsx");
  assert.ok(source.includes("<CommandPaletteTriggerButton"));
});

check("K3: SecondaryPageHeader is unaffected — it already exposed only the global trigger and never had a SearchBar", () => {
  const source = src("src/components/SecondaryPageHeader.tsx");
  assert.ok(source.includes("<CommandPaletteTriggerButton") && !/SearchBar/.test(source));
});

check("K4: LibraryView renders/reuses the existing SearchBar component in its own content toolbar — not a second search-input implementation", () => {
  const source = src("src/components/LibraryView.tsx");
  assert.ok(source.includes('import { SearchBar } from "@/components/SearchBar"'), "must import and reuse the existing component, not reimplement one");
  assert.ok(source.includes("<SearchBar"), "must actually render it");
});

check("K5: Library's relocated search still drives the exact same currentDefinition.query state and handler — moving it changed nothing about how it filters", () => {
  const source = src("src/components/LibraryView.tsx");
  assert.ok(/<SearchBar\s+value=\{currentDefinition\.query\}/.test(source), "expected SearchBar's value to still be currentDefinition.query");
  assert.ok(
    source.includes("onChange={(value) => setCurrentDefinition((current) => ({ ...current, query: value }))}"),
    "expected the exact same query-updating handler as before the move",
  );
});

check("K6: no other page gained a SearchBar of its own — Library remains the only page with page-local filter search", () => {
  for (const view of ["src/components/DashboardView.tsx", "src/components/CalendarView.tsx", "src/components/ReminderCenterView.tsx"]) {
    assert.ok(!src(view).includes("<SearchBar"), `${view} must not render SearchBar`);
  }
});

check("K7: still exactly one global palette instance/mount point — relocating its sibling control introduced no second provider or palette", () => {
  const layoutSource = src("src/app/layout.tsx");
  assert.ok(layoutSource.includes("<CommandPaletteProvider>"));
  assert.ok(!src("src/components/LibraryView.tsx").includes("CommandPaletteProvider"), "LibraryView must not mount its own provider");
});

check("K8: the global Ctrl/Cmd+K shortcut handler itself is untouched by this pass", () => {
  const providerSource = src("src/components/CommandPaletteProvider.tsx");
  assert.ok(
    /event\.metaKey \|\| event\.ctrlKey/.test(providerSource) &&
      /event\.key\.toLowerCase\(\) !== "k"/.test(providerSource) &&
      /event\.isComposing/.test(providerSource),
    "expected the same shortcut predicate as before this pass",
  );
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
  "\nNote: Sections A-G reproduce src/lib/command-palette.ts and src/hooks/useCommandPaletteRecents.ts's pure normalization/ranking/recents logic verbatim (same convention as every other script in this directory) and test it directly — deterministic, no DOM/network/localStorage involved. Sections H-J statically verify the no-side-effects, onboarding-compatibility, and architectural contracts. Section K statically verifies the Stage 36 header search-affordance consistency pass (one global search control per Header, Library's filter search reused in its own toolbar). It cannot and does not judge visual/aesthetic quality — that was done via live browser walkthroughs documented in the Stage 36 report.",
);
