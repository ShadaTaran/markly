import type { TrackingAdapter } from "./types";

/**
 * Reads Markly's own controlled test page (see
 * src/app/dev/reader-test/page.tsx in the main app) — proves the full
 * detection → link → auto-update pipeline without depending on a real
 * external site's DOM, which can change at any time. Stage 19 adds the
 * first real site adapter; this one stays as a permanent architecture
 * smoke test, not a real feature.
 */
export const marklyTestReaderAdapter: TrackingAdapter = {
  id: "markly-test-reader",
  displayName: "Markly Test Reader",

  matches(url) {
    const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    // Boundary-checked, not startsWith: "/dev/reader-test" alone must not
    // also claim "/dev/reader-test-generic/..." (the universal-detection
    // test page) — a plain prefix check would swallow it and silently
    // stop universal detection from ever running there.
    return isLocalHost && /^\/dev\/reader-test(\/|$)/.test(url.pathname);
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
      adapterId: "markly-test-reader",
      sourceKey,
      sourceUrl: url.toString(),
      sourceTitle,
      mediaType: "novel",
      progress: { kind: "chapter", value },
    };
  },
};
