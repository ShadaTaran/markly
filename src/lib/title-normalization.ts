/**
 * Deterministic comparison key for title matching — folds away
 * differences a person would never consider meaningful (case, incidental
 * whitespace, common quote/dash character variants) without touching
 * anything that could change what the title actually says. Deliberately
 * does not strip words, numbers, or ordinary punctuation: "Lord of
 * Mysteries" and "Lord of Mysteries 2" must never normalize to the same
 * key. This is a comparison key only, never displayed or stored in place
 * of the real title.
 *
 * Shared, server/client-neutral (no "server-only" marker) so both Smart
 * Auto-Link (extension/auto-link.ts, server-only — the extension's
 * progress API route) and Stage 27's client-side duplicate detection
 * (lib/duplicate-detection.ts) use this exact same implementation rather
 * than two subtly-different ones — see README "Exact title normalization".
 */
export function normalizeTitleForMatching(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‒–—―]/g, "-")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}
