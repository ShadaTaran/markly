import type { TrackingAdapter } from "./types";

/**
 * Reads Markly's own controlled season-aware test harness (see
 * src/app/dev/video-test/show/season-[season]/episode-[episode]/page.tsx
 * in the main app) — proves the {kind:"season_episode"} wire shape and the
 * atomic seasonal comparison RPC end-to-end without depending on a real
 * streaming site's DOM, which Stage 25 deliberately does not add (see
 * README "Season-Aware Episode Tracking" — "the progress MODEL, not
 * provider expansion"). Mirrors markly-test-reader.ts's role for Stage
 * 18/19: a permanent, narrowly-scoped adapter that only ever matches
 * Markly's own dev origin, never a real site — universal detection is
 * deliberately not extended to parse seasons out of arbitrary pages, since
 * no real-world evidence backs a generic season URL/heading shape the way
 * Stage 23's chapter/episode patterns had.
 */
const PATH_PATTERN = /^\/dev\/video-test\/show\/season-(\d+)\/episode-(\d+)(\/|$)/;

export const marklySeasonTestAdapter: TrackingAdapter = {
  id: "markly-season-test",
  displayName: "Markly Season Test Harness",

  matches(url) {
    const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return isLocalHost && PATH_PATTERN.test(url.pathname);
  },

  detect(document, url) {
    const match = url.pathname.match(PATH_PATTERN);
    if (!match) return null;

    const season = Number(match[1]);
    const episode = Number(match[2]);
    if (!Number.isFinite(season) || season < 1 || !Number.isFinite(episode) || episode < 1) return null;

    return {
      adapterId: "markly-season-test",
      // Stable per-show identity — deliberately excludes the season/episode
      // segments, the same "strip the part that changes every page"
      // principle every other adapter's sourceKey follows (see url.ts's
      // strippedPath for the universal-detection equivalent).
      sourceKey: `${url.hostname}/dev/video-test/show`,
      sourceUrl: url.toString(),
      sourceTitle: "Markly Test Anime (Seasonal)",
      mediaType: "anime",
      progress: { kind: "season_episode", value: episode, season },
    };
  },
};
