#!/usr/bin/env node
// Verifies Stage 41 "Unified Continue & Resume Engine":
//   - lib/resume.ts: selectContinueSource, selectBestTrackingSource,
//     getContinueActionLabel, resolveResumeTarget — the one authoritative
//     "where does Continue/Resume/Open go" model reused by Dashboard, Item
//     Detail, Reminders, and Source Hub's own "most recently used" badge.
//   - The central correctness finding this stage exists to encode: a
//     manual source's last_seen_at means "time added/linked", never "time
//     consumed" (nothing updates it again after creation — see Stage 40's
//     own createManualSource/restoreTrackingSource), so it can't be
//     compared against an extension-detected source's genuinely-refreshed
//     last_seen_at, or even against another manual source's own "time
//     added". Tests A/I below are this finding's regression suite.
//   - Action-label engine: media type + status -> "Continue watching" /
//     "Start reading" / "Resume playing" / "Open source", using ONLY
//     fields that actually exist (no fabricated progress, no status
//     Markly doesn't have).
//   - Structural/architectural checks: Dashboard, Item Detail, and Source
//     Hub's badge all import from lib/resume.ts rather than re-deriving
//     their own answer (the exact bug this stage's own audit found: Item
//     Detail's PRE-Stage-41 primary action read media?.sourceUrl directly,
//     completely bypassing TrackingSources); no server-side fetch of any
//     submitted source URL; no derived ResumeTarget ever persisted; no
//     migration 0019.
//
// Reproduced verbatim from the real modules (same convention as every
// other script in this directory — plain .mjs, no TypeScript loader). No
// live database/Supabase call is made by this script.
//
// Run with: node scripts/verify-resume-engine.mjs

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

