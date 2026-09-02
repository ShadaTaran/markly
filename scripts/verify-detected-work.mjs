#!/usr/bin/env node
// Verifies the Stage 20 "detected-work fallback" logic:
//   - src/lib/extension/detected-item.ts (buildDetectedMediaInput,
//     buildDetectedTrackingValues)
//   - src/lib/metadata/catalog-item.ts (inferReadingFormatFromCatalog)
//   - the CatalogTrackingForm add-mode status-inference rule those feed
//     into (reproduced here, not imported, since it's private to that
//     component) — this is what actually turns "progress prefilled" into
//     "status = in_progress" for a catalog-hit add (Test A)
//   - the busy-guard pattern used by handleAddDetectedWork/
//     createAndLinkItem to make a duplicate click a no-op (Test G)
//
// Reproduced verbatim from the real modules rather than imported, since
// they're TS files with path-alias imports not directly runnable under
// plain Node — same approach as the other scripts in this directory. Keep
// this in sync if the real implementations change.
//
// Run with: node scripts/verify-detected-work.mjs

import assert from "node:assert/strict";

// --- inferReadingFormatFromCatalog, from src/lib/metadata/catalog-item.ts ---
function inferReadingFormatFromCatalog(provider) {
  if (provider === "anilist") return "light_novel";
  if (provider === "open-library") return "book";
  return undefined;
}

// --- buildDetectedTrackingValues / buildDetectedMediaInput, from src/lib/extension/detected-item.ts ---
const TRACKING_STATUS_OPTIONS_HAS_IN_PROGRESS = {
  anime: true,
  series: true,
  manga: true,
  novel: true,
  game: true,
  movie: false, // movie only ever offers planned/completed
};

function normalizeDetectedProgressUnit(kind) {
  return kind === "page" || kind === "percent" ? kind : "chapter";
}

function initialStatusFor(mediaType) {
  return TRACKING_STATUS_OPTIONS_HAS_IN_PROGRESS[mediaType] ? "in_progress" : "planned";
}

function buildDetectedTrackingValues(mediaType, progress) {
  if (!progress) return {};
  switch (mediaType) {
    case "anime":
    case "series":
      return progress.kind === "episode" ? { currentEpisode: progress.value } : {};
    case "manga":
      return progress.kind === "chapter" ? { currentChapter: progress.value } : {};
    case "novel":
      return { progressValue: progress.value, progressUnit: normalizeDetectedProgressUnit(progress.kind) };
    case "game":
      return progress.kind === "playtime" ? { playtimeHours: progress.value } : {};
    case "movie":
      return {};
  }
}

function buildDetectedMediaInput(source) {
  const common = {
    title: source.sourceTitle,
    sourceUrl: source.sourceUrl ?? undefined,
    status: initialStatusFor(source.mediaType),
    catalogSource: undefined,
  };
  const progress = source.lastDetectedProgress;
  if (source.mediaType === "novel") {
    return {
      ...common,
      progressValue: progress?.value,
      progressUnit: normalizeDetectedProgressUnit(progress?.kind),
      readingFormat: "web_novel",
    };
  }
  if (source.mediaType === "anime" || source.mediaType === "series") {
    return { ...common, currentEpisode: progress?.kind === "episode" ? progress.value : undefined };
  }
  return common;
}

// --- CatalogTrackingForm's add-mode status inference, from src/components/CatalogTrackingForm.tsx ---
function catalogAddModeStatus(mediaType, hasProgress) {
  return hasProgress && TRACKING_STATUS_OPTIONS_HAS_IN_PROGRESS[mediaType] ? "in_progress" : "planned";
}

// --- busy-guard pattern, from handleAddDetectedWork/createAndLinkItem in TrackingSettingsPanel.tsx ---
function createRunner() {
  let busy = null;
  const calls = [];
  return {
    async run(sourceId) {
      if (busy !== null) return "skipped"; // mirrors `if (!addLinkSource || busy !== null) return;`
      busy = `add-link-${sourceId}`;
      calls.push(sourceId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      busy = null;
      return "ran";
    },
    calls,
  };
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

async function main() {
  // --- Test A: catalog hit (AniList light novel, detected progress 40) ---
  {
    const provider = inferReadingFormatFromCatalog("anilist");
    check("A: AniList catalog result infers readingFormat 'light_novel'", () => {
      assert.equal(provider, "light_novel");
    });

    const tracking = buildDetectedTrackingValues("novel", { kind: "chapter", value: 40 });
    check("A: detected progress (chapter 40) prefills CatalogTrackingForm's initial values", () => {
      assert.deepEqual(tracking, { progressValue: 40, progressUnit: "chapter" });
    });

    const hasProgress = (tracking.progressValue ?? 0) > 0;
    const status = catalogAddModeStatus("novel", hasProgress);
    check("A: prefilled non-zero progress makes CatalogTrackingForm's own add-mode inference land on in_progress", () => {
      assert.equal(status, "in_progress");
    });
  }

  // --- Test B/C: web novel / no catalog result — detected-work fallback ---
  {
    const source = {
      mediaType: "novel",
      sourceTitle: "Lord of the Mysteries",
      sourceUrl: "https://novelphoenix.com/novel/lord-of-the-mysteries/chapter-235",
      lastDetectedProgress: { kind: "chapter", value: 235 },
    };
    const input = buildDetectedMediaInput(source);

    check("B/C: title is the detected title verbatim, never blank/retyped", () => {
      assert.equal(input.title, "Lord of the Mysteries");
    });
    check("C: mediaType-appropriate progress field is set to the detected value (235)", () => {
      assert.equal(input.progressValue, 235);
      assert.equal(input.progressUnit, "chapter");
    });
    check("C: status is in_progress (Reading), not planned", () => {
      assert.equal(input.status, "in_progress");
    });
    check("C: readingFormat is suggested as web_novel (never asserted for a catalog-backed item)", () => {
      assert.equal(input.readingFormat, "web_novel");
      assert.equal(input.catalogSource, undefined);
    });
  }

  // --- Test F: catalog totally down must not block the detected-work fallback ---
  {
    // buildDetectedMediaInput's signature takes only a TrackingSourceSummary
    // — no MetadataDetails, no provider, nothing catalog-shaped — so it is
    // structurally incapable of depending on catalog availability.
    const source = {
      mediaType: "novel",
      sourceTitle: "The Perfect Run",
      sourceUrl: null,
      lastDetectedProgress: { kind: "chapter", value: 50 },
    };
    const input = buildDetectedMediaInput(source);
    check("F: detected-work fallback works with no sourceUrl and needs no catalog data at all", () => {
      assert.equal(input.title, "The Perfect Run");
      assert.equal(input.progressValue, 50);
      assert.equal(input.status, "in_progress");
    });
  }

  // --- Test G: duplicate/concurrent Add & Track clicks ---
  await checkAsync("G: two concurrent calls collapse into exactly one actual run", async () => {
    const runner = createRunner();
    const [first, second] = await Promise.all([runner.run("source-1"), runner.run("source-1")]);
    const outcomes = [first, second].sort();
    assert.deepEqual(outcomes, ["ran", "skipped"]);
    assert.deepEqual(runner.calls, ["source-1"]);
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}`);
    if (!r.ok) console.log(`  ${r.err.message}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
