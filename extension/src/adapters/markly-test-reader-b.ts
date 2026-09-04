import type { TrackingAdapter } from "./types";

/**
 * Stage 26 — a second, independent dev-only adapter reading a second dev
 * harness page (src/app/dev/reader-test-b/page.tsx in the main app),
 * deliberately reporting the SAME work title as the real NovelPhoenix
 * source it's meant to be tested alongside — "Lord of the Mysteries," WITH
 * "the" (https://novelphoenix.com/novel/lord-of-the-mysteries) — never the
 * unrelated, pre-Stage-26 `/dev/reader-test` fixture's own "Lord of
 * Mysteries" (no "the"), which is a deliberately DIFFERENT title and must
 * stay one: Smart Auto-Link's exact normalized matching is supposed to
 * tell those apart, not treat them as the same work. This is the
 * "Source A / Source B, same work" scenario Stage 26 needed to prove the
 * cross-source model against — two genuinely distinct tracking_sources
 * rows (different adapterId, so different (user_id, adapter_id,
 * source_key) identity, never pretending to be NovelPhoenix's own
 * hostname/URL) that Smart Auto-Link's existing exact-title matching
 * already links to the same LibraryItem. Synthetic/development only,
 * never a real site — see README "Cross-Source Work Identity" for why no
 * new real provider was added for this.
 */
export const marklyTestReaderBAdapter: TrackingAdapter = {
  id: "markly-test-reader-b",
  displayName: "Markly Test Reader B",

  matches(url) {
    const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return isLocalHost && /^\/dev\/reader-test-b(\/|$)/.test(url.pathname);
  },

  detect(document, url) {
    const root = document.querySelector('[data-markly-reader="root"]');
    if (!root) return null;

    const sourceKey = root.getAttribute("data-source-key");
    const sourceTitle = root.getAttribute("data-source-title");
    if (!sourceKey || !sourceTitle) return null;

    const chapterEl = document.querySelector('[data-markly-reader="chapter"]');
    const chapterAttr = chapterEl?.getAttribute("data-chapter-number");
    const value = chapterAttr ? Number(chapterAttr) : NaN;
    if (!Number.isFinite(value) || value < 0) return null;

    return {
      adapterId: "markly-test-reader-b",
      sourceKey,
      sourceUrl: url.toString(),
      sourceTitle,
      mediaType: "novel",
      progress: { kind: "chapter", value },
    };
  },
};
