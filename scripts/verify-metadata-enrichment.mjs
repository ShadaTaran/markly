#!/usr/bin/env node
// Verifies the Stage 21 "safe detected metadata enrichment" logic:
//   - extension/src/tracking/universal/detected-metadata.ts (the
//     extension-side boilerplate filter, site-identity author filter,
//     and size/count bounds)
//   - src/lib/extension/detected-metadata.ts (the server-side,
//     authoritative re-validation of the same payload)
//   - src/lib/extension/enrichment.ts (enrichLibraryItemIfSparse's
//     fill-empty-only merge policy, including the readingFormat
//     suggestion's catalogSource guard)
//
// Reproduced verbatim from the real modules rather than imported, since
// they're TS files with path-alias/server-only imports not directly
// runnable under plain Node — same approach as the other scripts in this
// directory. Keep this in sync if the real implementations change.
//
// Run with: node scripts/verify-metadata-enrichment.mjs

import assert from "node:assert/strict";

const MAX_URL_LENGTH = 2000;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_AUTHORS = 5;
const MAX_AUTHOR_LENGTH = 100;
const MAX_GENRES = 8;
const MAX_GENRE_LENGTH = 40;

// --- extension/src/tracking/universal/detected-metadata.ts ---

function extBoundedHttpUrl(raw, baseUrl) {
  if (!raw) return undefined;
  try {
    const resolved = new URL(raw, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return undefined;
    const value = resolved.toString();
    return value.length > MAX_URL_LENGTH ? undefined : value;
  } catch {
    return undefined;
  }
}

function isLikelyBoilerplateDescription(description) {
  return /^read\b/i.test(description.trim());
}

function extBoundedDescription(raw) {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || isLikelyBoilerplateDescription(trimmed)) return undefined;
  return trimmed.length > MAX_DESCRIPTION_LENGTH ? trimmed.slice(0, MAX_DESCRIPTION_LENGTH) : trimmed;
}

function extBoundedAuthors(candidates, siteIdentity) {
  const seen = new Set();
  const authors = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (siteIdentity && trimmed.toLowerCase() === siteIdentity.toLowerCase()) continue;
    const bounded = trimmed.length > MAX_AUTHOR_LENGTH ? trimmed.slice(0, MAX_AUTHOR_LENGTH) : trimmed;
    const key = bounded.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    authors.push(bounded);
    if (authors.length >= MAX_AUTHORS) break;
  }
  return authors.length > 0 ? authors : undefined;
}

function extBoundedGenres(candidates) {
  const seen = new Set();
  const genres = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const bounded = trimmed.length > MAX_GENRE_LENGTH ? trimmed.slice(0, MAX_GENRE_LENGTH) : trimmed;
    const key = bounded.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    genres.push(bounded);
    if (genres.length >= MAX_GENRES) break;
  }
  return genres.length > 0 ? genres : undefined;
}

// --- src/lib/extension/detected-metadata.ts (server-side re-validation) ---

function parseHttpUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parseDescription(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, MAX_DESCRIPTION_LENGTH) : undefined;
}

function parseStringList(value, maxItems, maxItemLength) {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set();
  const items = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().slice(0, maxItemLength);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(trimmed);
    if (items.length >= maxItems) break;
  }
  return items.length > 0 ? items : undefined;
}

function parseDetectedMetadata(raw) {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw;

  const workUrl = parseHttpUrl(candidate.workUrl);
  const coverUrl = parseHttpUrl(candidate.coverUrl);
  const description = parseDescription(candidate.description);
  const authors = parseStringList(candidate.authors, MAX_AUTHORS, MAX_AUTHOR_LENGTH);
  const genres = parseStringList(candidate.genres, MAX_GENRES, MAX_GENRE_LENGTH);

  if (!workUrl && !coverUrl && !description && !authors && !genres) return null;

  return {
    ...(workUrl && { workUrl }),
    ...(coverUrl && { coverUrl }),
    ...(description && { description }),
    ...(authors && { authors }),
    ...(genres && { genres }),
  };
}

// --- src/lib/extension/enrichment.ts (fill-empty-only merge policy) ---

