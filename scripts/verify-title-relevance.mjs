#!/usr/bin/env node
// Verifies src/lib/metadata/relevance.ts's calculateTitleRelevance /
// partitionByRelevance against the exact real-world bug report: searching
// "Lord of the Mysteries" against Open Library returned unrelated mystery
// novels (Whose Body?, Lord Edgware Dies, Gaudy Night, The Seven Dials
// Mystery) that must not be presented as likely matches, while genuinely
// close variants and valid volume/subtitle results must not be
// over-filtered.
//
// Reproduced verbatim from the real module (see its own header comment
// for why: same server-only/client-safe split reasoning used elsewhere in
// this scripts/ directory). Keep in sync if it changes.
//
// Run with: node scripts/verify-title-relevance.mjs

import assert from "node:assert/strict";

function normalizeForComparison(text) {
  return text
    .normalize("NFKC")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‒–—―]/g, "-")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function stripPunctuation(text) {
  return text.replace(/['".,:;!?()[\]{}-]/g, "").replace(/\s+/g, " ").trim();
}

const VOLUME_SUFFIX_PATTERN = /\b(?:vol(?:ume)?|book|bk|part)\.?\s*\d+\b.*$/i;

function stripVolumeSuffix(text) {
  return text.replace(VOLUME_SUFFIX_PATTERN, "").trim();
}

const RELEVANCE_STOP_WORDS = new Set(["a", "an", "the"]);

function significantWords(text) {
  return text.split(" ").filter((word) => word.length > 0 && !RELEVANCE_STOP_WORDS.has(word));
}

function isOrderedPrefix(shorter, longer) {
  if (shorter.length === 0 || shorter.length > longer.length) return false;
  return shorter.every((word, index) => longer[index] === word);
}

function calculateTitleRelevance(query, resultTitle) {
  const normQuery = normalizeForComparison(query);
  const normResult = normalizeForComparison(resultTitle);
  if (normQuery === normResult) return "exact";

  const cleanQuery = stripPunctuation(normQuery);
  const cleanResult = stripPunctuation(normResult);

  const queryNoVolume = stripVolumeSuffix(cleanQuery);
  const resultNoVolume = stripVolumeSuffix(cleanResult);
  if (queryNoVolume === resultNoVolume) return "exact";

  const queryWords = significantWords(queryNoVolume);
  const resultWords = significantWords(resultNoVolume);
  if (queryWords.length === 0 || resultWords.length === 0) return "unrelated";

  if (isOrderedPrefix(queryWords, resultWords) || isOrderedPrefix(resultWords, queryWords)) {
    return "close";
  }

  const overlapCount = queryWords.filter((word) => resultWords.includes(word)).length;
  const unionSize = new Set([...queryWords, ...resultWords]).size;
  const jaccard = overlapCount / unionSize;
  return jaccard >= 0.6 ? "close" : "unrelated";
}

const RELEVANCE_RANK = { exact: 0, close: 1, unrelated: 2 };

function partitionByRelevance(query, results, getTitle) {
  const scored = results.map((result) => ({ result, relevance: calculateTitleRelevance(query, getTitle(result)) }));
  const relevant = scored
    .filter((entry) => entry.relevance !== "unrelated")
    .sort((a, b) => RELEVANCE_RANK[a.relevance] - RELEVANCE_RANK[b.relevance])
    .map((entry) => entry.result);
  const unrelated = scored.filter((entry) => entry.relevance === "unrelated").map((entry) => entry.result);
  return { relevant, unrelated };
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

// --- The exact reported bug scenario ---
{
  const query = "Lord of the Mysteries";
  const openLibraryResults = ["Whose Body?", "Lord Edgware Dies", "Gaudy Night", "The Seven Dials Mystery"];

  for (const title of openLibraryResults) {
    check(`bug repro: "${title}" is classified unrelated to "${query}"`, () => {
      assert.equal(calculateTitleRelevance(query, title), "unrelated");
    });
  }

  const { relevant, unrelated } = partitionByRelevance(query, openLibraryResults, (t) => t);
  check("bug repro: all 4 fuzzy Open Library results land in the unrelated bucket", () => {
    assert.equal(relevant.length, 0);
    assert.equal(unrelated.length, 4);
  });
}

// --- Exact / near-exact ---
check("exact: identical title", () => {
  assert.equal(calculateTitleRelevance("Lord of the Mysteries", "Lord of the Mysteries"), "exact");
});
check("exact: case/whitespace/punctuation-only differences", () => {
  assert.equal(calculateTitleRelevance("lord of the mysteries", "  Lord   of   the   Mysteries  "), "exact");
});
check("exact: differs only by a volume marker (Vol.)", () => {
  assert.equal(calculateTitleRelevance("Mushoku Tensei", "Mushoku Tensei, Vol. 1"), "exact");
});
check("exact: differs only by a volume marker (Volume, no comma)", () => {
  assert.equal(calculateTitleRelevance("Mushoku Tensei", "Mushoku Tensei Volume 3"), "exact");
});

// --- Close (related but not exact) ---
check("close: missing leading article ('the')", () => {
  assert.equal(calculateTitleRelevance("Lord of the Mysteries", "Lord of Mysteries"), "close");
});
check("close: result has additional real subtitle content", () => {
  assert.equal(calculateTitleRelevance("Mushoku Tensei", "Mushoku Tensei: Jobless Reincarnation"), "close");
});
check("close: longer query, shorter canonical result", () => {
  assert.equal(calculateTitleRelevance("Mushoku Tensei Jobless Reincarnation", "Mushoku Tensei"), "close");
});

// --- Unrelated, including a plausible false-positive trap ---
check("unrelated: one shared incidental word among otherwise different titles", () => {
  assert.equal(calculateTitleRelevance("Lord Edgware Dies", "Lord of the Mysteries"), "unrelated");
});
check("unrelated: shared common words inside an otherwise long, different title (false-positive trap)", () => {
  assert.equal(calculateTitleRelevance("The Perfect Run", "How to Run a Perfect Business"), "unrelated");
});
check("unrelated: completely different titles", () => {
  assert.equal(calculateTitleRelevance("Gaudy Night", "The Seven Dials Mystery"), "unrelated");
});

// --- partitionByRelevance ordering (exact before close, unrelated set aside) ---
{
  const query = "Mushoku Tensei";
  const catalogTitles = [
    "Mushoku Tensei: Jobless Reincarnation", // close
    "Mushoku Tensei", // exact
    "Whose Body?", // unrelated
    "Mushoku Tensei, Vol. 1", // exact (volume variant)
  ];
  const { relevant, unrelated } = partitionByRelevance(query, catalogTitles, (t) => t);
  check("partition: exact results sort ahead of close results", () => {
    assert.deepEqual(relevant, ["Mushoku Tensei", "Mushoku Tensei, Vol. 1", "Mushoku Tensei: Jobless Reincarnation"]);
  });
  check("partition: unrelated result set aside, not dropped", () => {
    assert.deepEqual(unrelated, ["Whose Body?"]);
  });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}`);
  if (!r.ok) console.log(`  ${r.err.message}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
