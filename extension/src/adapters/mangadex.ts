import type { TrackingAdapter } from "./types";
import { parseProgressText } from "../tracking/universal/progress";
import { buildDetectedMetadata } from "../tracking/universal/detected-metadata";

/**
 * Stage 23 — why MangaDex needs a real adapter, not just a site-capability
 * media-type hint (see tracking/universal/site-capability.ts for that
 * separate, narrower concept): a live reader page
 * (mangadex.org/chapter/<uuid>) has ZERO h1/h2 elements anywhere (verified
 * directly — its reader renders the chapter title into a plain,
 * unlabeled <div>, not a heading), and its URL carries a chapter UUID with
 * no numeric chapter segment at all, so url.ts's pattern matching finds
 * nothing there either. That leaves only two of universal detection's four
 * primary signals able to fire (document.title, og:title) — 20 + 15 = 35
 * weight, below the 55-point CONFIDENCE_THRESHOLD (and see confidence.ts:
 * the threshold is deliberately not lowered for this) — so universal
 * detection would never confidently detect a single MangaDex page,
 * independent of the media-type question entirely.
 *
 * A real-world post-deploy bug fix changed how this adapter cross-checks
 * signals, verified with live, timed evidence (not assumption): MangaDex
 * is a client-side-routed (Vue) SPA — "Next Chapter" changes the URL via
 * history.pushState with no reload. document.title updates correctly and
 * quickly on that transition (observed consistently within ~200ms across
 * two real chapter-to-chapter navigations). Its <meta property="og:title">
 * tag does NOT — it stays fixed at whatever chapter the page was originally
 * server-rendered for, observed still stale a full 1.5s after navigating
 * two chapters further, with no sign it would ever catch up. An earlier
 * version of this adapter required document.title and og:title to agree
 * on the chapter number before returning a detection — a reasonable-
 * looking safety check that, given this real og:title staleness, meant
 * detection silently failed on every single SPA navigation after the
 * first chapter of a browsing session (exactly the "Next Chapter ->
 * Markly updates automatically" case Stage 23 exists for). og:title is
 * therefore not used by this adapter at all, for chapter number OR work
 * title — document.title is the sole, empirically-reliable chapter-number
 * source, and the work title instead comes from a completely different,
 * independently-reliable signal below.
 */
const MANGADEX_HOSTNAMES = new Set(["mangadex.org", "www.mangadex.org"]);
const CHAPTER_PATH_PATTERN = /^\/chapter\/[0-9a-f-]{36}(\/|$)/i;
const TITLE_LINK_PATTERN = /^\/title\/([0-9a-f-]{36})(\/([^/?#]+))?/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WorkIdentity {
  mangaId: string;
  href: string;
  title: string;
}

/**
 * Collects every /title/<UUID>[/slug] anchor on the page — /title/random
 * (a real utility link MangaDex renders in its own nav) is rejected
 * outright by the strict UUID pattern, never treated as a candidate.
 * Distinct anchors that resolve to the SAME manga UUID (the reader page
 * genuinely has more than one, confirmed live) are collapsed into one
 * identity, using the first non-empty anchor text found for it. If the
 * page's anchors point to more than one DIFFERENT manga UUID, there is no
 * safe way to know which one is "the" current work — reject rather than
 * arbitrarily picking the first, per the same "never guess" rule as
 * everything else in this codebase.
 */
function findWorkIdentity(document: Document): WorkIdentity | null {
  const byId = new Map<string, { href: string; title: string }>();
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/title/"]'));
  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href) continue;
    const match = href.match(TITLE_LINK_PATTERN);
    if (!match) continue;
    const mangaId = match[1];
    if (!UUID_PATTERN.test(mangaId)) continue;
    const text = link.textContent?.trim() ?? "";
    const existing = byId.get(mangaId);
    if (!existing) {
      byId.set(mangaId, { href, title: text });
    } else if (!existing.title && text) {
      // First candidate for this UUID had no usable text (e.g. an icon-only
      // link back to the title page) — a later one with real text improves it.
      existing.title = text;
    }
  }

  if (byId.size !== 1) return null; // zero candidates, or more than one distinct manga UUID — never guess
  const [mangaId, { href, title }] = [...byId.entries()][0];
  if (!title) return null; // found a valid work link but never a usable title for it
  return { mangaId, href, title };
}

export const mangadexAdapter: TrackingAdapter = {
  id: "mangadex",
  displayName: "MangaDex",

  matches(url) {
    return MANGADEX_HOSTNAMES.has(url.hostname) && CHAPTER_PATH_PATTERN.test(url.pathname);
  },

  detect(document, url) {
    const work = findWorkIdentity(document);
    if (!work) return null;

    // The sole chapter-number source (see the module doc comment for why
    // og:title is deliberately not cross-checked here). Oneshots/specials
    // MangaDex labels without a number (e.g. "Extra") correctly fall out
    // here as a non-match — never fabricated as chapter 0 or 1. The
    // leading reader-page-number ("2 | Chapter 71 - ...") is not itself
    // mistaken for progress: parseProgressText only matches on a
    // "ch"/"chapter" word boundary, which the page-number prefix never
    // satisfies.
    const titleMatch = parseProgressText(document.title);
    if (!titleMatch || titleMatch.kind !== "chapter") return null;

    const workUrl = new URL(work.href, url).toString();
    const detectedMetadata = buildDetectedMetadata(document, url, null, { workUrlOverride: workUrl, trustPageCover: false });

    return {
      adapterId: "mangadex",
      // Stable per-work identity — the manga UUID, never the chapter's own
      // UUID (which is a distinct release identifier; a re-upload or a
      // different translation group's version of "the same" chapter gets
      // its own chapter UUID but must still resolve to this same
      // sourceKey, since it's the same manga) and never the reader's own
      // page-within-chapter number (the trailing /2, /3, ... segment some
      // chapter URLs carry for multi-page reading — that's reading
      // position, not manga progress, and never appears in sourceKey).
      sourceKey: `mangadex.org::${work.mangaId}`,
      sourceUrl: url.toString(),
      sourceTitle: work.title,
      mediaType: "manga",
      progress: { kind: "chapter", value: titleMatch.value },
      ...(detectedMetadata && { detectedMetadata }),
    };
  },
};
