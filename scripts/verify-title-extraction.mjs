#!/usr/bin/env node
// Verifies extractWorkTitleFromLabel in
// extension/src/tracking/universal/detect.ts — the Stage 19 fix for
// real-world page labels that carry more than just the work title (a
// chapter marker, often a chapter name and/or the site's own name too).
//
// Reproduced verbatim below (see the file header comment there) since the
// real module lives inside a larger file with no standalone export
// surface convenient for a plain-Node script; keep this in sync if it
// changes. Cases marked "real" are the exact strings captured from
// https://novelphoenix.com during Stage 19 manual testing (2 novels, 3
// chapter URLs) — see the Stage 19 report for the live detectUniversal()
// run against the actual pages, which this only covers the title-cleaning
// slice of.
//
// Run with: node scripts/verify-title-extraction.mjs

const TITLE_SEGMENT_SEPARATOR = /\s+[-|:–—]\s+/;
const INLINE_PROGRESS_PATTERN = /\bch(?:apter)?\.?\s*\d+\b|\bep(?:isode)?\.?\s*\d+\b/i;

function extractWorkTitleFromLabel(text) {
  const segments = text.split(TITLE_SEGMENT_SEPARATOR);
  for (let i = 0; i < segments.length; i++) {
    const match = segments[i].match(INLINE_PROGRESS_PATTERN);
    if (!match || match.index === undefined) continue;
    const before = segments[i].slice(0, match.index).trim();
    if (before.length > 0) return [...segments.slice(0, i), before].join(" - ").trim();
    if (i === 0) return (segments[i + 1] ?? "").trim();
    return segments.slice(0, i).join(" - ").trim();
  }
  return text.trim();
}

const cases = [
  // From the Stage 18 spec.
  ["Lord of Mysteries - Chapter 234", "Lord of Mysteries"],
  ["Chapter 234 | Lord of Mysteries", "Lord of Mysteries"],
  ["Lord of Mysteries Ch. 234", "Lord of Mysteries"],
  // From the Stage 19 spec.
  ["Lord of Mysteries - Chapter 235", "Lord of Mysteries"],
  ["Lord of Mysteries Chapter 235 - NovelPhoenix", "Lord of Mysteries"],
  ["Chapter 235 - Lord of Mysteries - Novel Phoenix", "Lord of Mysteries"],
  // Real strings captured from novelphoenix.com (Stage 19 manual testing).
  ["Lord of the Mysteries - Chapter 1 - Crimson - Novel Phoenix", "Lord of the Mysteries"],
  ["Lord of the Mysteries - Chapter 2 - Situation - Novel Phoenix", "Lord of the Mysteries"],
  ["Reverend Insanity - Chapter 100 - 100: White Jade Gu - Novel Phoenix", "Reverend Insanity"],
  // Must never treat a plain trailing number as a chapter marker.
  ["Lord of Mysteries 2", "Lord of Mysteries 2"],
  ["Kill the Sun Season 2", "Kill the Sun Season 2"],
  // No marker at all — returned unchanged.
  ["Lord of Mysteries", "Lord of Mysteries"],
];

const results = [];
for (const [input, expected] of cases) {
  const actual = extractWorkTitleFromLabel(input);
  const ok = actual === expected;
  results.push({ input, expected, actual, ok });
  console.log(`${ok ? "PASS" : "FAIL"} — "${input}" -> "${actual}"${ok ? "" : ` (expected "${expected}")`}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
