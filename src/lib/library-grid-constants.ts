/**
 * Round 7/8 — Grid mode's one deliberate card height, shared by
 * MediaItemCard and WebsiteItemCard so a mixed grid never shows irregular
 * row heights. `mt-auto` footer-pinning alone wasn't enough: without an
 * explicit height on the card itself, a flex-1 child has no real extra
 * space to distribute, so a sparse card was simply shorter, not "the same
 * height with breathing room." `overflow-hidden` on the card is the hard
 * guarantee that no content can grow past it.
 *
 * Round 8 (micro-polish): round 7's h-72 (288px) was a manual estimate,
 * never measured. Live DOM measurement of the richest realistic card
 * (cover + long title + 3 tags + status/quick-increment + progress text
 * and bar + rating + footer with a secondary field) — reproduced
 * identically across anime/manga/game/novel combinations, including a
 * deliberately extreme progress number ("1234567.5 / 9999999 chapters")
 * meant to try to force text wrapping — measured a stable, non-clipped
 * natural content height of exactly 277px at every card width tested
 * (318px through 400px+). 288px therefore already had only ~11px of
 * avoidable slack; there wasn't a large hidden margin to cut. 280px
 * (a deliberate +3px buffer over the measured 277px ceiling, verified
 * live to produce zero scrollHeight/clientHeight overflow) is the
 * evidence-based tightened value — not rounded to a Tailwind step,
 * since the nearest ones (h-64=256px, h-72=288px) either clip or don't
 * tighten anything.
 */
export const LIBRARY_GRID_CARD_HEIGHT_CLASS = "h-[280px]";

/**
 * Round 7 — Compact mode's own fixed row height, shared by
 * MediaItemCompactCard and WebsiteItemCompactCard for the same reason as
 * the Grid constant above: measurement showed a website row (one metadata
 * line, a smaller favicon) rendering shorter than a media row (up to two
 * metadata lines, a taller cover) by ~22px in a mixed list. Deliberately a
 * different value than the Grid card height — Compact is a denser, distinct
 * mode, not a smaller version of Grid.
 */
export const LIBRARY_COMPACT_CARD_HEIGHT_CLASS = "h-20";
