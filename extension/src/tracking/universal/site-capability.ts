/**
 * A tiny, explicit registry of what KIND of media a known reader site
 * hosts — separate from title/chapter/source extraction, which stays
 * fully generic (see detect.ts). Universal detection can read "Chapter
 * 120" off nearly any reader site, but "chapter" alone is structurally
 * ambiguous between a manga/comic and a text-based web novel — no
 * generic DOM signal (heading structure, image count, URL shape) safely
 * distinguishes them, and guessing from page structure (e.g. "many <img>
 * tags") is exactly the kind of unreliable heuristic Stage 23 was told
 * not to build. This registry exists only to resolve that one narrow
 * ambiguity for sites we have real, verified evidence about; it is
 * checked by hostname alone and never reads any page content.
 *
 * This is deliberately not the same thing as a site-specific adapter — an
 * adapter also handles URL matching, title/progress extraction, and
 * source identity for a site whose markup defeats *generic* signal
 * extraction entirely (see mangadex.ts, whose own detect() is needed for
 * an unrelated reason: MangaDex's reader has no heading elements and no
 * numeric chapter in its URL, so universal detection can't reach its own
 * confidence threshold there at all, regardless of media type). This
 * registry's only job is answering "manga or novel" for a page universal
 * detection *did* confidently read.
 */
export type SiteMediaCapability = "manga" | "novel";

const KNOWN_MANGA_HOSTS = new Set<string>([
  // MangaDex itself is routed through its own adapter (see mangadex.ts),
  // which sets mediaType directly and never consults this registry — kept
  // here anyway so "MangaDex is manga" is recorded in one place, and as a
  // harmless safety net if MangaDex's markup ever changes enough for
  // universal detection to reach confidence there on its own.
  "mangadex.org",
]);

/** Returns null (not "novel") when nothing is known about the host — the caller decides what an unknown host's default should be, keeping this module a pure lookup. */
export function siteMediaCapability(hostname: string): SiteMediaCapability | null {
  return KNOWN_MANGA_HOSTS.has(hostname) ? "manga" : null;
}