function enrichPatch(current, metadata) {
  const patched = { ...current };
  let changed = false;

  if (!patched.imageUrl && metadata?.coverUrl) {
    patched.imageUrl = metadata.coverUrl;
    changed = true;
  }
  if (!patched.sourceUrl && metadata?.workUrl) {
    patched.sourceUrl = metadata.workUrl;
    changed = true;
  }
  if (!patched.description && metadata?.description) {
    patched.description = metadata.description;
    changed = true;
  }
  if ((patched.type === "novel" || patched.type === "manga") && (!patched.authors || patched.authors.length === 0) && metadata?.authors) {
    patched.authors = metadata.authors;
    changed = true;
  }
  if ("genres" in patched && (!patched.genres || patched.genres.length === 0) && metadata?.genres) {
    patched.genres = metadata.genres;
    changed = true;
  }
  if (patched.type === "novel" && !patched.readingFormat && !patched.catalogSource) {
    patched.readingFormat = "web_novel";
    changed = true;
  }

  return { patched, changed };
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

function main() {
  const baseUrl = new URL("https://novelphoenix.com/novel/lord-of-the-mysteries/chapter-52");

  // --- boilerplate description filter (real observed NovelPhoenix strings) ---
  check("boilerplate: 'Read Chapter 52 - ... online for free' is filtered", () => {
    assert.equal(extBoundedDescription("Read Chapter 52 - Spectator - Lord of the Mysteries online for free"), undefined);
  });
  check("boilerplate: 'Read Lord of the Mysteries novel online free at NovelPhoenix...' is filtered", () => {
    assert.equal(extBoundedDescription("Read Lord of the Mysteries novel online free at NovelPhoenix in Mobile, Tablet..."), undefined);
  });
  check("boilerplate: a genuine synopsis is kept", () => {
    assert.equal(
      extBoundedDescription("A duke stumbles upon a mysterious diary and is drawn into a world of gods and steam."),
      "A duke stumbles upon a mysterious diary and is drawn into a world of gods and steam.",
    );
  });
  check("boilerplate: description over 500 chars is truncated, not rejected", () => {
    const long = "A".repeat(600);
    const result = extBoundedDescription(long);
    assert.equal(result.length, MAX_DESCRIPTION_LENGTH);
  });
  check("boilerplate: empty/whitespace description yields undefined", () => {
    assert.equal(extBoundedDescription("   "), undefined);
    assert.equal(extBoundedDescription(null), undefined);
  });

  // --- site-identity author filter (real observed NovelPhoenix meta author = site name) ---
  check("author filter: site's own name ('Novel Phoenix') is excluded", () => {
    assert.equal(extBoundedAuthors(["Novel Phoenix"], "Novel Phoenix"), undefined);
  });
  check("author filter: site-name match is case-insensitive", () => {
    assert.equal(extBoundedAuthors(["novel phoenix"], "Novel Phoenix"), undefined);
  });
  check("author filter: a real author distinct from the site name is kept", () => {
    assert.deepEqual(extBoundedAuthors(["Cuttlefish That Loves Diving"], "Novel Phoenix"), ["Cuttlefish That Loves Diving"]);
  });
  check("author filter: case-insensitive dedupe keeps first occurrence", () => {
    assert.deepEqual(extBoundedAuthors(["Cai Yuan", "cai yuan", "Cai Yuan"], null), ["Cai Yuan"]);
  });
  check("author filter: more than MAX_AUTHORS candidates are truncated to the cap", () => {
    const many = Array.from({ length: 8 }, (_, i) => `Author ${i}`);
    const result = extBoundedAuthors(many, null);
    assert.equal(result.length, MAX_AUTHORS);
    assert.deepEqual(result, many.slice(0, MAX_AUTHORS));
  });
  check("author filter: an over-length name is truncated, not dropped", () => {
    const long = "B".repeat(150);
    const result = extBoundedAuthors([long], null);
    assert.equal(result[0].length, MAX_AUTHOR_LENGTH);
  });

  // --- genre dedupe/bounds ---
  check("genres: case-insensitive dedupe keeps first occurrence", () => {
    assert.deepEqual(extBoundedGenres(["Fantasy", "fantasy", "Fantasy"]), ["Fantasy"]);
  });
  check("genres: more than MAX_GENRES candidates are truncated to the cap", () => {
    const many = Array.from({ length: 12 }, (_, i) => `Genre${i}`);
    assert.equal(extBoundedGenres(many).length, MAX_GENRES);
  });
  check("genres: an over-length genre is truncated, not dropped", () => {
    const long = "G".repeat(60);
    assert.equal(extBoundedGenres([long])[0].length, MAX_GENRE_LENGTH);
  });
  check("genres: empty candidate list yields undefined, not []", () => {
    assert.equal(extBoundedGenres([]), undefined);
  });

  // --- URL bounds (extension side) ---
  check("url: http/https accepted", () => {
    assert.equal(extBoundedHttpUrl("https://novelphoenix.com/novel/lord-of-the-mysteries", baseUrl), "https://novelphoenix.com/novel/lord-of-the-mysteries");
  });
  check("url: relative path resolved against the page's own URL", () => {
    assert.equal(extBoundedHttpUrl("/novel/lord-of-the-mysteries", baseUrl), "https://novelphoenix.com/novel/lord-of-the-mysteries");
  });
  check("url: javascript: scheme is rejected", () => {
    assert.equal(extBoundedHttpUrl("javascript:alert(1)", baseUrl), undefined);
  });
  check("url: data: scheme is rejected", () => {
    assert.equal(extBoundedHttpUrl("data:text/html,<script>", baseUrl), undefined);
  });
  check("url: oversized URL is rejected outright (not truncated — a truncated URL wouldn't resolve)", () => {
    const huge = "https://novelphoenix.com/" + "a".repeat(MAX_URL_LENGTH);
    assert.equal(extBoundedHttpUrl(huge, baseUrl), undefined);
  });
  check("url: malformed input never throws", () => {
    // An unterminated IPv6-style host is invalid even as an absolute URL
    // and throws from the URL constructor itself (not just a bad relative
    // resolution) — the try/catch must swallow it and return undefined.
    assert.equal(extBoundedHttpUrl("http://[not-valid", baseUrl), undefined);
  });

  // --- server-side parseDetectedMetadata: abuse/oversized-payload handling ---
  check("server: null/non-object body yields null (no enrichment, no crash)", () => {
    assert.equal(parseDetectedMetadata(null), null);
    assert.equal(parseDetectedMetadata("a string"), null);
    assert.equal(parseDetectedMetadata(42), null);
  });
  check("server: entirely empty object yields null", () => {
    assert.equal(parseDetectedMetadata({}), null);
  });
  check("server: non-string entries in an authors array are dropped, not crashed on", () => {
    const result = parseDetectedMetadata({ authors: ["Real Author", 12345, null, { evil: true }] });
    assert.deepEqual(result.authors, ["Real Author"]);
  });
  check("server: a malicious webpage cannot cause an arbitrarily large write — genres array is capped", () => {
    const manyGenres = Array.from({ length: 500 }, (_, i) => `Genre ${i}`);
    const result = parseDetectedMetadata({ genres: manyGenres });
    assert.equal(result.genres.length, MAX_GENRES);
  });
  check("server: an oversized description is trimmed, not rejected wholesale", () => {
    const result = parseDetectedMetadata({ description: "C".repeat(10000) });
    assert.equal(result.description.length, MAX_DESCRIPTION_LENGTH);
  });
  check("server: a non-http(s) workUrl (e.g. file:) is rejected", () => {
    const result = parseDetectedMetadata({ workUrl: "file:///etc/passwd", description: "kept anyway" });
    assert.equal(result.workUrl, undefined);
    assert.equal(result.description, "kept anyway");
  });
  check("server: a fully valid payload round-trips all five fields", () => {
    const result = parseDetectedMetadata({
      workUrl: "https://novelphoenix.com/novel/lord-of-the-mysteries",
      coverUrl: "https://novelphoenix.com/covers/lotm.jpg",
      description: "A duke investigates the occult in a world on the edge of an industrial revolution.",
      authors: ["Cuttlefish That Loves Diving"],
      genres: ["Fantasy", "Mystery"],
    });
    assert.equal(result.workUrl, "https://novelphoenix.com/novel/lord-of-the-mysteries");
    assert.equal(result.coverUrl, "https://novelphoenix.com/covers/lotm.jpg");
    assert.ok(result.description.startsWith("A duke investigates"));
    assert.deepEqual(result.authors, ["Cuttlefish That Loves Diving"]);
    assert.deepEqual(result.genres, ["Fantasy", "Mystery"]);
  });

  // --- enrichment merge policy: Test A (rich new/sparse item gets filled) ---
  // NovelItem has no `genres` field in the type system at all (see
  // types/library-item.ts) — only anime/series/manga/movie carry genres —
  // so a novel's enrichment intentionally never touches it; that's
  // asserted explicitly below rather than assumed.
  check("merge A: a completely sparse novel item is filled from full metadata", () => {
    const sparse = { type: "novel", title: "Lord of the Mysteries" };
    const metadata = {
      coverUrl: "https://novelphoenix.com/covers/lotm.jpg",
      workUrl: "https://novelphoenix.com/novel/lord-of-the-mysteries",
      description: "A duke investigates the occult.",
      authors: ["Cuttlefish That Loves Diving"],
      genres: ["Fantasy"],
    };
    const { patched, changed } = enrichPatch(sparse, metadata);
    assert.equal(changed, true);
    assert.equal(patched.imageUrl, metadata.coverUrl);
    assert.equal(patched.sourceUrl, metadata.workUrl);
    assert.equal(patched.description, metadata.description);
    assert.deepEqual(patched.authors, metadata.authors);
    assert.equal(patched.genres, undefined);
    assert.equal(patched.readingFormat, "web_novel");
  });
  check("merge A2: a sparse manga item's genres ARE filled (manga does carry genres)", () => {
    // fromLibraryItemRow always sets `genres: readStringArray(...)` as an
    // explicit key (possibly undefined) for manga — mirrored here so the
    // "genres" in patched check below matches the real object shape.
    const sparse = { type: "manga", title: "X", genres: undefined };
    const { patched, changed } = enrichPatch(sparse, { genres: ["Action", "Fantasy"] });
    assert.equal(changed, true);
    assert.deepEqual(patched.genres, ["Action", "Fantasy"]);
  });

  // --- merge policy: Test D (user-entered value is preserved, never overwritten) ---
  check("merge D: an existing user-entered imageUrl is never overwritten by detected coverUrl", () => {
    const item = { type: "novel", title: "Lord of the Mysteries", imageUrl: "https://usersite.example/my-own-cover.jpg" };
    const { patched } = enrichPatch(item, { coverUrl: "https://novelphoenix.com/covers/lotm.jpg" });
    assert.equal(patched.imageUrl, "https://usersite.example/my-own-cover.jpg");
  });
  check("merge D: existing authors are never overwritten by detected authors", () => {
    // readingFormat is pre-set here specifically so its own independent
    // suggestion branch can't fire and muddy this test's `changed`
    // assertion — see the dedicated readingFormat tests below for that.
    const item = { type: "novel", title: "X", authors: ["User-Entered Author"], readingFormat: "book" };
    const { patched, changed } = enrichPatch(item, { authors: ["Detected Author"] });
    assert.deepEqual(patched.authors, ["User-Entered Author"]);
    assert.equal(changed, false);
  });

  // --- merge policy: Test G (catalog-created item's readingFormat isn't guessed at) ---
  check("merge G: catalogSource present blocks the readingFormat guess even when empty", () => {
    const item = { type: "novel", title: "X", catalogSource: "anilist" };
    const { patched, changed } = enrichPatch(item, null);
    assert.equal(patched.readingFormat, undefined);
    assert.equal(changed, false);
  });
  check("merge: readingFormat is suggested even with metadata=null, as long as no catalogSource", () => {
    const item = { type: "novel", title: "X" };
    const { patched, changed } = enrichPatch(item, null);
    assert.equal(patched.readingFormat, "web_novel");
    assert.equal(changed, true);
  });
  check("merge: readingFormat is never touched once already set", () => {
    const item = { type: "novel", title: "X", readingFormat: "book" };
    const { patched, changed } = enrichPatch(item, null);
    assert.equal(patched.readingFormat, "book");
    assert.equal(changed, false);
  });

  // --- merge policy: manga authors also fillable, non-novel/manga types never get an authors field ---
  check("merge: manga authors fillable from metadata just like novel", () => {
    const item = { type: "manga", title: "X" };
    const { patched } = enrichPatch(item, { authors: ["Some Mangaka"] });
    assert.deepEqual(patched.authors, ["Some Mangaka"]);
  });
  check("merge: an item type with no genres field at all (e.g. game) is left untouched by genre metadata", () => {
    const item = { type: "game", title: "X" };
    const { patched, changed } = enrichPatch(item, { genres: ["Action"] });
    assert.equal("genres" in patched, false);
    assert.equal(changed, false);
  });

  // --- exactly-once / no-op path: nothing to fill means no write at all ---
  check("merge: a fully populated item with no gaps produces changed=false (no DB write, no Activity)", () => {
    const item = {
      type: "manga",
      title: "X",
      imageUrl: "https://a/cover.jpg",
      sourceUrl: "https://a/work",
      description: "d",
      authors: ["A"],
      genres: ["G"],
    };
    const { changed } = enrichPatch(item, {
      coverUrl: "https://b/other-cover.jpg",
      workUrl: "https://b/other-work",
      description: "other",
      authors: ["B"],
      genres: ["H"],
    });
    assert.equal(changed, false);
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