// ============================================================
// lib/website.ts's isValidUrl — reproduced verbatim (same convention as
// every other script in this directory).
// ============================================================
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
// lib/extension/source-display.ts — reproduced verbatim.
// ============================================================
const ADAPTER_LABELS = {
  mangadex: "MangaDex",
  "markly-test-reader": "Markly Test Reader",
  "markly-test-reader-b": "Markly Test Reader B",
  "markly-season-test": "Markly Season Test",
};
const HOSTNAME_LABELS = { "novelphoenix.com": "NovelPhoenix", "mangadex.org": "MangaDex" };
function getSourceHostname(sourceUrl) {
  if (!sourceUrl) return null;
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
function getSourceDisplayName(adapterId, sourceUrl, sourceTitle) {
  if (adapterId === "manual" && sourceTitle) return sourceTitle;
  if (ADAPTER_LABELS[adapterId]) return ADAPTER_LABELS[adapterId];
  const hostname = getSourceHostname(sourceUrl);
  if (hostname && HOSTNAME_LABELS[hostname]) return HOSTNAME_LABELS[hostname];
  return hostname ?? adapterId;
}
function sameTrustedHost(urlA, urlB) {
  const hostA = getSourceHostname(urlA);
  const hostB = getSourceHostname(urlB);
  return hostA !== null && hostB !== null && hostA === hostB;
}
function getSafeOpenSourceUrl(source) {
  const safeSourceUrl = source.sourceUrl && isValidUrl(source.sourceUrl) ? source.sourceUrl : null;
  const workUrl = source.lastDetectedMetadata?.workUrl;
  if (workUrl && isValidUrl(workUrl) && safeSourceUrl && sameTrustedHost(workUrl, safeSourceUrl)) return workUrl;
  return safeSourceUrl;
}
function formatSourceProgress(progress) {
  if (!progress) return "No progress detected yet";
  const value = formatProgressValue(progress);
  return progress.confirmed === false ? `Detected: ${value} (not completed)` : value;
}
function formatProgressValue(progress) {
  switch (progress.kind) {
    case "season_episode":
      return progress.season !== undefined ? `Season ${progress.season}, Episode ${progress.value}` : `Episode ${progress.value}`;
    case "episode":
      return `Episode ${progress.value}`;
    case "chapter":
      return `Chapter ${progress.value}`;
    case "page":
      return `Page ${progress.value}`;
    case "percent":
      return `${progress.value}%`;
    case "playtime":
      return `${progress.value}h`;
    default:
      return `${progress.kind} ${progress.value}`;
  }
}

// ============================================================
// item-detail.ts helpers — reproduced verbatim.
// ============================================================
const MEDIA_TYPES = new Set(["anime", "manga", "novel", "game", "movie", "series"]);
function isMediaItem(item) {
  return MEDIA_TYPES.has(item.type);
}
function getItemHref(item) {
  return `/library/${item.id}`;
}

// ============================================================
// lib/resume.ts — reproduced verbatim (the module under test).
// ============================================================
function byRecencyThenId(a, b) {
  const byLastSeen = b.lastSeenAt.localeCompare(a.lastSeenAt);
  if (byLastSeen !== 0) return byLastSeen;
  return a.id.localeCompare(b.id);
}
function selectBestTrackingSource(sources, itemId) {
  const eligible = sources.filter((source) => source.libraryItemId === itemId);
  const withSafeUrl = eligible.filter((source) => getSafeOpenSourceUrl(source) !== null);
  if (withSafeUrl.length === 0) return null;
  return [...withSafeUrl].sort(byRecencyThenId)[0];
}
function selectContinueSource(sources, itemId) {
  const eligible = sources.filter((source) => source.libraryItemId === itemId && getSafeOpenSourceUrl(source) !== null);
  if (eligible.length === 0) return { kind: "none" };
  if (eligible.length === 1) {
    const source = eligible[0];
    return { kind: "direct", source, url: getSafeOpenSourceUrl(source) };
  }
  const allGenuinelyTimestamped = eligible.every((source) => source.adapterId !== "manual");
  if (allGenuinelyTimestamped) {
    const best = [...eligible].sort(byRecencyThenId)[0];
    return { kind: "direct", source: best, url: getSafeOpenSourceUrl(best) };
  }
  return { kind: "choose_source", sources: [...eligible].sort(byRecencyThenId) };
}
// Stage 41.1 — separates "can Continue deterministically open this" (the
// `direct` kind above) from "do we have genuine USAGE evidence for this
// specific source" (this function). A single manual source answers the
// first question "yes" (nothing to disambiguate) but the second "no" (its
// last_seen_at is a creation/link timestamp, never a consumption one).
function selectRecentlyUsedSource(sources, itemId) {
  const selection = selectContinueSource(sources, itemId);
  if (selection.kind !== "direct") return null;
  if (selection.source.adapterId === "manual") return null;
  return selection.source;
}
const CONTINUE_VERB = { anime: "watching", series: "watching", movie: "watching", manga: "reading", novel: "reading", game: "playing" };
function getContinueActionLabel(item) {
  if (item.type === "website") return "Open website";
  if (!isMediaItem(item)) return "Open item";
  const verb = CONTINUE_VERB[item.type];
  switch (item.status) {
    case "planned":
      return `Start ${verb}`;
    case "in_progress":
      return `Continue ${verb}`;
    case "on_hold":
      return `Resume ${verb}`;
    case "completed":
    case "dropped":
      return "Open source";
    default:
      return "Open source";
  }
}
function ownStoredUrl(item) {
  if (item.type === "website") return item.url;
  if (isMediaItem(item)) return item.sourceUrl;
  return undefined;
}
function toResumeSourceOption(source) {
  const url = getSafeOpenSourceUrl(source);
  return {
    sourceId: source.id,
    url,
    label: getSourceDisplayName(source.adapterId, source.sourceUrl, source.sourceTitle),
    hostname: getSourceHostname(url),
    progressText: formatSourceProgress(source.lastDetectedProgress),
  };
}
function resolveResumeTarget(item, trackingSources) {
  if (item.type === "website") {
    const stored = ownStoredUrl(item);
    if (stored && isValidUrl(stored)) return { kind: "canonical_url", url: stored, actionLabel: "Open website", hostname: getSourceHostname(stored) ?? undefined };
    return { kind: "unavailable", reason: "no-target" };
  }
  if (!isMediaItem(item)) return { kind: "unavailable", reason: "no-target" };

  const actionLabel = getContinueActionLabel(item);
  const selection = selectContinueSource(trackingSources, item.id);

  if (selection.kind === "direct") {
    const { source, url } = selection;
    return { kind: "direct", url, actionLabel, sourceLabel: getSourceDisplayName(source.adapterId, url, source.sourceTitle), hostname: getSourceHostname(url) ?? undefined };
  }
  if (selection.kind === "choose_source") {
    return { kind: "choose_source", actionLabel, sources: selection.sources.map(toResumeSourceOption) };
  }
  const stored = ownStoredUrl(item);
  if (stored && isValidUrl(stored)) return { kind: "canonical_url", url: stored, actionLabel, hostname: getSourceHostname(stored) ?? undefined };
  return { kind: "unavailable", reason: "no-target" };
}

// ============================================================
// Fixtures
// ============================================================
let idCounter = 0;
function makeItem(overrides = {}) {
  idCounter += 1;
  return {
    id: overrides.id ?? `item-${idCounter}`,
    type: "manga",
    title: `Item ${idCounter}`,
    description: "",
    category: "",
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "in_progress",
    ...overrides,
  };
}
function makeSource(overrides = {}) {
  return {
    id: "id" in overrides ? overrides.id : "source-1",
    adapterId: "adapterId" in overrides ? overrides.adapterId : "mangadex",
    sourceTitle: "sourceTitle" in overrides ? overrides.sourceTitle : "Some Title",
    sourceUrl: "sourceUrl" in overrides ? overrides.sourceUrl : "https://mangadex.org/title/abc",
    mediaType: "mediaType" in overrides ? overrides.mediaType : "manga",
    libraryItemId: "libraryItemId" in overrides ? overrides.libraryItemId : null,
    autoTrackEnabled: "autoTrackEnabled" in overrides ? overrides.autoTrackEnabled : true,
    lastDetectedProgress: "lastDetectedProgress" in overrides ? overrides.lastDetectedProgress : null,
    lastDetectedMetadata: overrides.lastDetectedMetadata,
    lastSeenAt: "lastSeenAt" in overrides ? overrides.lastSeenAt : "2026-01-01T00:00:00.000Z",
    autoLinkSuppressed: "autoLinkSuppressed" in overrides ? overrides.autoLinkSuppressed : false,
  };
}

// ============================================================
// A — source selection states (direct / choose_source / none)
// ============================================================
check("A1: zero eligible sources -> none", () => {
  assert.equal(selectContinueSource([], "i1").kind, "none");
});
check("A2: exactly one eligible source -> direct, trivially safe regardless of adapter", () => {
  const source = makeSource({ adapterId: "manual", libraryItemId: "i1" });
  const result = selectContinueSource([source], "i1");
  assert.equal(result.kind, "direct");
  assert.equal(result.source.id, source.id);
});
check("A3 (CRITICAL): several sources, all non-manual -> direct (last_seen_at is a genuine consumption signal for every candidate)", () => {
  const older = makeSource({ id: "a", libraryItemId: "i1", lastSeenAt: "2026-01-01T00:00:00.000Z" });
  const newer = makeSource({ id: "b", libraryItemId: "i1", lastSeenAt: "2026-02-01T00:00:00.000Z" });
  const result = selectContinueSource([older, newer], "i1");
  assert.equal(result.kind, "direct");
  assert.equal(result.source.id, "b");
});
check("A4 (CRITICAL): several sources, one of which is manual -> choose_source, never guess", () => {
  const manual = makeSource({ id: "m", adapterId: "manual", libraryItemId: "i1", lastSeenAt: "2026-06-01T00:00:00.000Z" });
  const ext = makeSource({ id: "e", libraryItemId: "i1", lastSeenAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(selectContinueSource([manual, ext], "i1").kind, "choose_source");
});
check("A5: two manual sources -> choose_source (recency between two 'added at' timestamps is not a consumption signal either)", () => {
  const a = makeSource({ id: "m1", adapterId: "manual", libraryItemId: "i1" });
  const b = makeSource({ id: "m2", adapterId: "manual", libraryItemId: "i1" });
  assert.equal(selectContinueSource([a, b], "i1").kind, "choose_source");
});
check("A6: ineligible sources (wrong item, unlinked, unsafe URL) never count toward eligibility or ambiguity", () => {
  const wrongItem = makeSource({ id: "w", libraryItemId: "i2" });
  const unlinked = makeSource({ id: "u", libraryItemId: null });
  const unsafe = makeSource({ id: "x", libraryItemId: "i1", sourceUrl: "javascript:x" });
  const onlyReal = makeSource({ id: "r", libraryItemId: "i1" });
  const result = selectContinueSource([wrongItem, unlinked, unsafe, onlyReal], "i1");
  assert.equal(result.kind, "direct");
  assert.equal(result.source.id, "r");
});
check("A7: selectBestTrackingSource (unchanged legacy helper) still trusts last_seen_at unconditionally — used only where that's already known to be safe, never by resolveResumeTarget's own ambiguity guard", () => {
  const manual = makeSource({ id: "m", adapterId: "manual", libraryItemId: "i1", lastSeenAt: "2026-06-01T00:00:00.000Z" });
  const ext = makeSource({ id: "e", libraryItemId: "i1", lastSeenAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(selectBestTrackingSource([manual, ext], "i1").id, "m", "documents the OLD helper's own unconditional behavior — resolveResumeTarget deliberately does not call it for the multi-source case");
});

// ============================================================
// B — action label engine (media type x status matrix)
// ============================================================
const TYPE_VERB = { anime: "watching", series: "watching", movie: "watching", manga: "reading", novel: "reading", game: "playing" };
check("B1: every trackable media type x every status produces the expected verb phrase, no fabricated status", () => {
  for (const type of Object.keys(TYPE_VERB)) {
    const verb = TYPE_VERB[type];
    assert.equal(getContinueActionLabel(makeItem({ type, status: "planned" })), `Start ${verb}`);
    assert.equal(getContinueActionLabel(makeItem({ type, status: "in_progress" })), `Continue ${verb}`);
    assert.equal(getContinueActionLabel(makeItem({ type, status: "on_hold" })), `Resume ${verb}`);
    assert.equal(getContinueActionLabel(makeItem({ type, status: "completed" })), "Open source");
    assert.equal(getContinueActionLabel(makeItem({ type, status: "dropped" })), "Open source");
  }
});
check("B2: website always 'Open website' regardless of any other field — matches the pre-existing exact copy", () => {
  assert.equal(getContinueActionLabel(makeItem({ type: "website", url: "https://example.com" })), "Open website");
});
check("B3 (§21/§23, CRITICAL): completed/dropped never say Continue/Resume — never claim unfinished work is ongoing", () => {
  assert.equal(getContinueActionLabel(makeItem({ type: "anime", status: "completed" })).startsWith("Continue"), false);
  assert.equal(getContinueActionLabel(makeItem({ type: "manga", status: "dropped" })).startsWith("Resume"), false);
});
check("B4 (§22): planned says Start, never Continue — nothing has been consumed yet", () => {
  assert.equal(getContinueActionLabel(makeItem({ type: "game", status: "planned" })), "Start playing");
});
check("B5: movie's own TRACKING_STATUS_OPTIONS only ever offers planned/completed through the UI, but the label engine still degrades sensibly if status is somehow in_progress/on_hold/dropped — never crashes, never a blank label", () => {
  assert.equal(getContinueActionLabel(makeItem({ type: "movie", status: "in_progress" })), "Continue watching");
  assert.equal(getContinueActionLabel(makeItem({ type: "movie", status: "on_hold" })), "Resume watching");
});

// ============================================================
// C — full resolveResumeTarget priority chain, per media type
// ============================================================
for (const type of ["anime", "manga", "novel", "game", "movie", "series"]) {
  check(`C-${type}: one eligible TrackingSource -> direct with the correct type-specific action label`, () => {
    const item = makeItem({ id: `i-${type}`, type, status: "in_progress" });
    const source = makeSource({ libraryItemId: item.id });
    const result = resolveResumeTarget(item, [source]);
    assert.equal(result.kind, "direct");
    assert.equal(result.actionLabel, `Continue ${TYPE_VERB[type]}`);
  });
  check(`C-${type}-canonical: zero TrackingSources but a valid own sourceUrl -> canonical_url, same action label`, () => {
    const item = makeItem({ id: `i-${type}-c`, type, status: "planned", sourceUrl: "https://myanimelist.net/x" });
    const result = resolveResumeTarget(item, []);
    assert.equal(result.kind, "canonical_url");
    assert.equal(result.actionLabel, `Start ${TYPE_VERB[type]}`);
  });
  check(`C-${type}-none: nothing at all -> unavailable`, () => {
    const item = makeItem({ id: `i-${type}-n`, type });
    assert.equal(resolveResumeTarget(item, []).kind, "unavailable");
  });
}
check("C-website: canonical_url via item.url, 'Open website' regardless of status (website has no status field)", () => {
  const item = { id: "w1", type: "website", title: "Site", url: "https://example.com", description: "", category: "", tags: [], favorite: false, createdAt: "2026-01-01T00:00:00.000Z" };
  const result = resolveResumeTarget(item, []);
  assert.equal(result.kind, "canonical_url");
  assert.equal(result.actionLabel, "Open website");
});
check("C-multi: several eligible sources incl. one manual -> choose_source, action label still present for the trigger button", () => {
  const item = makeItem({ id: "i-multi", type: "manga", status: "in_progress" });
  const manual = makeSource({ id: "m", adapterId: "manual", libraryItemId: item.id, lastSeenAt: "2026-06-01T00:00:00.000Z" });
  const ext = makeSource({ id: "e", libraryItemId: item.id, lastSeenAt: "2026-01-01T00:00:00.000Z" });
  const result = resolveResumeTarget(item, [manual, ext]);
  assert.equal(result.kind, "choose_source");
  assert.equal(result.actionLabel, "Continue reading");
  assert.equal(result.sources.length, 2);
});

// ============================================================
// D — URL safety at the resume boundary (defense in depth, never assume
// database content is trustworthy merely because it was validated before)
// ============================================================
check("D1 (CRITICAL): javascript:/data:/blob:/file: schemes never become a direct/canonical_url target", () => {
  for (const scheme of ["javascript:alert(1)", "data:text/html,x", "blob:https://x", "file:///etc/passwd"]) {
    const item = makeItem({ id: "i1" });
    const source = makeSource({ libraryItemId: "i1", sourceUrl: scheme });
    assert.equal(resolveResumeTarget(item, [source]).kind, "unavailable");
  }
});
check("D2 (CRITICAL): credential-bearing URLs rejected", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({ libraryItemId: "i1", sourceUrl: "https://user:pass@evil.example/x" });
  assert.equal(resolveResumeTarget(item, [source]).kind, "unavailable");
});
check("D3: an item's own manually-entered sourceUrl is validated exactly as strictly as any TrackingSource URL", () => {
  const item = makeItem({ id: "i1", sourceUrl: "javascript:alert(1)" });
  assert.equal(resolveResumeTarget(item, []).kind, "unavailable");
});

// ============================================================
// E — completed/planning/on-hold/dropped end-to-end through
// resolveResumeTarget (not just the label engine in isolation)
// ============================================================
check("E1: completed item with a linked source still gets a working direct target — sources are never hidden entirely, only the verb changes", () => {
  const item = makeItem({ id: "i1", status: "completed" });
  const source = makeSource({ libraryItemId: "i1" });
  const result = resolveResumeTarget(item, [source]);
  assert.equal(result.kind, "direct");
  assert.equal(result.actionLabel, "Open source");
});
check("E2: planning (not started) item with a source says Start, not Continue", () => {
  const item = makeItem({ id: "i1", status: "planned" });
  const source = makeSource({ libraryItemId: "i1" });
  assert.equal(resolveResumeTarget(item, [source]).actionLabel, "Start reading");
});
check("E3: on-hold item says Resume", () => {
  const item = makeItem({ id: "i1", type: "anime", status: "on_hold" });
  const source = makeSource({ libraryItemId: "i1" });
  assert.equal(resolveResumeTarget(item, [source]).actionLabel, "Resume watching");
});
check("E4: dropped item says Open source, not Resume", () => {
  const item = makeItem({ id: "i1", status: "dropped" });
  const source = makeSource({ libraryItemId: "i1" });
  assert.equal(resolveResumeTarget(item, [source]).actionLabel, "Open source");
});

// ============================================================
// F — unlinked/suppressed sources never leak into any resume result
// ============================================================
check("F1: an unlinked source (libraryItemId null) never becomes direct, choose_source, or otherwise visible to Continue", () => {
  const item = makeItem({ id: "i1" });
  const unlinked = makeSource({ libraryItemId: null, autoLinkSuppressed: true });
  assert.equal(resolveResumeTarget(item, [unlinked]).kind, "unavailable");
});
check("F2: autoLinkSuppressed on an otherwise-eligible (linked) row does not exclude it — suppression only matters for auto-RELINK eligibility, not for an already-linked row's own Continue eligibility (matches Stage 26/40's own invariant: a linked row's suppression is always cleared by linkSource)", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({ libraryItemId: "i1", autoLinkSuppressed: true });
  assert.equal(resolveResumeTarget(item, [source]).kind, "direct", "eligibility is driven by libraryItemId + safe URL only, exactly as selectContinueSource defines it");
});

// ============================================================
// G — "broken source" has no dedicated field in the current schema
// (Stage 41 audit finding) — a source with an invalid/unsafe URL is
// already excluded via getSafeOpenSourceUrl, which is the actual
// authoritative "can this be opened at all" signal.
// ============================================================
check("G1: a source with no parseable URL at all is excluded the same way an explicitly unsafe one is — there is no separate 'broken' flag to also check", () => {
  const item = makeItem({ id: "i1" });
  const source = makeSource({ libraryItemId: "i1", sourceUrl: null });
  assert.equal(resolveResumeTarget(item, [source]).kind, "unavailable");
});

// ============================================================
// H — canonical LibraryItem progress vs TrackingSource detection progress
// ============================================================
check("H1: resolveResumeTarget never reads or reports lastDetectedProgress as the canonical position — it only ever returns a URL/label/hostname/actionLabel, never a progress value of any kind", () => {
  const item = makeItem({ id: "i1", currentChapter: 5 });
  const source = makeSource({ libraryItemId: "i1", lastDetectedProgress: { kind: "chapter", value: 999 } });
  const result = resolveResumeTarget(item, [source]);
  assert.ok(!("progress" in result) && !("lastDetectedProgress" in result), "the engine must never surface a source's detection progress as if it were canonical");
});
check("H2: a chooser row's own progressText comes from the SOURCE's lastDetectedProgress only (context about that specific source), never from the canonical LibraryItem progress fields", () => {
  const manual = makeSource({ id: "m", adapterId: "manual", libraryItemId: "i1", lastDetectedProgress: null });
  const ext = makeSource({ id: "e", libraryItemId: "i1", lastDetectedProgress: { kind: "chapter", value: 12 } });
  const item = makeItem({ id: "i1", currentChapter: 999 });
  const result = resolveResumeTarget(item, [manual, ext]);
  assert.equal(result.kind, "choose_source");
  const extRow = result.sources.find((s) => s.sourceId === "e");
  assert.equal(extRow.progressText, "Chapter 12", "never the item's own currentChapter (999)");
});

// ============================================================
// I — manual vs. extension adapter distinction, direct regression
// coverage for this dedicated script (see also verify-dashboard-
// continue.mjs's own Section I, which covers the same finding from
// resolveResumeTarget's pre-existing call site).
// ============================================================
check("I1 (CRITICAL): manual source created 1 second ago is never preferred over an extension source genuinely used yesterday", () => {
  const item = makeItem({ id: "i1" });
  const usedYesterday = makeSource({ id: "used", libraryItemId: "i1", lastSeenAt: "2026-06-01T00:00:00.000Z" });
  const justAdded = makeSource({ id: "added", adapterId: "manual", libraryItemId: "i1", lastSeenAt: "2026-06-02T00:00:00.000Z" });
  const result = resolveResumeTarget(item, [usedYesterday, justAdded]);
  assert.equal(result.kind, "choose_source", "must not silently resolve to the just-added source");
});

// ============================================================
// J — no server-side fetch of any submitted/stored source URL anywhere in
// the resume engine or its UI consumers (static source-text audit).
// ============================================================
const RESUME_FILES = [
  "src/lib/resume.ts",
  "src/components/SourceChooserDialog.tsx",
];
check("J1 (CRITICAL): no file in the resume engine ever calls fetch() on a URL variable — no SSRF surface introduced by Continue/Resume", () => {
  for (const file of RESUME_FILES) {
    const source = stripComments(src(file));
    assert.ok(!/\bfetch\(/.test(source), `${file} must never call fetch() — Continue/Resume only selects/opens URLs, never server-fetches them`);
  }
});

// ============================================================
// K — no derived ResumeTarget/state is ever persisted (DB, localStorage,
// or otherwise) — it must be recomputed fresh every time, so merge and
// recovery/undo naturally produce a correct answer with zero source-
// specific code of their own.
// ============================================================
check("K1: lib/resume.ts contains no write of any kind — no supabase client, no localStorage, no fetch POST/PUT/PATCH — it is pure computation over its arguments only", () => {
  const source = stripComments(src("src/lib/resume.ts"));
  assert.ok(!/localStorage|sessionStorage|supabase|method:\s*["']POST["']|method:\s*["']PUT["']/i.test(source));
});
check("K2: resolveResumeTarget/selectContinueSource take the current items/sources as plain function arguments — no internal cache, no module-level mutable state that could go stale after a merge or recovery/undo", () => {
  const source = stripComments(src("src/lib/resume.ts"));
  assert.ok(!/^\s*let\s+\w+\s*=/m.test(source.replace(/CONTINUE_VERB[\s\S]*?\};/, "")), "no top-level mutable `let` binding used as a cache");
});

// ============================================================
// L — Dashboard, Item Detail, Reminders, and Source Hub all import the
// SAME engine — the exact architectural bug this stage's Phase 0 audit
// found (Item Detail's own pre-Stage-41 `media?.sourceUrl` primitive,
// bypassing TrackingSources entirely; Library's card overflow menu doing
// the same via LibraryItemActions).
// ============================================================
check("L1 (CRITICAL): DashboardView imports resolveResumeTarget from lib/resume, not a local reimplementation", () => {
  const source = src("src/components/DashboardView.tsx");
  assert.ok(/from "@\/lib\/resume"/.test(source));
  assert.ok(/resolveResumeTarget/.test(source));
});
check("L2 (CRITICAL): ItemDetailView imports resolveResumeTarget from lib/resume and no longer reads media?.sourceUrl directly as its primary action", () => {
  const source = stripComments(src("src/components/ItemDetailView.tsx"));
  assert.ok(/from "@\/lib\/resume"/.test(source));
  assert.ok(!/const externalUrl = item\.type === "website" \? item\.url : media\?\.sourceUrl/.test(source), "the old bypass-TrackingSources primitive must be gone");
});
check("L3: ReminderCenterView imports resolveResumeTarget from lib/resume (moved from lib/dashboard)", () => {
  const source = src("src/components/ReminderCenterView.tsx");
  assert.ok(/from "@\/lib\/resume"/.test(source));
});
check("L4 (Stage 41.1, CRITICAL): ItemTrackingSourcesSection's 'most recently used' badge uses selectRecentlyUsedSource from lib/resume — NOT selectContinueSource, and not a second, hand-rolled recency comparison. Using selectContinueSource directly was the exact bug this correction fixes (it let a single manual source's direct resolution earn a usage badge it had no evidence for).", () => {
  const source = src("src/components/ItemTrackingSourcesSection.tsx");
  assert.ok(/from "@\/lib\/resume"/.test(source));
  assert.ok(/selectRecentlyUsedSource/.test(source));
  assert.ok(!/selectContinueSource/.test(source), "must not import/call the determinism-only function directly for the badge");
});
check("L5: lib/dashboard.ts no longer defines its own ResumeTarget/resolveResumeTarget/selectBestTrackingSource — moved out entirely, not merely re-exported, so every import site visibly points at the real general-purpose home", () => {
  const source = src("src/lib/dashboard.ts");
  assert.ok(!/export function resolveResumeTarget/.test(source));
  assert.ok(!/export function selectBestTrackingSource/.test(source));
  assert.ok(!/export interface ResumeTarget/.test(source));
});

// ============================================================
// M — source chooser: explicit selection only, secure external opening,
// no management controls (opening != managing).
// ============================================================
check("M1: SourceChooserDialog's rows are safe external links — target=_blank, rel=noopener noreferrer, same policy as every other source-open action in Markly", () => {
  const source = src("src/components/SourceChooserDialog.tsx");
  assert.ok(/target="_blank"/.test(source) && /rel="noopener noreferrer"/.test(source));
});
check("M2: SourceChooserDialog has no unlink/enable/disable/add-source control — it is an opening affordance only, never a second Source Hub", () => {
  const source = stripComments(src("src/components/SourceChooserDialog.tsx"));
  assert.ok(!/unlink|toggleAutoTrack|AddSourceDialog/i.test(source));
});
check("M3: selecting a chooser row never calls any tracking-sources mutation endpoint — opening a source must never write a 'preferred source' anywhere (no such column exists, Stage 41 does not add one)", () => {
  const source = stripComments(src("src/components/SourceChooserDialog.tsx"));
  assert.ok(!/\/api\/tracking-sources/.test(source));
});

// ============================================================
// N — local-mode fallback (tracking_sources is cloud-only; a local item
// can still resume via its own stored sourceUrl).
// ============================================================
check("N1: a media item with its own sourceUrl and ZERO TrackingSources (the only possible state in local/signed-out mode) still resolves to a usable canonical_url target", () => {
  const item = makeItem({ id: "i1", sourceUrl: "https://myanimelist.net/manga/1" });
  const result = resolveResumeTarget(item, []); // local mode: trackingSources is always []
  assert.equal(result.kind, "canonical_url");
  assert.equal(result.url, "https://myanimelist.net/manga/1");
});
check("N2: a local media item with no sourceUrl at all -> unavailable, never a fabricated TrackingSource-shaped answer", () => {
  const item = makeItem({ id: "i1" });
  assert.equal(resolveResumeTarget(item, []).kind, "unavailable");
});

// ============================================================
// O — merge/recovery: the engine is computed fresh from whatever
// items/sources are passed in — a caller re-running it after a merge
// (surviving item's own updated source list) or an undo (restored item)
// naturally gets a correct answer with no Stage-41-specific merge code.
// ============================================================
check("O1: calling resolveResumeTarget twice with two DIFFERENT sources arrays for the same item id produces two independently-correct answers — proves there is no hidden memoization keyed only on item.id that could serve a stale answer after a merge changed which sources are linked", () => {
  const item = makeItem({ id: "i1" });
  const before = resolveResumeTarget(item, []);
  const afterMerge = resolveResumeTarget(item, [makeSource({ libraryItemId: "i1" })]);
  assert.equal(before.kind, "unavailable");
  assert.equal(afterMerge.kind, "direct", "the exact same item id now resolves differently once the merge's surviving sources are passed in — nothing was cached from the first call");
});

// ============================================================
// P — no migration 0019 (Stage 41 requires no schema change).
// ============================================================
check("P1: no migration 0019 (or beyond) exists — Stage 41 required no schema change", () => {
  const migrations = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
  assert.equal(migrations[migrations.length - 1], "0018_stage40_backup_item_map.sql");
});

// ============================================================
// Q — catalogSource is never misused as a resume source (structural: it
// has no url field at all, confirmed against the real type definition).
// ============================================================
check("Q1: CatalogSourceReference has no url field — resolveResumeTarget could not read one even if it tried", () => {
  const source = src("src/types/library-item.ts");
  const match = source.match(/export interface CatalogSourceReference \{([\s\S]*?)\}/);
  assert.ok(match, "CatalogSourceReference must still exist");
  assert.ok(!/url/i.test(match[1]), "must never gain a url field — that would reopen the exact misuse this stage's audit ruled out");
});
check("Q2: resolveResumeTarget's own source file never reads .catalogSource at all", () => {
  const source = stripComments(src("src/lib/resume.ts"));
  assert.ok(!/catalogSource/.test(source));
});

// ============================================================
// R — a Continue/chooser click never mutates progress or writes Activity
// (opening != consuming).
// ============================================================
check("R1: SourceChooserDialog never calls any progress-mutation function (quickIncrementProgress, updateTracking, logEvent, etc.)", () => {
  const source = stripComments(src("src/components/SourceChooserDialog.tsx"));
  assert.ok(!/quickIncrement|updateTracking|logEvent|setStatus/i.test(source));
});
check("R2: ItemDetailView's new primary-action block does not call any progress-mutating handler — it only renders a link/button driven by resumeTarget", () => {
  const source = stripComments(src("src/components/ItemDetailView.tsx"));
  const start = source.indexOf('resumeTarget.kind === "direct"');
  const end = source.indexOf("media && (", start);
  const block = source.slice(start, end === -1 ? start + 1500 : end);
  assert.ok(!/quickIncrementProgress\(|updateTracking\(/.test(block));
});

// ============================================================
// S — Stage 41.1: resume DETERMINISM vs usage EVIDENCE are separate
// questions. selectContinueSource's "direct" kind answers only "can
// Markly deterministically open this" — a single manual source answers
// that "yes" trivially, since there's nothing to disambiguate it against.
// selectRecentlyUsedSource answers a strictly narrower question: "do we
// have genuine detection-recency evidence this exact source was used".
// The Source Hub badge must consult ONLY the latter — these tests are the
// six cases the Stage 41.1 correction explicitly requires (A-F).
// ============================================================
check("S-A: one manual source -> Continue is direct, but selectRecentlyUsedSource returns null (no badge) — a source added a moment ago must never claim 'most recently used'", () => {
  const manual = makeSource({ id: "m", adapterId: "manual", libraryItemId: "i1" });
  assert.equal(selectContinueSource([manual], "i1").kind, "direct", "resume determinism: unaffected by this correction");
  assert.equal(selectRecentlyUsedSource([manual], "i1"), null, "usage evidence: a manual timestamp proves nothing about actual use");
});
check("S-B: one non-manual (genuinely detected) source -> direct, and badge IS allowed on that source", () => {
  const ext = makeSource({ id: "e", adapterId: "mangadex", libraryItemId: "i1" });
  const result = selectRecentlyUsedSource([ext], "i1");
  assert.ok(result !== null);
  assert.equal(result.id, "e");
});
check("S-C: two non-manual sources -> the newest genuine detection is selected for the badge, and only that one", () => {
  const older = makeSource({ id: "e1", libraryItemId: "i1", lastSeenAt: "2026-01-01T00:00:00.000Z" });
  const newer = makeSource({ id: "e2", libraryItemId: "i1", lastSeenAt: "2026-02-01T00:00:00.000Z" });
  const result = selectRecentlyUsedSource([older, newer], "i1");
  assert.equal(result.id, "e2", "the newer genuine detection wins the badge");
});
check("S-D: manual + non-manual -> choose_source, and selectRecentlyUsedSource returns null (no badge on either row)", () => {
  const manual = makeSource({ id: "m", adapterId: "manual", libraryItemId: "i1", lastSeenAt: "2026-06-01T00:00:00.000Z" });
  const ext = makeSource({ id: "e", libraryItemId: "i1", lastSeenAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(selectContinueSource([manual, ext], "i1").kind, "choose_source");
  assert.equal(selectRecentlyUsedSource([manual, ext], "i1"), null);
});
check("S-E: two manual sources -> choose_source, and selectRecentlyUsedSource returns null (no badge)", () => {
  const a = makeSource({ id: "m1", adapterId: "manual", libraryItemId: "i1" });
  const b = makeSource({ id: "m2", adapterId: "manual", libraryItemId: "i1" });
  assert.equal(selectContinueSource([a, b], "i1").kind, "choose_source");
  assert.equal(selectRecentlyUsedSource([a, b], "i1"), null);
});
check("S-F (CRITICAL): a manual source created/linked MORE RECENTLY than a genuinely-used extension source still yields no badge — the chooser appears, and the manual source's fresher creation timestamp must never be mistaken for 'most recently used'", () => {
  const freshManual = makeSource({ id: "m", adapterId: "manual", libraryItemId: "i1", lastSeenAt: "2026-09-01T00:00:00.000Z" });
  const olderButRealUse = makeSource({ id: "e", libraryItemId: "i1", lastSeenAt: "2026-01-01T00:00:00.000Z" });
  const continueResult = selectContinueSource([freshManual, olderButRealUse], "i1");
  assert.equal(continueResult.kind, "choose_source", "ambiguous — the fresher manual timestamp must not silently win Continue either");
  assert.equal(selectRecentlyUsedSource([freshManual, olderButRealUse], "i1"), null, "and certainly must not win the usage-evidence badge");
});
check("S-G: selectRecentlyUsedSource never itself changes selectContinueSource's own result — it is a pure read-only refinement layered on top, never a redesign of source-selection rule 5 (§5 of the correction: 'resume engine must remain unchanged unless necessary')", () => {
  const scenarios = [
    [makeSource({ id: "m", adapterId: "manual", libraryItemId: "i1" })],
    [makeSource({ id: "e1", libraryItemId: "i1" }), makeSource({ id: "e2", libraryItemId: "i1", lastSeenAt: "2026-03-01T00:00:00.000Z" })],
    [makeSource({ id: "m", adapterId: "manual", libraryItemId: "i1" }), makeSource({ id: "e", libraryItemId: "i1" })],
  ];
  for (const sources of scenarios) {
    const before = JSON.stringify(selectContinueSource(sources, "i1"));
    selectRecentlyUsedSource(sources, "i1");
    const after = JSON.stringify(selectContinueSource(sources, "i1"));
    assert.equal(before, after);
  }
});

// ============================================================
// T — Stage 41.2: single-source-of-truth synchronization contract. A live
// production test found that ItemDetailView and ItemTrackingSourcesSection
// each independently fetched and held their OWN copy of this item's
// TrackingSources — Add Source / Unlink updated only the section's local
// copy, so ItemDetailView's own primary Continue/Resume button could keep
// showing a stale (or missing) target until a full reload. The fix makes
// ItemTrackingSourcesSection a controlled component: ItemDetailView owns
// the one fetch/state and passes it down as `sources`, and every
// mutation is reported back up through `onSourcesChange` rather than
// kept in a second local state. These are static/structural checks
// (same convention as this script's own Section L) — they cannot spin up
// a real DOM, so E/F/G below instead re-run the actual production
// `resolveResumeTarget` against the exact sequence of arrays the
// component code now produces on each mutation, proving the state
// transitions the live architecture relies on actually recompute
// correctly.
// ============================================================
const itemDetailSource = stripComments(src("src/components/ItemDetailView.tsx"));
const sectionSourceText = stripComments(src("src/components/ItemTrackingSourcesSection.tsx"));

check("T-A (CRITICAL): ItemDetailView owns the one TrackingSource fetch/state and passes it down as the `sources` prop — ItemTrackingSourcesSection no longer fetches on mount", () => {
  assert.ok(/const \[trackingSources, setTrackingSources\] = useState/.test(itemDetailSource), "ItemDetailView must own the shared trackingSources state");
  assert.ok(/<ItemTrackingSourcesSection[\s\S]{0,200}sources=\{trackingSources\}/.test(itemDetailSource), "must pass the owned state down as `sources`");
  assert.ok(!/useEffect[\s\S]{0,300}fetch\(`\/api\/tracking-sources\?libraryItemId=/.test(sectionSourceText), "ItemTrackingSourcesSection must no longer have its own mount-time fetch of this item's sources — that was the duplicate-fetch bug");
});

check("T-B (CRITICAL): a successful Add/Link source outcome reports the fresh list up via onSourcesChange, not a local setState", () => {
  assert.ok(!/const \[sources, setSources\] = useState/.test(sectionSourceText), "the section must no longer hold its own independent sources state");
  const addBlock = sectionSourceText.slice(sectionSourceText.indexOf("function handleAddSourceOutcome"));
  assert.ok(/onSourcesChange\(data\.sources\)/.test(addBlock), "the post-add refresh must hand its result to the parent via onSourcesChange");
});

check("T-C (CRITICAL): a successful Unlink reports the filtered list up via onSourcesChange", () => {
  const unlinkBlock = sectionSourceText.slice(sectionSourceText.indexOf("async function unlink("), sectionSourceText.indexOf("function handleAddSourceOutcome"));
  assert.ok(/onSourcesChange\(previous\.filter/.test(unlinkBlock), "unlink's success path must report the updated list to the parent, not a local setSources call");
});

check("T-D: ItemDetailView's resolveResumeTarget call reads from the exact same trackingSources state onSourcesChange/setTrackingSources updates — one variable, one source of truth", () => {
  assert.ok(/resolveResumeTarget\(item, trackingSources \?\? \[\]\)/.test(itemDetailSource));
  assert.ok(/onSourcesChange=\{setTrackingSources\}/.test(itemDetailSource), "the callback passed down must be the very setter that feeds resolveResumeTarget, not a second, disconnected setter");
});

check("T-E: zero -> one source transition recomputes unavailable/canonical_url -> direct, using the exact array-update shape the component performs after a successful Add", () => {
  const item = makeItem({ id: "sync1", type: "manga", status: "in_progress" });
  const before = resolveResumeTarget(item, []);
  assert.equal(before.kind, "unavailable");
  const afterAdd = [makeSource({ id: "manual-a", adapterId: "manual", libraryItemId: "sync1", sourceTitle: "Manual A", sourceUrl: "https://example.com/a" })];
  const after = resolveResumeTarget(item, afterAdd);
  assert.equal(after.kind, "direct");
});

check("T-F: one manual -> two manual recomputes direct -> choose_source, using the append shape the component performs after a second successful Add", () => {
  const item = makeItem({ id: "sync2", type: "manga", status: "in_progress" });
  const manualA = makeSource({ id: "manual-a", adapterId: "manual", libraryItemId: "sync2", sourceUrl: "https://example.com/a" });
  const before = resolveResumeTarget(item, [manualA]);
  assert.equal(before.kind, "direct");
  const manualB = makeSource({ id: "manual-b", adapterId: "manual", libraryItemId: "sync2", sourceUrl: "https://example.com/b" });
  const after = resolveResumeTarget(item, [manualA, manualB]);
  assert.equal(after.kind, "choose_source");
});

check("T-G: two manual -> one manual recomputes choose_source -> direct, using the exact `previous.filter(source => source.id !== sourceId)` shape unlink() performs", () => {
  const item = makeItem({ id: "sync3", type: "manga", status: "in_progress" });
  const manualA = makeSource({ id: "manual-a", adapterId: "manual", libraryItemId: "sync3", sourceUrl: "https://example.com/a" });
  const manualB = makeSource({ id: "manual-b", adapterId: "manual", libraryItemId: "sync3", sourceUrl: "https://example.com/b" });
  const previous = [manualA, manualB];
  const before = resolveResumeTarget(item, previous);
  assert.equal(before.kind, "choose_source");
  const afterUnlinkB = previous.filter((source) => source.id !== "manual-b");
  const after = resolveResumeTarget(item, afterUnlinkB);
  assert.equal(after.kind, "direct");
  assert.equal(after.url, "https://example.com/a");
});

check("T-H: the Stage 41.1 badge rule is unaffected by this synchronization fix — same selectRecentlyUsedSource, now simply operating on the shared array instead of a duplicated one", () => {
  const manualOnly = [makeSource({ id: "m", adapterId: "manual", libraryItemId: "sync4" })];
  assert.equal(selectRecentlyUsedSource(manualOnly, "sync4"), null);
  const twoManual = [
    makeSource({ id: "m1", adapterId: "manual", libraryItemId: "sync4" }),
    makeSource({ id: "m2", adapterId: "manual", libraryItemId: "sync4" }),
  ];
  assert.equal(selectRecentlyUsedSource(twoManual, "sync4"), null);
});

check("T-I (CRITICAL): no page reload / router hard-refresh is used as a synchronization workaround anywhere in either file", () => {
  for (const source of [itemDetailSource, sectionSourceText]) {
    assert.ok(!/window\.location\.reload|router\.refresh\(\)|location\.href\s*=/.test(source), "must never rely on a reload to pick up fresh source state");
  }
});

check("T-J (CRITICAL): no global custom-event or localStorage synchronization hack was introduced", () => {
  for (const source of [itemDetailSource, sectionSourceText]) {
    assert.ok(!/dispatchEvent|CustomEvent|addEventListener\(\s*["']storage["']|localStorage/.test(source), "must use plain React props/state, not a global signaling mechanism");
  }
});

// ============================================================
// U — Stage 41.3: refresh-failure safety gate. The Stage 41.2 sync fix
// eliminated staleness on the SUCCESS path (add/unlink recompute the
// primary Continue action live, no reload) but left one edge case open:
// once a server mutation genuinely succeeds, the one deliberate follow-up
// GET (see handleAddSourceOutcome) could itself fail — and up to now the
// parent would just keep treating its OLD, now-unverified array as
// authoritative. The fix: the parent's source state is invalidated to
// `null` the MOMENT the mutation is known to have succeeded, before the
// GET even starts — not only in its `.catch()`. `null` already meant
// "unknown" for initial loading, so ItemDetailView's existing
// `resolveResumeTarget(item, trackingSources ?? [])` fallback naturally
// stops offering a (possibly stale) direct/choose_source target the
// instant invalidation happens, with zero change to the resume engine
// itself. These are static/structural + pure-function tests, same
// convention as Section T.
// ============================================================

check("U-A (CRITICAL): a successful Add/Link invalidates the parent (onSourcesChange(null)) BEFORE the reconciling GET is issued — not only if that GET later fails", () => {
  const branch = sectionSourceText.slice(sectionSourceText.indexOf("function handleAddSourceOutcome"), sectionSourceText.indexOf('if (outcome.status === "already-linked")'));
  const invalidateIndex = branch.indexOf("onSourcesChange(null)");
  const fetchIndex = branch.indexOf("fetch(`/api/tracking-sources?libraryItemId=");
  assert.ok(invalidateIndex !== -1, "must call onSourcesChange(null) somewhere in the created/linked branch");
  assert.ok(fetchIndex !== -1, "the reconciling GET must still be present");
  assert.ok(invalidateIndex < fetchIndex, "invalidation must happen BEFORE the GET starts, so a slow or failing GET is never covering for a silently-stale array");
});

check("U-B: successful Add + GET success installs the new array — resolveResumeTarget recomputes from it normally (pure re-run, same as T-E/T-F)", () => {
  const item = makeItem({ id: "u1", type: "manga", status: "in_progress" });
  let trackingSources = null; // invalidated the moment the mutation succeeded
  assert.equal(resolveResumeTarget(item, trackingSources ?? []).kind, "unavailable", "while unknown, no stale target is offered");
  trackingSources = [makeSource({ id: "a", adapterId: "manual", libraryItemId: "u1", sourceUrl: "https://example.com/a" })]; // GET succeeded
  assert.equal(resolveResumeTarget(item, trackingSources ?? []).kind, "direct");
});

check("U-C (CRITICAL): successful Add + GET failure — parent stays unknown, and the OLD direct target cannot remain active", () => {
  const item = makeItem({ id: "u2", type: "manga", status: "in_progress" });
  const manualA = makeSource({ id: "a", adapterId: "manual", libraryItemId: "u2", sourceUrl: "https://example.com/a" });
  // Before the mutation: one source, direct target.
  const before = resolveResumeTarget(item, [manualA]);
  assert.equal(before.kind, "direct");
  assert.equal(before.url, "https://example.com/a");
  // Mutation (adding manualB) succeeds server-side -> parent invalidated to null immediately.
  const invalidated = null;
  // The reconciling GET fails -> parent stays at null (never reinstates [manualA], never learns about manualB either).
  const stillInvalidated = invalidated;
  const after = resolveResumeTarget(item, stillInvalidated ?? []);
  assert.notEqual(after.kind, "direct", "must never keep exposing the pre-mutation direct target as authoritative");
  assert.equal(after.kind, "unavailable", "safe behavior: omit the external Continue action rather than fabricate or guess one");
});

check("U-D: successful Relink (outcome.status === \"linked\") goes through the exact same invalidate-then-refetch branch as \"created\" — no separate, unaudited relink code path", () => {
  const fnBody = sectionSourceText.slice(sectionSourceText.indexOf("function handleAddSourceOutcome"), sectionSourceText.indexOf("if (outcome.status === \"already-linked\")"));
  assert.ok(/outcome\.status === "created" \|\| outcome\.status === "linked"/.test(fnBody), "created and linked must share one branch");
  const invalidateIndex = fnBody.indexOf("onSourcesChange(null)");
  const branchConditionIndex = fnBody.indexOf('outcome.status === "created"');
  assert.ok(branchConditionIndex !== -1 && invalidateIndex !== -1 && invalidateIndex > branchConditionIndex, "the shared branch (covering both created and linked) must contain the invalidation");
});

check("U-E: a POST Add failure never reaches handleAddSourceOutcome at all, so onSourcesChange(null) is never called and the parent's old state is retained by construction", () => {
  const dialogSource = stripComments(src("src/components/AddSourceDialog.tsx"));
  const submitFn = dialogSource.slice(dialogSource.indexOf("async function handleSubmit"));
  const guardIndex = submitFn.indexOf('if (!response.ok || !outcome || "error" in outcome)');
  const onLinkedIndex = submitFn.indexOf("onLinked(outcome)");
  assert.ok(guardIndex !== -1 && onLinkedIndex !== -1 && guardIndex < onLinkedIndex, "the failure guard (with its own early return) must come before onLinked is ever called — a failed POST can never trigger invalidation");
});

check("U-F: Unlink success still updates state immediately via a local filter — no GET, no invalidation-to-null, since the resulting list is already fully known client-side", () => {
  const unlinkBlock = sectionSourceText.slice(sectionSourceText.indexOf("async function unlink("), sectionSourceText.indexOf("function handleAddSourceOutcome"));
  assert.ok(/onSourcesChange\(previous\.filter/.test(unlinkBlock));
  assert.ok(!/fetch\(`\/api\/tracking-sources\?libraryItemId=/.test(unlinkBlock), "unlink must not perform the reconciling GET — its outcome is already fully known locally");
  assert.ok(!/onSourcesChange\(null\)/.test(unlinkBlock), "unlink must not invalidate to unknown — nothing about its success is uncertain");
});

check("U-G (CRITICAL): ItemDetailView never computes a Continue target directly from a possibly-null trackingSources — it always goes through the `?? []` fallback that treats unknown as \"nothing to offer\", never as \"keep what we last knew\"", () => {
  assert.ok(/resolveResumeTarget\(item, trackingSources \?\? \[\]\)/.test(itemDetailSource));
  assert.ok(!/resolveResumeTarget\(item, trackingSources\)/.test(itemDetailSource.replace(/resolveResumeTarget\(item, trackingSources \?\? \[\]\)/g, "")), "must not have a second call site that skips the fallback");
});

check("U-H: initial loading is still represented by the exact same single `useState<...| null>(null)` this whole mechanism already used in Stage 41.2 — no second flag (e.g. a separate 'hasLoadedOnce' boolean) was added merely to distinguish loading from post-mutation-unknown, keeping the state machine as small as the correction requires", () => {
  const matches = itemDetailSource.match(/const \[trackingSources, setTrackingSources\] = useState/g) ?? [];
  assert.equal(matches.length, 1, "exactly one trackingSources state declaration");
  assert.ok(!/hasLoadedOnce|hasFetchedOnce|isSourcesStale/i.test(itemDetailSource), "no extra staleness-tracking flag was introduced — null alone still carries the full meaning");
});

check("U-I: the Stage 41.1 badge rule is still untouched by this refresh-failure correction — same selectRecentlyUsedSource, unrelated to source-list freshness handling", () => {
  const single = [makeSource({ id: "m", adapterId: "manual", libraryItemId: "u3" })];
  assert.equal(selectRecentlyUsedSource(single, "u3"), null);
});

check("U-J: the new invalidation call itself is plain React state (onSourcesChange(null)) — not a reload, router.refresh, global event, or polling loop", () => {
  assert.ok(!/window\.location\.reload|router\.refresh\(\)|location\.href\s*=|dispatchEvent|CustomEvent|setInterval/.test(sectionSourceText));
});

// ============================================================
// V — Stage 41.4: unknown-state canonical-fallback safety gate.
// `resolveResumeTarget(item, trackingSources ?? [])` alone conflates two
// different meanings of `trackingSources === null`:
//   - "an authoritative fetch confirmed zero linked sources" ([]) — which
//     legitimately unlocks the engine's own item.sourceUrl canonical_url
//     fallback.
//   - "we do not yet/no longer know the real TrackingSource set" (null) —
//     still loading, or a mutation succeeded but its reconciling GET
//     failed (Stage 41.3) — where that same fallback would leak through
//     as an authoritative-looking resume target while the truth might
//     actually be ambiguous (e.g. mid-reconciliation after a second
//     source was added server-side).
// ItemDetailView's own `sourceStateUnknown` gate (deliberately NOT inside
// lib/resume.ts — this is UI-consumer loading-state handling, not a
// resume-engine concern) suppresses the external action in exactly that
// window, for authenticated trackable media only. Reproduced verbatim
// here for pure testing, same convention as every other section.
// ============================================================
function computeItemDetailResumeTarget(item, userId, trackingSources) {
  const media = isMediaItem(item) ? item : null;
  const sourceStateUnknown = userId !== null && media !== null && trackingSources === null;
  if (sourceStateUnknown) return { kind: "unavailable", reason: "no-target" };
  return resolveResumeTarget(item, trackingSources ?? []);
}
function makeWebsiteItem(overrides = {}) {
  idCounter += 1;
  return {
    id: overrides.id ?? `website-${idCounter}`,
    type: "website",
    title: `Site ${idCounter}`,
    description: "",
    category: "",
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    url: "https://example.com",
    ...overrides,
  };
}

check("V-A (CRITICAL): authenticated media, trackingSources = null, item.sourceUrl present -> NO external resume action (the exact bug: a stale-looking canonical_url must not leak through while the source state is unknown)", () => {
  const item = makeItem({ id: "v1", sourceUrl: "https://myanimelist.net/manga/1" });
  const result = computeItemDetailResumeTarget(item, "user-1", null);
  assert.equal(result.kind, "unavailable");
  // Confirms the raw engine itself WOULD have returned canonical_url here — proving the gate, not the engine, is what changed.
  assert.equal(resolveResumeTarget(item, []).kind, "canonical_url", "sanity check: without the gate this exact input would leak a canonical_url target");
});

check("V-B: authenticated media, trackingSources = [] (authoritatively confirmed empty), same item.sourceUrl -> canonical_url allowed", () => {
  const item = makeItem({ id: "v2", sourceUrl: "https://myanimelist.net/manga/1" });
  const result = computeItemDetailResumeTarget(item, "user-1", []);
  assert.equal(result.kind, "canonical_url");
  assert.equal(result.url, "https://myanimelist.net/manga/1");
});

check("V-C: authenticated media, trackingSources = null, no item.sourceUrl -> unavailable either way, but for the RIGHT reason (unknown state, not merely 'no sources')", () => {
  const item = makeItem({ id: "v3" });
  assert.equal(computeItemDetailResumeTarget(item, "user-1", null).kind, "unavailable");
});

check("V-D: website item -> Open website works regardless of TrackingSource state (null, [], or anything else) — websites never read the second argument at all", () => {
  const item = makeWebsiteItem({ id: "v4", url: "https://example.com/site" });
  for (const trackingSources of [null, [], [makeSource({ libraryItemId: "v4" })]]) {
    const result = computeItemDetailResumeTarget(item, "user-1", trackingSources);
    assert.equal(result.kind, "canonical_url");
    assert.equal(result.actionLabel, "Open website");
  }
});

check("V-E: signed-out/local media (userId = null) with a safe sourceUrl -> existing canonical fallback still works, even though trackingSources is permanently null for local mode", () => {
  const item = makeItem({ id: "v5", sourceUrl: "https://myanimelist.net/manga/2" });
  const result = computeItemDetailResumeTarget(item, null, null);
  assert.equal(result.kind, "canonical_url", "local mode must NOT be caught by the unknown-state gate — null there means 'not applicable', not 'not yet known'");
});

check("V-F: authenticated media, initial loading (trackingSources still null on first render) -> no canonical-url flash before the fetch resolves", () => {
  const item = makeItem({ id: "v6", sourceUrl: "https://myanimelist.net/manga/3" });
  // First render, before the mount effect's fetch has resolved.
  assert.equal(computeItemDetailResumeTarget(item, "user-1", null).kind, "unavailable");
});

check("V-G (CRITICAL): a successful Add invalidates the parent to null -> canonical sourceUrl cannot leak through while reconciling, even though the item itself still has a perfectly valid sourceUrl", () => {
  const item = makeItem({ id: "v7", sourceUrl: "https://myanimelist.net/manga/4" });
  const beforeMutation = computeItemDetailResumeTarget(item, "user-1", []); // zero sources, authoritatively known
  assert.equal(beforeMutation.kind, "canonical_url");
  const duringReconciliation = computeItemDetailResumeTarget(item, "user-1", null); // Add succeeded -> invalidated to null
  assert.equal(duringReconciliation.kind, "unavailable", "must not keep offering the canonical fallback just because the item itself still has a sourceUrl");
});

check("V-H: failed reconciliation keeps trackingSources at null -> canonical sourceUrl remains suppressed for as long as it stays null", () => {
  const item = makeItem({ id: "v8", sourceUrl: "https://myanimelist.net/manga/5" });
  const stillNullAfterFailedGet = null;
  assert.equal(computeItemDetailResumeTarget(item, "user-1", stillNullAfterFailedGet).kind, "unavailable");
});

check("V-I: successful reconciliation to [] (genuinely zero sources confirmed) -> canonical fallback becomes available again if the item has one", () => {
  const item = makeItem({ id: "v9", sourceUrl: "https://myanimelist.net/manga/6" });
  assert.equal(computeItemDetailResumeTarget(item, "user-1", []).kind, "canonical_url");
});

check("V-J: successful reconciliation to a real source array -> direct/chooser behavior is completely unchanged by this gate (it only ever affects the null case)", () => {
  const item = makeItem({ id: "v10", type: "manga", status: "in_progress" });
  const oneSource = [makeSource({ id: "s1", libraryItemId: "v10" })];
  assert.equal(computeItemDetailResumeTarget(item, "user-1", oneSource).kind, "direct");
  const twoManual = [
    makeSource({ id: "m1", adapterId: "manual", libraryItemId: "v10" }),
    makeSource({ id: "m2", adapterId: "manual", libraryItemId: "v10" }),
  ];
  assert.equal(computeItemDetailResumeTarget(item, "user-1", twoManual).kind, "choose_source");
});

check("V-K: badge semantics (Stage 41.1) are completely untouched by this consumer-side gate — selectRecentlyUsedSource never sees userId or the gate at all", () => {
  const single = [makeSource({ id: "m", adapterId: "manual", libraryItemId: "v11" })];
  assert.equal(selectRecentlyUsedSource(single, "v11"), null);
});

check("V-L (CRITICAL): ItemDetailView's actual source file contains the sourceStateUnknown gate and uses it to guard the real resumeTarget computation — not just this test's reproduction", () => {
  assert.ok(/const sourceStateUnknown = userId !== null && media !== null && trackingSources === null/.test(itemDetailSource));
  assert.ok(/const resumeTarget: ResumeTarget = sourceStateUnknown/.test(itemDetailSource));
});

check("V-M: the initial-fetch failure handler in ItemDetailView now leaves/resets trackingSources to null (unknown), never [] (falsely-confirmed-empty) — the same conflation this whole correction targets, fixed at its other occurrence in the same effect", () => {
  const effectBlock = itemDetailSource.slice(itemDetailSource.indexOf("useEffect(() => {", itemDetailSource.indexOf("const [trackingSources, setTrackingSources]")), itemDetailSource.indexOf("if (!library.isHydrated)"));
  assert.ok(/\.catch\(\(\) => \{\s*if \(!cancelled\) setTrackingSources\(null\);/.test(effectBlock), "a failed initial fetch must not be promoted to a false 'confirmed zero' result");
});

check("V-N: this gate does not touch selectContinueSource, selectRecentlyUsedSource, or resolveResumeTarget themselves — it lives entirely in ItemDetailView, the consumer, per the correction's own explicit instruction not to encode UI loading state in the pure resume engine", () => {
  const resumeLibSource = stripComments(src("src/lib/resume.ts"));
  assert.ok(!/sourceStateUnknown/.test(resumeLibSource), "the gate must not have been pushed down into lib/resume.ts");
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
